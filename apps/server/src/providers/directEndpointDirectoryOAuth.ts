import type {
  AnthropicCompatibleProviderConfiguration,
  OpenAiCompatibleProviderConfiguration,
  ProviderCredentialStatus,
  ProviderFailure,
  ProviderObservedDirectoryBinding,
  ProviderUnauthenticatedReason,
} from "@octant/contracts";
import {
  directoryOAuthFailure,
  readDirectoryOAuthCredential,
  withDirectoryOAuthBearer,
  type DirectoryOAuthAttempt,
  type DirectoryOAuthCredential,
  type DirectoryOAuthEndpoint,
  type DirectoryOAuthHost,
  type DirectoryOAuthRefusal,
} from "@octant/provider-sdk/directory-oauth";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import type { CompatibleRequestAuthorization } from "./openAiCompatibleEndpoint";

/**
 * A direct endpoint that signs in with the organization's directory: where it
 * may send a directory bearer, and the broker it asks for one. A tenant
 * driver kind fixes the audience and host list and the instance names
 * tenant, client, and base URL; an organization's gateway names its own
 * issuer, client, scope, and base URL.
 */
export interface DirectEndpointDirectoryOAuth {
  readonly endpoint: DirectoryOAuthEndpoint;
  /** Absent means the broker is unreachable: the endpoint reads `unavailable`. */
  readonly host: DirectoryOAuthHost | undefined;
}

/**
 * Where a gateway that signs in with its organization's own issuer may send
 * its bearer; undefined for a gateway that signs in another way. A gateway
 * configuration that names a sign-in always gets one, even without a broker,
 * so a stored value is never sent in its place.
 */
export function gatewayDirectorySignIn(
  configuration: OpenAiCompatibleProviderConfiguration | AnthropicCompatibleProviderConfiguration,
  host: DirectoryOAuthHost | undefined,
): DirectEndpointDirectoryOAuth | undefined {
  if (configuration.authentication !== "directory-oauth") return undefined;
  return {
    endpoint: {
      issuer: configuration.directory.issuer,
      clientId: configuration.directory.clientId,
      scope: configuration.directory.scope,
      baseUrl: configuration.baseUrl,
    },
    host,
  };
}

/**
 * Error codes a tenant kind's endpoint answers a token from another tenant
 * with. Only the code is read, never the message, which could echo a claim.
 * The real-tenant smoke confirms the set the Foundry endpoint uses. An
 * organization's gateway has no documented codes, so only its status is read.
 */
const TENANT_MISMATCH_CODES: ReadonlySet<string> = new Set(["InvalidAuthenticationTokenTenant"]);
/**
 * The code Azure AI Foundry answers a signed-in account without a data-plane
 * role with. It arrives as a 401, so a refresh would not help: it is read as
 * the missing role it names, not as a refused token.
 */
const MISSING_ROLE_CODES: ReadonlySet<string> = new Set(["PermissionDenied"]);
/** A refusal's error code sits in the first bytes; the rest is never read. */
const REFUSAL_BODY_LIMIT_BYTES = 16_384;

/** The stored pointer, or why there is none to use. */
export type DirectoryPointerRead =
  | { readonly kind: "pointer"; readonly credential: DirectoryOAuthCredential }
  | { readonly kind: "refused"; readonly refusal: DirectoryOAuthRefusal };

/**
 * Read the instance's stored directory pointer. A value that is not one, such
 * as an API key left from an earlier configuration, is never sent: it reads
 * as no sign-in. A store that cannot be reached reads `unavailable`.
 */
export async function readDirectoryPointer(
  credentialResolver: ProviderCredentialResolver | undefined,
  instanceId: string,
): Promise<DirectoryPointerRead> {
  const missing = {
    kind: "refused",
    refusal: { kind: "unauthenticated", reason: "missing" },
  } as const;
  if (credentialResolver === undefined) return missing;
  let raw: string;
  try {
    raw = await credentialResolver.resolve(instanceId);
  } catch (error) {
    // The store says "missing" as an unauthenticated failure; anything else
    // is the store itself being unreachable.
    return isRecord(error) && error.category === "unauthenticated"
      ? missing
      : { kind: "refused", refusal: { kind: "unavailable" } };
  }
  const credential = readDirectoryOAuthCredential(raw);
  return credential === undefined ? missing : { kind: "pointer", credential };
}

/**
 * The request authorization for one stored pointer: every request resolves
 * its own bearer, a 401 after a usable token renews it once and resends once,
 * and a refusal rejects with a fixed Octant sentence. The bearer lives only
 * in the headers of the one send that carries it.
 */
export function directoryRequestAuthorization(input: {
  readonly credential: DirectoryOAuthCredential | undefined;
  readonly directory: DirectEndpointDirectoryOAuth;
  readonly now: () => number;
}): CompatibleRequestAuthorization {
  return async (send) => {
    const outcome = await withDirectoryOAuthBearer(
      {
        credential: input.credential,
        endpoint: input.directory.endpoint,
        host: input.directory.host,
        now: input.now,
      },
      async (bearer) => {
        const response = await send({ authorization: `Bearer ${bearer}` });
        return "tenantId" in input.directory.endpoint
          ? classifyTenantAnswer(response)
          : classifyStatus(response);
      },
    );
    if (outcome.kind === "answered") return outcome.value;
    throw refusedFailure(outcome);
  };
}

/** The refusal behind a failure this module raised, when it raised it. */
export function directoryRefusalOf(error: unknown): DirectoryOAuthRefusal | undefined {
  return isRecord(error) ? refusals.get(error) : undefined;
}

/** A refusal as a failure, remembered so a probe can report its reason. */
export function refusedFailure(refusal: DirectoryOAuthRefusal): ProviderFailure {
  const failure = directoryOAuthFailure(refusal);
  refusals.set(failure, refusal);
  return failure;
}

/** How readiness reads a refusal, with the fixed sentence Settings shows. */
export function directoryRefusalReport(refusal: DirectoryOAuthRefusal): {
  readonly readiness: "unauthenticated" | "unavailable" | "incompatible";
  readonly credentialStatus: ProviderCredentialStatus;
  readonly unauthenticatedReason?: ProviderUnauthenticatedReason;
  readonly message: string;
} {
  const { message } = directoryOAuthFailure(refusal);
  if (refusal.kind === "unavailable") {
    return { readiness: "unavailable", credentialStatus: "unavailable", message };
  }
  if (refusal.kind === "incompatible") {
    return { readiness: "incompatible", credentialStatus: "stored", message };
  }
  return {
    readiness: "unauthenticated",
    // An ended or absent sign-in has no grant left; one the organization
    // wants repeated, or one without a role, is still held.
    credentialStatus:
      refusal.reason === "interaction-required" || refusal.reason === "not-authorized"
        ? "stored"
        : "missing",
    unauthenticatedReason: refusal.reason,
    message,
  };
}

/** The binding a probe checked, as readiness records it. */
export function observedDirectoryBinding(
  endpoint: DirectoryOAuthEndpoint,
): ProviderObservedDirectoryBinding | undefined {
  let origin: string;
  try {
    origin = new URL(endpoint.baseUrl).origin;
  } catch {
    return undefined;
  }
  return "tenantId" in endpoint
    ? { tenantId: endpoint.tenantId, clientId: endpoint.clientId, endpointOrigin: origin }
    : { issuer: endpoint.issuer, clientId: endpoint.clientId, endpointOrigin: origin };
}

const refusals = new WeakMap<object, DirectoryOAuthRefusal>();

/**
 * What one send to an organization's gateway answered: a 401 is a refused
 * token, a 403 an account without access. The body is the caller's to read.
 */
function classifyStatus(response: Response): DirectoryOAuthAttempt<Response> {
  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel().catch(() => undefined);
    return { kind: response.status === 401 ? "unauthorized" : "forbidden" };
  }
  return { kind: "answered", value: response };
}

/**
 * What one send to a tenant kind's endpoint answered. A 401 is a refused
 * token unless its code names the missing role or another tenant; a 403 is
 * the missing role unless its code names another tenant. Every other status
 * is the caller's to read.
 */
async function classifyTenantAnswer(response: Response): Promise<DirectoryOAuthAttempt<Response>> {
  if (response.status !== 401 && response.status !== 403) {
    return { kind: "answered", value: response };
  }
  const code = await refusalCode(response);
  if (code !== undefined && TENANT_MISMATCH_CODES.has(code)) return { kind: "tenant-mismatch" };
  if (response.status === 403 || (code !== undefined && MISSING_ROLE_CODES.has(code))) {
    return { kind: "forbidden" };
  }
  return { kind: "unauthorized" };
}

/** The `error.code` of a refusal body, read within a bound; the body is then released. */
async function refusalCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < REFUSAL_BODY_LIMIT_BYTES) {
      const read = await reader.read();
      if (read.done) break;
      chunks.push(read.value);
      length += read.value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return undefined;
  }
  const error = isRecord(parsed) ? parsed.error : undefined;
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code) ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

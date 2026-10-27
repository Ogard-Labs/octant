import {
  CloudIamSigningScope,
  CloudIamSourceIdentity,
  type ProviderFailure,
} from "@octant/contracts";
import { Schema } from "effect";

/**
 * Host-driven cloud-IAM signing for a direct HTTP endpoint that authorizes
 * each request by a cloud signature. The broker holds the source identity
 * (the organization's single sign-on session) and the temporary role
 * credentials it mints; a driver holds only a pointer, describes each request
 * by its fields, and receives that one request's signature headers. A driver
 * never sees a key, a secret, or a token it could reuse.
 *
 * The driver compares its configuration with the pointer, and the request
 * with the scope, before it asks; the broker checks the request against the
 * scope it stored at sign-in again before it signs. Nothing here falls back
 * to another kind of authentication.
 */

const KIND = "cloud-iam";
const CREDENTIAL_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POINTER_KEYS: ReadonlySet<string> = new Set(["kind", "credentialRef", "source", "scope"]);
// The headers a signature consists of. A broker answer naming any other is
// not a signature, and the driver refuses to send it.
const SIGNATURE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-amz-date",
  "x-amz-security-token",
]);

export const CLOUD_IAM_CREDENTIAL_KIND = KIND;

/** The credential store's value for a signed-in instance: a reference, never material. */
export interface CloudIamCredential {
  readonly kind: typeof KIND;
  readonly credentialRef: string;
  readonly source: CloudIamSourceIdentity;
  readonly scope: CloudIamSigningScope;
}

/** What the instance's configuration says its grant must be. */
export interface CloudIamEndpoint {
  readonly source: CloudIamSourceIdentity;
  readonly scope: CloudIamSigningScope;
}

/**
 * One request as its fields: the broker builds the canonical request from
 * these alone. `headers` are the ones to sign besides the host and the date
 * (the content type and what the driver accepts); `payloadHash` is the hex
 * SHA-256 of exactly the body that is sent.
 */
export interface CloudIamRequest {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}

export type CloudIamSignInAgainReason = "expired" | "revoked";

export type CloudIamUnauthenticatedReason = "missing" | "expired" | "revoked" | "not-authorized";

/**
 * The broker as a driver reaches it. `sign` answers with one request's
 * signature headers, or why it would not: the grant ended, the portal no
 * longer gives the role, or the request lies outside the grant's scope. A
 * rejection is treated as an unreachable broker. `renewCredentials` asks for
 * fresh role credentials, for the one retry after the endpoint refused them.
 */
export interface CloudIamHost {
  readonly sign: (
    credentialRef: string,
    request: CloudIamRequest,
    options: { readonly renewCredentials: boolean },
  ) => Promise<
    | { readonly kind: "signed"; readonly headers: Readonly<Record<string, string>> }
    | { readonly kind: "sign-in-again"; readonly reason: CloudIamSignInAgainReason }
    | { readonly kind: "not-authorized" }
    | { readonly kind: "outside-scope" }
    | { readonly kind: "unavailable" }
  >;
}

export type CloudIamRefusal =
  | { readonly kind: "unauthenticated"; readonly reason: CloudIamUnauthenticatedReason }
  | { readonly kind: "unavailable" }
  | { readonly kind: "incompatible" };

export type CloudIamResolution =
  | { readonly kind: "signature"; readonly headers: Readonly<Record<string, string>> }
  | CloudIamRefusal;

/**
 * What one signed request answered. `unauthorized` is the endpoint refusing
 * the credentials themselves (expired, unrecognized, or a signature it could
 * not match); `forbidden` is the role lacking the permission the request
 * needs.
 */
export type CloudIamAttempt<T> =
  | { readonly kind: "answered"; readonly value: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" };

export type CloudIamOutcome<T> = { readonly kind: "answered"; readonly value: T } | CloudIamRefusal;

export interface CloudIamResolveInput {
  readonly credential: CloudIamCredential | undefined;
  readonly endpoint: CloudIamEndpoint;
  readonly host: CloudIamHost | undefined;
}

export function encodeCloudIamCredential(credential: CloudIamCredential): string {
  return JSON.stringify({
    kind: KIND,
    credentialRef: credential.credentialRef,
    source: {
      startUrl: credential.source.startUrl,
      ssoRegion: credential.source.ssoRegion,
      accountId: credential.source.accountId,
      roleName: credential.source.roleName,
    },
    scope: {
      partition: credential.scope.partition,
      region: credential.scope.region,
      service: credential.scope.service,
      host: credential.scope.host,
      pathPrefix: credential.scope.pathPrefix,
      method: credential.scope.method,
    },
  });
}

/**
 * A stored API key, another kind's pointer, invalid JSON, or a pointer with
 * an unknown field or a scope outside the closed vocabulary is not this kind.
 */
export function readCloudIamCredential(value: string): CloudIamCredential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.kind !== KIND) return undefined;
  const keys = Object.keys(parsed);
  if (keys.length !== POINTER_KEYS.size || !keys.every((key) => POINTER_KEYS.has(key))) {
    return undefined;
  }
  const { credentialRef, source, scope } = parsed;
  if (
    typeof credentialRef !== "string" ||
    !CREDENTIAL_REF_PATTERN.test(credentialRef) ||
    !isStrict(CloudIamSourceIdentity, source) ||
    !isStrict(CloudIamSigningScope, scope)
  ) {
    return undefined;
  }
  return { kind: KIND, credentialRef, source, scope };
}

/** Whether a pointer names exactly the portal, account, role, and scope the configuration does. */
export function sameCloudIamGrant(
  credential: CloudIamCredential,
  endpoint: CloudIamEndpoint,
): boolean {
  const left = credential.source;
  const right = endpoint.source;
  return (
    String(left.startUrl) === String(right.startUrl) &&
    String(left.ssoRegion) === String(right.ssoRegion) &&
    String(left.accountId) === String(right.accountId) &&
    String(left.roleName) === String(right.roleName) &&
    credential.scope.partition === endpoint.scope.partition &&
    String(credential.scope.region) === String(endpoint.scope.region) &&
    credential.scope.service === endpoint.scope.service &&
    credential.scope.host === endpoint.scope.host &&
    credential.scope.pathPrefix === endpoint.scope.pathPrefix &&
    credential.scope.method === endpoint.scope.method
  );
}

/** Whether a request lies where the endpoint's scope lets a signature go. */
export function requestWithinCloudIamScope(
  request: CloudIamRequest,
  scope: CloudIamSigningScope,
): boolean {
  return (
    request.method === scope.method &&
    request.host === scope.host &&
    request.path.startsWith(scope.pathPrefix)
  );
}

/**
 * Resolve one request's signature. Call it for every request: a signature
 * covers one request at one moment. The headers are the return value only and
 * must not be kept after the request.
 *
 * Every check runs before the host is asked, so a mis-set instance or a
 * request outside its scope costs no broker call.
 */
export async function resolveCloudIamSignature(
  input: CloudIamResolveInput & {
    readonly request: CloudIamRequest;
    readonly renewCredentials?: boolean;
  },
): Promise<CloudIamResolution> {
  const { credential, endpoint, request } = input;
  if (credential === undefined) return { kind: "unauthenticated", reason: "missing" };
  if (
    !sameCloudIamGrant(credential, endpoint) ||
    !requestWithinCloudIamScope(request, endpoint.scope)
  ) {
    return { kind: "incompatible" };
  }
  if (input.host === undefined) return { kind: "unavailable" };
  let signed: Awaited<ReturnType<CloudIamHost["sign"]>>;
  try {
    signed = await input.host.sign(credential.credentialRef, request, {
      renewCredentials: input.renewCredentials === true,
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (signed.kind === "outside-scope") return { kind: "incompatible" };
  if (signed.kind === "not-authorized") {
    return { kind: "unauthenticated", reason: "not-authorized" };
  }
  if (signed.kind === "sign-in-again") return { kind: "unauthenticated", reason: signed.reason };
  if (signed.kind !== "signed" || !isSignature(signed.headers)) return { kind: "unavailable" };
  return { kind: "signature", headers: signed.headers };
}

/**
 * Run one request with a cloud signature. When the endpoint refuses the
 * credentials themselves, the broker renews them once and the request goes
 * once more inside the same attempt; renewing a credential is the transport's
 * own business, apart from the host's outage retries. A second refusal is
 * unauthenticated, which the host does not retry.
 *
 * `attempt` may run twice, so it builds its request, body included, on each
 * call; the body must be exactly the one whose hash the request names.
 */
export async function withCloudIamSignature<T>(
  input: CloudIamResolveInput & { readonly request: CloudIamRequest },
  attempt: (headers: Readonly<Record<string, string>>) => Promise<CloudIamAttempt<T>>,
): Promise<CloudIamOutcome<T>> {
  const first = await resolveCloudIamSignature(input);
  if (first.kind !== "signature") return first;
  const answered = await attempt(first.headers);
  if (answered.kind !== "unauthorized") return outcomeOf(answered);
  const renewed = await resolveCloudIamSignature({ ...input, renewCredentials: true });
  if (renewed.kind !== "signature") return renewed;
  const retried = await attempt(renewed.headers);
  // The broker had just minted these credentials and the endpoint still
  // refused them, so only a new sign-in can change the answer.
  if (retried.kind === "unauthorized") return { kind: "unauthenticated", reason: "revoked" };
  return outcomeOf(retried);
}

export function cloudIamReadiness(
  outcome: CloudIamOutcome<unknown> | CloudIamResolution,
): "ready" | "unauthenticated" | "unavailable" | "incompatible" {
  return outcome.kind === "answered" || outcome.kind === "signature" ? "ready" : outcome.kind;
}

/**
 * A refusal as the host reports it, in fixed Octant sentences: no portal or
 * endpoint text, which could echo a token or an account detail, reaches a
 * failure.
 */
export function cloudIamFailure(refusal: CloudIamRefusal): ProviderFailure {
  if (refusal.kind === "incompatible") {
    return {
      category: "incompatible",
      message:
        "This endpoint's cloud sign-in does not match its portal, account, role, or region. Sign in again for this endpoint.",
    };
  }
  if (refusal.kind === "unavailable") {
    return {
      category: "unavailable",
      message: "The cloud sign-in service is unavailable. Try again.",
    };
  }
  return {
    category: "unauthenticated",
    reason: "authentication-required",
    message: UNAUTHENTICATED_MESSAGES[refusal.reason],
  };
}

const UNAUTHENTICATED_MESSAGES: Readonly<Record<CloudIamUnauthenticatedReason, string>> = {
  missing: "Sign in with your organization's single sign-on before using this endpoint.",
  expired: "Your single sign-on session has ended. Sign in again to use this endpoint.",
  revoked: "Your single sign-on is no longer accepted. Sign in again to use this endpoint.",
  "not-authorized":
    "Your cloud role is signed in but has no access to this endpoint or model. Ask an administrator for the permission.",
};

function outcomeOf<T>(
  answered: Exclude<CloudIamAttempt<T>, { readonly kind: "unauthorized" }>,
): CloudIamOutcome<T> {
  if (answered.kind === "forbidden") return { kind: "unauthenticated", reason: "not-authorized" };
  return answered;
}

/** A signature is exactly its own headers, each a non-empty line of visible text. */
function isSignature(headers: unknown): headers is Readonly<Record<string, string>> {
  if (!isRecord(headers)) return false;
  const entries = Object.entries(headers);
  return (
    entries.length > 0 &&
    "authorization" in headers &&
    entries.every(
      ([name, value]) =>
        SIGNATURE_HEADERS.has(name) &&
        typeof value === "string" &&
        /^[\x20-\x7e]{1,8192}$/.test(value),
    )
  );
}

function isStrict<A, I>(schema: Schema.Schema<A, I>, value: unknown): value is A {
  return Schema.is(schema)(value, { onExcessProperty: "error" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

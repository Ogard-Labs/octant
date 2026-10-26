import { DirectoryClientId, DirectoryTenantId, type ProviderFailure } from "@octant/contracts";
import { Schema } from "effect";

/**
 * Host-driven directory sign-in for a direct HTTP endpoint: an organization's
 * own OAuth/OIDC tenant issues a bearer for the endpoint's resource.
 *
 * The broker holds the refresh token and the validated identity; a driver
 * holds only a pointer and asks the host for one access token per request,
 * naming the binding it expects. The driver checks its own configuration
 * against the pointer before it asks, and the broker checks the binding again
 * before it releases a token, so a mis-set instance never sends a directory
 * bearer to another tenant or host. Nothing here falls back to another kind
 * of authentication.
 */

const KIND = "directory-oauth";
const CREDENTIAL_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .@_'-]{0,127}$/;
const POINTER_KEYS = new Set([
  "kind",
  "credentialRef",
  "tenantId",
  "clientId",
  "audience",
  "endpointOrigin",
  "accountLabel",
]);
/** A token this close to its expiry is refreshed before it is sent. */
const EXPIRY_SKEW_MS = 15_000;

export const DIRECTORY_OAUTH_CREDENTIAL_KIND = KIND;

/** What a grant was signed in for; the broker refuses access under any other. */
export interface DirectoryOAuthBinding {
  readonly tenantId: DirectoryTenantId;
  readonly clientId: DirectoryClientId;
  /** The one resource the driver kind's endpoint accepts. */
  readonly audience: string;
  /** The canonical https origin of the endpoint the grant was signed in for. */
  readonly endpointOrigin: string;
}

/** The credential store's value for a signed-in instance: references, never material. */
export interface DirectoryOAuthCredential extends DirectoryOAuthBinding {
  readonly kind: typeof KIND;
  readonly credentialRef: string;
  readonly accountLabel: string;
}

/** The instance's own view of where it may send a directory bearer. */
export interface DirectoryOAuthEndpoint {
  readonly tenantId: DirectoryTenantId;
  readonly clientId: DirectoryClientId;
  /** The one resource this driver kind's endpoint accepts. */
  readonly audience: string;
  /** The instance's current base URL. */
  readonly baseUrl: string;
  /**
   * Host suffixes this driver kind's endpoints live under, each starting with
   * a dot. A base URL whose host ends in none of them receives no bearer.
   */
  readonly hostSuffixes: ReadonlyArray<string>;
}

export type DirectoryOAuthSignInAgainReason =
  | "expired"
  | "revoked"
  | "refresh-reused"
  | "interaction-required";

export type DirectoryOAuthUnauthenticatedReason =
  | "missing"
  | "expired"
  | "revoked"
  | "interaction-required"
  | "not-authorized";

/**
 * The broker as a driver reaches it. `access` returns a token only when the
 * binding matches the grant; a grant the broker no longer holds reads
 * `sign-in-again`. A rejection is treated as an unreachable broker.
 */
export interface DirectoryOAuthHost {
  readonly refresh: (
    credentialRef: string,
  ) => Promise<
    | { readonly kind: "refreshed" }
    | { readonly kind: "sign-in-again"; readonly reason: DirectoryOAuthSignInAgainReason }
    | { readonly kind: "transient" }
    | { readonly kind: "unavailable" }
  >;
  readonly access: (
    credentialRef: string,
    binding: DirectoryOAuthBinding,
  ) => Promise<
    | { readonly kind: "granted"; readonly accessToken: string; readonly expiresAt: string }
    | { readonly kind: "sign-in-again"; readonly reason: DirectoryOAuthSignInAgainReason }
    | { readonly kind: "binding-mismatch" }
    | { readonly kind: "unavailable" }
  >;
}

export type DirectoryOAuthRefusal =
  | { readonly kind: "unauthenticated"; readonly reason: DirectoryOAuthUnauthenticatedReason }
  | { readonly kind: "unavailable" }
  | { readonly kind: "incompatible" };

export type DirectoryOAuthResolution =
  | { readonly kind: "bearer"; readonly token: string }
  | DirectoryOAuthRefusal;

/**
 * What one request answered. `unauthorized` is an HTTP 401; `forbidden` is a
 * 403 the endpoint did not attribute to the tenant (a missing role
 * assignment); `tenant-mismatch` is the endpoint's own signal that the token
 * came from another tenant.
 */
export type DirectoryOAuthAttempt<T> =
  | { readonly kind: "answered"; readonly value: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "tenant-mismatch" };

export type DirectoryOAuthOutcome<T> =
  | { readonly kind: "answered"; readonly value: T }
  | DirectoryOAuthRefusal;

export interface DirectoryOAuthResolveInput {
  readonly credential: DirectoryOAuthCredential | undefined;
  readonly endpoint: DirectoryOAuthEndpoint;
  readonly host: DirectoryOAuthHost | undefined;
  readonly now: () => number;
}

export function encodeDirectoryOAuthCredential(credential: DirectoryOAuthCredential): string {
  return JSON.stringify({
    kind: KIND,
    credentialRef: credential.credentialRef,
    tenantId: credential.tenantId,
    clientId: credential.clientId,
    audience: credential.audience,
    endpointOrigin: credential.endpointOrigin,
    accountLabel: credential.accountLabel,
  });
}

/**
 * A stored API key, another kind's pointer, invalid JSON, or a pointer with
 * an unknown field or a loose binding is not this kind.
 */
export function readDirectoryOAuthCredential(value: string): DirectoryOAuthCredential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.kind !== KIND) return undefined;
  if (Object.keys(parsed).some((key) => !POINTER_KEYS.has(key))) return undefined;
  const { credentialRef, tenantId, clientId, audience, endpointOrigin, accountLabel } = parsed;
  if (
    typeof credentialRef !== "string" ||
    !CREDENTIAL_REF_PATTERN.test(credentialRef) ||
    !Schema.is(DirectoryTenantId)(tenantId) ||
    !Schema.is(DirectoryClientId)(clientId) ||
    typeof audience !== "string" ||
    !isAudience(audience) ||
    typeof endpointOrigin !== "string" ||
    canonicalHttpsOrigin(endpointOrigin) !== endpointOrigin ||
    typeof accountLabel !== "string" ||
    !ACCOUNT_LABEL_PATTERN.test(accountLabel)
  ) {
    return undefined;
  }
  return { kind: KIND, credentialRef, tenantId, clientId, audience, endpointOrigin, accountLabel };
}

/**
 * Resolve one request's bearer. Call it for every request, never once per
 * session: a session outlives a token. The token is the return value only and
 * must not be kept after the request.
 *
 * Every binding check runs before the host is asked, so a mis-set instance
 * costs no broker call. `forceRefresh` renews the token even when its expiry
 * says it is usable, for the one retry after the endpoint refused it.
 */
export async function resolveDirectoryOAuthBearer(
  input: DirectoryOAuthResolveInput & { readonly forceRefresh?: boolean },
): Promise<DirectoryOAuthResolution> {
  const { credential, endpoint } = input;
  if (credential === undefined) return { kind: "unauthenticated", reason: "missing" };
  const origin = canonicalHttpsOrigin(endpoint.baseUrl);
  if (
    origin === undefined ||
    !hostIsListed(new URL(origin).hostname, endpoint.hostSuffixes) ||
    origin !== credential.endpointOrigin ||
    String(credential.tenantId) !== String(endpoint.tenantId) ||
    String(credential.clientId) !== String(endpoint.clientId) ||
    credential.audience !== endpoint.audience
  ) {
    return { kind: "incompatible" };
  }
  if (input.host === undefined) return { kind: "unavailable" };
  const binding: DirectoryOAuthBinding = {
    tenantId: endpoint.tenantId,
    clientId: endpoint.clientId,
    audience: endpoint.audience,
    endpointOrigin: origin,
  };
  if (input.forceRefresh === true) {
    const refusal = await refresh(input.host, credential.credentialRef);
    if (refusal !== undefined) return refusal;
    return access(input.host, credential.credentialRef, binding, input.now, true);
  }
  return access(input.host, credential.credentialRef, binding, input.now, false);
}

/**
 * Run one request with a directory bearer. A 401 after a usable token renews
 * it once and sends once more inside the same attempt: renewing a credential
 * is the transport's own business, apart from the host's outage retries. A
 * second 401 is unauthenticated, which the host does not retry.
 *
 * `attempt` may run twice, so it builds its request, body included, on each
 * call: a stream body consumed by the refused send cannot be sent again.
 */
export async function withDirectoryOAuthBearer<T>(
  input: DirectoryOAuthResolveInput,
  attempt: (bearer: string) => Promise<DirectoryOAuthAttempt<T>>,
): Promise<DirectoryOAuthOutcome<T>> {
  const first = await resolveDirectoryOAuthBearer(input);
  if (first.kind !== "bearer") return first;
  const answered = await attempt(first.token);
  if (answered.kind !== "unauthorized") return outcomeOf(answered);
  const renewed = await resolveDirectoryOAuthBearer({ ...input, forceRefresh: true });
  if (renewed.kind !== "bearer") return renewed;
  const retried = await attempt(renewed.token);
  // The directory had just issued this token and the endpoint still refused
  // it, so only a new sign-in can change the answer.
  if (retried.kind === "unauthorized") return { kind: "unauthenticated", reason: "revoked" };
  return outcomeOf(retried);
}

export function directoryOAuthReadiness(
  outcome: DirectoryOAuthOutcome<unknown> | DirectoryOAuthResolution,
): "ready" | "unauthenticated" | "unavailable" | "incompatible" {
  return outcome.kind === "answered" || outcome.kind === "bearer" ? "ready" : outcome.kind;
}

/**
 * A refusal as the host reports it, in fixed Octant sentences: no directory
 * or endpoint text, which could echo a token or claim, reaches a failure.
 */
export function directoryOAuthFailure(refusal: DirectoryOAuthRefusal): ProviderFailure {
  if (refusal.kind === "incompatible") {
    return {
      category: "incompatible",
      message:
        "This endpoint's organization sign-in does not match its tenant, client, or address. Sign in again for this endpoint.",
    };
  }
  if (refusal.kind === "unavailable") {
    return {
      category: "unavailable",
      message: "The organization sign-in service is unavailable. Try again.",
    };
  }
  return {
    category: "unauthenticated",
    reason: "authentication-required",
    message: UNAUTHENTICATED_MESSAGES[refusal.reason],
  };
}

const UNAUTHENTICATED_MESSAGES: Readonly<Record<DirectoryOAuthUnauthenticatedReason, string>> = {
  missing: "Sign in with your organization account before using this endpoint.",
  expired: "Your organization sign-in has ended. Sign in again to use this endpoint.",
  revoked: "Your organization sign-in is no longer accepted. Sign in again to use this endpoint.",
  "interaction-required":
    "Your organization asks you to sign in again in person, for example to complete multi-factor authentication.",
  "not-authorized":
    "Your organization account is signed in but has no access to this endpoint. Ask an administrator for a role on it.",
};

function outcomeOf<T>(
  answered: Exclude<DirectoryOAuthAttempt<T>, { readonly kind: "unauthorized" }>,
): DirectoryOAuthOutcome<T> {
  if (answered.kind === "forbidden") return { kind: "unauthenticated", reason: "not-authorized" };
  if (answered.kind === "tenant-mismatch") return { kind: "incompatible" };
  return answered;
}

async function access(
  host: DirectoryOAuthHost,
  credentialRef: string,
  binding: DirectoryOAuthBinding,
  now: () => number,
  refreshed: boolean,
): Promise<DirectoryOAuthResolution> {
  let granted: Awaited<ReturnType<DirectoryOAuthHost["access"]>>;
  try {
    granted = await host.access(credentialRef, binding);
  } catch {
    return { kind: "unavailable" };
  }
  if (granted.kind === "unavailable") return { kind: "unavailable" };
  if (granted.kind === "binding-mismatch") return { kind: "incompatible" };
  if (granted.kind === "sign-in-again") return signInAgain(granted.reason);
  if (granted.accessToken.length === 0) return { kind: "unavailable" };
  if (usable(granted.expiresAt, now())) return { kind: "bearer", token: granted.accessToken };
  if (refreshed) return { kind: "unauthenticated", reason: "expired" };
  const refusal = await refresh(host, credentialRef);
  if (refusal !== undefined) return refusal;
  return access(host, credentialRef, binding, now, true);
}

/** Undefined when the host renewed the token. */
async function refresh(
  host: DirectoryOAuthHost,
  credentialRef: string,
): Promise<DirectoryOAuthRefusal | undefined> {
  let renewed: Awaited<ReturnType<DirectoryOAuthHost["refresh"]>>;
  try {
    renewed = await host.refresh(credentialRef);
  } catch {
    return { kind: "unavailable" };
  }
  if (renewed.kind === "refreshed") return undefined;
  if (renewed.kind === "sign-in-again") return signInAgain(renewed.reason);
  return { kind: "unavailable" };
}

function signInAgain(reason: DirectoryOAuthSignInAgainReason): DirectoryOAuthRefusal {
  return {
    kind: "unauthenticated",
    reason: reason === "refresh-reused" ? "revoked" : reason,
  };
}

function usable(expiresAt: string, now: number): boolean {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry - EXPIRY_SKEW_MS > now;
}

function hostIsListed(hostname: string, suffixes: ReadonlyArray<string>): boolean {
  return suffixes.some(
    (suffix) =>
      suffix.startsWith(".") && suffix.length > 1 && hostname.endsWith(suffix.toLowerCase()),
  );
}

/** The origin of an https URL with no embedded credentials, or undefined. */
function canonicalHttpsOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  return url.origin;
}

/** An https resource identifier with no credentials, query, or fragment. */
function isAudience(value: string): boolean {
  if (value.length > 256 || value.includes("?") || value.includes("#")) return false;
  return canonicalHttpsOrigin(value) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

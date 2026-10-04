/**
 * Host-driven subscription sign-in for a direct HTTP endpoint.
 *
 * The broker stores the grant. A driver receives only a pointer and asks the
 * host for a short-lived access token per request. A missing or expired grant
 * is unauthenticated, and a binding mismatch is incompatible. Neither case
 * claims capabilities the endpoint has not demonstrated.
 */

const KIND = "subscription-oauth";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DESCRIPTOR_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACCOUNT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .@_-]{0,63}$/;
const EXPIRY_SKEW_MS = 15_000;

export const SUBSCRIPTION_OAUTH_CREDENTIAL_KIND = KIND;

export interface SubscriptionOAuthCredential {
  readonly kind: typeof KIND;
  readonly credentialRef: string;
  readonly descriptorId: string;
  readonly accountLabel: string;
}

export type SubscriptionOAuthSignInAgainReason = "revoked" | "expired" | "refresh-reused";

export interface SubscriptionOAuthHost {
  readonly refresh: (
    credentialRef: string,
  ) => Promise<
    | { readonly kind: "refreshed" }
    | { readonly kind: "sign-in-again"; readonly reason: SubscriptionOAuthSignInAgainReason }
    | { readonly kind: "transient" }
    | { readonly kind: "unavailable" }
  >;
  readonly access: (
    credentialRef: string,
  ) => Promise<
    | { readonly kind: "granted"; readonly accessToken: string; readonly expiresAt: string }
    | { readonly kind: "sign-in-again"; readonly reason: SubscriptionOAuthSignInAgainReason }
    | { readonly kind: "unavailable" }
  >;
}

export type SubscriptionOAuthResolution =
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "unauthenticated"; readonly reason: "missing" | "expired" | "revoked" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "incompatible" };

export function encodeSubscriptionOAuthCredential(credential: SubscriptionOAuthCredential): string {
  return JSON.stringify({
    kind: KIND,
    credentialRef: credential.credentialRef,
    descriptorId: credential.descriptorId,
    accountLabel: credential.accountLabel,
  });
}

/** A stored API key is not this kind. Invalid JSON is not this kind. */
export function readSubscriptionOAuthCredential(
  value: string,
): SubscriptionOAuthCredential | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.kind !== KIND) return undefined;
    const credentialRef = parsed.credentialRef;
    const descriptorId = parsed.descriptorId;
    const accountLabel = parsed.accountLabel;
    if (
      typeof credentialRef !== "string" ||
      !UUID_PATTERN.test(credentialRef) ||
      typeof descriptorId !== "string" ||
      !DESCRIPTOR_PATTERN.test(descriptorId) ||
      typeof accountLabel !== "string" ||
      !ACCOUNT_LABEL_PATTERN.test(accountLabel)
    ) {
      return undefined;
    }
    return { kind: KIND, credentialRef, descriptorId, accountLabel };
  } catch {
    return undefined;
  }
}

/**
 * Resolve one request's bearer. The token is the return value only — callers
 * must not retain it after the request. Refresh runs through the host when
 * the stored access token is missing or near expiry.
 */
export async function resolveSubscriptionOAuthBearer(input: {
  readonly credential: SubscriptionOAuthCredential | undefined;
  readonly expectedDescriptorId: string | undefined;
  readonly host: SubscriptionOAuthHost | undefined;
  readonly now: () => number;
}): Promise<SubscriptionOAuthResolution> {
  if (input.credential === undefined) return { kind: "unauthenticated", reason: "missing" };
  if (
    input.expectedDescriptorId !== undefined &&
    input.credential.descriptorId !== input.expectedDescriptorId
  ) {
    return { kind: "incompatible" };
  }
  if (input.host === undefined) return { kind: "unavailable" };
  return accessOrRefresh(input.host, input.credential.credentialRef, input.now, false);
}

export function subscriptionOAuthReadiness(
  resolution: SubscriptionOAuthResolution,
): "ready" | "unauthenticated" | "unavailable" | "incompatible" {
  return resolution.kind === "bearer" ? "ready" : resolution.kind;
}

/** Capabilities may be claimed only after an authenticated probe succeeds. */
export function subscriptionOAuthMayClaimCapabilities(
  resolution: SubscriptionOAuthResolution,
): boolean {
  return resolution.kind === "bearer";
}

async function accessOrRefresh(
  host: SubscriptionOAuthHost,
  credentialRef: string,
  now: () => number,
  refreshed: boolean,
): Promise<SubscriptionOAuthResolution> {
  let granted: Awaited<ReturnType<SubscriptionOAuthHost["access"]>>;
  try {
    granted = await host.access(credentialRef);
  } catch {
    return { kind: "unavailable" };
  }
  if (granted.kind === "unavailable") return { kind: "unavailable" };
  if (granted.kind === "sign-in-again") return unauthenticated(granted.reason);
  if (!usable(granted.expiresAt, now())) {
    if (refreshed) return { kind: "unauthenticated", reason: "expired" };
    let refresh: Awaited<ReturnType<SubscriptionOAuthHost["refresh"]>>;
    try {
      refresh = await host.refresh(credentialRef);
    } catch {
      return { kind: "unavailable" };
    }
    if (refresh.kind === "sign-in-again") return unauthenticated(refresh.reason);
    if (refresh.kind !== "refreshed") return { kind: "unavailable" };
    return accessOrRefresh(host, credentialRef, now, true);
  }
  return { kind: "bearer", token: granted.accessToken };
}

function unauthenticated(reason: SubscriptionOAuthSignInAgainReason): SubscriptionOAuthResolution {
  if (reason === "revoked" || reason === "refresh-reused") {
    return { kind: "unauthenticated", reason: "revoked" };
  }
  return { kind: "unauthenticated", reason: "expired" };
}

function usable(expiresAt: string, now: number): boolean {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry - EXPIRY_SKEW_MS > now;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SubscriptionOAuthConformanceReport {
  readonly readiness: "ready" | "unauthenticated" | "unavailable" | "incompatible";
  readonly capabilitiesClaimed: boolean;
  readonly endpointCalled: boolean;
  readonly refreshed: boolean;
}

/**
 * Prove a subscription-oauth credential against a fake endpoint.
 * The report never includes the access token. The endpoint sees a bearer
 * only when the host granted a usable one.
 */
export async function runSubscriptionOAuthCredentialConformance(input: {
  readonly credential: SubscriptionOAuthCredential | undefined;
  readonly expectedDescriptorId: string | undefined;
  readonly host: SubscriptionOAuthHost;
  readonly endpointUrl: string;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly refreshCount: () => number;
}): Promise<SubscriptionOAuthConformanceReport> {
  const resolution = await resolveSubscriptionOAuthBearer({
    credential: input.credential,
    expectedDescriptorId: input.expectedDescriptorId,
    host: input.host,
    now: input.now,
  });
  let endpointCalled = false;
  if (resolution.kind === "bearer") {
    const response = await input.fetch(input.endpointUrl, {
      headers: { authorization: `Bearer ${resolution.token}` },
    });
    endpointCalled = response.ok;
  }
  return {
    readiness: subscriptionOAuthReadiness(resolution),
    capabilitiesClaimed: subscriptionOAuthMayClaimCapabilities(resolution),
    endpointCalled,
    refreshed: input.refreshCount() > 0,
  };
}

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";

const GRANT_KIND = "host-oauth-grant";
const CALLBACK_PATH = "/oauth/callback";
const OPENROUTER_DIALECT = "openrouter-pkce";
const CHATGPT_PLAN_DIALECT = "chatgpt-plan-siwc";
// The ChatGPT plan flow registers a user-defined agent on the first sign-in:
// the authorize request sends this placeholder client id, and the callback
// returns the issued client id (oaiapp_...) that the exchange and every later
// refresh must use. The placeholder is never stored.
const SIWC_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
// The resource every ChatGPT plan authorize, exchange, and refresh names.
const SIWC_RESOURCE = "https://api.openai.com/v1";
// The scope that authorizes plan usage. A valid identity without it is an
// identity-only sign-in: the credential is stored, plan usage stays disabled.
const SIWC_PLAN_SCOPE = "chatgpt.tokens.use.direct";
// The issuer and JWKS location of the ChatGPT plan identity tokens.
const SIWC_ISSUER = "https://auth.openai.com";
const SIWC_JWKS_PATH = "/.well-known/jwks.json";
// OpenRouter exchanges the code for a long-lived user-controlled API key.
// There is no refresh token; the stored refresh field repeats the key and a
// failed refresh sends the user back to sign-in. The key never expires, so
// the grant stores no expiry at all rather than a manufactured one.
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1_000;
const DEFAULT_DEVICE_INTERVAL_MS = 5_000;
const SLOW_DOWN_MS = 5_000;
const MAX_TOKEN_CHARS = 4_096;
const MAX_RESPONSE_CHARS = 16 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;
const ERROR_PATTERN = /^[a-z_]{1,64}$/;
const USER_CODE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const ISSUED_CLIENT_ID_PATTERN = /^oaiapp_[A-Za-z0-9_-]{1,128}$/;
const EXT_AGENT_HOST_ID_PATTERN = /^urn:[a-z0-9][a-z0-9.:-]{0,127}$/;
const AGENT_NAME_HINT_PATTERN = /^.{1,64}$/;
const JWKS_CACHE_MS = 10 * 60 * 1_000;

export type HostOAuthFlow = "authorization-code-pkce" | "device-code";

/** Vendor wire dialects the host OAuth runner can speak. */
export type HostOAuthDialect = "openrouter-pkce" | "chatgpt-plan-siwc";

export interface HostOAuthDescriptor {
  readonly descriptorId: string;
  /** Absent only for a dialect that sends no `client_id`. */
  readonly clientId?: string;
  /** A vendor wire dialect. Absent means the standard OAuth runner path. */
  readonly dialect?: HostOAuthDialect;
  readonly flow: HostOAuthFlow;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint?: string;
  readonly scopes: readonly string[];
  readonly termsId: string;
  /**
   * ChatGPT plan dialect only: the stable host id sent as
   * `ext_agent_host_id` and persisted before the first sign-in.
   */
  readonly extAgentHostId?: string;
  /** ChatGPT plan dialect only: the app name sent as `agent_name_hint` on registration. */
  readonly agentNameHint?: string;
}

export type HostOAuthSignInAgainReason = "revoked" | "expired" | "refresh-reused";

export type HostOAuthRefusalReason =
  | "state-mismatch"
  | "verifier-mismatch"
  | "denied"
  | "timeout"
  | "exchange-refused"
  | "unavailable"
  | "terms-required"
  | "invalid";

export type HostOAuthPublicState =
  | {
      readonly kind: "awaiting-consent";
      readonly attemptId: string;
      readonly descriptorId: string;
      readonly flow: "authorization-code-pkce";
      readonly authorizationUrl: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "awaiting-consent";
      readonly attemptId: string;
      readonly descriptorId: string;
      readonly flow: "device-code";
      readonly verificationUri: string;
      readonly userCode: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "signed-in";
      readonly attemptId: string;
      readonly descriptorId: string;
      readonly credentialRef: string;
    }
  | {
      readonly kind: "refused";
      readonly attemptId: string;
      readonly descriptorId: string;
      readonly reason: HostOAuthRefusalReason;
    }
  | { readonly kind: "unknown" };

export type HostOAuthBeginResult =
  | Extract<HostOAuthPublicState, { readonly kind: "awaiting-consent" }>
  | { readonly kind: "refused"; readonly reason: HostOAuthRefusalReason };

export type HostOAuthRefreshResult =
  | { readonly kind: "refreshed" }
  | { readonly kind: "sign-in-again"; readonly reason: HostOAuthSignInAgainReason }
  | { readonly kind: "transient" }
  | { readonly kind: "unavailable" };

export type HostOAuthAccessResult =
  | {
      readonly kind: "granted";
      readonly accessToken: string;
      readonly tokenType: string;
      /** Absent when the stored credential does not expire. */
      readonly expiresAt?: string;
      /**
       * ChatGPT plan dialect only: false when the granted scopes do not
       * include the plan-usage scope. The bearer is still valid for
       * identity; plan usage is disabled.
       */
      readonly planUsageEnabled?: boolean;
    }
  | { readonly kind: "sign-in-again"; readonly reason: HostOAuthSignInAgainReason }
  | { readonly kind: "unavailable" };

export interface HostOAuthRuntime {
  readonly begin: (input: {
    readonly descriptor: HostOAuthDescriptor;
    readonly actorId: string;
    readonly termsAcknowledgedAt: string;
  }) => Promise<HostOAuthBeginResult>;
  readonly status: (attemptId: string) => HostOAuthPublicState;
  readonly refresh: (credentialRef: string) => Promise<HostOAuthRefreshResult>;
  readonly access: (credentialRef: string) => Promise<HostOAuthAccessResult>;
  /**
   * ChatGPT plan dialect only: revoke the refresh token at the issuer's
   * revocation endpoint, then drop the stored grant. Other dialects have no
   * revocation endpoint and simply drop the grant.
   */
  readonly revoke: (credentialRef: string) => Promise<HostOAuthRevokeResult>;
  readonly close: () => Promise<void>;
}

export type HostOAuthRevokeResult = { readonly kind: "revoked" } | { readonly kind: "unavailable" };

interface StoredGrant {
  readonly kind: typeof GRANT_KIND;
  readonly version: 1;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: string;
  /**
   * Epoch millis of expiry. Absent means the credential never expires:
   * OpenRouter's issued API key stays valid until the user revokes it, and a
   * manufactured far-future expiry would silently break resolution when it
   * eventually passes.
   */
  readonly expiresAt?: number;
  readonly scope: string;
  readonly clientId: string;
  readonly tokenEndpoint: string;
  readonly generation: number;
  readonly dialect?: string;
  /**
   * ChatGPT plan dialect only: the identity token from the last exchange or
   * refresh. Retained so a reauthorization can send it as `id_token_hint`.
   */
  readonly idToken?: string;
  /** ChatGPT plan dialect only: the stable host id the registration is bound to. */
  readonly extAgentHostId?: string;
  /** ChatGPT plan dialect only: the verified `sub` of the identity token. */
  readonly subject?: string;
  /** ChatGPT plan dialect only: the verified `email` claim, when present. */
  readonly email?: string;
  /**
   * ChatGPT plan dialect only: false when the granted scopes do not include
   * the plan-usage scope. The sign-in is still valid for identity; plan
   * usage is disabled until a reauthorization grants the scope.
   */
  readonly planUsageEnabled?: boolean;
}

interface Attempt {
  status: HostOAuthPublicState;
  readonly descriptorId: string;
  listener: Server | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
}

export function codeVerifierMatchesChallenge(verifier: string, challenge: string): boolean {
  const actual = createHash("sha256").update(verifier).digest("base64url");
  const expected = Buffer.from(challenge);
  const computed = Buffer.from(actual);
  if (expected.length !== computed.length) return false;
  return timingSafeEqual(expected, computed);
}

export function isHostOAuthGrantMaterial(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && parsed.kind === GRANT_KIND;
  } catch {
    return false;
  }
}

export async function exchangeAuthorizationCode(input: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly verifier: string;
  readonly challenge: string;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly dialect?: HostOAuthDialect;
  /** ChatGPT plan dialect: the OIDC nonce bound to the identity token. */
  readonly nonce?: string;
  /** ChatGPT plan dialect: the issued client id captured from the callback. */
  readonly issuedClientId?: string;
  /** ChatGPT plan dialect: the stable host id stored on the grant. */
  readonly extAgentHostId?: string;
  /** ChatGPT plan dialect: the runtime's memoized JWKS cache. */
  readonly jwks?: { current: SiwcJwksCache | undefined };
  /** ChatGPT plan dialect: the identity issuer (JWKS + revocation). */
  readonly issuer?: string;
}): Promise<
  | { readonly kind: "tokens"; readonly grant: StoredGrant }
  | {
      readonly kind: "refused";
      readonly reason: "verifier-mismatch" | "exchange-refused" | "unavailable";
    }
  | { readonly kind: "transient" }
> {
  if (!codeVerifierMatchesChallenge(input.verifier, input.challenge)) {
    return { kind: "refused", reason: "verifier-mismatch" };
  }
  if (input.dialect === OPENROUTER_DIALECT) {
    return exchangeOpenRouterKey({
      fetch: input.fetch,
      tokenEndpoint: input.tokenEndpoint,
      code: input.code,
      verifier: input.verifier,
    });
  }
  if (input.dialect === CHATGPT_PLAN_DIALECT) {
    const issuedClientId = input.issuedClientId;
    const nonce = input.nonce;
    const extAgentHostId = input.extAgentHostId;
    if (
      issuedClientId === undefined ||
      !ISSUED_CLIENT_ID_PATTERN.test(issuedClientId) ||
      nonce === undefined ||
      extAgentHostId === undefined
    ) {
      return { kind: "refused", reason: "exchange-refused" };
    }
    const exchanged = await exchangeChatGptPlanCode({
      fetch: input.fetch,
      now: input.now,
      tokenEndpoint: input.tokenEndpoint,
      issuedClientId,
      extAgentHostId,
      nonce,
      jwks: input.jwks ?? { current: undefined },
      issuer: input.issuer ?? SIWC_ISSUER,
      code: input.code,
      redirectUri: input.redirectUri,
      verifier: input.verifier,
    });
    if (exchanged.kind === "tokens") return exchanged;
    if (exchanged.kind === "transient") return exchanged;
    if (exchanged.reason === "unavailable") return { kind: "refused", reason: "unavailable" };
    return { kind: "refused", reason: "exchange-refused" };
  }
  const exchanged = await requestTokens({
    fetch: input.fetch,
    now: input.now,
    endpoint: input.tokenEndpoint,
    form: {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
    },
    clientId: input.clientId,
    tokenEndpoint: input.tokenEndpoint,
    previousRefresh: undefined,
    generation: 0,
    codeExchange: true,
  });
  if (exchanged.kind === "tokens") return exchanged;
  if (exchanged.kind === "transient") return exchanged;
  if (exchanged.kind === "pending") return { kind: "refused", reason: "exchange-refused" };
  if (exchanged.reason === "verifier-mismatch" || exchanged.reason === "unavailable") {
    return { kind: "refused", reason: exchanged.reason };
  }
  return { kind: "refused", reason: "exchange-refused" };
}

/**
 * OpenRouter's /auth page accepts the OAuth `state` parameter and echoes it
 * back on the callback, so the dialect sends one and the callback validates
 * it like the standard PKCE path. The code exchange takes a JSON body, not a
 * form. The exchange returns a user-controlled API key; there is no refresh
 * token and no expiry, so the key is stored without an expiry (a non-expiring
 * credential) and the refresh slot repeats the key (a refresh attempt on a
 * revoked key fails and sends the user back to sign-in).
 */
function openRouterAuthorizationRequest(
  endpoint: string,
  input: { readonly redirectUri: string; readonly challenge: string; readonly state: string },
): string {
  const url = new URL(endpoint);
  url.searchParams.set("callback_url", input.redirectUri);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function exchangeOpenRouterKey(input: {
  readonly fetch: typeof fetch;
  readonly tokenEndpoint: string;
  readonly code: string;
  readonly verifier: string;
}): Promise<
  | { readonly kind: "tokens"; readonly grant: StoredGrant }
  | { readonly kind: "refused"; readonly reason: "exchange-refused" | "unavailable" }
  | { readonly kind: "transient" }
> {
  let response: Response;
  try {
    response = await input.fetch(input.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        code_verifier: input.verifier,
        code_challenge_method: "S256",
      }),
    });
  } catch {
    return { kind: "refused", reason: "unavailable" };
  }
  if (response.status === 429 || response.status >= 500) return { kind: "transient" };
  const body = await readResponseJson(response);
  const key = body === undefined ? undefined : stringField(body, "key");
  if (!response.ok || key === undefined || key.length > MAX_TOKEN_CHARS) {
    return { kind: "refused", reason: "exchange-refused" };
  }
  return {
    kind: "tokens",
    grant: {
      kind: GRANT_KIND,
      version: 1,
      accessToken: key,
      refreshToken: key,
      tokenType: "Bearer",
      // The issued key has no expiry. Store no expiry rather than a
      // manufactured far-future one: a fake date would eventually pass and
      // break resolution for a key that is still valid.
      scope: "",
      clientId: "",
      tokenEndpoint: input.tokenEndpoint,
      generation: 1,
      dialect: OPENROUTER_DIALECT,
    },
  };
}

/**
 * The ChatGPT plan (Sign in with ChatGPT) dialect. The wire shape differs
 * from the standard runner in four ways: the first authorize request sends
 * `client_id=dynamic_agent_client` plus `agent_name_hint`, `ext_agent_host_id`,
 * an OIDC `nonce`, and `resource`; the callback returns the issued
 * `client_id` alongside the code, and that issued id — never the placeholder
 * — is what the exchange and every later refresh send; the exchange and
 * refresh also send `resource`; and the identity token is validated against
 * the issuer's JWKS (signature, issuer, audience, expiry, nonce) before the
 * grant is stored.
 */
function chatGptPlanAuthorizationRequest(
  endpoint: string,
  input: {
    readonly redirectUri: string;
    readonly scope: string;
    readonly state: string;
    readonly challenge: string;
    readonly nonce: string;
    readonly extAgentHostId: string;
    readonly agentNameHint: string | undefined;
    /** The issued client id on a reauthorization; absent on first sign-in. */
    readonly issuedClientId: string | undefined;
    readonly idTokenHint: string | undefined;
  },
): string {
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  // First sign-in registers the agent under the placeholder; reauthorization
  // reuses the issued client id stored on the grant.
  url.searchParams.set("client_id", input.issuedClientId ?? SIWC_DYNAMIC_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", SIWC_RESOURCE);
  url.searchParams.set("ext_agent_host_id", input.extAgentHostId);
  // The agent name hint is registration-only; a reauthorization omits it.
  if (input.agentNameHint !== undefined)
    url.searchParams.set("agent_name_hint", input.agentNameHint);
  if (input.idTokenHint !== undefined) url.searchParams.set("id_token_hint", input.idTokenHint);
  return url.toString();
}

interface SiwcExchangeContext {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly tokenEndpoint: string;
  readonly issuedClientId: string;
  readonly extAgentHostId: string;
  readonly nonce: string;
  readonly jwks: { current: SiwcJwksCache | undefined };
  readonly issuer: string;
}

/**
 * Exchange a ChatGPT plan authorization code. The form carries the issued
 * client id (captured from the callback), the code, the PKCE verifier, the
 * same redirect URI, and the resource — never a client secret. The identity
 * token is validated before the grant is built.
 */
async function exchangeChatGptPlanCode(
  input: SiwcExchangeContext & {
    readonly code: string;
    readonly redirectUri: string;
    readonly verifier: string;
  },
): Promise<
  | { readonly kind: "tokens"; readonly grant: StoredGrant }
  | { readonly kind: "refused"; readonly reason: "exchange-refused" | "unavailable" }
  | { readonly kind: "transient" }
> {
  const exchanged = await requestTokens({
    fetch: input.fetch,
    now: input.now,
    endpoint: input.tokenEndpoint,
    form: {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.issuedClientId,
      code_verifier: input.verifier,
      resource: SIWC_RESOURCE,
    },
    clientId: input.issuedClientId,
    tokenEndpoint: input.tokenEndpoint,
    previousRefresh: undefined,
    generation: 0,
    codeExchange: true,
  });
  if (exchanged.kind === "transient") return exchanged;
  if (exchanged.kind === "pending") return { kind: "refused", reason: "exchange-refused" };
  if (exchanged.kind !== "tokens") {
    if (exchanged.reason === "unavailable") return { kind: "refused", reason: "unavailable" };
    return { kind: "refused", reason: "exchange-refused" };
  }
  const grant = exchanged.grant;
  const idToken = grant.idToken;
  if (idToken === undefined) {
    return { kind: "refused", reason: "exchange-refused" };
  }
  const identity = await validateSiwcIdToken({
    fetch: input.fetch,
    now: input.now,
    idToken,
    expectedAudience: input.issuedClientId,
    expectedNonce: input.nonce,
    jwks: input.jwks,
    issuer: input.issuer,
  });
  if (identity.kind !== "valid") return { kind: "refused", reason: "exchange-refused" };
  const scopes = parseScopeList(grant.scope);
  return {
    kind: "tokens",
    grant: {
      ...grant,
      dialect: CHATGPT_PLAN_DIALECT,
      idToken,
      extAgentHostId: input.extAgentHostId,
      subject: identity.subject,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      planUsageEnabled: scopes.includes(SIWC_PLAN_SCOPE),
    },
  };
}

/**
 * Refresh a ChatGPT plan grant. The form carries the issued client id, the
 * refresh token, and the resource; the rotating replacement refresh token is
 * stored by the caller. The identity token is revalidated when present.
 */
async function refreshChatGptPlanGrant(
  input: SiwcExchangeContext & {
    readonly refreshToken: string;
    readonly generation: number;
  },
): Promise<TokenRequestResult> {
  const exchanged = await requestTokens({
    fetch: input.fetch,
    now: input.now,
    endpoint: input.tokenEndpoint,
    form: {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.issuedClientId,
      resource: SIWC_RESOURCE,
    },
    clientId: input.issuedClientId,
    tokenEndpoint: input.tokenEndpoint,
    previousRefresh: input.refreshToken,
    generation: input.generation,
    codeExchange: false,
  });
  if (exchanged.kind !== "tokens") return exchanged;
  const grant = exchanged.grant;
  const idToken = grant.idToken;
  if (idToken === undefined) {
    // A refresh without a new identity token keeps the prior one; the
    // identity it proved is unchanged.
    return { kind: "tokens", grant };
  }
  const identity = await validateSiwcIdToken({
    fetch: input.fetch,
    now: input.now,
    idToken,
    expectedAudience: input.issuedClientId,
    expectedNonce: input.nonce,
    jwks: input.jwks,
    issuer: input.issuer,
  });
  if (identity.kind !== "valid") {
    return { kind: "refused", reason: "exchange-refused", error: "id_token_invalid" };
  }
  const scopes = parseScopeList(grant.scope);
  return {
    kind: "tokens",
    grant: {
      ...grant,
      dialect: CHATGPT_PLAN_DIALECT,
      idToken,
      extAgentHostId: input.extAgentHostId,
      subject: identity.subject,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      planUsageEnabled: scopes.includes(SIWC_PLAN_SCOPE),
    },
  };
}

function parseScopeList(scope: string): readonly string[] {
  return scope.split(/\s+/).filter((entry) => entry.length > 0);
}

type SiwcIdTokenValidation =
  | { readonly kind: "valid"; readonly subject: string; readonly email?: string }
  | { readonly kind: "invalid" };

/**
 * Validate a ChatGPT plan identity token: RS256 signature against the
 * issuer's JWKS, issuer, audience (the issued client id), expiry, and the
 * nonce issued for this attempt. Implemented on node:crypto so the host
 * runtime keeps no JWT dependency.
 */
async function validateSiwcIdToken(input: {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly idToken: string;
  readonly expectedAudience: string;
  readonly expectedNonce: string;
  readonly jwks: { current: SiwcJwksCache | undefined };
  readonly issuer: string;
}): Promise<SiwcIdTokenValidation> {
  const segments = input.idToken.split(".");
  if (segments.length !== 3) return { kind: "invalid" };
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return { kind: "invalid" };
  }
  let header: unknown;
  let payload: unknown;
  let signature: Buffer;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as unknown;
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown;
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(header) || !isRecord(payload)) return { kind: "invalid" };
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { kind: "invalid" };
  const keys = await fetchSiwcJwks(input.fetch, input.issuer, input.jwks, input.now);
  const key = keys.get(header.kid);
  if (key === undefined) return { kind: "invalid" };
  const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8");
  let signatureValid = false;
  try {
    signatureValid = cryptoVerify("RSA-SHA256", signed, key, signature);
  } catch {
    return { kind: "invalid" };
  }
  if (!signatureValid) return { kind: "invalid" };
  if (payload.iss !== input.issuer) return { kind: "invalid" };
  const audience = payload.aud;
  const audienceMatches =
    audience === input.expectedAudience ||
    (Array.isArray(audience) && audience.includes(input.expectedAudience));
  if (!audienceMatches) return { kind: "invalid" };
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return { kind: "invalid" };
  // Allow a small clock skew on expiry, matching the resolver's skew.
  if (payload.exp * 1_000 <= input.now() - 60_000) return { kind: "invalid" };
  if (payload.nonce !== input.expectedNonce) return { kind: "invalid" };
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return { kind: "invalid" };
  const email = payload.email;
  return {
    kind: "valid",
    subject: payload.sub,
    ...(typeof email === "string" && email.length > 0 ? { email } : {}),
  };
}

interface SiwcJwksCache {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly fetchedAt: number;
}

const SIWC_DISCOVERY_PATH = "/.well-known/openid-configuration";

/**
 * Revoke a ChatGPT plan refresh token at the issuer's discovery
 * `revocation_endpoint`. Best-effort: the local grant is dropped regardless,
 * but a failed revocation is reported so the caller can surface it.
 */
async function revokeSiwcRefreshToken(input: {
  readonly fetch: typeof fetch;
  readonly issuer: string;
  readonly clientId: string;
  readonly refreshToken: string;
}): Promise<boolean> {
  let discovery: Response;
  try {
    discovery = await input.fetch(`${input.issuer}${SIWC_DISCOVERY_PATH}`, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
    });
  } catch {
    return false;
  }
  if (!discovery.ok) return false;
  const document = await readResponseJson(discovery);
  const endpoint =
    document === undefined ? undefined : stringField(document, "revocation_endpoint");
  if (endpoint === undefined || !allowedEndpoint(endpoint)) return false;
  try {
    const response = await input.fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: input.refreshToken,
        token_type_hint: "refresh_token",
        client_id: input.clientId,
      }).toString(),
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/**
 * Fetch (and memoize per runtime) the issuer's JWKS. The cache lives on the
 * runtime so a refresh does not re-fetch keys the issuer already published.
 */
async function fetchSiwcJwks(
  fetchImpl: typeof fetch,
  issuer: string,
  cache: { current: SiwcJwksCache | undefined },
  now: () => number,
): Promise<ReadonlyMap<string, KeyObject>> {
  const fresh = cache.current !== undefined && now() - cache.current.fetchedAt < JWKS_CACHE_MS;
  if (fresh && cache.current !== undefined) return cache.current.keys;
  let response: Response;
  try {
    response = await fetchImpl(`${issuer}${SIWC_JWKS_PATH}`, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
    });
  } catch {
    return new Map();
  }
  if (!response.ok) return new Map();
  const body = await readResponseJson(response);
  const keys = body === undefined ? undefined : body.keys;
  if (!Array.isArray(keys)) return new Map();
  const parsed = new Map<string, KeyObject>();
  for (const entry of keys) {
    if (!isRecord(entry)) continue;
    if (entry.kty !== "RSA") continue;
    if (entry.alg !== undefined && entry.alg !== "RS256") continue;
    if (
      typeof entry.kid !== "string" ||
      typeof entry.n !== "string" ||
      typeof entry.e !== "string"
    ) {
      continue;
    }
    try {
      const key = createPublicKey({
        key: {
          kty: "RSA",
          n: entry.n,
          e: entry.e,
        },
        format: "jwk",
      });
      parsed.set(entry.kid, key);
    } catch {
      continue;
    }
  }
  cache.current = { keys: parsed, fetchedAt: now() };
  return parsed;
}

export function createHostOAuthRuntime(options: {
  readonly store: CredentialStore;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * ChatGPT plan dialect only: the identity issuer whose JWKS validates the
   * identity token and whose discovery document names the revocation
   * endpoint. Defaults to the production issuer; tests point it at a fake.
   */
  readonly siwcIssuer?: string;
}): HostOAuthRuntime {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const siwcIssuer = options.siwcIssuer ?? SIWC_ISSUER;
  const attempts = new Map<string, Attempt>();
  const inflightRefresh = new Map<string, Promise<HostOAuthRefreshResult>>();
  // The ChatGPT plan dialect memoizes the issuer's JWKS here so a refresh
  // does not re-fetch keys the issuer already published.
  const siwcJwks: { current: SiwcJwksCache | undefined } = { current: undefined };
  let closed = false;

  const publish = (attemptId: string, status: HostOAuthPublicState) => {
    const attempt = attempts.get(attemptId);
    if (attempt === undefined) return;
    attempt.status = status;
  };

  const finishListener = (attempt: Attempt) => {
    if (attempt.timer !== undefined) clearTimeout(attempt.timer);
    attempt.timer = undefined;
    const listener = attempt.listener;
    attempt.listener = undefined;
    if (listener !== undefined) {
      listener.close();
      listener.closeAllConnections();
    }
  };

  const begin = async (input: {
    readonly descriptor: HostOAuthDescriptor;
    readonly actorId: string;
    readonly termsAcknowledgedAt: string;
  }): Promise<HostOAuthBeginResult> => {
    if (closed) return { kind: "refused", reason: "unavailable" };
    if (!UUID_PATTERN.test(input.actorId) || input.termsAcknowledgedAt.trim().length === 0) {
      return { kind: "refused", reason: "terms-required" };
    }
    const descriptor = validateDescriptor(input.descriptor);
    if (descriptor === undefined) return { kind: "refused", reason: "invalid" };
    if (descriptor.flow === "device-code") return beginDevice(descriptor);
    return beginPkce(descriptor);
  };

  const beginPkce = async (descriptor: HostOAuthDescriptor): Promise<HostOAuthBeginResult> => {
    const authorizationEndpoint = descriptor.authorizationEndpoint;
    if (authorizationEndpoint === undefined) return { kind: "refused", reason: "invalid" };
    const attemptId = randomUUID();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    // The ChatGPT plan dialect binds the identity token to this attempt with
    // an OIDC nonce; the standard and OpenRouter paths send none.
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = now() + timeoutMs;
    const attempt: Attempt = {
      descriptorId: descriptor.descriptorId,
      closed: false,
      listener: undefined,
      timer: undefined,
      status: {
        kind: "awaiting-consent",
        attemptId,
        descriptorId: descriptor.descriptorId,
        flow: "authorization-code-pkce",
        authorizationUrl: "http://127.0.0.1/",
        expiresAt: new Date(expiresAt).toISOString(),
      },
    };
    attempts.set(attemptId, attempt);
    let redirectUri = "";
    try {
      const listener = createServer((request, response) => {
        void handleCallback(request, response, {
          attempt,
          attemptId,
          descriptor,
          state,
          verifier,
          challenge,
          nonce,
          redirectUri,
        });
      });
      await listen(listener);
      const address = listener.address() as AddressInfo | null;
      if (address === null) {
        listener.close();
        publish(attemptId, refused(attemptId, descriptor.descriptorId, "unavailable"));
        return { kind: "refused", reason: "unavailable" };
      }
      redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      let authorizationUrl: string;
      if (descriptor.dialect === OPENROUTER_DIALECT) {
        authorizationUrl = openRouterAuthorizationRequest(authorizationEndpoint, {
          redirectUri,
          challenge,
          state,
        });
      } else if (descriptor.dialect === CHATGPT_PLAN_DIALECT) {
        // A reauthorization reuses the issued client id and the retained
        // identity token from the stored grant; a first sign-in registers
        // under the placeholder with the agent name hint.
        const existing = await findChatGptPlanGrant(descriptor);
        authorizationUrl = chatGptPlanAuthorizationRequest(authorizationEndpoint, {
          redirectUri,
          scope: descriptor.scopes.join(" "),
          state,
          challenge,
          nonce,
          extAgentHostId: descriptor.extAgentHostId ?? "",
          agentNameHint: existing === undefined ? descriptor.agentNameHint : undefined,
          issuedClientId: existing?.clientId,
          idTokenHint: existing?.idToken,
        });
      } else {
        authorizationUrl = authorizationRequest(authorizationEndpoint, {
          clientId: descriptor.clientId ?? "",
          redirectUri,
          scope: descriptor.scopes.join(" "),
          state,
          challenge,
        });
      }
      const awaiting: HostOAuthBeginResult = {
        kind: "awaiting-consent",
        attemptId,
        descriptorId: descriptor.descriptorId,
        flow: "authorization-code-pkce",
        authorizationUrl,
        expiresAt: new Date(expiresAt).toISOString(),
      };
      attempt.listener = listener;
      attempt.status = awaiting;
      attempt.timer = setTimeout(() => {
        if (attempt.closed || attempt.status.kind !== "awaiting-consent") return;
        attempt.closed = true;
        publish(attemptId, refused(attemptId, descriptor.descriptorId, "timeout"));
        finishListener(attempt);
      }, timeoutMs);
      return awaiting;
    } catch {
      publish(attemptId, refused(attemptId, descriptor.descriptorId, "unavailable"));
      return { kind: "refused", reason: "unavailable" };
    }
  };

  /**
   * Find the stored ChatGPT plan grant for a descriptor, so a reauthorization
   * can reuse the issued client id and the retained identity token. The
   * credential store is keyed by opaque refs, so the grant is located by
   * scanning stored grant material for this descriptor's dialect and host id.
   */
  const findChatGptPlanGrant = async (
    descriptor: HostOAuthDescriptor,
  ): Promise<StoredGrant | undefined> => {
    const list = await options.store.list?.();
    if (list === undefined) return undefined;
    for (const ref of list) {
      try {
        const grant = decodeGrant(await options.store.resolve(ref));
        if (
          grant.dialect === CHATGPT_PLAN_DIALECT &&
          grant.extAgentHostId === descriptor.extAgentHostId &&
          ISSUED_CLIENT_ID_PATTERN.test(grant.clientId)
        ) {
          return grant;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  };

  const handleCallback = async (
    request: IncomingMessage,
    response: ServerResponse,
    session: {
      readonly attempt: Attempt;
      readonly attemptId: string;
      readonly descriptor: HostOAuthDescriptor;
      readonly state: string;
      readonly verifier: string;
      readonly challenge: string;
      readonly nonce: string;
      readonly redirectUri: string;
    },
  ) => {
    const remote = request.socket.remoteAddress ?? "";
    if (!isLoopback(remote)) {
      response.writeHead(403, { "cache-control": "no-store" });
      response.end("forbidden");
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (session.attempt.closed) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    session.attempt.closed = true;
    const query = url.search.length > 4_096 ? "" : url.search;
    const params = new URLSearchParams(query);
    // Every flow — the standard PKCE path and the dialects — sends a CSRF
    // `state` and must see it echoed back before the code is exchanged.
    const presented = params.get("state") ?? "";
    if (!statesEqual(session.state, presented)) {
      publish(
        session.attemptId,
        refused(session.attemptId, session.descriptor.descriptorId, "state-mismatch"),
      );
      replyCallback(response, 400);
      finishListener(session.attempt);
      return;
    }
    const error = params.get("error");
    if (error !== null) {
      const reason = error === "access_denied" ? "denied" : "exchange-refused";
      publish(
        session.attemptId,
        refused(session.attemptId, session.descriptor.descriptorId, reason),
      );
      replyCallback(response, 400);
      finishListener(session.attempt);
      return;
    }
    const code = params.get("code") ?? "";
    if (!CODE_PATTERN.test(code)) {
      publish(
        session.attemptId,
        refused(session.attemptId, session.descriptor.descriptorId, "exchange-refused"),
      );
      replyCallback(response, 400);
      finishListener(session.attempt);
      return;
    }
    // The ChatGPT plan callback returns the issued client id alongside the
    // code. The exchange and every later refresh must use the issued id —
    // never the dynamic_agent_client placeholder. A reauthorization that
    // returns a different client id than the stored grant is refused.
    let issuedClientId: string | undefined;
    if (session.descriptor.dialect === CHATGPT_PLAN_DIALECT) {
      const returned = params.get("client_id") ?? "";
      if (!ISSUED_CLIENT_ID_PATTERN.test(returned)) {
        publish(
          session.attemptId,
          refused(session.attemptId, session.descriptor.descriptorId, "exchange-refused"),
        );
        replyCallback(response, 400);
        finishListener(session.attempt);
        return;
      }
      issuedClientId = returned;
    }
    const exchanged = await exchangeAuthorizationCode({
      tokenEndpoint: session.descriptor.tokenEndpoint,
      clientId: issuedClientId ?? session.descriptor.clientId ?? "",
      code,
      redirectUri: session.redirectUri,
      verifier: session.verifier,
      challenge: session.challenge,
      fetch: fetchImpl,
      now,
      ...(session.descriptor.dialect === undefined ? {} : { dialect: session.descriptor.dialect }),
      ...(session.nonce === "" ? {} : { nonce: session.nonce }),
      ...(issuedClientId === undefined ? {} : { issuedClientId }),
      ...(session.descriptor.extAgentHostId === undefined
        ? {}
        : { extAgentHostId: session.descriptor.extAgentHostId }),
      jwks: siwcJwks,
      issuer: siwcIssuer,
    });
    if (exchanged.kind === "tokens") {
      const credentialRef = randomUUID();
      try {
        await options.store.set(credentialRef, JSON.stringify(exchanged.grant));
        publish(session.attemptId, {
          kind: "signed-in",
          attemptId: session.attemptId,
          descriptorId: session.descriptor.descriptorId,
          credentialRef,
        });
        replyCallback(response, 200);
      } catch {
        publish(
          session.attemptId,
          refused(session.attemptId, session.descriptor.descriptorId, "unavailable"),
        );
        replyCallback(response, 503);
      }
    } else if (exchanged.kind === "transient") {
      publish(
        session.attemptId,
        refused(session.attemptId, session.descriptor.descriptorId, "unavailable"),
      );
      replyCallback(response, 503);
    } else {
      publish(
        session.attemptId,
        refused(session.attemptId, session.descriptor.descriptorId, exchanged.reason),
      );
      replyCallback(response, 400);
    }
    finishListener(session.attempt);
  };

  const beginDevice = async (descriptor: HostOAuthDescriptor): Promise<HostOAuthBeginResult> => {
    const deviceEndpoint = descriptor.deviceAuthorizationEndpoint;
    if (deviceEndpoint === undefined) return { kind: "refused", reason: "invalid" };
    const issued = await postForm(fetchImpl, deviceEndpoint, {
      client_id: descriptor.clientId ?? "",
      scope: descriptor.scopes.join(" "),
    });
    if (issued.kind !== "json") return { kind: "refused", reason: "unavailable" };
    const deviceCode = stringField(issued.value, "device_code");
    const userCode = stringField(issued.value, "user_code");
    const verificationUri = stringField(issued.value, "verification_uri");
    const expiresIn = numberField(issued.value, "expires_in") ?? 300;
    const interval = numberField(issued.value, "interval") ?? DEFAULT_DEVICE_INTERVAL_MS / 1_000;
    if (
      deviceCode === undefined ||
      userCode === undefined ||
      !USER_CODE_PATTERN.test(userCode) ||
      verificationUri === undefined ||
      !allowedEndpoint(verificationUri)
    ) {
      return { kind: "refused", reason: "exchange-refused" };
    }
    const attemptId = randomUUID();
    const expiresAt = now() + expiresIn * 1_000;
    const awaiting: Extract<HostOAuthPublicState, { readonly kind: "awaiting-consent" }> = {
      kind: "awaiting-consent",
      attemptId,
      descriptorId: descriptor.descriptorId,
      flow: "device-code",
      verificationUri,
      userCode,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const attempt: Attempt = {
      descriptorId: descriptor.descriptorId,
      closed: false,
      listener: undefined,
      timer: undefined,
      status: awaiting,
    };
    attempts.set(attemptId, attempt);
    void pollDevice({
      attempt,
      attemptId,
      descriptor,
      deviceCode,
      expiresAt,
      intervalMs: Math.max(1, interval) * 1_000,
    });
    return awaiting;
  };

  const pollDevice = async (session: {
    readonly attempt: Attempt;
    readonly attemptId: string;
    readonly descriptor: HostOAuthDescriptor;
    readonly deviceCode: string;
    readonly expiresAt: number;
    intervalMs: number;
  }) => {
    while (!closed && !session.attempt.closed) {
      if (now() >= session.expiresAt) {
        session.attempt.closed = true;
        publish(
          session.attemptId,
          refused(session.attemptId, session.descriptor.descriptorId, "timeout"),
        );
        return;
      }
      await sleep(session.intervalMs);
      if (closed || session.attempt.closed || now() >= session.expiresAt) {
        if (!session.attempt.closed && now() >= session.expiresAt) {
          session.attempt.closed = true;
          publish(
            session.attemptId,
            refused(session.attemptId, session.descriptor.descriptorId, "timeout"),
          );
        }
        return;
      }
      const polled = await requestTokens({
        fetch: fetchImpl,
        now,
        endpoint: session.descriptor.tokenEndpoint,
        form: {
          grant_type: DEVICE_GRANT,
          device_code: session.deviceCode,
          client_id: session.descriptor.clientId ?? "",
        },
        clientId: session.descriptor.clientId ?? "",
        tokenEndpoint: session.descriptor.tokenEndpoint,
        previousRefresh: undefined,
        generation: 0,
        codeExchange: true,
      });
      if (polled.kind === "pending") {
        if (polled.slowDown) session.intervalMs += SLOW_DOWN_MS;
        continue;
      }
      session.attempt.closed = true;
      if (polled.kind === "tokens") {
        const credentialRef = randomUUID();
        try {
          await options.store.set(credentialRef, JSON.stringify(polled.grant));
          publish(session.attemptId, {
            kind: "signed-in",
            attemptId: session.attemptId,
            descriptorId: session.descriptor.descriptorId,
            credentialRef,
          });
        } catch {
          publish(
            session.attemptId,
            refused(session.attemptId, session.descriptor.descriptorId, "unavailable"),
          );
        }
        return;
      }
      const reason =
        polled.kind === "refused"
          ? polled.reason === "verifier-mismatch"
            ? "timeout"
            : polled.reason
          : "unavailable";
      publish(
        session.attemptId,
        refused(session.attemptId, session.descriptor.descriptorId, reason),
      );
      return;
    }
  };

  const refreshOnce = async (credentialRef: string): Promise<HostOAuthRefreshResult> => {
    if (!UUID_PATTERN.test(credentialRef)) return { kind: "unavailable" };
    let current: StoredGrant;
    try {
      current = decodeGrant(await options.store.resolve(credentialRef));
    } catch (error) {
      if (error instanceof CredentialStoreFailure && error.category === "missing") {
        return { kind: "sign-in-again", reason: "expired" };
      }
      return { kind: "unavailable" };
    }
    const generation = current.generation;
    // A dialect grant whose credential never rotates (an OpenRouter key)
    // needs no token exchange: while the grant is stored, it is valid.
    if (current.dialect === OPENROUTER_DIALECT) return { kind: "refreshed" };
    // The ChatGPT plan dialect refreshes with the issued client id and the
    // resource, revalidates the identity token, and stores the rotating
    // replacement refresh token. The nonce is fresh per refresh: the identity
    // token is bound to this attempt, not to the original sign-in.
    if (current.dialect === CHATGPT_PLAN_DIALECT) {
      const exchanged = await refreshChatGptPlanGrant({
        fetch: fetchImpl,
        now,
        tokenEndpoint: current.tokenEndpoint,
        issuedClientId: current.clientId,
        extAgentHostId: current.extAgentHostId ?? "",
        nonce: randomBytes(24).toString("base64url"),
        jwks: siwcJwks,
        issuer: siwcIssuer,
        refreshToken: current.refreshToken,
        generation,
      });
      if (exchanged.kind === "transient") return { kind: "transient" };
      if (exchanged.kind === "pending") return { kind: "transient" };
      if (exchanged.kind === "refused") {
        const reason = refreshRefusal(exchanged.reason, exchanged.error);
        try {
          await options.store.delete(credentialRef);
        } catch {
          return { kind: "unavailable" };
        }
        return { kind: "sign-in-again", reason };
      }
      try {
        const latest = decodeGrant(await options.store.resolve(credentialRef));
        if (latest.generation !== generation) return { kind: "refreshed" };
        await options.store.set(credentialRef, JSON.stringify(exchanged.grant));
        return { kind: "refreshed" };
      } catch {
        return { kind: "unavailable" };
      }
    }
    const exchanged = await requestTokens({
      fetch: fetchImpl,
      now,
      endpoint: current.tokenEndpoint,
      form: {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: current.clientId,
      },
      clientId: current.clientId,
      tokenEndpoint: current.tokenEndpoint,
      previousRefresh: current.refreshToken,
      generation,
      codeExchange: false,
    });
    if (exchanged.kind === "transient") return { kind: "transient" };
    if (exchanged.kind === "pending") return { kind: "transient" };
    if (exchanged.kind === "refused") {
      const reason = refreshRefusal(exchanged.reason, exchanged.error);
      try {
        await options.store.delete(credentialRef);
      } catch {
        return { kind: "unavailable" };
      }
      return { kind: "sign-in-again", reason };
    }
    try {
      const latest = decodeGrant(await options.store.resolve(credentialRef));
      if (latest.generation !== generation) return { kind: "refreshed" };
      await options.store.set(credentialRef, JSON.stringify(exchanged.grant));
      return { kind: "refreshed" };
    } catch {
      return { kind: "unavailable" };
    }
  };

  return Object.freeze({
    begin,
    status: (attemptId: string): HostOAuthPublicState => {
      const attempt = attempts.get(attemptId);
      return attempt === undefined ? { kind: "unknown" } : attempt.status;
    },
    refresh: (credentialRef: string): Promise<HostOAuthRefreshResult> => {
      const existing = inflightRefresh.get(credentialRef);
      if (existing !== undefined) return existing;
      const run = refreshOnce(credentialRef).finally(() => {
        inflightRefresh.delete(credentialRef);
      });
      inflightRefresh.set(credentialRef, run);
      return run;
    },
    access: async (credentialRef: string): Promise<HostOAuthAccessResult> => {
      if (!UUID_PATTERN.test(credentialRef)) return { kind: "unavailable" };
      try {
        const grant = decodeGrant(await options.store.resolve(credentialRef));
        return {
          kind: "granted",
          accessToken: grant.accessToken,
          tokenType: grant.tokenType,
          ...(grant.expiresAt === undefined
            ? {}
            : { expiresAt: new Date(grant.expiresAt).toISOString() }),
          ...(grant.planUsageEnabled === undefined
            ? {}
            : { planUsageEnabled: grant.planUsageEnabled }),
        };
      } catch (error) {
        if (error instanceof CredentialStoreFailure && error.category === "missing") {
          return { kind: "sign-in-again", reason: "expired" };
        }
        return { kind: "unavailable" };
      }
    },
    revoke: async (credentialRef: string): Promise<HostOAuthRevokeResult> => {
      if (!UUID_PATTERN.test(credentialRef)) return { kind: "unavailable" };
      let grant: StoredGrant;
      try {
        grant = decodeGrant(await options.store.resolve(credentialRef));
      } catch (error) {
        if (error instanceof CredentialStoreFailure && error.category === "missing") {
          return { kind: "revoked" };
        }
        return { kind: "unavailable" };
      }
      // Only the ChatGPT plan dialect has a revocation endpoint: the refresh
      // token is revoked at the issuer's discovery revocation_endpoint before
      // the local grant is dropped. Other dialects have nothing to revoke.
      if (grant.dialect === CHATGPT_PLAN_DIALECT) {
        const revoked = await revokeSiwcRefreshToken({
          fetch: fetchImpl,
          issuer: siwcIssuer,
          clientId: grant.clientId,
          refreshToken: grant.refreshToken,
        });
        if (!revoked) return { kind: "unavailable" };
      }
      try {
        await options.store.delete(credentialRef);
      } catch {
        return { kind: "unavailable" };
      }
      return { kind: "revoked" };
    },
    close: async () => {
      closed = true;
      for (const attempt of attempts.values()) {
        attempt.closed = true;
        finishListener(attempt);
      }
    },
  });
}

export async function handleHostOAuthBrokerRoute(
  pathname: string,
  request: Request,
  runtime: HostOAuthRuntime,
): Promise<Response> {
  const decoded = await readObject(request);
  if (decoded.kind === "too-large") return Response.json({ error: "too-large" }, { status: 413 });
  if (decoded.kind === "invalid")
    return Response.json({ error: "invalid-request" }, { status: 400 });
  if (pathname === "/v1/oauth/begin") return beginRoute(decoded.value, runtime);
  if (pathname === "/v1/oauth/status") return statusRoute(decoded.value, runtime);
  if (pathname === "/v1/oauth/refresh") return refreshRoute(decoded.value, runtime);
  if (pathname === "/v1/oauth/access") return accessRoute(decoded.value, runtime);
  if (pathname === "/v1/oauth/revoke") return revokeRoute(decoded.value, runtime);
  return Response.json({ error: "not-found" }, { status: 404 });
}

async function beginRoute(
  value: Record<string, unknown>,
  runtime: HostOAuthRuntime,
): Promise<Response> {
  const descriptor = value.descriptor;
  const actorId = value.actorId;
  const termsAcknowledgedAt = value.termsAcknowledgedAt;
  if (
    !isRecord(descriptor) ||
    typeof actorId !== "string" ||
    typeof termsAcknowledgedAt !== "string"
  ) {
    return Response.json({ error: "invalid-request" }, { status: 400 });
  }
  const parsed = descriptorFromRecord(descriptor);
  if (parsed === undefined) return Response.json({ error: "invalid-request" }, { status: 400 });
  const started = await runtime.begin({ descriptor: parsed, actorId, termsAcknowledgedAt });
  return Response.json(publicBegin(started), { headers: { "cache-control": "no-store" } });
}

function statusRoute(value: Record<string, unknown>, runtime: HostOAuthRuntime): Response {
  const attemptId = value.attemptId;
  if (typeof attemptId !== "string" || !UUID_PATTERN.test(attemptId)) {
    return Response.json({ error: "invalid-request" }, { status: 400 });
  }
  return Response.json(publicStatus(runtime.status(attemptId)), {
    headers: { "cache-control": "no-store" },
  });
}

async function refreshRoute(
  value: Record<string, unknown>,
  runtime: HostOAuthRuntime,
): Promise<Response> {
  const credentialRef = value.credentialRef;
  if (typeof credentialRef !== "string" || !UUID_PATTERN.test(credentialRef)) {
    return Response.json({ error: "invalid-request" }, { status: 400 });
  }
  return Response.json(await runtime.refresh(credentialRef), {
    headers: { "cache-control": "no-store" },
  });
}

async function accessRoute(
  value: Record<string, unknown>,
  runtime: HostOAuthRuntime,
): Promise<Response> {
  const credentialRef = value.credentialRef;
  if (typeof credentialRef !== "string" || !UUID_PATTERN.test(credentialRef)) {
    return Response.json({ error: "invalid-request" }, { status: 400 });
  }
  const granted = await runtime.access(credentialRef);
  if (granted.kind !== "granted") {
    return Response.json(granted, { headers: { "cache-control": "no-store" } });
  }
  return Response.json(
    {
      kind: "granted",
      accessToken: granted.accessToken,
      tokenType: granted.tokenType,
      ...(granted.expiresAt === undefined ? {} : { expiresAt: granted.expiresAt }),
      ...(granted.planUsageEnabled === undefined
        ? {}
        : { planUsageEnabled: granted.planUsageEnabled }),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function revokeRoute(
  value: Record<string, unknown>,
  runtime: HostOAuthRuntime,
): Promise<Response> {
  const credentialRef = value.credentialRef;
  if (typeof credentialRef !== "string" || !UUID_PATTERN.test(credentialRef)) {
    return Response.json({ error: "invalid-request" }, { status: 400 });
  }
  return Response.json(await runtime.revoke(credentialRef), {
    headers: { "cache-control": "no-store" },
  });
}

function publicBegin(started: HostOAuthBeginResult): HostOAuthBeginResult {
  if (started.kind === "refused") return { kind: "refused", reason: started.reason };
  return publicStatus(started) as HostOAuthBeginResult;
}

function publicStatus(status: HostOAuthPublicState): HostOAuthPublicState {
  if (status.kind === "unknown") return { kind: "unknown" };
  if (status.kind === "refused") {
    return {
      kind: "refused",
      attemptId: status.attemptId,
      descriptorId: status.descriptorId,
      reason: status.reason,
    };
  }
  if (status.kind === "signed-in") {
    return {
      kind: "signed-in",
      attemptId: status.attemptId,
      descriptorId: status.descriptorId,
      credentialRef: status.credentialRef,
    };
  }
  if (status.flow === "device-code") {
    return {
      kind: "awaiting-consent",
      attemptId: status.attemptId,
      descriptorId: status.descriptorId,
      flow: "device-code",
      verificationUri: status.verificationUri,
      userCode: status.userCode,
      expiresAt: status.expiresAt,
    };
  }
  return {
    kind: "awaiting-consent",
    attemptId: status.attemptId,
    descriptorId: status.descriptorId,
    flow: "authorization-code-pkce",
    authorizationUrl: status.authorizationUrl,
    expiresAt: status.expiresAt,
  };
}

type TokenRequestResult =
  | { readonly kind: "tokens"; readonly grant: StoredGrant }
  | {
      readonly kind: "refused";
      readonly reason:
        | "verifier-mismatch"
        | "exchange-refused"
        | "unavailable"
        | "denied"
        | "timeout";
      readonly error?: string;
    }
  | { readonly kind: "transient" }
  | { readonly kind: "pending"; readonly slowDown: boolean };

async function requestTokens(input: {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly endpoint: string;
  readonly form: Readonly<Record<string, string>>;
  readonly clientId: string;
  readonly tokenEndpoint: string;
  readonly previousRefresh: string | undefined;
  readonly generation: number;
  readonly codeExchange: boolean;
}): Promise<TokenRequestResult> {
  let response: Response;
  try {
    response = await input.fetch(input.endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(input.form).toString(),
    });
  } catch {
    return input.codeExchange ? { kind: "refused", reason: "unavailable" } : { kind: "transient" };
  }
  if (response.status === 429 || response.status >= 500) return { kind: "transient" };
  const body = await readResponseJson(response);
  if (body === undefined) {
    return input.codeExchange
      ? { kind: "refused", reason: "exchange-refused" }
      : { kind: "transient" };
  }
  const error = stringField(body, "error");
  if (error !== undefined) return mapTokenError(error, input.codeExchange);
  if (!response.ok) {
    return input.codeExchange
      ? { kind: "refused", reason: "exchange-refused" }
      : { kind: "transient" };
  }
  const accessToken = stringField(body, "access_token");
  const refreshToken = stringField(body, "refresh_token") ?? input.previousRefresh;
  const tokenType = stringField(body, "token_type") ?? "Bearer";
  const expiresIn = numberField(body, "expires_in") ?? 3_600;
  const idToken = stringField(body, "id_token");
  if (
    accessToken === undefined ||
    refreshToken === undefined ||
    accessToken.length > MAX_TOKEN_CHARS ||
    refreshToken.length > MAX_TOKEN_CHARS ||
    (idToken !== undefined && idToken.length > MAX_TOKEN_CHARS)
  ) {
    return { kind: "refused", reason: "exchange-refused" };
  }
  return {
    kind: "tokens",
    grant: {
      kind: GRANT_KIND,
      version: 1,
      accessToken,
      refreshToken,
      tokenType: tokenType.slice(0, 32),
      expiresAt: input.now() + expiresIn * 1_000,
      scope: (stringField(body, "scope") ?? "").slice(0, 512),
      clientId: input.clientId,
      tokenEndpoint: input.tokenEndpoint,
      generation: input.generation + 1,
      ...(idToken === undefined ? {} : { idToken }),
    },
  };
}

function mapTokenError(error: string, codeExchange: boolean): TokenRequestResult {
  if (!ERROR_PATTERN.test(error)) {
    return codeExchange ? { kind: "refused", reason: "exchange-refused" } : { kind: "transient" };
  }
  if (error === "authorization_pending") return { kind: "pending", slowDown: false };
  if (error === "slow_down") return { kind: "pending", slowDown: true };
  if (error === "access_denied") return { kind: "refused", reason: "denied", error };
  if (error === "expired_token") return { kind: "refused", reason: "timeout", error };
  if (error === "refresh_token_reused")
    return { kind: "refused", reason: "exchange-refused", error };
  // The ChatGPT plan issuer reports a dead refresh token with its own error
  // codes; every one of them means the grant is gone and the person must
  // sign in again.
  if (
    error === "invalid_grant" ||
    error === "invalid_refresh_token" ||
    error === "token_expired" ||
    error === "refresh_token_expired" ||
    error === "refresh_token_invalidated"
  ) {
    return {
      kind: "refused",
      reason: codeExchange ? "verifier-mismatch" : "exchange-refused",
      error,
    };
  }
  if (codeExchange) return { kind: "refused", reason: "exchange-refused", error };
  return { kind: "transient" };
}

function refreshRefusal(
  reason: "verifier-mismatch" | "exchange-refused" | "unavailable" | "denied" | "timeout",
  error: string | undefined,
): HostOAuthSignInAgainReason {
  if (error === "refresh_token_reused") return "refresh-reused";
  if (error === "expired_token" || error === "token_expired" || reason === "timeout") {
    return "expired";
  }
  // invalid_grant, invalid_refresh_token, refresh_token_expired, and
  // refresh_token_invalidated all mean the grant is gone.
  return "revoked";
}

function decodeGrant(raw: string): StoredGrant {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.kind !== GRANT_KIND || parsed.version !== 1) {
    throw new CredentialStoreFailure("invalid");
  }
  const accessToken = parsed.accessToken;
  const refreshToken = parsed.refreshToken;
  const tokenType = parsed.tokenType;
  const expiresAt = parsed.expiresAt;
  const scope = parsed.scope;
  const clientId = parsed.clientId;
  const tokenEndpoint = parsed.tokenEndpoint;
  const generation = parsed.generation;
  const dialect = parsed.dialect;
  const idToken = parsed.idToken;
  const extAgentHostId = parsed.extAgentHostId;
  const subject = parsed.subject;
  const email = parsed.email;
  const planUsageEnabled = parsed.planUsageEnabled;
  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    typeof tokenType !== "string" ||
    (expiresAt !== undefined && typeof expiresAt !== "number") ||
    typeof scope !== "string" ||
    typeof clientId !== "string" ||
    typeof tokenEndpoint !== "string" ||
    typeof generation !== "number" ||
    (dialect !== undefined && typeof dialect !== "string") ||
    (idToken !== undefined && typeof idToken !== "string") ||
    (extAgentHostId !== undefined && typeof extAgentHostId !== "string") ||
    (subject !== undefined && typeof subject !== "string") ||
    (email !== undefined && typeof email !== "string") ||
    (planUsageEnabled !== undefined && typeof planUsageEnabled !== "boolean")
  ) {
    throw new CredentialStoreFailure("invalid");
  }
  return {
    kind: GRANT_KIND,
    version: 1,
    accessToken,
    refreshToken,
    tokenType,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    scope,
    clientId,
    tokenEndpoint,
    generation,
    ...(dialect === undefined ? {} : { dialect }),
    ...(idToken === undefined ? {} : { idToken }),
    ...(extAgentHostId === undefined ? {} : { extAgentHostId }),
    ...(subject === undefined ? {} : { subject }),
    ...(email === undefined ? {} : { email }),
    ...(planUsageEnabled === undefined ? {} : { planUsageEnabled }),
  };
}

function validateDescriptor(descriptor: HostOAuthDescriptor): HostOAuthDescriptor | undefined {
  if (!safeId(descriptor.descriptorId) || !safeId(descriptor.termsId)) return undefined;
  const dialect = descriptor.dialect;
  if (dialect !== undefined && dialect !== OPENROUTER_DIALECT && dialect !== CHATGPT_PLAN_DIALECT) {
    return undefined;
  }
  // A dialect entry declares its own wire shape (OpenRouter: no client
  // registration, no scopes; ChatGPT plan: no client registration, but a
  // stable host id and an agent name hint). Every other flow needs a client
  // identity and at least one scope.
  if (dialect === undefined) {
    if (typeof descriptor.clientId !== "string" || !safeClientId(descriptor.clientId)) {
      return undefined;
    }
    if (descriptor.scopes.length === 0) return undefined;
  }
  if (dialect === CHATGPT_PLAN_DIALECT) {
    // The ChatGPT plan flow registers its client during the first sign-in,
    // so the descriptor declares no client id; it must declare the stable
    // host id and the agent name hint the registration sends, and at least
    // one scope.
    if (descriptor.clientId !== undefined) return undefined;
    if (
      descriptor.extAgentHostId === undefined ||
      !EXT_AGENT_HOST_ID_PATTERN.test(descriptor.extAgentHostId)
    ) {
      return undefined;
    }
    if (
      descriptor.agentNameHint === undefined ||
      !AGENT_NAME_HINT_PATTERN.test(descriptor.agentNameHint)
    ) {
      return undefined;
    }
    if (descriptor.scopes.length === 0) return undefined;
  }
  if (descriptor.flow !== "authorization-code-pkce" && descriptor.flow !== "device-code")
    return undefined;
  // A dialect exists precisely because its wire shape is not OAuth; a
  // device-code grant cannot pair with one.
  if (dialect !== undefined && descriptor.flow !== "authorization-code-pkce") return undefined;
  if (!allowedEndpoint(descriptor.tokenEndpoint)) return undefined;
  if (descriptor.scopes.length > 16) return undefined;
  if (!descriptor.scopes.every((scope) => /^[A-Za-z0-9._:-]{1,128}$/.test(scope))) return undefined;
  if (descriptor.flow === "authorization-code-pkce") {
    if (
      descriptor.authorizationEndpoint === undefined ||
      !allowedEndpoint(descriptor.authorizationEndpoint)
    ) {
      return undefined;
    }
  }
  if (descriptor.flow === "device-code") {
    if (
      descriptor.deviceAuthorizationEndpoint === undefined ||
      !allowedEndpoint(descriptor.deviceAuthorizationEndpoint)
    ) {
      return undefined;
    }
  }
  return descriptor;
}

function descriptorFromRecord(value: Record<string, unknown>): HostOAuthDescriptor | undefined {
  const flow = value.flow;
  const descriptorId = value.descriptorId;
  const clientId = value.clientId;
  const tokenEndpoint = value.tokenEndpoint;
  const termsId = value.termsId;
  const scopes = value.scopes;
  if (
    (flow !== "authorization-code-pkce" && flow !== "device-code") ||
    typeof descriptorId !== "string" ||
    (clientId !== undefined && typeof clientId !== "string") ||
    typeof tokenEndpoint !== "string" ||
    typeof termsId !== "string" ||
    !Array.isArray(scopes) ||
    !scopes.every((scope): scope is string => typeof scope === "string")
  ) {
    return undefined;
  }
  const authorizationEndpoint = value.authorizationEndpoint;
  const deviceAuthorizationEndpoint = value.deviceAuthorizationEndpoint;
  const dialect = value.dialect;
  if (dialect !== undefined && dialect !== OPENROUTER_DIALECT && dialect !== CHATGPT_PLAN_DIALECT) {
    return undefined;
  }
  const extAgentHostId = value.extAgentHostId;
  const agentNameHint = value.agentNameHint;
  if (
    (extAgentHostId !== undefined && typeof extAgentHostId !== "string") ||
    (agentNameHint !== undefined && typeof agentNameHint !== "string")
  ) {
    return undefined;
  }
  return validateDescriptor({
    descriptorId,
    ...(typeof clientId === "string" ? { clientId } : {}),
    ...(dialect === undefined ? {} : { dialect }),
    flow,
    tokenEndpoint,
    termsId,
    scopes,
    ...(typeof authorizationEndpoint === "string" ? { authorizationEndpoint } : {}),
    ...(typeof deviceAuthorizationEndpoint === "string" ? { deviceAuthorizationEndpoint } : {}),
    ...(typeof extAgentHostId === "string" ? { extAgentHostId } : {}),
    ...(typeof agentNameHint === "string" ? { agentNameHint } : {}),
  });
}

function authorizationRequest(
  endpoint: string,
  input: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly scope: string;
    readonly state: string;
    readonly challenge: string;
  },
): string {
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function allowedEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function safeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function safeClientId(value: string): boolean {
  return /^[^\s/?#]{1,256}$/.test(value);
}

function statesEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function refused(
  attemptId: string,
  descriptorId: string,
  reason: HostOAuthRefusalReason,
): Extract<HostOAuthPublicState, { readonly kind: "refused" }> {
  return { kind: "refused", attemptId, descriptorId, reason };
}

function replyCallback(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end("<!doctype html><p>You can close this window.</p>");
}

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function postForm(
  fetchImpl: typeof fetch,
  endpoint: string,
  fields: Readonly<Record<string, string>>,
): Promise<
  { readonly kind: "json"; readonly value: Record<string, unknown> } | { readonly kind: "failed" }
> {
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    if (!response.ok) return { kind: "failed" };
    const value = await readResponseJson(response);
    return value === undefined ? { kind: "failed" } : { kind: "json", value };
  } catch {
    return { kind: "failed" };
  }
}

async function readResponseJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_CHARS)
    return undefined;
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readObject(
  request: Request,
): Promise<
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" }
> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_CHARS) return { kind: "too-large" };
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(value) ? { kind: "ok", value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
const MCP_DIALECT = "mcp-authorization";
const DIRECTORY_DIALECT = "directory-oidc";
// The one directory authority the directory dialect signs in against. The
// broker builds every authority URL from this host and the tenant GUID, so no
// descriptor, configuration, or discovery document can name another identity
// provider or a look-alike sign-in page.
const DIRECTORY_ISSUER = "https://login.microsoftonline.com";
// Resources a directory grant may be issued for. A driver kind names the one
// its endpoint accepts; anything else is refused before a listener opens.
const DIRECTORY_AUDIENCES: ReadonlySet<string> = new Set(["https://cognitiveservices.azure.com"]);
// Identity scopes requested beside the audience's `.default`. The directory
// may leave them out of the echoed scope, so they never count as the token's
// resource.
const DIRECTORY_IDENTITY_SCOPES: ReadonlySet<string> = new Set([
  "openid",
  "profile",
  "offline_access",
  "email",
]);
// Refresh refusals the directory reports with a code that means the person
// must be present again (multi-factor, a password change prompt, consent).
// The grant stays: signing in again in person renews it.
const DIRECTORY_INTERACTION_ERRORS: ReadonlySet<string> = new Set([
  "interaction_required",
  "login_required",
  "consent_required",
]);
const DIRECTORY_INTERACTION_SUBERRORS: ReadonlySet<string> = new Set([
  "basic_action",
  "additional_action",
  "message_only",
  "user_password_expired",
  "consent_required",
]);
// AADSTS50076 and 50079 (multi-factor required or not yet registered), 50158
// (an external security challenge), 65001 (consent not granted).
const DIRECTORY_INTERACTION_CODES: ReadonlySet<number> = new Set([50076, 50079, 50158, 65001]);
// AADSTS70008 and 700082 (refresh token expired from inactivity), 70043
// (expired by a sign-in frequency policy). Every other `invalid_grant`,
// including 50173 (a password change or an administrator's revocation), is
// read as revoked.
const DIRECTORY_EXPIRED_CODES: ReadonlySet<number> = new Set([70008, 700082, 70043]);
const ACCOUNT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .@_'-]{0,127}$/;
// RFC 6749 §3.3 scope-token: printable ASCII without space, quote, or
// backslash. A resource may advertise a URL-shaped scope; the authorize URL
// and the token form encode it, so the wider grammar leaks nowhere.
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/;
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
// A live ChatGPT sign-in driven over Screen Sharing ran past three minutes
// between opening the browser and choosing the account, so the callback hit a
// closed listener. Ten minutes matches how long issuers keep a code valid.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
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
export type HostOAuthDialect =
  | "openrouter-pkce"
  | "chatgpt-plan-siwc"
  | "mcp-authorization"
  | "directory-oidc";

export interface HostOAuthDescriptor {
  readonly descriptorId: string;
  /** Absent only for a dialect that sends no `client_id`. */
  readonly clientId?: string;
  /** A vendor wire dialect. Absent means the standard OAuth runner path. */
  readonly dialect?: HostOAuthDialect;
  readonly flow: HostOAuthFlow;
  readonly authorizationEndpoint?: string;
  /**
   * Absent only for the directory dialect, whose authority URLs the broker
   * builds itself from the closed issuer host and the tenant.
   */
  readonly tokenEndpoint?: string;
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
  /**
   * MCP authorization dialect only: the canonical address of the MCP server
   * the token is for (RFC 8707), sent as `resource` on authorize, exchange
   * and refresh so the issuer binds the token to that server.
   */
  readonly resource?: string;
  /**
   * MCP authorization dialect only: the loopback port the callback listens
   * on. The client registration had to name the redirect address before the
   * flow could begin, so the caller chooses the port and the runner binds it.
   */
  readonly redirectPort?: number;
  /**
   * Directory dialect only: the organization's tenant, as a lowercase GUID.
   * A multi-tenant alias would let an account from any tenant answer.
   */
  readonly tenantId?: string;
  /** Directory dialect only: the resource the access token is for, from a closed list. */
  readonly audience?: string;
  /** Directory dialect only: the https origin of the endpoint the grant is signed in for. */
  readonly endpointOrigin?: string;
}

/**
 * What a directory grant was signed in for. `access` releases a directory
 * grant's token only to a caller naming exactly this binding.
 */
export interface HostOAuthDirectoryBinding {
  readonly tenantId: string;
  readonly clientId: string;
  readonly audience: string;
  readonly endpointOrigin: string;
}

/**
 * `interaction-required` (directory dialect): the directory wants the person
 * present again, for multi-factor or a consent prompt. Unlike the others it
 * keeps the grant, which a new sign-in in person renews.
 */
export type HostOAuthSignInAgainReason =
  | "revoked"
  | "expired"
  | "refresh-reused"
  | "interaction-required";

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
       * False when the sign-in identifies the person but the issuer did not
       * grant the scope that lets requests draw on their subscription; the
       * bearer is valid, subscription-billed requests are not. Absent when
       * the dialect makes no such distinction.
       */
      readonly subscriptionUsageGranted?: boolean;
    }
  | { readonly kind: "sign-in-again"; readonly reason: HostOAuthSignInAgainReason }
  /**
   * The caller named a binding the grant was not signed in for, named none
   * for a directory grant, or named one for a grant of another kind.
   */
  | { readonly kind: "binding-mismatch" }
  | { readonly kind: "unavailable" };

export interface HostOAuthRuntime {
  readonly begin: (input: {
    readonly descriptor: HostOAuthDescriptor;
    readonly actorId: string;
    readonly termsAcknowledgedAt: string;
    /**
     * ChatGPT plan reauthorization: the instance's stored grant. The runtime
     * resolves this one credential and reuses its issued client id and
     * identity token. Absent means a first sign-in. The store is not scanned;
     * production stores cannot list their entries.
     */
    readonly credentialRef?: string;
  }) => Promise<HostOAuthBeginResult>;
  readonly status: (attemptId: string) => HostOAuthPublicState;
  readonly refresh: (credentialRef: string) => Promise<HostOAuthRefreshResult>;
  /**
   * A directory grant requires `binding` and releases its token only when the
   * binding equals the one it was signed in for; a grant of any other kind
   * refuses a binding.
   */
  readonly access: (
    credentialRef: string,
    binding?: HostOAuthDirectoryBinding,
  ) => Promise<HostOAuthAccessResult>;
  /**
   * ChatGPT plan dialect only: revoke the refresh token at the issuer's
   * revocation endpoint, then drop the stored grant. Other dialects have no
   * revocation endpoint and simply drop the grant; the directory offers no
   * client-side refresh-token revocation, so its sign-out is local.
   */
  readonly revoke: (credentialRef: string) => Promise<HostOAuthRevokeResult>;
  readonly close: () => Promise<void>;
}

/**
 * `not-revoked`: the issuer did not confirm the revocation (unreachable,
 * refused, or no same-origin revocation endpoint). The local grant is kept so
 * the caller can retry or deliberately forget it on this host only.
 * `unavailable`: the grant could not be read or deleted locally.
 */
export type HostOAuthRevokeResult =
  | { readonly kind: "revoked" }
  | { readonly kind: "not-revoked" }
  | { readonly kind: "unavailable" };

interface StoredGrant {
  readonly kind: typeof GRANT_KIND;
  readonly version: 1;
  readonly accessToken: string;
  /**
   * Absent when the issuer granted no refresh token (RFC 6749 §5.1 lets it):
   * the access token is the whole grant and expiry means signing in again.
   */
  readonly refreshToken?: string;
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
  /** MCP authorization dialect: the resource every refresh names again. */
  readonly resource?: string;
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
  /**
   * Directory dialect only: the binding the identity token proved at sign-in.
   * `access` compares a caller's binding with these and `clientId`. The
   * identity token itself is not kept: nothing later needs it.
   */
  readonly tenantId?: string;
  readonly audience?: string;
  readonly endpointOrigin?: string;
  /** Directory dialect only: a display name from the identity token, when it is plain text. */
  readonly accountLabel?: string;
}

/** A directory sign-in or refresh: its binding, built authority, and key cache. */
interface DirectoryContext {
  readonly binding: HostOAuthDirectoryBinding;
  readonly authority: DirectoryAuthority;
  readonly jwks: { current: JwksCache | undefined };
}

interface DirectoryAuthority {
  /** The `iss` every identity token from this tenant carries. */
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUrl: string;
}

interface Attempt {
  status: HostOAuthPublicState;
  readonly descriptorId: string;
  listener: Server | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  /**
   * Issued client id the authorize request used, when this attempt is a
   * ChatGPT plan reauthorization. The callback may omit client_id; this is
   * the id retained. A different callback client id is refused.
   */
  expectedIssuedClientId?: string;
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
  /** MCP authorization dialect: the resource the exchange names (RFC 8707). */
  readonly resource?: string;
  /** ChatGPT plan dialect: the OIDC nonce bound to the identity token. */
  readonly nonce?: string;
  /** ChatGPT plan dialect: the issued client id captured from the callback. */
  readonly issuedClientId?: string;
  /** ChatGPT plan dialect: the stable host id stored on the grant. */
  readonly extAgentHostId?: string;
  /** ChatGPT plan dialect: the runtime's memoized JWKS cache. */
  readonly jwks?: { current: JwksCache | undefined };
  /** ChatGPT plan dialect: the identity issuer (JWKS + revocation). */
  readonly issuer?: string;
  /** Directory dialect: the binding and authority the attempt began with. */
  readonly directory?: DirectoryContext;
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
  if (input.dialect === DIRECTORY_DIALECT) {
    const directory = input.directory;
    const nonce = input.nonce;
    if (directory === undefined || nonce === undefined) {
      return { kind: "refused", reason: "exchange-refused" };
    }
    return exchangeDirectoryCode({
      fetch: input.fetch,
      now: input.now,
      directory,
      nonce,
      code: input.code,
      redirectUri: input.redirectUri,
      verifier: input.verifier,
    });
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
      ...(input.resource === undefined ? {} : { resource: input.resource }),
    },
    clientId: input.clientId,
    tokenEndpoint: input.tokenEndpoint,
    previousRefresh: undefined,
    generation: 0,
    codeExchange: true,
    ...(input.resource === undefined ? {} : { resource: input.resource }),
    ...(input.dialect === MCP_DIALECT ? { refreshTokenOptional: true } : {}),
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
  /**
   * The OIDC nonce bound to an authorization-code exchange. Absent on
   * refresh: a refresh identity token is not bound to a nonce this process
   * sent.
   */
  readonly nonce?: string;
  readonly jwks: { current: JwksCache | undefined };
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
    ...(input.nonce === undefined ? {} : { expectedNonce: input.nonce }),
    jwks: input.jwks,
    issuer: input.issuer,
  });
  // A JWKS that cannot be obtained is the endpoint's problem, not a bad
  // token: the exchange reports unavailable so a first sign-in can be
  // retried rather than reading as a refused code.
  if (identity.kind === "unavailable") return { kind: "refused", reason: "unavailable" };
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
 * stored by the caller. A response without an identity token keeps the prior
 * identity. A response with one is checked for signature, issuer, audience,
 * expiry, and subject — not for a nonce, because refresh does not send one.
 */
async function refreshChatGptPlanGrant(
  input: SiwcExchangeContext & {
    readonly refreshToken: string;
    readonly generation: number;
    readonly priorIdToken?: string;
    readonly priorSubject?: string;
    readonly priorEmail?: string;
    readonly priorPlanUsageEnabled?: boolean;
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
    // identity it proved is unchanged. The token response itself does not
    // carry those fields, so they are copied from the stored grant.
    return {
      kind: "tokens",
      grant: {
        ...grant,
        dialect: CHATGPT_PLAN_DIALECT,
        extAgentHostId: input.extAgentHostId,
        ...(input.priorIdToken === undefined ? {} : { idToken: input.priorIdToken }),
        ...(input.priorSubject === undefined ? {} : { subject: input.priorSubject }),
        ...(input.priorEmail === undefined ? {} : { email: input.priorEmail }),
        ...(input.priorPlanUsageEnabled === undefined
          ? {}
          : { planUsageEnabled: input.priorPlanUsageEnabled }),
      },
    };
  }
  if (input.priorSubject === undefined) {
    return { kind: "refused", reason: "exchange-refused", error: "id_token_invalid" };
  }
  const identity = await validateSiwcIdToken({
    fetch: input.fetch,
    now: input.now,
    idToken,
    expectedAudience: input.issuedClientId,
    expectedSubject: input.priorSubject,
    jwks: input.jwks,
    issuer: input.issuer,
  });
  // The issuer already rotated the refresh token, so refusing here would
  // make the caller delete the grant and the replacement token with it: the
  // next refresh would fail with refresh_token_reused. An unavailable JWKS
  // (a brief outage, or keys this process could not fetch) keeps the rotated
  // tokens and the prior identity — the same shape as a refresh without an
  // identity token — and validation runs again on a later refresh. The new
  // identity token is NOT kept: it was never verified, and the prior one is
  // still the identity this grant proved.
  if (identity.kind === "unavailable") {
    const { idToken: _unverifiedIdToken, ...rotated } = grant;
    return {
      kind: "tokens",
      grant: {
        ...rotated,
        dialect: CHATGPT_PLAN_DIALECT,
        extAgentHostId: input.extAgentHostId,
        ...(input.priorIdToken === undefined ? {} : { idToken: input.priorIdToken }),
        ...(input.priorSubject === undefined ? {} : { subject: input.priorSubject }),
        ...(input.priorEmail === undefined ? {} : { email: input.priorEmail }),
        ...(input.priorPlanUsageEnabled === undefined
          ? {}
          : { planUsageEnabled: input.priorPlanUsageEnabled }),
      },
    };
  }
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

/**
 * The directory dialect (an organization's Microsoft Entra ID tenant). The
 * broker builds every authority URL from the closed issuer host and the
 * tenant GUID; the descriptor names only the tenant, the organization's own
 * public client, an audience from a closed list, and the endpoint origin.
 * The identity token is validated against the tenant's published keys
 * (signature, issuer, audience, `tid`, expiry, nonce) before the grant is
 * stored. The access token is never parsed: the directory treats it as
 * opaque to clients, so the tenant-specific authority and the echoed scope
 * bind it instead.
 */
function directoryAuthority(issuerOrigin: string, tenantId: string): DirectoryAuthority {
  const tenant = `${issuerOrigin}/${tenantId}`;
  return {
    issuer: `${tenant}/v2.0`,
    authorizationEndpoint: `${tenant}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${tenant}/oauth2/v2.0/token`,
    jwksUrl: `${tenant}/discovery/v2.0/keys`,
  };
}

/** The only scopes a directory sign-in or refresh requests. */
function directoryScope(audience: string): string {
  return `${audience}/.default openid profile offline_access`;
}

/**
 * Whether the echoed scope names the audience and no other resource. The
 * directory may omit the identity scopes from the echo, so they are ignored.
 */
function scopeBoundToAudience(scope: string, audience: string): boolean {
  const resourceScopes = parseScopeList(scope).filter(
    (entry) => !DIRECTORY_IDENTITY_SCOPES.has(entry),
  );
  return (
    resourceScopes.length > 0 && resourceScopes.every((entry) => entry.startsWith(`${audience}/`))
  );
}

/** A display name for the account, only when it is plain text a label can carry. */
function directoryAccountLabel(claims: Readonly<Record<string, unknown>>): string | undefined {
  for (const claim of [claims.preferred_username, claims.name]) {
    if (typeof claim === "string" && ACCOUNT_LABEL_PATTERN.test(claim)) return claim;
  }
  return undefined;
}

async function validateDirectoryIdToken(input: {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly idToken: string;
  readonly directory: DirectoryContext;
  readonly expectedNonce?: string;
  readonly expectedSubject?: string;
}): Promise<
  | { readonly kind: "valid"; readonly subject: string; readonly accountLabel?: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" }
> {
  const identity = await validateIdToken({
    fetch: input.fetch,
    now: input.now,
    idToken: input.idToken,
    expectedAudience: input.directory.binding.clientId,
    ...(input.expectedNonce === undefined ? {} : { expectedNonce: input.expectedNonce }),
    ...(input.expectedSubject === undefined ? {} : { expectedSubject: input.expectedSubject }),
    jwks: input.directory.jwks,
    issuer: input.directory.authority.issuer,
    jwksUrl: input.directory.authority.jwksUrl,
  });
  if (identity.kind !== "valid") return identity;
  // The issuer already names the tenant; `tid` is checked as well because it
  // is the claim the directory documents as the tenant the person signed in to.
  if (identity.claims.tid !== input.directory.binding.tenantId) return { kind: "invalid" };
  const accountLabel = directoryAccountLabel(identity.claims);
  return {
    kind: "valid",
    subject: identity.subject,
    ...(accountLabel === undefined ? {} : { accountLabel }),
  };
}

/**
 * Exchange a directory authorization code. The form carries the public
 * client id, the code, the PKCE verifier, the same redirect URI, and the
 * scope; a public client has no secret or client assertion to send.
 */
async function exchangeDirectoryCode(input: {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly directory: DirectoryContext;
  readonly nonce: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly verifier: string;
}): Promise<
  | { readonly kind: "tokens"; readonly grant: StoredGrant }
  | { readonly kind: "refused"; readonly reason: "exchange-refused" | "unavailable" }
  | { readonly kind: "transient" }
> {
  const { binding, authority } = input.directory;
  const exchanged = await requestTokens({
    fetch: input.fetch,
    now: input.now,
    endpoint: authority.tokenEndpoint,
    form: {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: binding.clientId,
      code_verifier: input.verifier,
      scope: directoryScope(binding.audience),
    },
    clientId: binding.clientId,
    tokenEndpoint: authority.tokenEndpoint,
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
  const { idToken, ...tokens } = exchanged.grant;
  if (idToken === undefined || !scopeBoundToAudience(tokens.scope, binding.audience)) {
    return { kind: "refused", reason: "exchange-refused" };
  }
  const identity = await validateDirectoryIdToken({
    fetch: input.fetch,
    now: input.now,
    idToken,
    directory: input.directory,
    expectedNonce: input.nonce,
  });
  if (identity.kind === "unavailable") return { kind: "refused", reason: "unavailable" };
  if (identity.kind !== "valid") return { kind: "refused", reason: "exchange-refused" };
  return {
    kind: "tokens",
    grant: {
      ...tokens,
      dialect: DIRECTORY_DIALECT,
      tenantId: binding.tenantId,
      audience: binding.audience,
      endpointOrigin: binding.endpointOrigin,
      subject: identity.subject,
      ...(identity.accountLabel === undefined ? {} : { accountLabel: identity.accountLabel }),
    },
  };
}

/**
 * Refresh a directory grant, storing the rotated refresh token. A response
 * whose echoed scope leaves the audience ends the grant. A new identity token
 * must keep the tenant and subject; one that cannot be checked because the
 * key set is unreachable keeps the rotated tokens and the prior identity, as
 * the ChatGPT plan dialect does, since the directory may already have
 * retired the previous refresh token.
 */
async function refreshDirectoryGrant(input: {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly directory: DirectoryContext;
  readonly refreshToken: string;
  readonly generation: number;
  readonly subject: string;
  readonly accountLabel: string | undefined;
}): Promise<TokenRequestResult> {
  const { binding, authority } = input.directory;
  const exchanged = await requestTokens({
    fetch: input.fetch,
    now: input.now,
    endpoint: authority.tokenEndpoint,
    form: {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: binding.clientId,
      scope: directoryScope(binding.audience),
    },
    clientId: binding.clientId,
    tokenEndpoint: authority.tokenEndpoint,
    previousRefresh: input.refreshToken,
    generation: input.generation,
    codeExchange: false,
    directoryErrors: true,
  });
  if (exchanged.kind !== "tokens") return exchanged;
  const { idToken, ...tokens } = exchanged.grant;
  if (!scopeBoundToAudience(tokens.scope, binding.audience)) {
    return { kind: "refused", reason: "exchange-refused", error: "scope_unbound" };
  }
  let subject = input.subject;
  let accountLabel = input.accountLabel;
  if (idToken !== undefined) {
    const identity = await validateDirectoryIdToken({
      fetch: input.fetch,
      now: input.now,
      idToken,
      directory: input.directory,
      expectedSubject: input.subject,
    });
    if (identity.kind === "invalid") {
      return { kind: "refused", reason: "exchange-refused", error: "id_token_invalid" };
    }
    if (identity.kind === "valid") {
      subject = identity.subject;
      accountLabel = identity.accountLabel ?? accountLabel;
    }
  }
  return {
    kind: "tokens",
    grant: {
      ...tokens,
      dialect: DIRECTORY_DIALECT,
      tenantId: binding.tenantId,
      audience: binding.audience,
      endpointOrigin: binding.endpointOrigin,
      subject,
      ...(accountLabel === undefined ? {} : { accountLabel }),
    },
  };
}

/**
 * Map a directory refresh refusal. The directory reports most dead grants as
 * `invalid_grant` and tells them apart with `suberror` and numeric
 * `error_codes`; its free-text description is never read, so no directory
 * text reaches a result.
 */
function mapDirectoryRefreshError(
  error: string,
  body: Readonly<Record<string, unknown>>,
): TokenRequestResult {
  const suberror = stringField(body, "suberror");
  const codes = Array.isArray(body.error_codes)
    ? body.error_codes.filter((code): code is number => typeof code === "number")
    : [];
  const refused = (signInAgain: HostOAuthSignInAgainReason): TokenRequestResult => ({
    kind: "refused",
    reason: "exchange-refused",
    error,
    signInAgain,
  });
  if (
    DIRECTORY_INTERACTION_ERRORS.has(error) ||
    (suberror !== undefined && DIRECTORY_INTERACTION_SUBERRORS.has(suberror)) ||
    codes.some((code) => DIRECTORY_INTERACTION_CODES.has(code))
  ) {
    return refused("interaction-required");
  }
  if (error === "invalid_grant") {
    if (suberror === "token_expired" || codes.some((code) => DIRECTORY_EXPIRED_CODES.has(code))) {
      return refused("expired");
    }
    return refused("revoked");
  }
  // The app registration was removed or no longer allows this client:
  // retrying can never succeed.
  if (error === "invalid_client" || error === "unauthorized_client") return refused("revoked");
  return { kind: "transient" };
}

/**
 * A directory grant releases its token only to a caller naming the binding it
 * was signed in for; a grant of any other kind refuses a binding, so a caller
 * that believes it holds a directory grant never receives another kind's
 * bearer.
 */
function grantAdmitsBinding(
  grant: StoredGrant,
  binding: HostOAuthDirectoryBinding | undefined,
): boolean {
  if (grant.dialect !== DIRECTORY_DIALECT) return binding === undefined;
  const signedInFor = grantDirectoryBinding(grant);
  return (
    signedInFor !== undefined &&
    binding !== undefined &&
    signedInFor.tenantId === binding.tenantId &&
    signedInFor.clientId === binding.clientId &&
    signedInFor.audience === binding.audience &&
    signedInFor.endpointOrigin === binding.endpointOrigin
  );
}

function grantDirectoryBinding(grant: StoredGrant): HostOAuthDirectoryBinding | undefined {
  const { tenantId, audience, endpointOrigin } = grant;
  if (tenantId === undefined || audience === undefined || endpointOrigin === undefined) {
    return undefined;
  }
  return { tenantId, clientId: grant.clientId, audience, endpointOrigin };
}

/** A validated directory descriptor's binding; undefined for every other dialect. */
function descriptorDirectoryBinding(
  descriptor: HostOAuthDescriptor,
): HostOAuthDirectoryBinding | undefined {
  const { dialect, tenantId, clientId, audience, endpointOrigin } = descriptor;
  if (
    dialect !== DIRECTORY_DIALECT ||
    tenantId === undefined ||
    clientId === undefined ||
    audience === undefined ||
    endpointOrigin === undefined
  ) {
    return undefined;
  }
  return { tenantId, clientId, audience, endpointOrigin };
}

/** The https origin of a URL with no embedded credentials, or undefined. */
function canonicalHttpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

type SiwcIdTokenValidation =
  | { readonly kind: "valid"; readonly subject: string; readonly email?: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

/**
 * Validate a ChatGPT plan identity token: RS256 signature against the
 * issuer's JWKS, issuer, audience (the issued client id), and expiry.
 * An authorization-code exchange also checks the nonce issued for that
 * attempt. A refresh does not: no nonce was sent, so a nonce check would
 * reject a token that is otherwise valid and delete the grant. A refresh
 * instead requires the subject to equal the stored subject.
 */
async function validateSiwcIdToken(input: {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly idToken: string;
  readonly expectedAudience: string;
  readonly expectedNonce?: string;
  readonly expectedSubject?: string;
  readonly jwks: { current: JwksCache | undefined };
  readonly issuer: string;
}): Promise<SiwcIdTokenValidation> {
  const identity = await validateIdToken({
    ...input,
    jwksUrl: `${input.issuer}${SIWC_JWKS_PATH}`,
  });
  if (identity.kind !== "valid") return identity;
  const email = identity.claims.email;
  return {
    kind: "valid",
    subject: identity.subject,
    ...(typeof email === "string" && email.length > 0 ? { email } : {}),
  };
}

type IdTokenValidation =
  | {
      readonly kind: "valid";
      readonly subject: string;
      readonly claims: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

/**
 * Validate an OIDC identity token: RS256 signature against the key set at
 * `jwksUrl`, issuer, audience, expiry, a non-empty subject, and, when given,
 * the nonce and the subject a refresh must keep. A dialect checks its own
 * further claims on the returned set.
 */
async function validateIdToken(input: {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly idToken: string;
  readonly expectedAudience: string;
  readonly expectedNonce?: string;
  readonly expectedSubject?: string;
  readonly jwks: { current: JwksCache | undefined };
  readonly issuer: string;
  readonly jwksUrl: string;
}): Promise<IdTokenValidation> {
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
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(header) || !isRecord(payload)) return { kind: "invalid" };
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { kind: "invalid" };
  const keys = await fetchJwks(input.fetch, input.jwksUrl, input.jwks, input.now, {
    kid: header.kid,
  });
  if (keys.kind === "unavailable") return { kind: "unavailable" };
  const key = keys.keys.get(header.kid);
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
  if (input.expectedNonce !== undefined && payload.nonce !== input.expectedNonce) {
    return { kind: "invalid" };
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return { kind: "invalid" };
  if (input.expectedSubject !== undefined && payload.sub !== input.expectedSubject) {
    return { kind: "invalid" };
  }
  return { kind: "valid", subject: payload.sub, claims: payload };
}

interface JwksCache {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly fetchedAt: number;
  /**
   * When an unknown kid last forced a refetch of a still-fresh key set.
   * Absent means no refetch has happened since the last routine fetch.
   */
  readonly refetchedAt?: number;
}

/**
 * Whether the issuer's JWKS could be obtained. `unavailable` keeps it
 * distinct from a fetched key set that simply lacks the `kid`: an
 * unreachable JWKS must not read as an invalid token, or a brief outage
 * would delete the stored grant.
 */
type JwksResult =
  | { readonly kind: "fetched"; readonly keys: ReadonlyMap<string, KeyObject> }
  | { readonly kind: "unavailable" };

const SIWC_DISCOVERY_PATH = "/.well-known/openid-configuration";

/**
 * Revoke a ChatGPT plan refresh token at the issuer's discovery
 * `revocation_endpoint`. True only when the issuer confirmed the revocation
 * with a 2xx answer. The endpoint must share the issuer's origin: discovery
 * is fetched over the network, and a document naming some other host must
 * not be able to collect the refresh token. A 404 means there was no
 * revocation endpoint to answer, not that the token is dead.
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
  if (endpoint === undefined || !allowedEndpoint(endpoint) || !sameOrigin(endpoint, input.issuer)) {
    return false;
  }
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
    return response.ok;
  } catch {
    return false;
  }
}

// An unknown `kid` is how issuer key rotation looks from this side: the
// cached key set is younger than the cache window yet no longer names the
// token's key. Each validation may force one refetch of a still-fresh key
// set, but never more often than this floor, so a burst of validations
// cannot turn into a request flood against the issuer.
const JWKS_REFETCH_MS = 30_000;

// A directory key set publishes each key with its certificate chain, several
// keys at a time, so it runs past the token-response limit.
const MAX_JWKS_CHARS = 64 * 1_024;

/**
 * Fetch (and memoize per runtime) the issuer's JWKS. The cache lives on the
 * runtime so a refresh does not re-fetch keys the issuer already published.
 * A still-fresh cached key set that does not name `wanted.kid` is refetched
 * once (bounded by the refetch floor) — that is what issuer key rotation
 * looks like — and any failure to obtain the key set is reported as
 * `unavailable` rather than an empty key set, so a caller can keep the
 * grant instead of reading it as an invalid token.
 */
async function fetchJwks(
  fetchImpl: typeof fetch,
  jwksUrl: string,
  cache: { current: JwksCache | undefined },
  now: () => number,
  wanted: { readonly kid: string } = { kid: "" },
): Promise<JwksResult> {
  const cached = cache.current;
  const fresh = cached !== undefined && now() - cached.fetchedAt < JWKS_CACHE_MS;
  if (fresh && cached !== undefined) {
    // The cached key set is definitive when it names the wanted kid. When
    // it does not, only a refetch can tell issuer rotation from a key this
    // issuer never had; the floor keeps a burst of validations from
    // hammering the issuer after a refetch already happened. Inside the
    // floor the key was never checked against the issuer's current set, so
    // it is unavailable rather than invalid: reading it as invalid deleted a
    // grant whose refresh token the issuer had already rotated.
    const lastForced = cached.refetchedAt ?? 0;
    if (cached.keys.has(wanted.kid)) return { kind: "fetched", keys: cached.keys };
    if (now() - lastForced < JWKS_REFETCH_MS) return { kind: "unavailable" };
  }
  let response: Response;
  try {
    response = await fetchImpl(jwksUrl, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (!response.ok) return { kind: "unavailable" };
  const body = await readResponseJson(response, MAX_JWKS_CHARS);
  const keys = body === undefined ? undefined : body.keys;
  if (!Array.isArray(keys)) return { kind: "unavailable" };
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
  cache.current = {
    keys: parsed,
    fetchedAt: now(),
    // A fetch the cache age alone did not require is a rotation refetch;
    // recording it keeps the refetch floor honest for later validations.
    ...(fresh ? { refetchedAt: now() } : {}),
  };
  return { kind: "fetched", keys: parsed };
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
  const siwcJwks: { current: JwksCache | undefined } = { current: undefined };
  // The directory dialect publishes one key set per tenant.
  const directoryJwks = new Map<string, { current: JwksCache | undefined }>();
  let closed = false;

  const directoryContext = (binding: HostOAuthDirectoryBinding): DirectoryContext => {
    let jwks = directoryJwks.get(binding.tenantId);
    if (jwks === undefined) {
      jwks = { current: undefined };
      directoryJwks.set(binding.tenantId, jwks);
    }
    return { binding, authority: directoryAuthority(DIRECTORY_ISSUER, binding.tenantId), jwks };
  };

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
    readonly credentialRef?: string;
  }): Promise<HostOAuthBeginResult> => {
    if (closed) return { kind: "refused", reason: "unavailable" };
    if (!UUID_PATTERN.test(input.actorId) || input.termsAcknowledgedAt.trim().length === 0) {
      return { kind: "refused", reason: "terms-required" };
    }
    const descriptor = validateDescriptor(input.descriptor);
    if (descriptor === undefined) return { kind: "refused", reason: "invalid" };
    if (descriptor.flow === "device-code") return beginDevice(descriptor);
    return beginPkce(descriptor, input.credentialRef);
  };

  const beginPkce = async (
    descriptor: HostOAuthDescriptor,
    credentialRef: string | undefined,
  ): Promise<HostOAuthBeginResult> => {
    // The directory dialect's descriptor names no URL: the broker builds the
    // tenant's authority from the closed issuer host.
    const directoryBinding = descriptorDirectoryBinding(descriptor);
    const directory =
      directoryBinding === undefined ? undefined : directoryContext(directoryBinding);
    const authorizationEndpoint =
      directory?.authority.authorizationEndpoint ?? descriptor.authorizationEndpoint;
    const tokenEndpoint = directory?.authority.tokenEndpoint ?? descriptor.tokenEndpoint;
    if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
      return { kind: "refused", reason: "invalid" };
    }
    // Resolve a named grant before opening the loopback listener, so a store
    // failure does not leave a listener behind and a missing grant falls
    // through to first sign-in.
    let issuedGrant: StoredGrant | undefined;
    if (descriptor.dialect === CHATGPT_PLAN_DIALECT && credentialRef !== undefined) {
      const resolved = await resolveChatGptPlanGrant(credentialRef);
      if (resolved.kind === "unavailable") return { kind: "refused", reason: "unavailable" };
      if (resolved.kind === "grant") issuedGrant = resolved.grant;
    }
    const attemptId = randomUUID();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    // The ChatGPT plan and directory dialects bind the identity token to this
    // attempt with an OIDC nonce; the standard and OpenRouter paths send none.
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = now() + timeoutMs;
    const attempt: Attempt = {
      descriptorId: descriptor.descriptorId,
      closed: false,
      listener: undefined,
      timer: undefined,
      ...(issuedGrant === undefined ? {} : { expectedIssuedClientId: issuedGrant.clientId }),
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
          tokenEndpoint,
          ...(directory === undefined ? {} : { directory }),
          state,
          verifier,
          challenge,
          nonce,
          redirectUri,
        });
      });
      await listen(listener, descriptor.redirectPort);
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
        // A named grant is a reauthorization: reuse its issued client id and
        // retained identity token. No named grant is a first sign-in under
        // the placeholder, with the agent name hint. The store is not scanned.
        authorizationUrl = chatGptPlanAuthorizationRequest(authorizationEndpoint, {
          redirectUri,
          scope: descriptor.scopes.join(" "),
          state,
          challenge,
          nonce,
          extAgentHostId: descriptor.extAgentHostId ?? "",
          agentNameHint: issuedGrant === undefined ? descriptor.agentNameHint : undefined,
          issuedClientId: issuedGrant?.clientId,
          idTokenHint: issuedGrant?.idToken,
        });
      } else if (directory !== undefined) {
        authorizationUrl = authorizationRequest(authorizationEndpoint, {
          clientId: directory.binding.clientId,
          redirectUri,
          scope: directoryScope(directory.binding.audience),
          state,
          challenge,
          nonce,
        });
      } else {
        authorizationUrl = authorizationRequest(authorizationEndpoint, {
          clientId: descriptor.clientId ?? "",
          redirectUri,
          scope: descriptor.scopes.join(" "),
          state,
          challenge,
          ...(descriptor.resource === undefined ? {} : { resource: descriptor.resource }),
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
   * Resolve the one ChatGPT plan grant a reauthorization named. A missing or
   * non-plan grant is absent (first sign-in); a store that cannot be read is
   * unavailable. The store is never listed.
   */
  const resolveChatGptPlanGrant = async (
    credentialRef: string,
  ): Promise<
    | { readonly kind: "grant"; readonly grant: StoredGrant }
    | { readonly kind: "absent" }
    | { readonly kind: "unavailable" }
  > => {
    if (!UUID_PATTERN.test(credentialRef)) return { kind: "absent" };
    try {
      const grant = decodeGrant(await options.store.resolve(credentialRef));
      if (grant.dialect === CHATGPT_PLAN_DIALECT && ISSUED_CLIENT_ID_PATTERN.test(grant.clientId)) {
        return { kind: "grant", grant };
      }
      return { kind: "absent" };
    } catch (error) {
      if (
        error instanceof CredentialStoreFailure &&
        (error.category === "missing" || error.category === "invalid")
      ) {
        return { kind: "absent" };
      }
      return { kind: "unavailable" };
    }
  };

  const handleCallback = async (
    request: IncomingMessage,
    response: ServerResponse,
    session: {
      readonly attempt: Attempt;
      readonly attemptId: string;
      readonly descriptor: HostOAuthDescriptor;
      readonly tokenEndpoint: string;
      readonly directory?: DirectoryContext;
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
    // code. A first sign-in must present an oaiapp_ id — never the
    // dynamic_agent_client placeholder. A reauthorization may omit client_id;
    // the issued id used in the authorize request is retained. A callback
    // client id that differs from that expected id is refused before exchange.
    let issuedClientId: string | undefined;
    if (session.descriptor.dialect === CHATGPT_PLAN_DIALECT) {
      const returned = params.get("client_id");
      const expected = session.attempt.expectedIssuedClientId;
      const omitted = returned === null || returned.length === 0;
      if (omitted) {
        if (expected === undefined) {
          publish(
            session.attemptId,
            refused(session.attemptId, session.descriptor.descriptorId, "exchange-refused"),
          );
          replyCallback(response, 400);
          finishListener(session.attempt);
          return;
        }
        issuedClientId = expected;
      } else if (expected !== undefined && returned !== expected) {
        publish(
          session.attemptId,
          refused(session.attemptId, session.descriptor.descriptorId, "exchange-refused"),
        );
        replyCallback(response, 400);
        finishListener(session.attempt);
        return;
      } else if (!ISSUED_CLIENT_ID_PATTERN.test(returned)) {
        publish(
          session.attemptId,
          refused(session.attemptId, session.descriptor.descriptorId, "exchange-refused"),
        );
        replyCallback(response, 400);
        finishListener(session.attempt);
        return;
      } else {
        issuedClientId = returned;
      }
    }
    const exchanged = await exchangeAuthorizationCode({
      tokenEndpoint: session.tokenEndpoint,
      clientId: issuedClientId ?? session.descriptor.clientId ?? "",
      code,
      redirectUri: session.redirectUri,
      verifier: session.verifier,
      challenge: session.challenge,
      fetch: fetchImpl,
      now,
      ...(session.descriptor.dialect === undefined ? {} : { dialect: session.descriptor.dialect }),
      ...(session.descriptor.resource === undefined
        ? {}
        : { resource: session.descriptor.resource }),
      ...(session.nonce === "" ? {} : { nonce: session.nonce }),
      ...(issuedClientId === undefined ? {} : { issuedClientId }),
      ...(session.descriptor.extAgentHostId === undefined
        ? {}
        : { extAgentHostId: session.descriptor.extAgentHostId }),
      jwks: siwcJwks,
      issuer: siwcIssuer,
      ...(session.directory === undefined ? {} : { directory: session.directory }),
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
    const tokenEndpoint = descriptor.tokenEndpoint;
    if (deviceEndpoint === undefined || tokenEndpoint === undefined) {
      return { kind: "refused", reason: "invalid" };
    }
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
      tokenEndpoint,
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
    readonly tokenEndpoint: string;
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
        endpoint: session.tokenEndpoint,
        form: {
          grant_type: DEVICE_GRANT,
          device_code: session.deviceCode,
          client_id: session.descriptor.clientId ?? "",
        },
        clientId: session.descriptor.clientId ?? "",
        tokenEndpoint: session.tokenEndpoint,
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
    // A grant issued without a refresh token lasts exactly as long as its
    // access token; when that passes, the person signs in again.
    if (current.refreshToken === undefined) {
      if (current.expiresAt === undefined || current.expiresAt > now())
        return { kind: "refreshed" };
      try {
        await options.store.delete(credentialRef);
      } catch {
        return { kind: "unavailable" };
      }
      return { kind: "sign-in-again", reason: "expired" };
    }
    const refreshToken = current.refreshToken;
    if (current.dialect === DIRECTORY_DIALECT) {
      const binding = grantDirectoryBinding(current);
      if (binding === undefined || current.subject === undefined) return { kind: "unavailable" };
      const exchanged = await refreshDirectoryGrant({
        fetch: fetchImpl,
        now,
        directory: directoryContext(binding),
        refreshToken,
        generation,
        subject: current.subject,
        accountLabel: current.accountLabel,
      });
      if (exchanged.kind === "transient" || exchanged.kind === "pending") {
        return { kind: "transient" };
      }
      if (exchanged.kind === "refused") {
        const reason = exchanged.signInAgain ?? refreshRefusal(exchanged.reason, exchanged.error);
        // The person can satisfy the directory's prompt by signing in again
        // in person; until then the grant is kept, not dropped.
        if (reason === "interaction-required") return { kind: "sign-in-again", reason };
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
    // The ChatGPT plan dialect refreshes with the issued client id and the
    // resource, and stores the rotating replacement refresh token. A new
    // identity token is checked without a nonce: refresh does not send one,
    // and inventing one would reject the issuer's token and delete the grant.
    if (current.dialect === CHATGPT_PLAN_DIALECT) {
      const exchanged = await refreshChatGptPlanGrant({
        fetch: fetchImpl,
        now,
        tokenEndpoint: current.tokenEndpoint,
        issuedClientId: current.clientId,
        extAgentHostId: current.extAgentHostId ?? "",
        jwks: siwcJwks,
        issuer: siwcIssuer,
        refreshToken,
        generation,
        ...(current.idToken === undefined ? {} : { priorIdToken: current.idToken }),
        ...(current.subject === undefined ? {} : { priorSubject: current.subject }),
        ...(current.email === undefined ? {} : { priorEmail: current.email }),
        ...(current.planUsageEnabled === undefined
          ? {}
          : { priorPlanUsageEnabled: current.planUsageEnabled }),
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
        refresh_token: refreshToken,
        client_id: current.clientId,
        ...(current.resource === undefined ? {} : { resource: current.resource }),
      },
      clientId: current.clientId,
      tokenEndpoint: current.tokenEndpoint,
      previousRefresh: refreshToken,
      generation,
      codeExchange: false,
      ...(current.resource === undefined ? {} : { resource: current.resource }),
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
    access: async (
      credentialRef: string,
      binding?: HostOAuthDirectoryBinding,
    ): Promise<HostOAuthAccessResult> => {
      if (!UUID_PATTERN.test(credentialRef)) return { kind: "unavailable" };
      try {
        const grant = decodeGrant(await options.store.resolve(credentialRef));
        if (!grantAdmitsBinding(grant, binding)) return { kind: "binding-mismatch" };
        return {
          kind: "granted",
          accessToken: grant.accessToken,
          tokenType: grant.tokenType,
          ...(grant.expiresAt === undefined
            ? {}
            : { expiresAt: new Date(grant.expiresAt).toISOString() }),
          ...(grant.planUsageEnabled === undefined
            ? {}
            : { subscriptionUsageGranted: grant.planUsageEnabled }),
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
      if (grant.dialect === CHATGPT_PLAN_DIALECT && grant.refreshToken !== undefined) {
        const revoked = await revokeSiwcRefreshToken({
          fetch: fetchImpl,
          issuer: siwcIssuer,
          clientId: grant.clientId,
          refreshToken: grant.refreshToken,
        });
        if (!revoked) return { kind: "not-revoked" };
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
  const credentialRef = value.credentialRef;
  if (
    !isRecord(descriptor) ||
    typeof actorId !== "string" ||
    typeof termsAcknowledgedAt !== "string" ||
    (credentialRef !== undefined &&
      (typeof credentialRef !== "string" || !UUID_PATTERN.test(credentialRef)))
  ) {
    return Response.json({ error: "invalid-request" }, { status: 400 });
  }
  const parsed = descriptorFromRecord(descriptor);
  if (parsed === undefined) return Response.json({ error: "invalid-request" }, { status: 400 });
  const started = await runtime.begin({
    descriptor: parsed,
    actorId,
    termsAcknowledgedAt,
    ...(typeof credentialRef === "string" ? { credentialRef } : {}),
  });
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
  const binding = value.binding === undefined ? undefined : bindingFromRecord(value.binding);
  if (value.binding !== undefined && binding === undefined) {
    return Response.json({ error: "invalid-request" }, { status: 400 });
  }
  const granted = await runtime.access(credentialRef, binding);
  if (granted.kind !== "granted") {
    return Response.json(granted, { headers: { "cache-control": "no-store" } });
  }
  return Response.json(
    {
      kind: "granted",
      accessToken: granted.accessToken,
      tokenType: granted.tokenType,
      ...(granted.expiresAt === undefined ? {} : { expiresAt: granted.expiresAt }),
      ...(granted.subscriptionUsageGranted === undefined
        ? {}
        : { subscriptionUsageGranted: granted.subscriptionUsageGranted }),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

const BINDING_KEYS: ReadonlySet<string> = new Set([
  "tenantId",
  "clientId",
  "audience",
  "endpointOrigin",
]);

/** Exactly the four binding fields, each a bounded string; anything else is malformed. */
function bindingFromRecord(value: unknown): HostOAuthDirectoryBinding | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== BINDING_KEYS.size || !keys.every((key) => BINDING_KEYS.has(key))) {
    return undefined;
  }
  const { tenantId, clientId, audience, endpointOrigin } = value;
  if (
    typeof tenantId !== "string" ||
    typeof clientId !== "string" ||
    typeof audience !== "string" ||
    typeof endpointOrigin !== "string" ||
    [tenantId, clientId, audience, endpointOrigin].some((field) => field.length > 256)
  ) {
    return undefined;
  }
  return { tenantId, clientId, audience, endpointOrigin };
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
      /** Directory dialect: the sign-in-again reason its own error codes name. */
      readonly signInAgain?: HostOAuthSignInAgainReason;
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
  /** MCP authorization dialect: kept on the grant so a refresh names it again. */
  readonly resource?: string;
  /** MCP authorization dialect: an issuer may grant an access token alone. */
  readonly refreshTokenOptional?: boolean;
  /** Directory dialect refresh: read the directory's own error codes. */
  readonly directoryErrors?: boolean;
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
  if (error !== undefined) {
    if (input.directoryErrors === true && ERROR_PATTERN.test(error)) {
      return mapDirectoryRefreshError(error, body);
    }
    return mapTokenError(error, input.codeExchange);
  }
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
    (refreshToken === undefined && input.refreshTokenOptional !== true) ||
    accessToken.length > MAX_TOKEN_CHARS ||
    (refreshToken !== undefined && refreshToken.length > MAX_TOKEN_CHARS) ||
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
      ...(refreshToken === undefined ? {} : { refreshToken }),
      tokenType: tokenType.slice(0, 32),
      expiresAt: input.now() + expiresIn * 1_000,
      scope: (stringField(body, "scope") ?? "").slice(0, 512),
      clientId: input.clientId,
      tokenEndpoint: input.tokenEndpoint,
      generation: input.generation + 1,
      ...(idToken === undefined ? {} : { idToken }),
      ...(input.resource === undefined ? {} : { resource: input.resource }),
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
  // The issuer no longer recognizes the client the grant was issued to (a
  // ChatGPT plan registration that was removed, for example). Retrying can
  // never succeed, so on refresh this ends the grant like a dead refresh
  // token instead of reporting a transient failure forever.
  if (error === "invalid_client") return { kind: "refused", reason: "exchange-refused", error };
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
  // invalid_grant, invalid_refresh_token, refresh_token_expired,
  // refresh_token_invalidated, and invalid_client all mean the grant is gone.
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
  const resource = parsed.resource;
  const tenantId = parsed.tenantId;
  const audience = parsed.audience;
  const endpointOrigin = parsed.endpointOrigin;
  const accountLabel = parsed.accountLabel;
  // A directory grant without its whole binding and subject cannot be checked
  // at `access` or kept on refresh, so it is unreadable rather than unbound.
  if (
    dialect === DIRECTORY_DIALECT &&
    (typeof tenantId !== "string" ||
      typeof audience !== "string" ||
      typeof endpointOrigin !== "string" ||
      typeof subject !== "string")
  ) {
    throw new CredentialStoreFailure("invalid");
  }
  if (
    (tenantId !== undefined && typeof tenantId !== "string") ||
    (audience !== undefined && typeof audience !== "string") ||
    (endpointOrigin !== undefined && typeof endpointOrigin !== "string") ||
    (accountLabel !== undefined && typeof accountLabel !== "string") ||
    (resource !== undefined && typeof resource !== "string") ||
    typeof accessToken !== "string" ||
    (refreshToken !== undefined && typeof refreshToken !== "string") ||
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
    ...(refreshToken === undefined ? {} : { refreshToken }),
    tokenType,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    scope,
    clientId,
    tokenEndpoint,
    generation,
    ...(resource === undefined ? {} : { resource }),
    ...(dialect === undefined ? {} : { dialect }),
    ...(idToken === undefined ? {} : { idToken }),
    ...(extAgentHostId === undefined ? {} : { extAgentHostId }),
    ...(subject === undefined ? {} : { subject }),
    ...(email === undefined ? {} : { email }),
    ...(planUsageEnabled === undefined ? {} : { planUsageEnabled }),
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(audience === undefined ? {} : { audience }),
    ...(endpointOrigin === undefined ? {} : { endpointOrigin }),
    ...(accountLabel === undefined ? {} : { accountLabel }),
  };
}

function validateDescriptor(descriptor: HostOAuthDescriptor): HostOAuthDescriptor | undefined {
  if (!safeId(descriptor.descriptorId) || !safeId(descriptor.termsId)) return undefined;
  const dialect = descriptor.dialect;
  if (
    dialect !== undefined &&
    dialect !== OPENROUTER_DIALECT &&
    dialect !== CHATGPT_PLAN_DIALECT &&
    dialect !== MCP_DIALECT &&
    dialect !== DIRECTORY_DIALECT
  ) {
    return undefined;
  }
  if (dialect === DIRECTORY_DIALECT) return validateDirectoryDescriptor(descriptor);
  if (
    descriptor.tenantId !== undefined ||
    descriptor.audience !== undefined ||
    descriptor.endpointOrigin !== undefined
  ) {
    return undefined;
  }
  if (dialect === MCP_DIALECT) {
    // The MCP authorization flow registered its client before beginning and
    // names the server the token is for; a server may grant with no scope.
    if (typeof descriptor.clientId !== "string" || !safeClientId(descriptor.clientId)) {
      return undefined;
    }
    if (descriptor.resource === undefined || !allowedEndpoint(descriptor.resource)) {
      return undefined;
    }
    if (
      descriptor.redirectPort !== undefined &&
      (!Number.isInteger(descriptor.redirectPort) ||
        descriptor.redirectPort < 1024 ||
        descriptor.redirectPort > 65535)
    ) {
      return undefined;
    }
  } else if (descriptor.resource !== undefined || descriptor.redirectPort !== undefined) {
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
  if (descriptor.tokenEndpoint === undefined || !allowedEndpoint(descriptor.tokenEndpoint)) {
    return undefined;
  }
  if (descriptor.scopes.length > 16) return undefined;
  if (!descriptor.scopes.every((scope) => SCOPE_TOKEN_PATTERN.test(scope))) return undefined;
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

/**
 * A directory descriptor names its tenant, the organization's own public
 * client, an audience from the closed list, and the endpoint origin, and
 * nothing else: no URL (the broker builds the authority), no scope (the
 * broker requests only the audience), and only the loopback PKCE flow.
 */
function validateDirectoryDescriptor(
  descriptor: HostOAuthDescriptor,
): HostOAuthDescriptor | undefined {
  const { tenantId, clientId, audience, endpointOrigin } = descriptor;
  if (
    descriptor.flow !== "authorization-code-pkce" ||
    tenantId === undefined ||
    !UUID_PATTERN.test(tenantId) ||
    clientId === undefined ||
    !UUID_PATTERN.test(clientId) ||
    audience === undefined ||
    !DIRECTORY_AUDIENCES.has(audience) ||
    endpointOrigin === undefined ||
    canonicalHttpsOrigin(endpointOrigin) !== endpointOrigin ||
    descriptor.scopes.length !== 0 ||
    descriptor.authorizationEndpoint !== undefined ||
    descriptor.tokenEndpoint !== undefined ||
    descriptor.deviceAuthorizationEndpoint !== undefined ||
    descriptor.resource !== undefined ||
    descriptor.redirectPort !== undefined ||
    descriptor.extAgentHostId !== undefined ||
    descriptor.agentNameHint !== undefined
  ) {
    return undefined;
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
    (tokenEndpoint !== undefined && typeof tokenEndpoint !== "string") ||
    typeof termsId !== "string" ||
    !Array.isArray(scopes) ||
    !scopes.every((scope): scope is string => typeof scope === "string")
  ) {
    return undefined;
  }
  const authorizationEndpoint = value.authorizationEndpoint;
  const deviceAuthorizationEndpoint = value.deviceAuthorizationEndpoint;
  const dialect = value.dialect;
  if (
    dialect !== undefined &&
    dialect !== OPENROUTER_DIALECT &&
    dialect !== CHATGPT_PLAN_DIALECT &&
    dialect !== MCP_DIALECT &&
    dialect !== DIRECTORY_DIALECT
  ) {
    return undefined;
  }
  const extAgentHostId = value.extAgentHostId;
  const agentNameHint = value.agentNameHint;
  const resource = value.resource;
  const redirectPort = value.redirectPort;
  const tenantId = value.tenantId;
  const audience = value.audience;
  const endpointOrigin = value.endpointOrigin;
  if (
    (tenantId !== undefined && typeof tenantId !== "string") ||
    (audience !== undefined && typeof audience !== "string") ||
    (endpointOrigin !== undefined && typeof endpointOrigin !== "string") ||
    (extAgentHostId !== undefined && typeof extAgentHostId !== "string") ||
    (agentNameHint !== undefined && typeof agentNameHint !== "string") ||
    (resource !== undefined && typeof resource !== "string") ||
    (redirectPort !== undefined && typeof redirectPort !== "number")
  ) {
    return undefined;
  }
  return validateDescriptor({
    descriptorId,
    ...(typeof clientId === "string" ? { clientId } : {}),
    ...(dialect === undefined ? {} : { dialect }),
    flow,
    ...(typeof tokenEndpoint === "string" ? { tokenEndpoint } : {}),
    termsId,
    scopes,
    ...(typeof authorizationEndpoint === "string" ? { authorizationEndpoint } : {}),
    ...(typeof deviceAuthorizationEndpoint === "string" ? { deviceAuthorizationEndpoint } : {}),
    ...(typeof extAgentHostId === "string" ? { extAgentHostId } : {}),
    ...(typeof agentNameHint === "string" ? { agentNameHint } : {}),
    ...(typeof resource === "string" ? { resource } : {}),
    ...(typeof redirectPort === "number" ? { redirectPort } : {}),
    ...(typeof tenantId === "string" ? { tenantId } : {}),
    ...(typeof audience === "string" ? { audience } : {}),
    ...(typeof endpointOrigin === "string" ? { endpointOrigin } : {}),
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
    /** RFC 8707: the server the token is for; the MCP dialect always names it. */
    readonly resource?: string;
    /** OIDC nonce the identity token must echo; the directory dialect sends one. */
    readonly nonce?: string;
  },
): string {
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  // An empty scope is left off: an MCP server that advertises none grants
  // without one, and some issuers refuse `scope=`.
  if (input.scope.length > 0) url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.resource !== undefined) url.searchParams.set("resource", input.resource);
  if (input.nonce !== undefined) url.searchParams.set("nonce", input.nonce);
  return url.toString();
}

function sameOrigin(value: string, other: string): boolean {
  try {
    return new URL(value).origin === new URL(other).origin;
  } catch {
    return false;
  }
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

function listen(server: Server, port = 0): Promise<void> {
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
    server.listen(port, "127.0.0.1");
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

async function readResponseJson(
  response: Response,
  limit = MAX_RESPONSE_CHARS,
): Promise<Record<string, unknown> | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return undefined;
  const text = await response.text();
  if (text.length > limit) return undefined;
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

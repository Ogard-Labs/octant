import { createHash, randomBytes } from "node:crypto";
import type { IntegrationAccount } from "@octant/contracts/integration";
import {
  INTEGRATION_CREDENTIAL_REF_HEADER,
  type IntegrationPkceAuthorizationRequest,
  type IntegrationPkceBeginResult,
  type IntegrationPkceRefreshResult,
  type IntegrationRevokeResult,
} from "@octant/plugin-api/integration";
import type { IntegrationSecretVault } from "./integrationCredentialVault";

const PENDING_TTL_MS = 10 * 60 * 1_000;
const ACCESS_TOKEN_SKEW_MS = 60 * 1_000;

export const AUTHORIZATION_EXPIRED_REASON = "The authorization expired. Reconnect to continue.";

export interface StoredOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: string;
  readonly expiresAt: number;
  readonly scope: string;
  readonly clientId: string;
  readonly tokenEndpoint: string;
}

export interface IntegrationConnectionState {
  readonly source: "oauth" | "personal-api-key";
  readonly reconnectRequired: boolean;
  readonly account?: IntegrationAccount;
}

interface PendingPkceSession {
  readonly state: string;
  readonly verifier: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly tokenEndpoint: string;
  readonly scope: string;
  readonly createdAt: number;
}

export interface IntegrationOAuthHost {
  readonly beginPkceAuthorization: (
    request: IntegrationPkceAuthorizationRequest,
  ) => Promise<IntegrationPkceBeginResult>;
  readonly completePkceAuthorization: (request: {
    readonly state: string;
    readonly code: string;
  }) => Promise<
    { readonly kind: "stored" } | { readonly kind: "refused"; readonly reason: string }
  >;
  readonly refreshPkceAuthorization: (request: {
    readonly scope: string;
    readonly tokenEndpoint: string;
    readonly clientId: string;
  }) => Promise<IntegrationPkceRefreshResult>;
  readonly revokeCredential: (request: {
    readonly scope: string;
    readonly revokeEndpoint: string;
  }) => Promise<IntegrationRevokeResult>;
  readonly requestCredential: (
    scope: string,
  ) => Promise<
    | { readonly kind: "granted"; readonly reference: string }
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "unavailable"; readonly reason: string }
  >;
  readonly authorizedFetch: (input: Request) => Promise<Response>;
  readonly putSecret: (
    scope: string,
    secret: string,
  ) => Promise<
    { readonly kind: "stored" } | { readonly kind: "unavailable"; readonly reason: string }
  >;
  readonly deleteSecret: (scope: string) => Promise<void>;
  readonly connectionState: () => IntegrationConnectionState | undefined;
  readonly recordAccount: (
    account: IntegrationAccount,
    source: "oauth" | "personal-api-key",
  ) => void;
  readonly clearReconnect: () => void;
}

export function createIntegrationOAuthHost(options: {
  readonly vault: IntegrationSecretVault;
  readonly credentialIds: Readonly<Record<string, string>>;
  readonly fetch?: (input: Request) => Promise<Response>;
  readonly now?: () => number;
  readonly connectionStore?: {
    readonly read: () => IntegrationConnectionState | undefined;
    readonly write: (state: IntegrationConnectionState | undefined) => void;
  };
}): IntegrationOAuthHost {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const pending = new Map<string, PendingPkceSession>();
  const connectionStore = options.connectionStore;
  let connection: IntegrationConnectionState | undefined = connectionStore?.read();
  const oauthId = options.credentialIds["oauth"];
  const personalId = options.credentialIds["personal-api-key"];
  const setConnection = (state: IntegrationConnectionState | undefined) => {
    connection = state;
    connectionStore?.write(state);
  };

  const idFor = (scope: string): string | undefined => options.credentialIds[scope];

  const prunePending = () => {
    const cutoff = now() - PENDING_TTL_MS;
    for (const [state, session] of pending) {
      if (session.createdAt < cutoff) pending.delete(state);
    }
  };

  const readOAuth = async (): Promise<StoredOAuthTokens | undefined> => {
    if (oauthId === undefined) return undefined;
    const raw = await options.vault.resolve(oauthId);
    if (raw === undefined) return undefined;
    return decodeStoredTokens(raw);
  };

  const writeOAuth = async (tokens: StoredOAuthTokens): Promise<boolean> => {
    if (oauthId === undefined) return false;
    const stored = await options.vault.put(oauthId, JSON.stringify(tokens));
    return stored.kind === "stored";
  };

  const deleteOAuth = async () => {
    if (oauthId === undefined) return;
    await options.vault.delete(oauthId);
  };

  const beginPkceAuthorization = async (
    request: IntegrationPkceAuthorizationRequest,
  ): Promise<IntegrationPkceBeginResult> => {
    prunePending();
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(24));
    const authorizationUrl = buildAuthorizationUrl(request, challenge, state);
    pending.set(state, {
      state,
      verifier,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      tokenEndpoint: request.tokenEndpoint,
      scope: request.scopes.join(","),
      createdAt: now(),
    });
    return { kind: "redirect", authorizationUrl };
  };

  const completePkceAuthorization = async (request: {
    readonly state: string;
    readonly code: string;
  }): Promise<
    { readonly kind: "stored" } | { readonly kind: "refused"; readonly reason: string }
  > => {
    prunePending();
    const session = pending.get(request.state);
    pending.delete(request.state);
    if (session === undefined) {
      return { kind: "refused", reason: "The authorization session is unknown or expired." };
    }
    const exchanged = await exchangeTokenForm(fetchImpl, session.tokenEndpoint, {
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: session.redirectUri,
      client_id: session.clientId,
      code_verifier: session.verifier,
    });
    if (exchanged.kind !== "tokens") {
      return {
        kind: "refused",
        reason: exchanged.kind === "failed" ? exchanged.reason : "The authorization was refused.",
      };
    }
    if (
      !(await writeOAuth({
        ...exchanged.tokens,
        clientId: session.clientId,
        tokenEndpoint: session.tokenEndpoint,
      }))
    ) {
      return { kind: "refused", reason: "The secure credential store is unavailable." };
    }
    setConnection({
      source: "oauth",
      reconnectRequired: false,
    });
    return { kind: "stored" };
  };

  const refreshPkceAuthorization = async (request: {
    readonly scope: string;
    readonly tokenEndpoint: string;
    readonly clientId: string;
  }): Promise<IntegrationPkceRefreshResult> => {
    if (request.scope !== "oauth") {
      return { kind: "failed", reason: "Only the host-owned OAuth credential can be refreshed." };
    }
    if (connection?.reconnectRequired === true) return { kind: "invalid_grant" };
    const current = await readOAuth();
    if (current === undefined) {
      return { kind: "failed", reason: "No Linear authorization is stored on this host." };
    }
    const exchanged = await exchangeTokenForm(fetchImpl, request.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: request.clientId,
    });
    if (exchanged.kind === "invalid_grant") {
      setConnection({ source: "oauth", reconnectRequired: true });
      await deleteOAuth();
      return { kind: "invalid_grant" };
    }
    if (exchanged.kind !== "tokens") {
      return { kind: "failed", reason: exchanged.reason };
    }
    if (
      !(await writeOAuth({
        ...exchanged.tokens,
        clientId: request.clientId,
        tokenEndpoint: request.tokenEndpoint,
      }))
    ) {
      return { kind: "failed", reason: "The secure credential store is unavailable." };
    }
    setConnection({
      source: "oauth",
      reconnectRequired: false,
      ...(connection?.account === undefined ? {} : { account: connection.account }),
    });
    return { kind: "ready" };
  };

  const revokeCredential = async (request: {
    readonly scope: string;
    readonly revokeEndpoint: string;
  }): Promise<IntegrationRevokeResult> => {
    const current = request.scope === "oauth" ? await readOAuth() : undefined;
    let revoked = false;
    if (current !== undefined) {
      revoked = await revokeToken(fetchImpl, request.revokeEndpoint, current.accessToken);
    }
    await deleteOAuth();
    if (personalId !== undefined && request.scope === "oauth") {
      // Disconnect of the OAuth connection leaves an advanced personal key in
      // place; it is not a fallback for an expired grant.
    }
    if (request.scope === "personal-api-key" && personalId !== undefined) {
      await options.vault.delete(personalId);
    }
    if (request.scope === "oauth") {
      setConnection(undefined);
    } else if (connection?.source === "personal-api-key") {
      setConnection(undefined);
    }
    return { kind: revoked ? "revoked" : "cleared" };
  };

  const requestCredential: IntegrationOAuthHost["requestCredential"] = async (scope) => {
    const id = idFor(scope);
    if (id === undefined) {
      return { kind: "unavailable", reason: "Unknown credential scope." };
    }
    if (connection?.source === "oauth" && connection.reconnectRequired === true) {
      return { kind: "refused", reason: AUTHORIZATION_EXPIRED_REASON };
    }
    if (!(await options.vault.has(id))) {
      return { kind: "unavailable", reason: "No credential is stored for this integration." };
    }
    return { kind: "granted", reference: id };
  };

  const authorizedFetch = async (input: Request): Promise<Response> => {
    const reference = input.headers.get(INTEGRATION_CREDENTIAL_REF_HEADER);
    if (reference === null) return fetchImpl(input);
    const headers = new Headers(input.headers);
    headers.delete(INTEGRATION_CREDENTIAL_REF_HEADER);
    const prepared = await resolveBearerToken(reference, { refreshIfExpired: true });
    if (prepared.kind === "invalid_grant") {
      return Response.json({ error: "invalid_grant" }, { status: 401 });
    }
    if (prepared.kind !== "token") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    headers.set("authorization", `Bearer ${prepared.token}`);
    const authorized = new Request(input, { headers });
    const response = await fetchImpl(authorized);
    if (response.status !== 401 || reference !== oauthId) return response;
    const refreshed = await resolveBearerToken(reference, { forceRefresh: true });
    if (refreshed.kind === "invalid_grant") {
      return Response.json({ error: "invalid_grant" }, { status: 401 });
    }
    if (refreshed.kind !== "token" || refreshed.token === prepared.token) return response;
    headers.set("authorization", `Bearer ${refreshed.token}`);
    return fetchImpl(new Request(input, { headers }));
  };

  const putSecret: IntegrationOAuthHost["putSecret"] = async (scope, secret) => {
    const id = idFor(scope);
    if (id === undefined) {
      return { kind: "unavailable", reason: "Unknown credential scope." };
    }
    const stored = await options.vault.put(id, secret);
    if (stored.kind === "stored" && scope === "personal-api-key") {
      if (connection?.source !== "oauth" && connection?.reconnectRequired !== true) {
        setConnection({ source: "personal-api-key", reconnectRequired: false });
      }
    }
    return stored;
  };

  const deleteSecret: IntegrationOAuthHost["deleteSecret"] = async (scope) => {
    const id = idFor(scope);
    if (id === undefined) return;
    await options.vault.delete(id);
    if (scope === "personal-api-key" && connection?.source === "personal-api-key") {
      setConnection(undefined);
    }
  };

  async function resolveBearerToken(
    reference: string,
    refresh: { readonly refreshIfExpired?: boolean; readonly forceRefresh?: boolean } = {},
  ): Promise<
    | { readonly kind: "token"; readonly token: string }
    | { readonly kind: "invalid_grant" }
    | { readonly kind: "missing" }
  > {
    if (oauthId !== undefined && reference === oauthId) {
      if (connection?.reconnectRequired === true) return { kind: "invalid_grant" };
      const tokens = await readOAuth();
      if (tokens === undefined) return { kind: "missing" };
      const expired = tokens.expiresAt - ACCESS_TOKEN_SKEW_MS <= now();
      if (!refresh.forceRefresh && !expired) return { kind: "token", token: tokens.accessToken };
      if (!refresh.forceRefresh && !refresh.refreshIfExpired) {
        return { kind: "token", token: tokens.accessToken };
      }
      const refreshed = await refreshPkceAuthorization({
        scope: "oauth",
        tokenEndpoint: tokens.tokenEndpoint,
        clientId: tokens.clientId,
      });
      if (refreshed.kind === "invalid_grant") return { kind: "invalid_grant" };
      if (refreshed.kind !== "ready") return { kind: "token", token: tokens.accessToken };
      const next = await readOAuth();
      if (next === undefined) return { kind: "missing" };
      return { kind: "token", token: next.accessToken };
    }
    if (personalId !== undefined && reference === personalId) {
      const token = await options.vault.resolve(personalId);
      return token === undefined ? { kind: "missing" } : { kind: "token", token };
    }
    return { kind: "missing" };
  }

  return {
    beginPkceAuthorization,
    completePkceAuthorization,
    refreshPkceAuthorization,
    revokeCredential,
    requestCredential,
    authorizedFetch,
    putSecret,
    deleteSecret,
    connectionState: () => connection,
    recordAccount: (account, source) => {
      setConnection({
        source,
        reconnectRequired: false,
        account,
      });
    },
    clearReconnect: () => {
      if (connection === undefined) return;
      setConnection({ ...connection, reconnectRequired: false });
    },
  };
}

function buildAuthorizationUrl(
  request: IntegrationPkceAuthorizationRequest,
  challenge: string,
  state: string,
): string {
  const url = new URL(request.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", request.scopes.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (request.extraParams !== undefined) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

type TokenExchangeResult =
  | {
      readonly kind: "tokens";
      readonly tokens: Omit<StoredOAuthTokens, "clientId" | "tokenEndpoint">;
    }
  | { readonly kind: "invalid_grant" }
  | { readonly kind: "failed"; readonly reason: string };

async function exchangeTokenForm(
  fetchImpl: (input: Request) => Promise<Response>,
  tokenEndpoint: string,
  body: Readonly<Record<string, string>>,
): Promise<TokenExchangeResult> {
  let response: Response;
  try {
    response = await fetchImpl(
      new Request(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      }),
    );
  } catch {
    return { kind: "failed", reason: "The authorization server could not be reached." };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { kind: "failed", reason: "The authorization server returned an invalid response." };
  }
  if (!isRecord(parsed)) {
    return { kind: "failed", reason: "The authorization server returned an invalid response." };
  }
  if (parsed.error === "invalid_grant") return { kind: "invalid_grant" };
  if (!response.ok) {
    return { kind: "failed", reason: "The authorization server refused the request." };
  }
  const tokens = readTokenResponse(parsed);
  if (tokens === undefined) {
    return { kind: "failed", reason: "The authorization server returned an invalid response." };
  }
  return { kind: "tokens", tokens };
}

async function revokeToken(
  fetchImpl: (input: Request) => Promise<Response>,
  revokeEndpoint: string,
  token: string,
): Promise<boolean> {
  try {
    const response = await fetchImpl(
      new Request(revokeEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
      }),
    );
    return response.ok;
  } catch {
    return false;
  }
}

function readTokenResponse(
  value: Record<string, unknown>,
): Omit<StoredOAuthTokens, "clientId" | "tokenEndpoint"> | undefined {
  if (typeof value.access_token !== "string" || value.access_token.length === 0) return undefined;
  if (typeof value.refresh_token !== "string" || value.refresh_token.length === 0) return undefined;
  const expiresIn = typeof value.expires_in === "number" ? value.expires_in : 86_399;
  const scope =
    typeof value.scope === "string"
      ? value.scope
      : Array.isArray(value.scope)
        ? value.scope.filter((item): item is string => typeof item === "string").join(" ")
        : "";
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    tokenType: typeof value.token_type === "string" ? value.token_type : "Bearer",
    expiresAt: Date.now() + Math.max(0, expiresIn) * 1_000,
    scope,
  };
}

function decodeStoredTokens(raw: string): StoredOAuthTokens | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return undefined;
    if (typeof value.accessToken !== "string" || value.accessToken.length === 0) return undefined;
    if (typeof value.refreshToken !== "string" || value.refreshToken.length === 0) return undefined;
    if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return undefined;
    if (typeof value.clientId !== "string" || value.clientId.length === 0) return undefined;
    if (typeof value.tokenEndpoint !== "string" || value.tokenEndpoint.length === 0) {
      return undefined;
    }
    return {
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      tokenType: typeof value.tokenType === "string" ? value.tokenType : "Bearer",
      expiresAt: value.expiresAt,
      scope: typeof value.scope === "string" ? value.scope : "",
      clientId: value.clientId,
      tokenEndpoint: value.tokenEndpoint,
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

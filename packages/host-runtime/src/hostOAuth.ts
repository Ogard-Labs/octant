import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";

const GRANT_KIND = "host-oauth-grant";
const CALLBACK_PATH = "/oauth/callback";
const OPENROUTER_DIALECT = "openrouter-pkce";
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

export type HostOAuthFlow = "authorization-code-pkce" | "device-code";

/** Vendor wire dialect for OpenRouter's PKCE key exchange. */
export type HostOAuthDialect = "openrouter-pkce";

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
  readonly close: () => Promise<void>;
}

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

export function createHostOAuthRuntime(options: {
  readonly store: CredentialStore;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}): HostOAuthRuntime {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const attempts = new Map<string, Attempt>();
  const inflightRefresh = new Map<string, Promise<HostOAuthRefreshResult>>();
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
      const authorizationUrl =
        descriptor.dialect === OPENROUTER_DIALECT
          ? openRouterAuthorizationRequest(authorizationEndpoint, {
              redirectUri,
              challenge,
              state,
            })
          : authorizationRequest(authorizationEndpoint, {
              clientId: descriptor.clientId ?? "",
              redirectUri,
              scope: descriptor.scopes.join(" "),
              state,
              challenge,
            });
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
    const exchanged = await exchangeAuthorizationCode({
      tokenEndpoint: session.descriptor.tokenEndpoint,
      clientId: session.descriptor.clientId ?? "",
      code,
      redirectUri: session.redirectUri,
      verifier: session.verifier,
      challenge: session.challenge,
      fetch: fetchImpl,
      now,
      ...(session.descriptor.dialect === undefined ? {} : { dialect: session.descriptor.dialect }),
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
        };
      } catch (error) {
        if (error instanceof CredentialStoreFailure && error.category === "missing") {
          return { kind: "sign-in-again", reason: "expired" };
        }
        return { kind: "unavailable" };
      }
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
    },
    { headers: { "cache-control": "no-store" } },
  );
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
  if (
    accessToken === undefined ||
    refreshToken === undefined ||
    accessToken.length > MAX_TOKEN_CHARS ||
    refreshToken.length > MAX_TOKEN_CHARS
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
  if (error === "invalid_grant") {
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
  if (error === "expired_token" || reason === "timeout") return "expired";
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
  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    typeof tokenType !== "string" ||
    (expiresAt !== undefined && typeof expiresAt !== "number") ||
    typeof scope !== "string" ||
    typeof clientId !== "string" ||
    typeof tokenEndpoint !== "string" ||
    typeof generation !== "number" ||
    (dialect !== undefined && typeof dialect !== "string")
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
  };
}

function validateDescriptor(descriptor: HostOAuthDescriptor): HostOAuthDescriptor | undefined {
  if (!safeId(descriptor.descriptorId) || !safeId(descriptor.termsId)) return undefined;
  const dialect = descriptor.dialect;
  if (dialect !== undefined && dialect !== OPENROUTER_DIALECT) return undefined;
  // A dialect entry declares its own wire shape (OpenRouter: no client
  // registration, no scopes). Every other flow needs a client identity and
  // at least one scope.
  if (dialect === undefined) {
    if (typeof descriptor.clientId !== "string" || !safeClientId(descriptor.clientId)) {
      return undefined;
    }
    if (descriptor.scopes.length === 0) return undefined;
  }
  if (descriptor.flow !== "authorization-code-pkce" && descriptor.flow !== "device-code")
    return undefined;
  // The OpenRouter dialect exists precisely because its wire shape is not
  // OAuth; a device-code grant cannot pair with it.
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
  if (dialect !== undefined && dialect !== OPENROUTER_DIALECT) return undefined;
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

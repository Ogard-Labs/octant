import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { HostOAuthDescriptor } from "./hostOAuth";

/**
 * An organization's own OpenID Connect issuer over HTTP: its discovery
 * document, authorize, token, and key-set endpoints, for proving the
 * broker's issuer dialect without a real identity provider.
 *
 * The issuer is named by an https address, so `fetch` routes that host to
 * this server and refuses every other non-loopback host; `hostsContacted`
 * then shows the broker reached no identity provider but the configured one.
 * Every code and token the fake issues is recorded so a test can prove none
 * escapes.
 */

export const ISSUER_HOST = "login.gateway-issuer.example";
export const ISSUER = `https://${ISSUER_HOST}/oauth2/gateway`;
export const ISSUER_CLIENT_ID = "0oa1octantDesktop";
export const GATEWAY_SCOPE = "gateway.models";
export const GATEWAY_ORIGIN = "https://llm.gateway-issuer.example";
export const ISSUER_SUBJECT = "issuer-subject-41c9";
export const ISSUER_ACCOUNT_LABEL = "ada@gateway-issuer.example";

const ISSUER_ORIGIN = `https://${ISSUER_HOST}`;
const KEY_ID = "issuer-key-1";

export function issuerDescriptor(
  overrides: Partial<HostOAuthDescriptor> = {},
): HostOAuthDescriptor {
  return {
    descriptorId: "gateway-directory",
    dialect: "issuer-oidc",
    flow: "authorization-code-pkce",
    issuer: ISSUER,
    clientId: ISSUER_CLIENT_ID,
    endpointOrigin: GATEWAY_ORIGIN,
    scopes: [GATEWAY_SCOPE],
    termsId: "gateway-directory-1",
    ...overrides,
  };
}

export const ISSUER_BINDING = Object.freeze({
  issuer: ISSUER,
  clientId: ISSUER_CLIENT_ID,
  scope: GATEWAY_SCOPE,
  endpointOrigin: GATEWAY_ORIGIN,
});

/** How the discovery document is wrong, when it is. */
export type FakeDiscoveryFlaw =
  | "other-issuer"
  | "token-endpoint-off-origin"
  | "authorize-endpoint-off-origin"
  | "key-set-off-origin"
  | "no-s256"
  | "unreachable"
  | "server-error";

/** How the exchange's identity token is wrong, when it is. */
export type FakeIssuerIdTokenFlaw =
  | "other-issuer"
  | "other-audience"
  | "other-nonce"
  | "expired"
  | "unpublished-key"
  | "missing";

export type FakeIssuerRefreshAnswer =
  | {
      readonly kind: "tokens";
      readonly idToken?: "same-subject" | "other-subject";
      readonly scope?: string;
    }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "status"; readonly status: number };

export interface FakeIssuer {
  readonly fetch: typeof fetch;
  /** Every non-loopback host a request named, in order. */
  readonly hostsContacted: () => ReadonlyArray<string>;
  readonly discoveryRequests: () => number;
  readonly authorizeRequests: () => ReadonlyArray<URL>;
  readonly tokenRequests: () => ReadonlyArray<Readonly<Record<string, string>>>;
  /** Every authorization code, access, refresh, and identity token issued. */
  readonly issued: () => ReadonlyArray<string>;
  readonly flawDiscovery: (flaw: FakeDiscoveryFlaw | undefined) => void;
  readonly flawExchangeIdToken: (flaw: FakeIssuerIdTokenFlaw | undefined) => void;
  /** The scope the code exchange echoes; `undefined` leaves it out. */
  readonly echoExchangeScope: (scope: string | undefined) => void;
  readonly answerRefreshWith: (answer: FakeIssuerRefreshAnswer) => void;
  /** Act as the person's browser: open the authorize URL and follow it to the callback. */
  readonly consent: (authorizationUrl: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

let sharedKeys:
  | {
      readonly signing: { readonly publicKey: KeyObject; readonly privateKey: KeyObject };
      readonly unpublished: KeyObject;
    }
  | undefined;

function keys() {
  sharedKeys ??= {
    signing: generateKeyPairSync("rsa", { modulusLength: 2048 }),
    unpublished: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
  };
  return sharedKeys;
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const { signing, unpublished } = keys();
  const hosts: string[] = [];
  const authorizeRequests: URL[] = [];
  const tokenRequests: Record<string, string>[] = [];
  const issued: string[] = [];
  const codes = new Map<
    string,
    { readonly challenge: string; readonly redirectUri: string; readonly nonce: string }
  >();
  let discoveryRequests = 0;
  let discoveryFlaw: FakeDiscoveryFlaw | undefined;
  let exchangeFlaw: FakeIssuerIdTokenFlaw | undefined;
  let exchangeScope: string | undefined = `openid profile ${GATEWAY_SCOPE}`;
  let refreshAnswer: FakeIssuerRefreshAnswer = { kind: "tokens" };

  const issue = (kind: string): string => {
    const value = `fake-issuer-${kind}-${randomUUID()}`;
    issued.push(value);
    return value;
  };
  const identityToken = (claims: Readonly<Record<string, unknown>>, key: KeyObject): string => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: KEY_ID })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = cryptoSign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
    const token = `${header}.${payload}.${signature.toString("base64url")}`;
    issued.push(token);
    return token;
  };
  const claims = (nonce: string | undefined, subject = ISSUER_SUBJECT) => ({
    iss: ISSUER,
    aud: ISSUER_CLIENT_ID,
    sub: subject,
    preferred_username: ISSUER_ACCOUNT_LABEL,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    ...(nonce === undefined ? {} : { nonce }),
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, body: Readonly<Record<string, unknown>>) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (
      request.method === "GET" &&
      url.pathname === "/oauth2/gateway/.well-known/openid-configuration"
    ) {
      discoveryRequests += 1;
      const flaw = discoveryFlaw;
      if (flaw === "unreachable") {
        request.socket.destroy();
        return;
      }
      if (flaw === "server-error") return reply(503, {});
      const elsewhere = "https://login.look-alike.example/oauth2/gateway";
      return reply(200, {
        issuer: flaw === "other-issuer" ? elsewhere : ISSUER,
        authorization_endpoint: `${flaw === "authorize-endpoint-off-origin" ? elsewhere : ISSUER}/v1/authorize`,
        token_endpoint: `${flaw === "token-endpoint-off-origin" ? elsewhere : ISSUER}/v1/token`,
        jwks_uri: `${flaw === "key-set-off-origin" ? elsewhere : ISSUER}/v1/keys`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: flaw === "no-s256" ? ["plain"] : ["S256"],
      });
    }
    if (request.method === "GET" && url.pathname === "/oauth2/gateway/v1/keys") {
      const jwk = signing.publicKey.export({ format: "jwk" });
      return reply(200, { keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid: KEY_ID, ...jwk }] });
    }
    if (request.method === "GET" && url.pathname === "/oauth2/gateway/v1/authorize") {
      authorizeRequests.push(url);
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      const nonce = url.searchParams.get("nonce");
      if (redirectUri === null || state === null || challenge === null || nonce === null) {
        response.writeHead(400);
        response.end();
        return;
      }
      const code = issue("code");
      codes.set(code, { challenge, redirectUri, nonce });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/oauth2/gateway/v1/token") {
      return reply(404, { error: "not_found" });
    }
    void readForm(request).then((form) => {
      tokenRequests.push(form);
      if (form.grant_type === "authorization_code") {
        const pending = codes.get(form.code ?? "");
        codes.delete(form.code ?? "");
        const verified =
          pending !== undefined &&
          form.client_id === ISSUER_CLIENT_ID &&
          pending.redirectUri === form.redirect_uri &&
          createHash("sha256")
            .update(form.code_verifier ?? "")
            .digest("base64url") === pending.challenge;
        if (!verified) return reply(400, { error: "invalid_grant" });
        const flaw = exchangeFlaw;
        const tokenClaims = {
          ...claims(pending.nonce),
          ...(flaw === "other-issuer"
            ? { iss: "https://login.look-alike.example/oauth2/gateway" }
            : {}),
          ...(flaw === "other-audience" ? { aud: "another-client" } : {}),
          ...(flaw === "other-nonce" ? { nonce: randomUUID() } : {}),
          ...(flaw === "expired" ? { exp: Math.floor(Date.now() / 1_000) - 3_600 } : {}),
        };
        return reply(200, {
          token_type: "Bearer",
          expires_in: 3_600,
          access_token: issue("access"),
          refresh_token: issue("refresh"),
          ...(exchangeScope === undefined ? {} : { scope: exchangeScope }),
          ...(flaw === "missing"
            ? {}
            : {
                id_token: identityToken(
                  tokenClaims,
                  flaw === "unpublished-key" ? unpublished : signing.privateKey,
                ),
              }),
        });
      }
      if (form.grant_type !== "refresh_token")
        return reply(400, { error: "unsupported_grant_type" });
      const answer = refreshAnswer;
      if (answer.kind === "status") return reply(answer.status, {});
      if (answer.kind === "error") {
        return reply(400, {
          error: answer.error,
          error_description: `The refresh token ${form.refresh_token ?? ""} is not accepted.`,
        });
      }
      return reply(200, {
        token_type: "Bearer",
        expires_in: 3_600,
        scope: answer.scope ?? GATEWAY_SCOPE,
        access_token: issue("access"),
        refresh_token: issue("refresh"),
        ...(answer.idToken === undefined
          ? {}
          : {
              id_token: identityToken(
                claims(
                  undefined,
                  answer.idToken === "other-subject" ? "someone-else" : ISSUER_SUBJECT,
                ),
                signing.privateKey,
              ),
            }),
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const route = (input: RequestInfo | URL): URL => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") hosts.push(url.host);
    if (url.origin === ISSUER_ORIGIN) return new URL(`${url.pathname}${url.search}`, base);
    return url;
  };
  const routedFetch: typeof fetch = async (input, init) => {
    const url = route(input);
    if (url.hostname !== "127.0.0.1") throw new TypeError("fetch failed");
    return fetch(url, init);
  };

  return {
    fetch: routedFetch,
    hostsContacted: () => [...hosts],
    discoveryRequests: () => discoveryRequests,
    authorizeRequests: () => [...authorizeRequests],
    tokenRequests: () => [...tokenRequests],
    issued: () => [...issued],
    flawDiscovery: (flaw) => {
      discoveryFlaw = flaw;
    },
    flawExchangeIdToken: (flaw) => {
      exchangeFlaw = flaw;
    },
    echoExchangeScope: (scope) => {
      exchangeScope = scope;
    },
    answerRefreshWith: (answer) => {
      refreshAnswer = answer;
    },
    consent: async (authorizationUrl) => {
      const redirected = await routedFetch(authorizationUrl, { redirect: "manual" });
      const location = redirected.headers.get("location");
      if (location === null) throw new Error("The fake issuer did not redirect to the callback.");
      await fetch(location);
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function readForm(request: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    });
  });
}

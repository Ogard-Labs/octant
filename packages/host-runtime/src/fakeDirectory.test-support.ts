import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HostOAuthDescriptor } from "./hostOAuth";

/**
 * An organization's directory over HTTP: the tenant's authorize, token, and
 * key-set endpoints, answering as the directory documents them, for proving
 * the broker's directory dialect without a real tenant.
 *
 * The broker builds its authority from the production directory host and
 * has no switch to name another, so `fetch` routes that host to this server
 * and refuses every other non-loopback host; `hostsContacted` then shows the
 * broker reached no identity provider but the closed one. Every code and
 * token the fake issues is recorded so a test can prove none escapes.
 */

export const DIRECTORY_HOST = "login.microsoftonline.com";
export const TENANT_ID = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
export const OTHER_TENANT_ID = "7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
export const CLIENT_ID = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
export const AUDIENCE = "https://cognitiveservices.azure.com";
export const ENDPOINT_ORIGIN = "https://contoso.openai.azure.com";
export const SUBJECT = "directory-subject-7f3a";
export const ACCOUNT_LABEL = "ada@contoso.example";

const DIRECTORY_ORIGIN = `https://${DIRECTORY_HOST}`;
const KEY_ID = "directory-key-1";

export function directoryDescriptor(
  overrides: Partial<HostOAuthDescriptor> = {},
): HostOAuthDescriptor {
  return {
    descriptorId: "azure-foundry-directory",
    dialect: "directory-oidc",
    flow: "authorization-code-pkce",
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    audience: AUDIENCE,
    endpointOrigin: ENDPOINT_ORIGIN,
    scopes: [],
    termsId: "azure-foundry-directory-terms-1",
    ...overrides,
  };
}

export const BINDING = Object.freeze({
  tenantId: TENANT_ID,
  clientId: CLIENT_ID,
  audience: AUDIENCE,
  endpointOrigin: ENDPOINT_ORIGIN,
});

/** How the exchange's identity token is wrong, when it is. */
export type FakeIdTokenFlaw =
  | "other-tenant"
  | "other-issuer"
  | "other-audience"
  | "other-nonce"
  | "expired"
  | "unpublished-key"
  | "missing";

/** How the directory answers every later refresh. */
export type FakeRefreshAnswer =
  | {
      readonly kind: "tokens";
      /** Whether the answer carries a new identity token, and whose. */
      readonly idToken?: "same-subject" | "other-subject" | "other-tenant";
      readonly scope?: string;
    }
  | {
      readonly kind: "error";
      readonly error: string;
      readonly suberror?: string;
      readonly errorCodes?: ReadonlyArray<number>;
    }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "unreachable" };

export interface FakeDirectory {
  /** A fetch that reaches this directory in place of the production host. */
  readonly fetch: typeof fetch;
  /** Every non-loopback host a request named, in order. */
  readonly hostsContacted: () => ReadonlyArray<string>;
  readonly authorizeRequests: () => ReadonlyArray<URL>;
  readonly tokenRequests: () => ReadonlyArray<Readonly<Record<string, string>>>;
  readonly keySetRequests: () => number;
  /** Every authorization code, access, refresh, and identity token issued. */
  readonly issued: () => ReadonlyArray<string>;
  readonly answerRefreshWith: (answer: FakeRefreshAnswer) => void;
  readonly flawExchangeIdToken: (flaw: FakeIdTokenFlaw | undefined) => void;
  /** The scope the code exchange echoes. */
  readonly echoExchangeScope: (scope: string) => void;
  /** Act as the person's browser: open the authorize URL and follow it to the callback. */
  readonly consent: (authorizationUrl: string) => Promise<void>;
  /** Every device authorization request, as its form fields. */
  readonly deviceRequests: () => ReadonlyArray<Readonly<Record<string, string>>>;
  /** How the device authorization endpoint answers the next request. */
  readonly answerDeviceAuthorizationWith: (answer: FakeDeviceAuthorizationAnswer) => void;
  /**
   * Act as the person on another device: enter the code at the verification
   * page and approve, decline, or let the code expire.
   */
  readonly settleDeviceCode: (
    userCode: string,
    outcome: "approved" | "declined" | "expired",
  ) => void;
  readonly close: () => Promise<void>;
}

/** How the device authorization endpoint answers. */
export type FakeDeviceAuthorizationAnswer =
  | { readonly kind: "code"; readonly verificationUri?: string }
  | { readonly kind: "error"; readonly status: number; readonly error: string };

/** The verification page the directory names for a device code. */
export const DEVICE_VERIFICATION_URI = "https://microsoft.com/devicelogin";

interface KeyPairs {
  readonly signing: { readonly publicKey: KeyObject; readonly privateKey: KeyObject };
  readonly unpublished: { readonly privateKey: KeyObject };
}

// RSA generation is slow; every fake directory in a run shares one pair.
let sharedKeyPairs: KeyPairs | undefined;

function keyPairs(): KeyPairs {
  sharedKeyPairs ??= {
    signing: generateKeyPairSync("rsa", { modulusLength: 2048 }),
    unpublished: generateKeyPairSync("rsa", { modulusLength: 2048 }),
  };
  return sharedKeyPairs;
}

interface PendingCode {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly nonce: string;
  readonly clientId: string;
}

interface PendingDevice {
  readonly userCode: string;
  readonly clientId: string;
  outcome: "pending" | "approved" | "declined" | "expired";
}

export async function startFakeDirectory(): Promise<FakeDirectory> {
  const { signing, unpublished } = keyPairs();
  const hosts: string[] = [];
  const authorizeRequests: URL[] = [];
  const tokenRequests: Record<string, string>[] = [];
  const issued: string[] = [];
  const codes = new Map<string, PendingCode>();
  let keySetRequests = 0;
  let refreshAnswer: FakeRefreshAnswer = { kind: "tokens" };
  let exchangeFlaw: FakeIdTokenFlaw | undefined;
  let exchangeScope = `${AUDIENCE}/user_impersonation`;
  const deviceRequests: Record<string, string>[] = [];
  const devices = new Map<string, PendingDevice>();
  let deviceAnswer: FakeDeviceAuthorizationAnswer = { kind: "code" };

  const issue = (kind: string): string => {
    const value = `fake-directory-${kind}-${randomUUID()}`;
    issued.push(value);
    return value;
  };
  const identityToken = (
    claims: Readonly<Record<string, unknown>>,
    key: KeyObject = signing.privateKey,
  ): string => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KEY_ID })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = cryptoSign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`, "utf8"),
      key,
    ).toString("base64url");
    const token = `${header}.${payload}.${signature}`;
    issued.push(token);
    return token;
  };
  const claimsFor = (tenantId: string, nonce: string | undefined, subject = SUBJECT) => ({
    iss: `${DIRECTORY_ORIGIN}/${tenantId}/v2.0`,
    aud: CLIENT_ID,
    tid: tenantId,
    sub: subject,
    oid: "3c1f6a2e-9d4b-4e8a-b7c6-5d4e3f2a1b0c",
    preferred_username: ACCOUNT_LABEL,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    ...(nonce === undefined ? {} : { nonce }),
  });
  /**
   * The answer to a finished sign-in, with the identity token the configured
   * flaw describes. A device-code sign-in sends no nonce, so its token has none.
   */
  const signedInTokens = (nonce: string | undefined): Readonly<Record<string, unknown>> => {
    const flaw = exchangeFlaw;
    const claims = {
      ...claimsFor(flaw === "other-tenant" ? OTHER_TENANT_ID : TENANT_ID, nonce),
      ...(flaw === "other-tenant" ? { iss: `${DIRECTORY_ORIGIN}/${TENANT_ID}/v2.0` } : {}),
      ...(flaw === "other-issuer" ? { iss: `${DIRECTORY_ORIGIN}/${OTHER_TENANT_ID}/v2.0` } : {}),
      ...(flaw === "other-audience" ? { aud: randomUUID() } : {}),
      ...(flaw === "other-nonce" ? { nonce: randomUUID() } : {}),
      ...(flaw === "expired" ? { exp: Math.floor(Date.now() / 1_000) - 3_600 } : {}),
    };
    return {
      token_type: "Bearer",
      scope: exchangeScope,
      expires_in: 3_599,
      ext_expires_in: 3_599,
      access_token: issue("access"),
      refresh_token: issue("refresh"),
      ...(flaw === "missing"
        ? {}
        : {
            id_token: identityToken(
              claims,
              flaw === "unpublished-key" ? unpublished.privateKey : signing.privateKey,
            ),
          }),
    };
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match =
      /^\/([^/]+)\/(oauth2\/v2\.0\/authorize|oauth2\/v2\.0\/token|oauth2\/v2\.0\/devicecode|discovery\/v2\.0\/keys)$/.exec(
        url.pathname,
      );
    const tenant = match?.[1];
    const route = match?.[2];
    // The directory answers a tenant it does not hold with an error, never a page.
    if (tenant !== TENANT_ID || route === undefined) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_tenant" }));
      return;
    }
    if (request.method === "GET" && route === "discovery/v2.0/keys") {
      keySetRequests += 1;
      const jwk = signing.publicKey.export({ format: "jwk" });
      response.writeHead(200, { "content-type": "application/json" });
      // The directory publishes no `alg` on its keys.
      response.end(JSON.stringify({ keys: [{ kty: "RSA", use: "sig", kid: KEY_ID, ...jwk }] }));
      return;
    }
    if (request.method === "GET" && route === "oauth2/v2.0/authorize") {
      authorizeRequests.push(url);
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      const nonce = url.searchParams.get("nonce");
      const clientId = url.searchParams.get("client_id");
      if (
        redirectUri === null ||
        state === null ||
        challenge === null ||
        nonce === null ||
        clientId === null
      ) {
        response.writeHead(400);
        response.end();
        return;
      }
      // The directory's authorization codes are opaque and run past a thousand
      // characters (an Entra ID code of 1,350 characters has been reported), so
      // the fake issues one that long rather than a short stand-in.
      const code = `fake-directory-code-${randomBytes(1_000).toString("base64url")}`;
      issued.push(code);
      codes.set(code, { challenge, redirectUri, nonce, clientId });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      callback.searchParams.set("session_state", randomUUID());
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }
    if (request.method === "POST" && route === "oauth2/v2.0/devicecode") {
      void readForm(request).then((form) => {
        deviceRequests.push(form);
        const answer = deviceAnswer;
        response.writeHead(answer.kind === "error" ? answer.status : 200, {
          "content-type": "application/json",
        });
        if (answer.kind === "error") {
          response.end(JSON.stringify({ error: answer.error, error_codes: [7000218] }));
          return;
        }
        const deviceCode = issue("device-code");
        const userCode = randomBytes(6).toString("hex").toUpperCase().slice(0, 9);
        devices.set(deviceCode, { userCode, clientId: form.client_id ?? "", outcome: "pending" });
        response.end(
          JSON.stringify({
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: answer.verificationUri ?? DEVICE_VERIFICATION_URI,
            expires_in: 900,
            interval: 5,
            // Free text the broker must never show: only the code and the page are its own.
            message: `To sign in, use a web browser to open the page and enter the code ${userCode}.`,
          }),
        );
      });
      return;
    }
    if (request.method !== "POST" || route !== "oauth2/v2.0/token") {
      response.writeHead(405);
      response.end();
      return;
    }
    void readForm(request).then((form) => {
      tokenRequests.push(form);
      const reply = (status: number, body: Readonly<Record<string, unknown>>) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (form.grant_type === "authorization_code") {
        const pending = codes.get(form.code ?? "");
        codes.delete(form.code ?? "");
        const verified =
          pending !== undefined &&
          pending.clientId === form.client_id &&
          pending.redirectUri === form.redirect_uri &&
          createHash("sha256")
            .update(form.code_verifier ?? "")
            .digest("base64url") === pending.challenge;
        if (!verified) {
          reply(400, { error: "invalid_grant", error_codes: [70002] });
          return;
        }
        reply(200, signedInTokens(pending.nonce));
        return;
      }
      if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        const device = devices.get(form.device_code ?? "");
        if (device === undefined || device.clientId !== form.client_id) {
          reply(400, { error: "bad_verification_code", error_codes: [70019] });
          return;
        }
        // The directory's own codes for each state of a device code.
        if (device.outcome === "pending") {
          reply(400, { error: "authorization_pending", error_codes: [70016] });
          return;
        }
        if (device.outcome === "declined") {
          reply(400, { error: "authorization_declined", error_codes: [70000] });
          return;
        }
        if (device.outcome === "expired") {
          reply(400, { error: "expired_token", error_codes: [70019] });
          return;
        }
        devices.delete(form.device_code ?? "");
        reply(200, signedInTokens(undefined));
        return;
      }
      if (form.grant_type !== "refresh_token") {
        reply(400, { error: "unsupported_grant_type" });
        return;
      }
      const answer = refreshAnswer;
      if (answer.kind === "unreachable") {
        request.socket.destroy();
        return;
      }
      if (answer.kind === "status") {
        reply(answer.status, {});
        return;
      }
      if (answer.kind === "error") {
        reply(400, {
          error: answer.error,
          error_description: `AADSTS: refused; the refresh token ${form.refresh_token ?? ""} is not accepted.`,
          ...(answer.suberror === undefined ? {} : { suberror: answer.suberror }),
          ...(answer.errorCodes === undefined ? {} : { error_codes: answer.errorCodes }),
        });
        return;
      }
      const idToken =
        answer.idToken === undefined
          ? undefined
          : identityToken(
              claimsFor(
                answer.idToken === "other-tenant" ? OTHER_TENANT_ID : TENANT_ID,
                undefined,
                answer.idToken === "other-subject" ? "someone-else" : SUBJECT,
              ),
            );
      reply(200, {
        token_type: "Bearer",
        scope: answer.scope ?? `${AUDIENCE}/user_impersonation`,
        expires_in: 3_599,
        access_token: issue("access"),
        refresh_token: issue("refresh"),
        ...(idToken === undefined ? {} : { id_token: idToken }),
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
    if (url.origin === DIRECTORY_ORIGIN) return new URL(`${url.pathname}${url.search}`, base);
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
    authorizeRequests: () => [...authorizeRequests],
    tokenRequests: () => [...tokenRequests],
    keySetRequests: () => keySetRequests,
    issued: () => [...issued],
    answerRefreshWith: (answer) => {
      refreshAnswer = answer;
    },
    flawExchangeIdToken: (flaw) => {
      exchangeFlaw = flaw;
    },
    echoExchangeScope: (scope) => {
      exchangeScope = scope;
    },
    deviceRequests: () => [...deviceRequests],
    answerDeviceAuthorizationWith: (answer) => {
      deviceAnswer = answer;
    },
    settleDeviceCode: (userCode, outcome) => {
      const device = [...devices.values()].find((candidate) => candidate.userCode === userCode);
      if (device === undefined) throw new Error("The fake directory issued no such user code.");
      device.outcome = outcome;
    },
    consent: async (authorizationUrl) => {
      const redirected = await routedFetch(authorizationUrl, { redirect: "manual" });
      const location = redirected.headers.get("location");
      if (location === null)
        throw new Error("The fake directory did not redirect to the callback.");
      await fetch(location);
    },
    close: () => closeServer(server),
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

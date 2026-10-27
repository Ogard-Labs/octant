import { createHmac, randomBytes } from "node:crypto";
import type { CloudIamDescriptor } from "./cloudIam";
import { sha256Hex, sigV4CanonicalRequest, sigV4SigningKey } from "./sigV4";

/**
 * An in-memory stand-in for the cloud's single sign-on (the portal's OIDC
 * service and its role-credential endpoint) and for one model endpoint that
 * checks every Signature Version 4 request against the credentials the portal
 * minted. It answers only the hosts the broker builds for its region and
 * throws for any other, so a test proves the broker reaches nothing else and
 * no real cloud endpoint is ever called.
 */

export const SSO_REGION = "us-east-1";
export const MODEL_REGION = "us-west-2";
export const START_URL = "https://contoso-example.awsapps.com/start";
export const ACCOUNT_ID = "123456789012";
export const ROLE_NAME = "BedrockInvoke";
export const OIDC_HOST = `oidc.${SSO_REGION}.amazonaws.com`;
export const PORTAL_HOST = `portal.sso.${SSO_REGION}.amazonaws.com`;
export const MODEL_HOST = `bedrock-runtime.${MODEL_REGION}.amazonaws.com`;
export const DEVICE_PAGE = `https://device.sso.${SSO_REGION}.amazonaws.com/`;
export const MODEL_PATH = "/model/anthropic.claude-sonnet-4-20250514-v1%3A0/converse";

export function cloudDescriptor(
  overrides: Partial<{
    readonly source: Partial<CloudIamDescriptor["source"]>;
    readonly scope: Partial<Record<keyof CloudIamDescriptor["scope"], string>>;
  }> = {},
): CloudIamDescriptor {
  return {
    descriptorId: "amazon-bedrock-cloud-iam",
    termsId: "amazon-bedrock-cloud-iam-1",
    flow: "device-code",
    source: {
      startUrl: START_URL,
      ssoRegion: SSO_REGION,
      accountId: ACCOUNT_ID,
      roleName: ROLE_NAME,
      ...overrides.source,
    },
    scope: {
      partition: "aws",
      region: MODEL_REGION,
      service: "bedrock",
      host: MODEL_HOST,
      pathPrefix: "/model/",
      method: "POST",
      ...overrides.scope,
    } as CloudIamDescriptor["scope"],
  };
}

export type FakeRefreshAnswer =
  | "rotated"
  | "invalid_grant"
  | "invalid_client"
  | "access_denied"
  | "server-error"
  | "unreachable";

export type FakeMintAnswer = "credentials" | "forbidden" | "unauthorized" | "server-error";

interface MintedRole {
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  valid: boolean;
}

export interface FakeCloudRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

export class FakeCloud {
  readonly #clients = new Map<string, string>();
  readonly #devices = new Map<string, { state: "pending" | "approved" | "declined" | "expired" }>();
  readonly #sessions = new Set<string>();
  readonly #refreshTokens = new Set<string>();
  readonly #roles = new Map<string, MintedRole>();
  readonly #secrets: string[] = [];
  readonly #requests: FakeCloudRequest[] = [];
  #now: () => number;
  #refreshAnswer: FakeRefreshAnswer = "rotated";
  #mintAnswers: FakeMintAnswer[] = [];
  #roleLifetimeMs = 60 * 60_000;
  #sessionLifetimeSeconds = 8 * 60 * 60;
  #verificationUri = DEVICE_PAGE;
  #grantsRefreshToken = true;
  #reachable = true;
  #deviceAnswer: "issued" | "refused" | "unavailable" = "issued";

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    const request: FakeCloudRequest = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body,
    };
    this.#requests.push(request);
    if (!this.#reachable) throw new TypeError("fetch failed");
    if (url.host === OIDC_HOST) return this.#oidc(url.pathname, body);
    if (url.host === PORTAL_HOST) return this.#portal(request);
    if (url.host === MODEL_HOST) return this.#model(request);
    throw new Error(`the fake cloud does not serve ${url.host}`);
  };

  /** Every request the broker made, by host, for "nothing else was contacted". */
  requests(): ReadonlyArray<FakeCloudRequest> {
    return [...this.#requests];
  }

  count(host: string, path: string): number {
    return this.#requests.filter(
      (request) => request.url.host === host && request.url.pathname === path,
    ).length;
  }

  /** Every secret the fake issued: none may appear in a broker answer but its own place. */
  secrets(): ReadonlyArray<string> {
    return [...this.#secrets];
  }

  sessionTokens(): ReadonlyArray<string> {
    return [...this.#roles.values()].map((role) => role.sessionToken);
  }

  approve(userCode?: string): void {
    for (const [code, device] of this.#devices) {
      if (userCode === undefined || code.endsWith(userCode)) device.state = "approved";
    }
  }

  decline(): void {
    for (const device of this.#devices.values()) device.state = "declined";
  }

  expireCodes(): void {
    for (const device of this.#devices.values()) device.state = "expired";
  }

  answerRefreshWith(answer: FakeRefreshAnswer): void {
    this.#refreshAnswer = answer;
  }

  /** The next mint answers, in order; after them, credentials. */
  answerMintWith(...answers: FakeMintAnswer[]): void {
    this.#mintAnswers = answers;
  }

  setRoleLifetimeMs(value: number): void {
    this.#roleLifetimeMs = value;
  }

  setSessionLifetimeSeconds(value: number): void {
    this.#sessionLifetimeSeconds = value;
  }

  setVerificationUri(value: string): void {
    this.#verificationUri = value;
  }

  setGrantsRefreshToken(value: boolean): void {
    this.#grantsRefreshToken = value;
  }

  setReachable(value: boolean): void {
    this.#reachable = value;
  }

  setDeviceAnswer(value: "issued" | "refused" | "unavailable"): void {
    this.#deviceAnswer = value;
  }

  /** Every session and refresh token stops working, as an administrator's revocation does. */
  revokeSessions(): void {
    this.#sessions.clear();
    this.#refreshTokens.clear();
  }

  /** Every role credential minted so far stops working at the model endpoint. */
  expireRoleCredentials(): void {
    for (const role of this.#roles.values()) role.valid = false;
  }

  /**
   * Whether a request to the model endpoint carries a valid signature over
   * exactly what it sends. The check rebuilds the canonical request from the
   * request as received, never from what was asked to be signed.
   */
  verify(request: {
    readonly method: string;
    readonly url: URL;
    readonly headers: Headers;
    readonly body: string;
  }): "valid" | "invalid" | "expired" {
    const authorization = request.headers.get("authorization") ?? "";
    const parsed =
      /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z0-9-]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
        authorization,
      );
    if (parsed === null) return "invalid";
    const [
      ,
      accessKeyId = "",
      date = "",
      region = "",
      service = "",
      signedHeaders = "",
      signature,
    ] = parsed;
    const role = this.#roles.get(accessKeyId);
    if (role === undefined) return "invalid";
    if (request.headers.get("x-amz-security-token") !== role.sessionToken) return "invalid";
    const names = signedHeaders.split(";");
    if (!names.includes("host") || !names.includes("x-amz-date")) return "invalid";
    const headers: Record<string, string> = {};
    for (const name of names) {
      if (name === "host") continue;
      const value = request.headers.get(name);
      if (value === null) return "invalid";
      headers[name] = value;
    }
    const amzDate = headers["x-amz-date"] ?? "";
    if (!amzDate.startsWith(date)) return "invalid";
    const { "x-amz-date": _date, "x-amz-security-token": _token, ...signed } = headers;
    const dateHeaders: Record<string, string> = { "x-amz-date": amzDate };
    if (headers["x-amz-security-token"] !== undefined) {
      dateHeaders["x-amz-security-token"] = headers["x-amz-security-token"];
    }
    const { canonical, signedHeaders: rebuilt } = sigV4CanonicalRequest(
      {
        method: request.method,
        host: request.url.host,
        path: request.url.pathname,
        query: [...request.url.searchParams.entries()],
        headers: signed,
        payloadHash: sha256Hex(request.body),
      },
      dateHeaders,
    );
    if (rebuilt !== signedHeaders) return "invalid";
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      `${date}/${region}/${service}/aws4_request`,
      sha256Hex(canonical),
    ].join("\n");
    const expected = createHmac(
      "sha256",
      sigV4SigningKey(role.secretAccessKey, date, region, service),
    )
      .update(stringToSign)
      .digest("hex");
    if (expected !== signature || region !== MODEL_REGION || service !== "bedrock") {
      return "invalid";
    }
    return role.valid ? "valid" : "expired";
  }

  #issue(prefix: string, bytes = 24): string {
    const value = `${prefix}${randomBytes(bytes).toString("base64url")}`;
    this.#secrets.push(value);
    return value;
  }

  #oidc(path: string, body: string): Response {
    const fields = JSON.parse(body === "" ? "{}" : body) as Record<string, unknown>;
    if (path === "/client/register") {
      const clientId = this.#issue("client-");
      const clientSecret = this.#issue("client-secret-", 48);
      this.#clients.set(clientId, clientSecret);
      return Response.json({
        clientId,
        clientSecret,
        clientIdIssuedAt: Math.floor(this.#now() / 1_000),
        clientSecretExpiresAt: Math.floor(this.#now() / 1_000) + 90 * 24 * 60 * 60,
      });
    }
    if (this.#clients.get(String(fields.clientId)) !== fields.clientSecret) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    if (path === "/device_authorization") {
      if (this.#deviceAnswer === "unavailable") return new Response("", { status: 503 });
      if (this.#deviceAnswer === "refused") {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      if (fields.startUrl !== START_URL) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const userCode = `ABCD-${String(this.#devices.size).padStart(4, "0")}`;
      const deviceCode = this.#issue("device-code-");
      this.#devices.set(`${deviceCode}|${userCode}`, { state: "pending" });
      return Response.json({
        deviceCode,
        userCode,
        verificationUri: this.#verificationUri,
        verificationUriComplete: `${this.#verificationUri}?user_code=${userCode}`,
        expiresIn: 600,
        interval: 1,
      });
    }
    if (path === "/token") {
      if (fields.grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        const entry = [...this.#devices].find(([key]) =>
          key.startsWith(`${String(fields.deviceCode)}|`),
        );
        if (entry === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const [, device] = entry;
        if (device.state === "pending") {
          return Response.json({ error: "authorization_pending" }, { status: 400 });
        }
        if (device.state === "declined") {
          return Response.json({ error: "access_denied" }, { status: 400 });
        }
        if (device.state === "expired") {
          return Response.json({ error: "expired_token" }, { status: 400 });
        }
        return this.#session();
      }
      if (fields.grantType === "refresh_token") {
        if (this.#refreshAnswer === "unreachable") throw new TypeError("fetch failed");
        if (this.#refreshAnswer === "server-error") return new Response("", { status: 500 });
        if (this.#refreshAnswer !== "rotated") {
          return Response.json({ error: this.#refreshAnswer }, { status: 400 });
        }
        if (!this.#refreshTokens.has(String(fields.refreshToken))) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return this.#session();
      }
    }
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  #session(): Response {
    const accessToken = this.#issue("sso-access-", 48);
    this.#sessions.add(accessToken);
    const refreshToken = this.#grantsRefreshToken ? this.#issue("sso-refresh-", 48) : undefined;
    if (refreshToken !== undefined) this.#refreshTokens.add(refreshToken);
    return Response.json({
      accessToken,
      tokenType: "Bearer",
      expiresIn: this.#sessionLifetimeSeconds,
      ...(refreshToken === undefined ? {} : { refreshToken }),
    });
  }

  #portal(request: FakeCloudRequest): Response {
    const bearer = request.headers.get("x-amz-sso_bearer_token") ?? "";
    if (request.url.pathname === "/logout") {
      this.#sessions.delete(bearer);
      return new Response(null, { status: 200 });
    }
    if (request.url.pathname !== "/federation/credentials")
      return new Response("", { status: 404 });
    const answer = this.#mintAnswers.shift() ?? "credentials";
    if (answer === "server-error") return new Response("", { status: 500 });
    if (answer === "unauthorized" || !this.#sessions.has(bearer)) {
      return Response.json({ message: "Session token not found or invalid" }, { status: 401 });
    }
    if (
      answer === "forbidden" ||
      request.url.searchParams.get("account_id") !== ACCOUNT_ID ||
      request.url.searchParams.get("role_name") !== ROLE_NAME
    ) {
      return Response.json({ message: "No access" }, { status: 403 });
    }
    const accessKeyId = `ASIA${randomBytes(8).toString("hex").toUpperCase()}`;
    const secretAccessKey = this.#issue("role-secret-", 30);
    const sessionToken = `role-session-${randomBytes(48).toString("base64url")}`;
    this.#roles.set(accessKeyId, { secretAccessKey, sessionToken, valid: true });
    return Response.json({
      roleCredentials: {
        accessKeyId,
        secretAccessKey,
        sessionToken,
        expiration: this.#now() + this.#roleLifetimeMs,
      },
    });
  }

  #model(request: FakeCloudRequest): Response {
    const verdict = this.verify(request);
    if (verdict === "invalid") {
      return Response.json(
        {
          message: "The request signature we calculated does not match the signature you provided.",
        },
        { status: 403, headers: { "x-amzn-errortype": "InvalidSignatureException" } },
      );
    }
    if (verdict === "expired") {
      return Response.json(
        { message: "The security token included in the request is expired" },
        { status: 403, headers: { "x-amzn-errortype": "ExpiredTokenException" } },
      );
    }
    return Response.json({
      output: { message: { role: "assistant", content: [{ text: "Hello." }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
  }
}

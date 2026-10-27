import { randomBytes } from "node:crypto";
import {
  decodeCloudAccountId,
  decodeCloudIamRegion,
  decodeCloudIamStartUrl,
  decodeCloudRoleName,
  decodeProviderInstance,
  decodeProviderModelId,
  type AmazonBedrockProviderConfiguration,
  type ProviderInstance,
} from "@octant/contracts";
import { converseStreamResponse, textReply } from "./bedrockConverse.test-support";

/**
 * The cloud as the host credential broker and the Bedrock transport reach it,
 * in memory: the portal's OIDC service and role-credential endpoint, and a
 * Bedrock runtime that answers only requests carrying a signature made with
 * credentials the portal minted. It throws for any other host, so no real
 * cloud endpoint is ever called. The broker's own tests prove the signature
 * itself verifies; this one proves where every value went.
 */

export const BEDROCK_MODEL = decodeProviderModelId("anthropic.claude-sonnet-4-20250514-v1:0");
export const BEDROCK_HOST = "bedrock-runtime.us-west-2.amazonaws.com";

export function bedrockConfiguration(
  overrides: Partial<AmazonBedrockProviderConfiguration> = {},
): AmazonBedrockProviderConfiguration {
  return {
    kind: "amazon-bedrock-converse-http",
    region: decodeCloudIamRegion("us-west-2"),
    authentication: "cloud-iam",
    cloudIam: {
      startUrl: decodeCloudIamStartUrl("https://contoso.awsapps.com/start"),
      ssoRegion: decodeCloudIamRegion("us-east-1"),
      accountId: decodeCloudAccountId("123456789012"),
      roleName: decodeCloudRoleName("BedrockInvoke"),
    },
    manualModelIds: [BEDROCK_MODEL],
    ...overrides,
  };
}

export function bedrockInstance(
  instanceId: string,
  configuration: AmazonBedrockProviderConfiguration = bedrockConfiguration(),
): ProviderInstance {
  return decodeProviderInstance({
    id: instanceId,
    displayName: "Contoso Bedrock",
    driverKind: "amazon-bedrock",
    configuration,
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-10-27T09:00:00.000Z",
    updatedAt: "2026-10-27T09:00:00.000Z",
  });
}

export class FakeBedrockCloud {
  readonly #secrets: string[] = [];
  readonly #sessions = new Set<string>();
  readonly #roles = new Map<string, string>();
  readonly #hosts: string[] = [];
  readonly #modelAuthorizations: string[] = [];
  #approved = false;
  #logouts = 0;

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    this.#hosts.push(url.host);
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    if (url.host === "oidc.us-east-1.amazonaws.com") return this.#oidc(url.pathname, body);
    if (url.host === "portal.sso.us-east-1.amazonaws.com") return this.#portal(url, headers);
    if (url.host === BEDROCK_HOST) return this.#model(headers, body);
    throw new Error(`the fake cloud does not serve ${url.host}`);
  };

  approve(): void {
    this.#approved = true;
  }

  /** Every secret the fake issued: a client secret, codes, portal tokens, role keys. */
  secrets(): ReadonlyArray<string> {
    return [...this.#secrets];
  }

  /** The role session tokens, which travel only beside a signature. */
  roleSessionTokens(): ReadonlyArray<string> {
    return [...this.#roles.values()];
  }

  hosts(): ReadonlyArray<string> {
    return [...this.#hosts];
  }

  modelAuthorizations(): ReadonlyArray<string> {
    return [...this.#modelAuthorizations];
  }

  logouts(): number {
    return this.#logouts;
  }

  #issue(prefix: string): string {
    const value = `${prefix}${randomBytes(24).toString("base64url")}`;
    this.#secrets.push(value);
    return value;
  }

  #oidc(path: string, body: string): Response {
    const fields = JSON.parse(body === "" ? "{}" : body) as Record<string, unknown>;
    if (path === "/client/register") {
      return Response.json({
        clientId: this.#issue("client-"),
        clientSecret: this.#issue("client-secret-"),
        clientSecretExpiresAt: Math.floor(Date.now() / 1_000) + 86_400,
      });
    }
    if (path === "/device_authorization") {
      return Response.json({
        deviceCode: this.#issue("device-code-"),
        userCode: "WXYZ-1234",
        verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
        expiresIn: 600,
        interval: 1,
      });
    }
    if (path === "/token" && fields.grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      if (!this.#approved)
        return Response.json({ error: "authorization_pending" }, { status: 400 });
      const accessToken = this.#issue("sso-access-");
      this.#sessions.add(accessToken);
      return Response.json({
        accessToken,
        tokenType: "Bearer",
        expiresIn: 28_800,
        refreshToken: this.#issue("sso-refresh-"),
      });
    }
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  #portal(url: URL, headers: Headers): Response {
    const bearer = headers.get("x-amz-sso_bearer_token") ?? "";
    if (url.pathname === "/logout") {
      this.#logouts += 1;
      this.#sessions.delete(bearer);
      return new Response(null, { status: 200 });
    }
    if (!this.#sessions.has(bearer)) return Response.json({}, { status: 401 });
    const accessKeyId = `ASIA${randomBytes(8).toString("hex").toUpperCase()}`;
    const sessionToken = `role-session-${randomBytes(32).toString("base64url")}`;
    this.#roles.set(accessKeyId, sessionToken);
    return Response.json({
      roleCredentials: {
        accessKeyId,
        secretAccessKey: this.#issue("role-secret-"),
        sessionToken,
        expiration: Date.now() + 3_600_000,
      },
    });
  }

  #model(headers: Headers, body: string): Response {
    const authorization = headers.get("authorization") ?? "";
    this.#modelAuthorizations.push(authorization);
    const keyId = /Credential=([A-Z0-9]+)\//.exec(authorization)?.[1] ?? "";
    if (this.#roles.get(keyId) !== headers.get("x-amz-security-token")) {
      return Response.json(
        { message: "invalid" },
        { status: 403, headers: { "x-amzn-errortype": "InvalidSignatureException" } },
      );
    }
    const prompt = (
      JSON.parse(body) as { messages: Array<{ content: Array<{ text?: string }> }> }
    ).messages.at(-1)?.content[0]?.text;
    return converseStreamResponse(textReply(`Answered: ${prompt ?? ""}`));
  }
}

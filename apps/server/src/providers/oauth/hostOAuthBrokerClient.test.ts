import { randomUUID } from "node:crypto";
import {
  CredentialStoreFailure,
  SLACK_MCP_USER_OAUTH as slack,
  startCredentialBroker,
  type CredentialStore,
} from "@octant/host-runtime";
import { decodeHostOAuthDescriptor } from "@octant/contracts/host-oauth";
import { describe, expect, it } from "vitest";
import { createHostOAuthService } from "./hostOAuthService";
import { makeHostOAuthBrokerClient, type HostOAuthBrokerDescriptor } from "./hostOAuthBrokerClient";

const descriptor: HostOAuthBrokerDescriptor = {
  descriptorId: "slack-client-bridge-fixture",
  dialect: slack.dialect,
  clientId: "owned-fixture-client",
  flow: "authorization-code-pkce",
  termsId: "mcp-terms-fixture",
  scopes: [slack.readScope],
  authorizationEndpoint: slack.authorizationEndpoint,
  tokenEndpoint: slack.tokenEndpoint,
  resource: slack.resource,
  mcpTransportUrl: slack.transportUrl,
  mcpIssuer: slack.issuer,
  clientAuthentication: {
    method: "client_secret_post",
    secretRef: "55000000-0000-4000-8000-000000000001",
    tokenEndpoint: slack.tokenEndpoint,
  },
};
function memoryStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    delete: async (id) => void values.delete(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
  };
}

describe("host OAuth broker client closed MCP binding", () => {
  it("retains the closed descriptor through service and client serialization", async () => {
    const actorId = randomUUID();
    const attemptId = randomUUID();
    const client = makeHostOAuthBrokerClient({
      url: "http://127.0.0.1:9",
      token: "synthetic-broker-token",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        // Apply the public contract at the receiving boundary, not a duplicate serializer assertion.
        const delivered = decodeHostOAuthDescriptor(body.descriptor);
        expect(delivered.mcpTransportUrl).toBe(slack.transportUrl);
        expect(delivered.mcpIssuer).toBe(slack.issuer);
        return Response.json({
          kind: "awaiting-consent",
          descriptorId: descriptor.descriptorId,
          attemptId,
          flow: "authorization-code-pkce",
          authorizationUrl: slack.authorizationEndpoint,
          expiresAt: "2026-11-02T01:00:00.000Z",
        });
      },
    });
    const service = createHostOAuthService({
      broker: client,
      journal: { append: () => undefined },
    });
    const trusted = decodeHostOAuthDescriptor(descriptor);
    expect(
      service.acknowledgeTerms({ principalKind: "local-window", actorId, descriptor: trusted })
        .kind,
    ).toBe("recorded");
    expect(
      await service.begin({ principalKind: "local-window", actorId, descriptor: trusted }),
    ).toMatchObject({ kind: "awaiting-consent", attemptId });
  });
  it("preserves the independent transport and issuer across the real broker Begin boundary", async () => {
    const broker = await startCredentialBroker(memoryStore());
    try {
      const client = makeHostOAuthBrokerClient({ url: broker.url, token: broker.token });
      const started = await client.begin({
        descriptor,
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-11-02T00:00:00.000Z",
      });
      expect(started).toMatchObject({ kind: "awaiting-consent", flow: "authorization-code-pkce" });
      if (typeof started !== "object" || started === null || !("authorizationUrl" in started))
        return;
      const authorization = new URL(String(started.authorizationUrl));
      expect(authorization.origin + authorization.pathname).toBe(slack.authorizationEndpoint);
      expect(authorization.searchParams.get("resource")).toBe(slack.resource);
      expect(authorization.searchParams.get("scope")).toBe(slack.readScope);
      // This wire foundation does not claim Slack accepts the legacy callback.
      expect(authorization.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const service = createHostOAuthService({
        broker: client,
        journal: { append: () => undefined },
      });
      const actorId = randomUUID();
      const trusted = decodeHostOAuthDescriptor(descriptor);
      service.acknowledgeTerms({ principalKind: "local-window", actorId, descriptor: trusted });
      expect(
        await service.begin({ principalKind: "local-window", actorId, descriptor: trusted }),
      ).toMatchObject({ kind: "awaiting-consent" });
      await expect(
        client.begin({
          descriptor: { ...descriptor, mcpIssuer: "https://other.example" },
          actorId: randomUUID(),
          termsAcknowledgedAt: "2026-11-02T00:00:00.000Z",
        }),
      ).rejects.toThrow("Octant host OAuth broker refused the request.");
    } finally {
      await broker.close();
    }
  });
});

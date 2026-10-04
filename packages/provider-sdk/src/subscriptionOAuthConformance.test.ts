import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { runSubscriptionOAuthCredentialConformance } from "./subscriptionOAuth";
import { type SubscriptionOAuthCredential, type SubscriptionOAuthHost } from "./subscriptionOAuth";

const ACCESS = "access-token-must-not-appear-in-the-report";
const REFRESHED = "refreshed-access-token-must-stay-on-the-wire";
const REFRESH = "refresh-token-must-not-leave-the-host";
const CREDENTIAL_REF = "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a";

describe("subscription-oauth credential conformance", () => {
  it("uses a granted bearer on the fake endpoint and does not claim the token in the report", async () => {
    const endpoint = await fakeEndpoint();
    const report = await runSubscriptionOAuthCredentialConformance({
      credential: credential(),
      expectedDescriptorId: "sample-http",
      host: host({
        access: async () => ({
          kind: "granted",
          accessToken: ACCESS,
          expiresAt: "2026-10-04T15:00:00.000Z",
        }),
      }),
      endpointUrl: endpoint.url,
      fetch: globalThis.fetch,
      now: () => Date.parse("2026-10-04T14:00:00.000Z"),
      refreshCount: () => 0,
    });
    expect(report).toEqual({
      readiness: "ready",
      capabilitiesClaimed: true,
      endpointCalled: true,
      refreshed: false,
    });
    expect(endpoint.authorizations).toEqual([`Bearer ${ACCESS}`]);
    expect(JSON.stringify(report)).not.toContain(ACCESS);
    expect(JSON.stringify(report)).not.toContain(REFRESH);
    await endpoint.close();
  });

  it("does not call the endpoint or claim capabilities when the credential is missing or expired", async () => {
    const endpoint = await fakeEndpoint();
    const missing = await runSubscriptionOAuthCredentialConformance({
      credential: undefined,
      expectedDescriptorId: "sample-http",
      host: host({}),
      endpointUrl: endpoint.url,
      fetch: globalThis.fetch,
      now: () => Date.parse("2026-10-04T14:00:00.000Z"),
      refreshCount: () => 0,
    });
    expect(missing).toMatchObject({
      readiness: "unauthenticated",
      capabilitiesClaimed: false,
      endpointCalled: false,
    });

    let refreshes = 0;
    const expired = await runSubscriptionOAuthCredentialConformance({
      credential: credential(),
      expectedDescriptorId: "sample-http",
      host: host({
        access: async () => ({
          kind: "granted",
          accessToken: ACCESS,
          expiresAt: "2026-10-04T13:00:00.000Z",
        }),
        refresh: async () => {
          refreshes += 1;
          return { kind: "sign-in-again", reason: "expired" };
        },
      }),
      endpointUrl: endpoint.url,
      fetch: globalThis.fetch,
      now: () => Date.parse("2026-10-04T14:00:00.000Z"),
      refreshCount: () => refreshes,
    });
    expect(expired).toEqual({
      readiness: "unauthenticated",
      capabilitiesClaimed: false,
      endpointCalled: false,
      refreshed: true,
    });
    expect(endpoint.authorizations).toEqual([]);
    expect(JSON.stringify(expired)).not.toContain(ACCESS);
    expect(JSON.stringify(expired)).not.toContain(REFRESH);
    await endpoint.close();
  });

  it("refreshes through the host and sends only the new access token", async () => {
    const endpoint = await fakeEndpoint();
    let accessCalls = 0;
    let refreshes = 0;
    const report = await runSubscriptionOAuthCredentialConformance({
      credential: credential(),
      expectedDescriptorId: "sample-http",
      host: host({
        access: async () => {
          accessCalls += 1;
          return accessCalls === 1
            ? {
                kind: "granted",
                accessToken: ACCESS,
                expiresAt: "2026-10-04T13:00:00.000Z",
              }
            : {
                kind: "granted",
                accessToken: REFRESHED,
                expiresAt: "2026-10-04T16:00:00.000Z",
              };
        },
        refresh: async () => {
          refreshes += 1;
          return { kind: "refreshed" };
        },
      }),
      endpointUrl: endpoint.url,
      fetch: globalThis.fetch,
      now: () => Date.parse("2026-10-04T14:00:00.000Z"),
      refreshCount: () => refreshes,
    });
    expect(report).toMatchObject({
      readiness: "ready",
      capabilitiesClaimed: true,
      endpointCalled: true,
      refreshed: true,
    });
    expect(endpoint.authorizations).toEqual([`Bearer ${REFRESHED}`]);
    expect(endpoint.authorizations.join(" ")).not.toContain(REFRESH);
    expect(JSON.stringify(report)).not.toContain(REFRESHED);
    await endpoint.close();
  });

  it("reports incompatible and does not call the host when the binding does not match", async () => {
    const endpoint = await fakeEndpoint();
    let called = false;
    const report = await runSubscriptionOAuthCredentialConformance({
      credential: credential(),
      expectedDescriptorId: "other-descriptor",
      host: host({
        access: async () => {
          called = true;
          return { kind: "unavailable" };
        },
      }),
      endpointUrl: endpoint.url,
      fetch: globalThis.fetch,
      now: () => Date.parse("2026-10-04T14:00:00.000Z"),
      refreshCount: () => 0,
    });
    expect(report).toMatchObject({
      readiness: "incompatible",
      capabilitiesClaimed: false,
      endpointCalled: false,
    });
    expect(called).toBe(false);
    await endpoint.close();
  });
});

function credential(): SubscriptionOAuthCredential {
  return {
    kind: "subscription-oauth",
    credentialRef: CREDENTIAL_REF,
    descriptorId: "sample-http",
    accountLabel: "Fixture account",
  };
}

function host(overrides: Partial<SubscriptionOAuthHost>): SubscriptionOAuthHost {
  return {
    refresh: async () => ({ kind: "unavailable" }),
    access: async () => ({ kind: "unavailable" }),
    ...overrides,
  };
}

async function fakeEndpoint(): Promise<{
  readonly url: string;
  readonly authorizations: string[];
  readonly close: () => Promise<void>;
}> {
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/models`,
    authorizations,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

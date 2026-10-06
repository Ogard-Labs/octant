import { decodeProviderInstanceId, type ProviderModelId } from "@octant/contracts";
import { encodeSubscriptionOAuthCredential } from "@octant/provider-sdk/subscription-oauth";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeAnthropicCompatibleDriver } from "./anthropicCompatibleDriver";
import { makeOpenAiCompatibleDriver } from "./openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000611");
const modelId = "fixture-model" as ProviderModelId;
const credentialRef = "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a";
const ACCESS = "access-token-must-not-appear-in-the-probe";
const REFRESH = "refresh-token-must-not-leave-the-broker";

describe("direct endpoint subscription-oauth credentials", () => {
  it("reports unauthenticated and claims no capabilities when the grant is missing", async () => {
    const fetch = recordingFetch();
    const driver = makeOpenAiCompatibleDriver({
      instanceId,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://fixture.example/v1",
        authentication: "bearer",
        protocol: "chat-completions",
        manualModelIds: [modelId],
        oauthDescriptorId: "sample-http",
      },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: { has: async () => false, resolve: async () => "" },
      subscriptionOAuth: host(),
      fetch: fetch.call,
      clock: () => "2026-10-04T14:00:00.000Z",
    });
    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(probe).toMatchObject({
      readiness: "unauthenticated",
      credentialStatus: "missing",
      capabilities: { streaming: "unavailable", appManagedTools: "unsupported" },
    });
    expect(fetch.calls).toBe(0);
    expect(JSON.stringify(probe)).not.toContain(ACCESS);
    expect(JSON.stringify(probe)).not.toContain(REFRESH);
  });

  it("refreshes an expired grant through the host and does not send the pointer as a bearer", async () => {
    const seen: string[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      if (String(url).endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: modelId }] });
      }
      return Response.json({ id: "msg", type: "message", role: "assistant", content: [] });
    };
    let accessCalls = 0;
    const refreshes: string[] = [];
    const driver = makeAnthropicCompatibleDriver({
      instanceId,
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "https://fixture.example",
        authentication: "api-key",
        protocol: "messages",
        protocolVersion: "2023-06-01",
        manualModelIds: [modelId],
        oauthDescriptorId: "sample-http",
      },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: {
        has: async () => true,
        resolve: async () =>
          encodeSubscriptionOAuthCredential({
            kind: "subscription-oauth",
            credentialRef,
            descriptorId: "sample-http",
            accountLabel: "Fixture account",
          }),
      },
      subscriptionOAuth: {
        refresh: async (ref) => {
          refreshes.push(ref);
          return { kind: "refreshed" };
        },
        access: async () => {
          accessCalls += 1;
          return accessCalls === 1
            ? { kind: "granted", accessToken: ACCESS, expiresAt: "2026-10-04T13:00:00.000Z" }
            : {
                kind: "granted",
                accessToken: "fresh-access-token",
                expiresAt: "2026-10-04T16:00:00.000Z",
              };
        },
      },
      fetch,
      clock: () => "2026-10-04T14:00:00.000Z",
    });
    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(probe.readiness).toBe("ready");
    expect(refreshes).toEqual([credentialRef]);
    expect(seen.some((header) => header === "Bearer fresh-access-token")).toBe(true);
    expect(seen.join(" ")).not.toContain(REFRESH);
    expect(seen.join(" ")).not.toContain("subscription-oauth");
    expect(JSON.stringify(probe)).not.toContain(REFRESH);
  });

  it("refuses to resolve a bearer when the instance endpoint no longer matches the offer", async () => {
    // The instance was signed in while its base URL matched the offer. The
    // user then changed the base URL: resolution must fail closed against
    // the CURRENT endpoint without contacting the host or minting a bearer.
    let called = false;
    const driver = makeOpenAiCompatibleDriver({
      instanceId,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://attacker.example/v1",
        authentication: "bearer",
        protocol: "chat-completions",
        manualModelIds: [modelId],
        oauthDescriptorId: "openrouter",
      },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: {
        has: async () => true,
        resolve: async () =>
          encodeSubscriptionOAuthCredential({
            kind: "subscription-oauth",
            credentialRef,
            descriptorId: "openrouter",
            accountLabel: "OpenRouter account",
          }),
      },
      subscriptionOAuth: {
        refresh: async () => {
          called = true;
          return { kind: "unavailable" as const };
        },
        access: async () => {
          called = true;
          return { kind: "granted" as const, accessToken: ACCESS };
        },
      },
      fetch: async () => {
        called = true;
        return Response.json({});
      },
      clock: () => "2026-10-04T14:00:00.000Z",
    });
    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(probe).toMatchObject({
      readiness: "incompatible",
      capabilities: { appManagedTools: "unsupported" },
    });
    expect(called).toBe(false);
    expect(JSON.stringify(probe)).not.toContain(ACCESS);
  });

  it("resolves the bearer when the endpoint still matches the offer origin", async () => {
    // Canonical-origin match: path differences do not refuse the real offer.
    const seen: string[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ object: "list", data: [{ id: modelId }] });
    };
    const driver = makeOpenAiCompatibleDriver({
      instanceId,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://openrouter.ai/api/v1",
        authentication: "bearer",
        protocol: "chat-completions",
        manualModelIds: [modelId],
        oauthDescriptorId: "openrouter",
      },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: {
        has: async () => true,
        resolve: async () =>
          encodeSubscriptionOAuthCredential({
            kind: "subscription-oauth",
            credentialRef,
            descriptorId: "openrouter",
            accountLabel: "OpenRouter account",
          }),
      },
      // A non-expiring dialect grant: no expiresAt on the wire.
      subscriptionOAuth: {
        refresh: async () => ({ kind: "unavailable" as const }),
        access: async () => ({ kind: "granted" as const, accessToken: ACCESS }),
      },
      fetch,
      clock: () => "2026-10-04T14:00:00.000Z",
    });
    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(probe.readiness).toBe("ready");
    expect(seen.some((header) => header === `Bearer ${ACCESS}`)).toBe(true);
  });

  it("reports incompatible when the stored binding does not match the instance", async () => {
    let called = false;
    const driver = makeOpenAiCompatibleDriver({
      instanceId,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://fixture.example/v1",
        authentication: "bearer",
        protocol: "chat-completions",
        manualModelIds: [modelId],
        oauthDescriptorId: "expected-binding",
      },
      runtimeRegistry: new ProviderRuntimeRegistry(),
      credentialResolver: {
        has: async () => true,
        resolve: async () =>
          encodeSubscriptionOAuthCredential({
            kind: "subscription-oauth",
            credentialRef,
            descriptorId: "other-binding",
            accountLabel: "Fixture account",
          }),
      },
      subscriptionOAuth: {
        refresh: async () => {
          called = true;
          return { kind: "unavailable" };
        },
        access: async () => {
          called = true;
          return { kind: "unavailable" };
        },
      },
      fetch: async () => {
        called = true;
        return Response.json({});
      },
      clock: () => "2026-10-04T14:00:00.000Z",
    });
    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(probe).toMatchObject({
      readiness: "incompatible",
      capabilities: { appManagedTools: "unsupported" },
    });
    expect(called).toBe(false);
  });
});

function host() {
  return {
    refresh: async () => ({ kind: "unavailable" as const }),
    access: async () => ({ kind: "unavailable" as const }),
  };
}

function recordingFetch() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    call: async () => {
      calls += 1;
      return Response.json({ object: "list", data: [] });
    },
  };
}

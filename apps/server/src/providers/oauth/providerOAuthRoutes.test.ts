import { decodeWindowId, type ProviderInstanceId } from "@octant/contracts";
import type { HostOAuthDescriptor, SubscriptionOAuthOffer } from "@octant/contracts/host-oauth";
import { encodeSubscriptionOAuthCredential } from "@octant/provider-sdk/subscription-oauth";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "../../windowAuthorityStore";
import type { ProviderCredentialStore } from "../credentialBrokerClient";
import type { HostOAuthService } from "./hostOAuthService";
import { createProviderOAuthRouteHandler } from "./providerOAuthRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("80000000-0000-4000-8000-000000000020");
const instanceId = "00000000-0000-4000-8000-000000000901" as ProviderInstanceId;
const descriptor: HostOAuthDescriptor = {
  descriptorId: "fixture-oauth" as HostOAuthDescriptor["descriptorId"],
  clientId: "client",
  flow: "authorization-code-pkce",
  authorizationEndpoint: "https://example.com/authorize",
  tokenEndpoint: "https://example.com/token",
  scopes: ["openid"],
  termsId: "terms-1" as HostOAuthDescriptor["termsId"],
};
const offer: SubscriptionOAuthOffer = {
  descriptor,
  accountLabel: "Fixture account",
  termsSummary: "Acknowledge the terms before this sign-in continues.",
  driverKinds: ["openai-compatible"],
};

describe("provider OAuth routes", () => {
  it("does not reflect a foreign Origin into CORS", async () => {
    const route = fixture();
    const response = await route(
      new Request("http://127.0.0.1/api/providers/oauth", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(response?.status).toBe(400);
    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes a loopback renderer Origin after window auth", async () => {
    const route = fixture();
    const response = await route(command("status", { origin: "http://127.0.0.1:5173" }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(await response?.json()).toMatchObject({ kind: "signed-out" });
  });

  it("leaves a mismatched descriptor pointer in place on sign-out", async () => {
    const credentials = {
      has: vi.fn(async () => true),
      resolve: vi.fn(async () =>
        encodeSubscriptionOAuthCredential({
          kind: "subscription-oauth",
          credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          descriptorId: "other-oauth",
          accountLabel: "Other account",
        }),
      ),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const signOut = vi.fn();
    const route = fixture({ credentials, signOut });
    const response = await route(command("sign-out"));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ kind: "signed-out" });
    expect(signOut).not.toHaveBeenCalled();
    expect(credentials.delete).not.toHaveBeenCalled();
  });

  it("does not report signed in when grant refresh is unavailable", async () => {
    const credentials = {
      has: vi.fn(async () => true),
      resolve: vi.fn(async () =>
        encodeSubscriptionOAuthCredential({
          kind: "subscription-oauth",
          credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          descriptorId: "fixture-oauth",
          accountLabel: "Fixture account",
        }),
      ),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const refresh = vi.fn(async () => ({ kind: "unavailable" as const }));
    const route = fixture({ credentials, refresh });
    const response = await route(command("status"));
    expect(await response?.json()).toEqual({ kind: "refused", reason: "unavailable" });
  });
});

function command(kind: "status" | "sign-out", options: { readonly origin?: string } = {}) {
  return new Request("http://127.0.0.1/api/providers/oauth", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    body: JSON.stringify({ kind, instanceId, descriptorId: "fixture-oauth" }),
  });
}

function fixture(
  overrides: {
    readonly credentials?: ProviderCredentialStore;
    readonly refresh?: HostOAuthService["refresh"];
    readonly signOut?: HostOAuthService["signOut"];
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const service: HostOAuthService = {
    offer: () => ({
      oauth: { available: true, termsRequired: false },
      apiKey: { available: true },
    }),
    acknowledgeTerms: () => ({ kind: "refused", reason: "invalid" }),
    restoreAcknowledgment: () => undefined,
    begin: async () => ({ kind: "refused", reason: "invalid" }),
    status: async () => ({ kind: "unknown" }),
    refresh: overrides.refresh ?? (async () => ({ kind: "refreshed" })),
    signOut:
      overrides.signOut ??
      (async () => ({
        kind: "signed-out" as const,
      })),
  };
  return createProviderOAuthRouteHandler({
    service,
    windowAuthorityStore: store,
    now: () => 1,
    offers: [offer],
    ...(overrides.credentials === undefined ? {} : { credentials: overrides.credentials }),
  });
}

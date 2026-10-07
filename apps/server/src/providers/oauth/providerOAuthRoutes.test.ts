import { decodeProviderInstance, decodeWindowId, type ProviderInstanceId } from "@octant/contracts";
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
  allowedEndpoint: "https://example.com",
};

function instanceAt(baseUrl: string) {
  return decodeProviderInstance({
    id: "00000000-0000-4000-8000-000000000901",
    displayName: "Fixture endpoint",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl,
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  });
}

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

  it("refuses to begin a sign-in for an instance whose endpoint does not match the offer", async () => {
    const begin = vi.fn(async () => ({ kind: "refused", reason: "invalid" }) as const);
    const route = fixture({
      begin,
      readInstance: () => instanceAt("https://attacker.example/v1"),
    });
    const response = await route(command("begin"));
    expect(await response?.json()).toEqual({ kind: "refused", reason: "endpoint-mismatch" });
    expect(begin).not.toHaveBeenCalled();
  });

  it("begins a sign-in when the instance endpoint matches the offer origin", async () => {
    const begin = vi.fn(async () => ({ kind: "refused", reason: "invalid" }) as const);
    // Path and trailing-slash differences do not break the canonical origin match.
    const route = fixture({
      begin,
      readInstance: () => instanceAt("https://example.com/v1/"),
    });
    const response = await route(command("begin"));
    expect(begin).toHaveBeenCalled();
    expect(await response?.json()).toEqual({ kind: "refused", reason: "invalid" });
  });

  it("passes the instance credential ref when beginning a sign-in for an offer that already has a pointer", async () => {
    const begin = vi.fn(async () => ({ kind: "refused", reason: "invalid" }) as const);
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
    const route = fixture({
      begin,
      credentials,
      readInstance: () => instanceAt("https://example.com/v1"),
    });
    await route(command("begin"));
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    );
  });

  it("does not pass a credential ref from a pointer for a different offer", async () => {
    const seen: unknown[] = [];
    const begin: HostOAuthService["begin"] = async (input) => {
      seen.push(input);
      return { kind: "refused", reason: "invalid" };
    };
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
    const route = fixture({
      begin,
      credentials,
      readInstance: () => instanceAt("https://example.com/v1"),
    });
    await route(command("begin"));
    expect(seen).toHaveLength(1);
    const input = seen[0];
    expect(typeof input === "object" && input !== null && "credentialRef" in input).toBe(false);
  });

  it("refuses to store a credential pointer when the endpoint no longer matches on poll", async () => {
    const credentials = {
      has: vi.fn(async () => false),
      resolve: vi.fn(async () => {
        throw new Error("missing");
      }),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const route = fixture({
      credentials,
      status: async () => ({
        kind: "signed-in",
        attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        descriptorId: descriptor.descriptorId,
        credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      readInstance: () => instanceAt("https://attacker.example/v1"),
    });
    const response = await route(command("poll"));
    expect(await response?.json()).toEqual({ kind: "refused", reason: "endpoint-mismatch" });
    expect(credentials.set).not.toHaveBeenCalled();
  });

  it("stores the credential pointer when the poll endpoint matches the offer", async () => {
    const credentials = {
      has: vi.fn(async () => false),
      resolve: vi.fn(async () => {
        throw new Error("missing");
      }),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const route = fixture({
      credentials,
      status: async () => ({
        kind: "signed-in",
        attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        descriptorId: descriptor.descriptorId,
        credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      readInstance: () => instanceAt("https://example.com/v1"),
    });
    const response = await route(command("poll"));
    expect(await response?.json()).toEqual({ kind: "signed-in", accountLabel: "Fixture account" });
    expect(credentials.set).toHaveBeenCalled();
  });

  it("keeps the grant and reports it is still active when the issuer cannot be told about a sign-out", async () => {
    const credentials = pointerStore("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const signOut = vi.fn<HostOAuthService["signOut"]>(async (input) =>
      input.forgetWhenNotRevoked === true
        ? { kind: "signed-out-locally" }
        : { kind: "not-revoked" },
    );
    const route = fixture({ credentials, signOut });
    const response = await route(command("sign-out"));
    expect(await response?.json()).toEqual({
      kind: "not-revoked",
      accountLabel: "Fixture account",
    });
    expect(signOut).toHaveBeenCalledWith(expect.objectContaining({ forgetWhenNotRevoked: false }));
    expect(credentials.delete).not.toHaveBeenCalled();
  });

  it("signs out on this host only when asked, and says the issuer was not told", async () => {
    const credentials = pointerStore("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const signOut = vi.fn<HostOAuthService["signOut"]>(async (input) =>
      input.forgetWhenNotRevoked === true
        ? { kind: "signed-out-locally" }
        : { kind: "not-revoked" },
    );
    const route = fixture({ credentials, signOut });
    const response = await route(command("sign-out-locally"));
    expect(await response?.json()).toMatchObject({
      kind: "signed-out-locally",
      accountLabel: "Fixture account",
    });
    expect(signOut).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        forgetWhenNotRevoked: true,
      }),
    );
    expect(credentials.delete).toHaveBeenCalledWith(instanceId);
  });

  it("drops the replaced grant on a re-sign-in even when the issuer cannot be told", async () => {
    const credentials = pointerStore("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    const signOut = vi.fn<HostOAuthService["signOut"]>(async (input) =>
      input.forgetWhenNotRevoked === true
        ? { kind: "signed-out-locally" }
        : { kind: "not-revoked" },
    );
    const route = fixture({
      credentials,
      signOut,
      status: async () => ({
        kind: "signed-in",
        attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        descriptorId: descriptor.descriptorId,
        credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
      readInstance: () => instanceAt("https://example.com/v1"),
    });
    const response = await route(command("poll"));
    expect(await response?.json()).toEqual({ kind: "signed-in", accountLabel: "Fixture account" });
    // The old grant's local material is forgotten, not left orphaned.
    expect(signOut).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialRef: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        forgetWhenNotRevoked: true,
      }),
    );
    expect(credentials.set).toHaveBeenLastCalledWith(
      instanceId,
      expect.stringContaining("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    );
  });
});

function pointerStore(credentialRef: string) {
  return {
    has: vi.fn(async () => true),
    resolve: vi.fn(async () =>
      encodeSubscriptionOAuthCredential({
        kind: "subscription-oauth",
        credentialRef,
        descriptorId: "fixture-oauth",
        accountLabel: "Fixture account",
      }),
    ),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function command(
  kind: "status" | "sign-out" | "sign-out-locally" | "begin" | "poll",
  options: { readonly origin?: string } = {},
) {
  return new Request("http://127.0.0.1/api/providers/oauth", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    body: JSON.stringify({
      kind,
      instanceId,
      descriptorId: "fixture-oauth",
      ...(kind === "poll" ? { attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : {}),
    }),
  });
}

function fixture(
  overrides: {
    readonly credentials?: ProviderCredentialStore;
    readonly refresh?: HostOAuthService["refresh"];
    readonly signOut?: HostOAuthService["signOut"];
    readonly begin?: HostOAuthService["begin"];
    readonly status?: HostOAuthService["status"];
    readonly readInstance?: (id: ProviderInstanceId) => ReturnType<typeof instanceAt>;
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
    begin: overrides.begin ?? (async () => ({ kind: "refused", reason: "invalid" })),
    status: overrides.status ?? (async () => ({ kind: "unknown" })),
    refresh: overrides.refresh ?? (async () => ({ kind: "refreshed" })),
    signOut:
      overrides.signOut ??
      (async () => ({
        kind: "signed-out" as const,
      })),
    revokesOnSignOut: () => false,
  };
  return createProviderOAuthRouteHandler({
    service,
    windowAuthorityStore: store,
    now: () => 1,
    offers: [offer],
    ...(overrides.credentials === undefined ? {} : { credentials: overrides.credentials }),
    ...(overrides.readInstance === undefined ? {} : { readInstance: overrides.readInstance }),
  });
}

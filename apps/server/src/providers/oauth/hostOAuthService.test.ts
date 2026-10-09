import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveHostRuntimeHostId, startCredentialBroker } from "@octant/host-runtime";
import { CredentialStoreFailure, type CredentialStore } from "@octant/host-runtime";
import {
  decodeHostOAuthDescriptor,
  type HostOAuthJournalRecord,
} from "@octant/contracts/host-oauth";
import { describe, expect, it } from "vitest";
import { makeHostOAuthBrokerClient } from "./hostOAuthBrokerClient";
import { createHostOAuthService, extAgentHostIdFor } from "./hostOAuthService";

const ACCESS = "access-token-must-not-reach-the-journal";
const REFRESH = "refresh-token-must-not-reach-the-journal";

function memoryStore(): CredentialStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void values.delete(id),
  };
}

function descriptor(authorize: string, token: string) {
  return decodeHostOAuthDescriptor({
    descriptorId: "sample-http",
    clientId: "public-client",
    flow: "authorization-code-pkce",
    authorizationEndpoint: authorize,
    tokenEndpoint: token,
    scopes: ["read"],
    termsId: "terms-v1",
  });
}

function chatGptPlan() {
  return decodeHostOAuthDescriptor({
    descriptorId: "chatgpt-plan",
    dialect: "chatgpt-plan-siwc",
    flow: "authorization-code-pkce",
    authorizationEndpoint: "https://auth.openai.com/api/accounts/authorize",
    tokenEndpoint: "https://auth.openai.com/api/accounts/oauth/token",
    scopes: ["openid"],
    termsId: "chatgpt-plan-terms-1",
  });
}

describe("host OAuth service", () => {
  it("records who acknowledged the terms and when, without a secret", () => {
    const journal: HostOAuthJournalRecord[] = [];
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: throwingBroker(),
      now: () => new Date("2026-10-03T18:04:00.000Z"),
    });
    const recorded = service.acknowledgeTerms({
      principalKind: "local-window",
      actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
      descriptor: descriptor("https://idp.example/authorize", "https://idp.example/token"),
    });
    expect(recorded).toMatchObject({
      kind: "recorded",
      acknowledgment: {
        actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
        acknowledgedAt: "2026-10-03T18:04:00.000Z",
      },
    });
    expect(JSON.stringify(journal)).not.toContain("secret");
    expect(journal).toEqual([
      {
        name: "host-oauth.terms-acknowledged",
        descriptorId: "sample-http",
        termsId: "terms-v1",
        actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
        acknowledgedAt: "2026-10-03T18:04:00.000Z",
      },
    ]);
  });

  it("refuses to start sign-in before the terms are acknowledged", async () => {
    let called = false;
    const service = createHostOAuthService({
      journal: { append: () => undefined },
      broker: {
        begin: async () => {
          called = true;
          return {};
        },
        status: async () => ({}),
        refresh: async () => ({}),
        access: async () => ({}),
        forget: async () => undefined,
        revoke: async () => ({ kind: "revoked" }),
      },
    });
    const result = await service.begin({
      principalKind: "local-window",
      actorId: randomUUID(),
      descriptor: descriptor("https://idp.example/authorize", "https://idp.example/token"),
    });
    expect(result).toMatchObject({ kind: "refused", reason: "terms-required" });
    expect(called).toBe(false);
  });

  it("refuses a remote principal before any listener or broker call", async () => {
    let called = false;
    const service = createHostOAuthService({
      journal: { append: () => undefined },
      broker: {
        begin: async () => {
          called = true;
          return {};
        },
        status: async () => ({}),
        refresh: async () => ({}),
        access: async () => ({}),
        forget: async () => undefined,
        revoke: async () => ({ kind: "revoked" }),
      },
    });
    const sample = descriptor("https://idp.example/authorize", "https://idp.example/token");
    service.acknowledgeTerms({
      principalKind: "local-window",
      actorId: randomUUID(),
      descriptor: sample,
    });
    const result = await service.begin({
      principalKind: "remote-device",
      actorId: randomUUID(),
      descriptor: sample,
    });
    expect(result).toMatchObject({ kind: "refused", reason: "local-host-required" });
    expect(called).toBe(false);
  });

  it("keeps the API-key path available beside sign-in", () => {
    const service = createHostOAuthService({
      journal: { append: () => undefined },
      broker: throwingBroker(),
    });
    const offer = service.offer(
      descriptor("https://idp.example/authorize", "https://idp.example/token"),
    );
    expect(offer.apiKey.available).toBe(true);
    expect(offer.oauth.available).toBe(true);
  });

  it("does not write the access or refresh token into the journal", async () => {
    const fake = await startFakeAuthorizationServer();
    const store = memoryStore();
    const broker = await startCredentialBroker(store);
    const journal: HostOAuthJournalRecord[] = [];
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: makeHostOAuthBrokerClient({ url: broker.url, token: broker.token }),
      now: () => new Date("2026-10-03T18:04:00.000Z"),
    });
    try {
      const sample = descriptor(`${fake.url}/authorize`, `${fake.url}/token`);
      service.acknowledgeTerms({
        principalKind: "local-window",
        actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
        descriptor: sample,
      });
      const started = await service.begin({
        principalKind: "local-window",
        actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
        descriptor: sample,
      });
      expect(started.kind).toBe("awaiting-consent");
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await service.status({
        principalKind: "local-window",
        attemptId: started.attemptId,
        descriptor: sample,
      });
      expect(done.kind).toBe("signed-in");
      const journalText = JSON.stringify(journal);
      expect(journalText).not.toContain(ACCESS);
      expect(journalText).not.toContain(REFRESH);
      expect([...store.values.values()].join("\n")).toContain(REFRESH);
      expect(journal.map((record) => record.name)).toEqual([
        "host-oauth.terms-acknowledged",
        "host-oauth.sign-in-started",
        "host-oauth.sign-in-completed",
      ]);
    } finally {
      await broker.close();
      await fake.close();
    }
  });

  it("drops a broker field that is not part of the sign-in state instead of journaling it", async () => {
    const journal: HostOAuthJournalRecord[] = [];
    const leaked = "broker-echoed-refresh-token";
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: {
        begin: async () => ({
          kind: "signed-in",
          attemptId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
          descriptorId: "sample-http",
          credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
          refreshToken: leaked,
        }),
        status: async () => ({}),
        refresh: async () => ({}),
        access: async () => ({}),
        forget: async () => undefined,
        revoke: async () => ({ kind: "revoked" }),
      },
      now: () => new Date("2026-10-03T18:04:00.000Z"),
    });
    const sample = descriptor("https://idp.example/authorize", "https://idp.example/token");
    service.acknowledgeTerms({
      principalKind: "local-window",
      actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
      descriptor: sample,
    });
    const started = await service.begin({
      principalKind: "local-window",
      actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
      descriptor: sample,
    });
    expect(started).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(JSON.stringify(journal)).not.toContain(leaked);
  });

  it("forwards an optional credential ref to the broker when beginning sign-in", async () => {
    let forwarded: { readonly credentialRef?: string } | undefined;
    const service = createHostOAuthService({
      journal: { append: () => undefined },
      broker: {
        begin: async (input) => {
          forwarded = input;
          return { kind: "refused", reason: "invalid" };
        },
        status: async () => ({}),
        refresh: async () => ({}),
        access: async () => ({}),
        forget: async () => undefined,
        revoke: async () => ({ kind: "revoked" }),
      },
      now: () => new Date("2026-10-03T18:04:00.000Z"),
    });
    const sample = descriptor("https://idp.example/authorize", "https://idp.example/token");
    service.acknowledgeTerms({
      principalKind: "local-window",
      actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
      descriptor: sample,
    });
    await service.begin({
      principalKind: "local-window",
      actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
      descriptor: sample,
      credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(forwarded?.credentialRef).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("keeps the grant and journals nothing when the issuer could not be told about the sign-out", async () => {
    const journal: HostOAuthJournalRecord[] = [];
    const forgotten: string[] = [];
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: {
        begin: async () => ({}),
        status: async () => ({}),
        refresh: async () => ({}),
        access: async () => ({}),
        forget: async (credentialRef) => void forgotten.push(credentialRef),
        // The broker answers HTTP 200 with not-revoked when the issuer did
        // not confirm the revocation: the refresh token stayed valid there.
        revoke: async () => ({ kind: "not-revoked" }),
      },
    });
    const result = await service.signOut({
      principalKind: "local-window",
      descriptor: chatGptPlan(),
      credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(result).toEqual({ kind: "not-revoked" });
    expect(forgotten).toEqual([]);
    expect(journal.map((record) => record.name)).not.toContain("host-oauth.signed-out");
  });

  it("signs out on this host only, and says the issuer was not told, when asked to forget an unrevoked grant", async () => {
    const journal: HostOAuthJournalRecord[] = [];
    const forgotten: string[] = [];
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: {
        begin: async () => ({}),
        status: async () => ({}),
        refresh: async () => ({}),
        access: async () => ({}),
        forget: async (credentialRef) => void forgotten.push(credentialRef),
        revoke: async () => ({ kind: "not-revoked" }),
      },
    });
    const result = await service.signOut({
      principalKind: "local-window",
      descriptor: chatGptPlan(),
      credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      forgetWhenNotRevoked: true,
    });
    expect(result).toEqual({ kind: "signed-out-locally" });
    expect(forgotten).toEqual(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
    expect(journal.map((record) => record.name)).toContain("host-oauth.signed-out");
  });

  it("removes a ChatGPT plan grant from the credential store on a local sign-out while the issuer is unreachable", async () => {
    const store = memoryStore();
    const credentialRef = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await store.set(
      credentialRef,
      JSON.stringify({
        kind: "host-oauth-grant",
        version: 1,
        accessToken: ACCESS,
        refreshToken: REFRESH,
        tokenType: "Bearer",
        scope: "openid",
        clientId: "oaiapp_test-client",
        tokenEndpoint: "https://auth.openai.com/api/accounts/oauth/token",
        generation: 1,
        dialect: "chatgpt-plan-siwc",
      }),
    );
    let issuerCalls = 0;
    // Every issuer request fails the way an offline network does; the
    // broker's option is typed as Bun's fetch, which also carries preconnect.
    const offline = Object.assign(
      async (): Promise<Response> => {
        issuerCalls += 1;
        throw new TypeError("network is offline");
      },
      { preconnect: fetch.preconnect },
    );
    const broker = await startCredentialBroker(store, undefined, { fetch: offline });
    const journal: HostOAuthJournalRecord[] = [];
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: makeHostOAuthBrokerClient({ url: broker.url, token: broker.token }),
    });
    try {
      await expect(
        service.signOut({
          principalKind: "local-window",
          descriptor: chatGptPlan(),
          credentialRef,
        }),
      ).resolves.toEqual({ kind: "not-revoked" });
      expect(store.values.has(credentialRef)).toBe(true);
      await expect(
        service.signOut({
          principalKind: "local-window",
          descriptor: chatGptPlan(),
          credentialRef,
          forgetWhenNotRevoked: true,
        }),
      ).resolves.toEqual({ kind: "signed-out-locally" });
      expect(issuerCalls).toBeGreaterThan(0);
      expect(store.values.has(credentialRef)).toBe(false);
      expect(journal.map((record) => record.name)).toEqual(["host-oauth.signed-out"]);
    } finally {
      await broker.close();
    }
  });

  it("reports sign-out unavailable when the broker could not drop the grant", async () => {
    const journal: HostOAuthJournalRecord[] = [];
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: {
        begin: async () => ({}),
        status: async () => ({}),
        refresh: async () => ({}),
        access: async () => ({}),
        forget: async () => undefined,
        revoke: async () => ({ kind: "unavailable" }),
      },
    });
    const result = await service.signOut({
      principalKind: "local-window",
      descriptor: chatGptPlan(),
      credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      forgetWhenNotRevoked: true,
    });
    expect(result).toEqual({ kind: "unavailable" });
    expect(journal.map((record) => record.name)).not.toContain("host-oauth.signed-out");
  });

  it("registers a ChatGPT plan sign-in under the host id derived from the data directory", async () => {
    const forwarded: unknown[] = [];
    const dataDirectory = "/Users/example/Library/Application Support/Octant";
    const hostId = extAgentHostIdFor(dataDirectory);
    expect(hostId).toBe(`urn:uuid:${deriveHostRuntimeHostId(dataDirectory)}`);
    expect(hostId).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Stable across restarts of the same host, distinct for another host.
    expect(extAgentHostIdFor(dataDirectory)).toBe(hostId);
    expect(extAgentHostIdFor("/Users/example/other-octant-data")).not.toBe(hostId);
    const service = createHostOAuthService({
      journal: { append: () => undefined },
      broker: {
        begin: async (input) => {
          forwarded.push(input.descriptor);
          return {
            kind: "refused",
            descriptorId: input.descriptor.descriptorId,
            reason: "invalid",
          };
        },
        status: async () => ({}),
        refresh: async () => ({}),
        access: async () => ({}),
        forget: async () => undefined,
        revoke: async () => ({ kind: "revoked" }),
      },
      extAgentHostId: hostId,
    });
    for (const sample of [
      chatGptPlan(),
      descriptor("https://idp.example/authorize", "https://idp.example/token"),
    ]) {
      service.acknowledgeTerms({
        principalKind: "local-window",
        actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
        descriptor: sample,
      });
      await service.begin({
        principalKind: "local-window",
        actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
        descriptor: sample,
      });
    }
    expect(forwarded[0]).toMatchObject({ descriptorId: "chatgpt-plan", extAgentHostId: hostId });
    // Only the ChatGPT plan dialect registers the host; other sign-ins never
    // carry the host id.
    expect(forwarded[1]).not.toHaveProperty("extAgentHostId");
  });

  it("journals the sign-out only after the broker confirms the grant was revoked", async () => {
    const journal: HostOAuthJournalRecord[] = [];
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: {
        begin: async () => ({}),
        status: async () => ({}),
        refresh: async () => ({}),
        access: async () => ({}),
        forget: async () => undefined,
        revoke: async () => ({ kind: "revoked" }),
      },
    });
    const plan = decodeHostOAuthDescriptor({
      descriptorId: "chatgpt-plan",
      dialect: "chatgpt-plan-siwc",
      flow: "authorization-code-pkce",
      authorizationEndpoint: "https://auth.openai.com/api/accounts/authorize",
      tokenEndpoint: "https://auth.openai.com/api/accounts/oauth/token",
      scopes: ["openid"],
      termsId: "chatgpt-plan-terms-1",
    });
    const result = await service.signOut({
      principalKind: "local-window",
      descriptor: plan,
      credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(result).toEqual({ kind: "signed-out" });
    expect(journal.map((record) => record.name)).toContain("host-oauth.signed-out");
  });

  it("journals a finished ChatGPT plan sign-in from the answer the broker gives once the callback lands", async () => {
    const journal: HostOAuthJournalRecord[] = [];
    const attemptId = "acd76c77-23e4-40e0-bf23-b4783c7f4757";
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: {
        ...throwingBroker(),
        // The exact shape a live broker published for a finished sign-in.
        status: async () => ({
          kind: "signed-in",
          attemptId,
          descriptorId: "chatgpt-plan",
          credentialRef: "324feb28-718a-462a-9a15-1d999922d1b5",
        }),
      },
    });
    const done = await service.status({
      principalKind: "local-window",
      attemptId,
      descriptor: chatGptPlan(),
    });
    expect(done).toMatchObject({ kind: "signed-in", attemptId });
    expect(journal).toEqual([
      {
        name: "host-oauth.sign-in-completed",
        descriptorId: "chatgpt-plan",
        attemptId,
        credentialRef: "324feb28-718a-462a-9a15-1d999922d1b5",
      },
    ]);
  });

  it("refuses a finished sign-in it cannot journal, and says why in the log without a secret", async () => {
    const lines: string[] = [];
    const attemptId = "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19";
    let fail = true;
    const journal: HostOAuthJournalRecord[] = [];
    const service = createHostOAuthService({
      journal: {
        append: (record) => {
          if (fail) throw new Error(`disk full while writing ${ACCESS}`);
          journal.push(record);
        },
      },
      broker: {
        ...throwingBroker(),
        status: async () => ({
          kind: "signed-in",
          attemptId,
          descriptorId: "chatgpt-plan",
          credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
        }),
      },
      log: (line) => lines.push(line),
    });
    const input = { principalKind: "local-window" as const, attemptId, descriptor: chatGptPlan() };
    expect(await service.status(input)).toEqual({
      kind: "refused",
      attemptId,
      descriptorId: "chatgpt-plan",
      reason: "unavailable",
    });
    expect(lines.join("\n")).toContain("host-oauth.sign-in-completed");
    expect(lines.join("\n")).not.toContain(ACCESS);
    expect(lines.join("\n")).not.toContain("7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a");
    // Once the journal works again, the next poll still records the sign-in.
    fail = false;
    expect(await service.status(input)).toMatchObject({ kind: "signed-in" });
    expect(journal.map((record) => record.name)).toEqual(["host-oauth.sign-in-completed"]);
  });

  it("refuses and logs a sign-in state from the broker the server cannot read", async () => {
    const lines: string[] = [];
    const journal: HostOAuthJournalRecord[] = [];
    const attemptId = "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19";
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: {
        ...throwingBroker(),
        status: async () => ({
          kind: "refused",
          attemptId,
          descriptorId: "chatgpt-plan",
          reason: "client-id-unexpected",
          accessToken: ACCESS,
        }),
      },
      log: (line) => lines.push(line),
    });
    const refused = await service.status({
      principalKind: "local-window",
      attemptId,
      descriptor: chatGptPlan(),
    });
    expect(refused).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(journal).toEqual([
      {
        name: "host-oauth.sign-in-refused",
        descriptorId: "chatgpt-plan",
        attemptId,
        reason: "unavailable",
      },
    ]);
    const logged = lines.join("\n");
    expect(logged).toContain("refused");
    expect(logged).toContain("client-id-unexpected");
    expect(logged).not.toContain(ACCESS);
  });
});

describe("host OAuth broker client", () => {
  it("posts an optional credential ref on begin and omits it when absent", async () => {
    const bodies: unknown[] = [];
    const client = makeHostOAuthBrokerClient({
      url: "http://127.0.0.1:9",
      token: "broker-token",
      fetch: async (_input, init) => {
        const parsed: unknown = JSON.parse(String(init?.body));
        bodies.push(parsed);
        return new Response(JSON.stringify({ kind: "refused", reason: "invalid" }), {
          status: 200,
        });
      },
    });
    const brokerDescriptor = {
      descriptorId: "sample-http",
      clientId: "public-client",
      flow: "authorization-code-pkce" as const,
      authorizationEndpoint: "https://idp.example/authorize",
      tokenEndpoint: "https://idp.example/token",
      scopes: ["read"],
      termsId: "terms-v1",
    };
    await client.begin({
      descriptor: brokerDescriptor,
      actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
      termsAcknowledgedAt: "2026-10-03T18:04:00.000Z",
      credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    await client.begin({
      descriptor: brokerDescriptor,
      actorId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
      termsAcknowledgedAt: "2026-10-03T18:04:00.000Z",
    });
    expect(bodies[0]).toMatchObject({
      credentialRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(bodies[1]).not.toHaveProperty("credentialRef");
  });
});

function throwingBroker() {
  return {
    begin: async () => {
      throw new Error("broker must not be called");
    },
    status: async () => {
      throw new Error("broker must not be called");
    },
    refresh: async () => {
      throw new Error("broker must not be called");
    },
    access: async () => {
      throw new Error("broker must not be called");
    },
    forget: async () => {
      throw new Error("broker must not be called");
    },
    revoke: async () => {
      throw new Error("broker must not be called");
    },
  };
}

async function startFakeAuthorizationServer(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const challenges = new Map<string, string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (redirect === null || state === null || challenge === null) {
        response.writeHead(400);
        response.end();
        return;
      }
      challenges.set(state, challenge);
      const callback = new URL(redirect);
      callback.searchParams.set("code", "auth-code");
      callback.searchParams.set("state", state);
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/token") {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const verifier =
        new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const known = [...challenges.values()].includes(challenge);
      if (!known) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: ACCESS,
          refresh_token: REFRESH,
          token_type: "Bearer",
          expires_in: 30,
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

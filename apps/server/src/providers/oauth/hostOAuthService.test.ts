import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startCredentialBroker } from "@octant/host-runtime";
import { CredentialStoreFailure, type CredentialStore } from "@octant/host-runtime";
import {
  decodeHostOAuthDescriptor,
  type HostOAuthJournalRecord,
} from "@octant/contracts/host-oauth";
import { describe, expect, it } from "vitest";
import { makeHostOAuthBrokerClient } from "./hostOAuthBrokerClient";
import { createHostOAuthService } from "./hostOAuthService";

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

  it("reports sign-out unavailable and journals nothing when the broker could not revoke the grant", async () => {
    const journal: HostOAuthJournalRecord[] = [];
    const service = createHostOAuthService({
      journal: { append: (record) => journal.push(record) },
      broker: {
        begin: async () => ({}),
        status: async () => ({}),
        refresh: async () => ({}),
        access: async () => ({}),
        forget: async () => undefined,
        // The broker answers HTTP 200 with an unavailable result when the
        // issuer refused the revocation: the refresh token stayed valid.
        revoke: async () => ({ kind: "unavailable" }),
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
    expect(result).toEqual({ kind: "unavailable" });
    expect(journal.map((record) => record.name)).not.toContain("host-oauth.signed-out");
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

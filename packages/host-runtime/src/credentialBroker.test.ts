import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { startCredentialBroker } from "./credentialBroker";
import { CredentialPurgeFailure, type CredentialPurgeStore } from "./credentialStore";

const providerInstanceId = randomUUID();
const credential = "fixture-provider-credential";

function purgeInput(dryRun: boolean) {
  return { dryRun, providerInstanceIds: [providerInstanceId] };
}

function purgeStore(
  purge: CredentialPurgeStore["purge"] = async (input) =>
    input.dryRun
      ? { dryRun: true, matchedCount: 0 }
      : { dryRun: false, deletedCount: 0, failedCount: 0 },
): CredentialPurgeStore {
  return { purge };
}

function memoryStore(): CredentialStore {
  const credentials = new Map<string, string>([[providerInstanceId, credential]]);
  return {
    set: async (id, value) => void credentials.set(id, value),
    has: async (id) => credentials.has(id),
    resolve: async (id) => {
      const value = credentials.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void credentials.delete(id),
  };
}

function brokerRequest(url: string, token: string, path: string, init: RequestInit = {}): Request {
  const { body, headers, ...rest } = init;
  const resolvedBody =
    init.method === "GET" || init.method === "HEAD"
      ? undefined
      : body === undefined
        ? JSON.stringify({ providerInstanceId })
        : body;
  return new Request(new URL(path, url), {
    method: "POST",
    ...rest,
    ...(resolvedBody === undefined ? {} : { body: resolvedBody }),
    headers: {
      "content-type": "application/json",
      "x-octant-credential-broker-token": token,
      ...headers,
    },
  });
}

describe("startCredentialBroker", () => {
  it("binds a random loopback port and creates a distinct launch token", async () => {
    const first = await startCredentialBroker(memoryStore());
    const second = await startCredentialBroker(memoryStore());
    try {
      const firstUrl = new URL(first.url);
      const secondUrl = new URL(second.url);
      expect(firstUrl.hostname).toBe("127.0.0.1");
      expect(Number(firstUrl.port)).toBeGreaterThan(0);
      expect(secondUrl.hostname).toBe("127.0.0.1");
      expect(secondUrl.port).not.toBe(firstUrl.port);
      expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.token).not.toBe(first.token);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("rejects browser, unauthenticated, and non-loopback credential resolution", async () => {
    const broker = await startCredentialBroker(memoryStore());
    try {
      const browserRequest = brokerRequest(broker.url, broker.token, "/v1/credentials/resolve", {
        headers: { origin: "http://127.0.0.1:13773" },
      });
      const unauthenticated = brokerRequest(
        broker.url,
        `${broker.token.slice(0, -1)}x`,
        "/v1/credentials/resolve",
      );
      const remote = brokerRequest(broker.url, broker.token, "/v1/credentials/resolve");
      const oversizedWithoutAuthority = fetch(new URL("/v1/credentials/resolve", broker.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(4097),
      });

      expect((await broker.fetchForTest(browserRequest)).status).toBe(401);
      expect((await broker.fetchForTest(unauthenticated)).status).toBe(401);
      expect((await broker.fetchForTest(remote, "192.0.2.10")).status).toBe(401);
      expect((await oversizedWithoutAuthority).status).toBe(401);
    } finally {
      await broker.close();
    }
  });

  it("exposes only exact POST routes without query parameters", async () => {
    const broker = await startCredentialBroker(memoryStore());
    try {
      const get = brokerRequest(broker.url, broker.token, "/v1/credentials/has", {
        method: "GET",
      });
      const query = brokerRequest(broker.url, broker.token, "/v1/credentials/has?debug=true");
      const nested = brokerRequest(broker.url, broker.token, "/v1/credentials/has/");
      const unknown = brokerRequest(broker.url, broker.token, "/v1/credentials/delete");

      expect((await broker.fetchForTest(get)).status).toBe(405);
      expect((await broker.fetchForTest(query)).status).toBe(400);
      expect((await broker.fetchForTest(nested)).status).toBe(404);
      expect((await broker.fetchForTest(unknown)).status).toBe(404);
    } finally {
      await broker.close();
    }
  });

  it("requires JSON with one canonical UUID and enforces the 16 KiB body limit", async () => {
    const broker = await startCredentialBroker(memoryStore());
    try {
      const wrongType = brokerRequest(broker.url, broker.token, "/v1/credentials/has", {
        headers: { "content-type": "text/plain" },
      });
      const extraKey = brokerRequest(broker.url, broker.token, "/v1/credentials/has", {
        body: JSON.stringify({ providerInstanceId, extra: true }),
      });
      const uppercase = brokerRequest(broker.url, broker.token, "/v1/credentials/has", {
        body: JSON.stringify({ providerInstanceId: providerInstanceId.toUpperCase() }),
      });
      const oversized = brokerRequest(broker.url, broker.token, "/v1/credentials/has", {
        body: JSON.stringify({ providerInstanceId, padding: "x".repeat(16 * 1024) }),
      });

      expect((await broker.fetchForTest(wrongType)).status).toBe(415);
      expect((await broker.fetchForTest(extraKey)).status).toBe(400);
      expect((await broker.fetchForTest(uppercase)).status).toBe(400);
      expect((await broker.fetchForTest(oversized)).status).toBe(413);
    } finally {
      await broker.close();
    }
  });

  it.each([
    ["array", [providerInstanceId]],
    ["object", { value: providerInstanceId }],
    ["number", 42],
    ["null", null],
  ])("rejects a non-string %s provider instance ID", async (_kind, value) => {
    const broker = await startCredentialBroker(memoryStore());
    try {
      const response = await broker.fetchForTest(
        brokerRequest(broker.url, broker.token, "/v1/credentials/has", {
          body: JSON.stringify({ providerInstanceId: value }),
        }),
      );

      expect(response.status).toBe(400);
    } finally {
      await broker.close();
    }
  });

  it("returns only presence or credential data to an authenticated loopback caller", async () => {
    const broker = await startCredentialBroker(memoryStore());
    try {
      const hasResponse = await fetch(new URL("/v1/credentials/has", broker.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": broker.token,
        },
        body: JSON.stringify({ providerInstanceId }),
      });
      const resolveResponse = await fetch(new URL("/v1/credentials/resolve", broker.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": broker.token,
        },
        body: JSON.stringify({ providerInstanceId }),
      });

      expect(hasResponse.status).toBe(200);
      expect(await hasResponse.json()).toEqual({ present: true });
      expect(resolveResponse.status).toBe(200);
      expect(await resolveResponse.json()).toEqual({ credential });
    } finally {
      await broker.close();
    }
  });

  it("sanitizes credential-store failures", async () => {
    const privateFailure = "private keychain diagnostic";
    const store: CredentialStore = {
      ...memoryStore(),
      resolve: async () => {
        throw new Error(privateFailure);
      },
    };
    const broker = await startCredentialBroker(store);
    try {
      const response = await broker.fetchForTest(
        brokerRequest(broker.url, broker.token, "/v1/credentials/resolve"),
      );
      const output = await response.text();

      expect(response.status).toBe(503);
      expect(output).not.toContain(privateFailure);
      expect(output).not.toContain(credential);
    } finally {
      await broker.close();
    }
  });

  describe("/v1/credentials/purge", () => {
    function purgeRequest(url: string, token: string, body: unknown): Request {
      return new Request(new URL("/v1/credentials/purge", url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": token,
        },
        body: JSON.stringify(body),
      });
    }

    it("reports a dry-run match count without deleting anything", async () => {
      const broker = await startCredentialBroker(
        memoryStore(),
        purgeStore(async (input) => {
          expect(input).toEqual(purgeInput(true));
          return { dryRun: true, matchedCount: 5 };
        }),
      );
      try {
        const response = await broker.fetchForTest(
          purgeRequest(broker.url, broker.token, purgeInput(true)),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ dryRun: true, matchedCount: 5 });
      } finally {
        await broker.close();
      }
    });

    it("accepts the complete bounded batch of provider identities", async () => {
      const providerInstanceIds = Array.from(
        { length: 128 },
        (_, index) => `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      );
      const broker = await startCredentialBroker(
        memoryStore(),
        purgeStore(async (input) => {
          expect(input).toEqual({ dryRun: true, providerInstanceIds });
          return { dryRun: true, matchedCount: providerInstanceIds.length };
        }),
      );
      try {
        const response = await broker.fetchForTest(
          purgeRequest(broker.url, broker.token, { dryRun: true, providerInstanceIds }),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ dryRun: true, matchedCount: 128 });
      } finally {
        await broker.close();
      }
    });

    it("reports a completed and a partially failing purge without a plaintext fallback", async () => {
      const broker = await startCredentialBroker(
        memoryStore(),
        purgeStore(async () => ({ dryRun: false, deletedCount: 1, failedCount: 1 })),
      );
      try {
        const response = await broker.fetchForTest(
          purgeRequest(broker.url, broker.token, purgeInput(false)),
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({ dryRun: false, deletedCount: 1, failedCount: 1 });
        expect(JSON.stringify(body)).not.toMatch(/[0-9a-f-]{36}/);
      } finally {
        await broker.close();
      }
    });

    it.each([
      ["locked", "locked", 423],
      ["unavailable", "unavailable", 503],
      ["indeterminate", "indeterminate", 500],
      ["failed", "failed", 500],
    ] as const)(
      "maps a %s Keychain purge failure to a typed status without raw diagnostics",
      async (category, expectedError, expectedStatus) => {
        const broker = await startCredentialBroker(
          memoryStore(),
          purgeStore(async () => {
            throw new CredentialPurgeFailure(category);
          }),
        );
        try {
          const response = await broker.fetchForTest(
            purgeRequest(broker.url, broker.token, purgeInput(false)),
          );
          const output = await response.text();

          expect(response.status).toBe(expectedStatus);
          expect(await JSON.parse(output)).toEqual({ error: expectedError });
        } finally {
          await broker.close();
        }
      },
    );

    it("rejects a request without a configured purge boundary", async () => {
      const broker = await startCredentialBroker(memoryStore());
      try {
        const response = await broker.fetchForTest(
          purgeRequest(broker.url, broker.token, purgeInput(true)),
        );

        expect(response.status).toBe(404);
      } finally {
        await broker.close();
      }
    });

    it("rejects an unauthenticated, non-boolean, or malformed purge request", async () => {
      const broker = await startCredentialBroker(memoryStore(), purgeStore());
      try {
        const unauthenticated = await broker.fetchForTest(
          purgeRequest(broker.url, `${broker.token.slice(0, -1)}x`, purgeInput(true)),
        );
        const nonBoolean = await broker.fetchForTest(
          purgeRequest(broker.url, broker.token, { ...purgeInput(true), dryRun: "true" }),
        );
        const extraKey = await broker.fetchForTest(
          purgeRequest(broker.url, broker.token, { dryRun: true, providerInstanceId }),
        );
        const duplicateProviderIds = await broker.fetchForTest(
          purgeRequest(broker.url, broker.token, {
            dryRun: true,
            providerInstanceIds: [providerInstanceId, providerInstanceId],
          }),
        );
        const malformedHostIdentityEvidence = await broker.fetchForTest(
          purgeRequest(broker.url, broker.token, {
            ...purgeInput(true),
            hostIdentityFingerprint: "not-a-fingerprint",
          }),
        );
        const missingKey = await broker.fetchForTest(purgeRequest(broker.url, broker.token, {}));

        expect(unauthenticated.status).toBe(401);
        expect(nonBoolean.status).toBe(400);
        expect(extraKey.status).toBe(400);
        expect(duplicateProviderIds.status).toBe(400);
        expect(malformedHostIdentityEvidence.status).toBe(400);
        expect(missingKey.status).toBe(400);
      } finally {
        await broker.close();
      }
    });
  });
});

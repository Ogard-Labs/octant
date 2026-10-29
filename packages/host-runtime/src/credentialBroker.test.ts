import { createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import type { OnePasswordRead } from "./appStoreConnectKeySource";
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
      const unknown = brokerRequest(broker.url, broker.token, "/v1/credentials/rotate");

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

      const nextId = randomUUID();
      const setResponse = await fetch(new URL("/v1/credentials/set", broker.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": broker.token,
        },
        body: JSON.stringify({ providerInstanceId: nextId, credential: "next-secret" }),
      });
      expect(setResponse.status).toBe(200);
      expect(await setResponse.json()).toEqual({ stored: true });
      const stored = await fetch(new URL("/v1/credentials/has", broker.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": broker.token,
        },
        body: JSON.stringify({ providerInstanceId: nextId }),
      });
      expect(await stored.json()).toEqual({ present: true });
      const deleteResponse = await fetch(new URL("/v1/credentials/delete", broker.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": broker.token,
        },
        body: JSON.stringify({ providerInstanceId: nextId }),
      });
      expect(deleteResponse.status).toBe(200);
      expect(await deleteResponse.json()).toEqual({ deleted: true });
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
      expect(JSON.parse(output)).toEqual({ error: "failed" });
      expect(output).not.toContain(privateFailure);
      expect(output).not.toContain(credential);
    } finally {
      await broker.close();
    }
  });

  it("returns the credential store's own category for a missing or unreadable secret", async () => {
    const missing = await startCredentialBroker({
      ...memoryStore(),
      resolve: async () => {
        throw new CredentialStoreFailure("missing");
      },
    });
    const unreadable = await startCredentialBroker({
      ...memoryStore(),
      resolve: async () => {
        throw new CredentialStoreFailure("unavailable");
      },
    });
    try {
      const missingResponse = await missing.fetchForTest(
        brokerRequest(missing.url, missing.token, "/v1/credentials/resolve"),
      );
      const unreadableResponse = await unreadable.fetchForTest(
        brokerRequest(unreadable.url, unreadable.token, "/v1/credentials/resolve"),
      );
      expect(missingResponse.status).toBe(404);
      expect(await missingResponse.json()).toEqual({ error: "missing" });
      expect(unreadableResponse.status).toBe(503);
      expect(await unreadableResponse.json()).toEqual({ error: "unavailable" });
    } finally {
      await missing.close();
      await unreadable.close();
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

  it("keeps replica device keys out of reach of a provider instance with the same id", async () => {
    const instanceId = randomUUID();
    const providers = memoryStore();
    const deviceKeys = memoryStore();
    const broker = await startCredentialBroker(providers, undefined, undefined, deviceKeys);
    try {
      const call = async (path: string, body: Record<string, string>) =>
        broker.fetchForTest(
          brokerRequest(broker.url, broker.token, path, { body: JSON.stringify(body) }),
        );
      expect(
        (await call("/v1/replica-device-keys/set", { instanceId, credential: "device-private" }))
          .status,
      ).toBe(200);

      // The provider routes name the same UUID and reach a different store.
      expect(
        (await call("/v1/credentials/resolve", { providerInstanceId: instanceId })).status,
      ).toBe(404);
      expect(
        await (await call("/v1/credentials/has", { providerInstanceId: instanceId })).json(),
      ).toEqual({ present: false });
      expect(
        (
          await call("/v1/credentials/set", {
            providerInstanceId: instanceId,
            credential: "provider-overwrite",
          })
        ).status,
      ).toBe(200);
      expect(
        (await call("/v1/credentials/delete", { providerInstanceId: instanceId })).status,
      ).toBe(200);

      expect(await deviceKeys.resolve(instanceId)).toBe("device-private");
      expect(await (await call("/v1/replica-device-keys/resolve", { instanceId })).json()).toEqual({
        credential: "device-private",
      });
      // A provider-shaped body is not a device-key request.
      expect(
        (await call("/v1/replica-device-keys/resolve", { providerInstanceId: instanceId })).status,
      ).toBe(400);
    } finally {
      await broker.close();
    }
  });

  it("keeps a sync bucket's key pair out of reach of a provider instance with the same id", async () => {
    const credentialRef = randomUUID();
    const providers = memoryStore();
    const deviceKeys = memoryStore();
    const bucketKeys = memoryStore();
    const broker = await startCredentialBroker(
      providers,
      undefined,
      undefined,
      deviceKeys,
      bucketKeys,
    );
    try {
      const call = async (path: string, body: Record<string, string>) =>
        broker.fetchForTest(
          brokerRequest(broker.url, broker.token, path, { body: JSON.stringify(body) }),
        );
      expect(
        (
          await call("/v1/replica-store-credentials/set", {
            credentialRef,
            credential: "bucket-key-pair",
          })
        ).status,
      ).toBe(200);

      // The provider and device-key routes name the same UUID and reach other stores.
      expect(
        (await call("/v1/credentials/resolve", { providerInstanceId: credentialRef })).status,
      ).toBe(404);
      expect(
        await (await call("/v1/credentials/has", { providerInstanceId: credentialRef })).json(),
      ).toEqual({ present: false });
      expect(
        (
          await call("/v1/credentials/set", {
            providerInstanceId: credentialRef,
            credential: "provider-overwrite",
          })
        ).status,
      ).toBe(200);
      expect(
        (await call("/v1/credentials/delete", { providerInstanceId: credentialRef })).status,
      ).toBe(200);
      expect(
        await (await call("/v1/replica-device-keys/has", { instanceId: credentialRef })).json(),
      ).toEqual({ present: false });
      expect(
        (await call("/v1/replica-device-keys/delete", { instanceId: credentialRef })).status,
      ).toBe(200);

      expect(await bucketKeys.resolve(credentialRef)).toBe("bucket-key-pair");
      expect(
        await (await call("/v1/replica-store-credentials/resolve", { credentialRef })).json(),
      ).toEqual({ credential: "bucket-key-pair" });
      // A provider-shaped or device-key-shaped body is not a bucket request.
      expect(
        (
          await call("/v1/replica-store-credentials/resolve", {
            providerInstanceId: credentialRef,
          })
        ).status,
      ).toBe(400);
      expect(
        (await call("/v1/replica-store-credentials/resolve", { instanceId: credentialRef })).status,
      ).toBe(400);
    } finally {
      await broker.close();
    }
  });

  it("keeps a public link's owner secret out of reach of the provider and sync key routes", async () => {
    const credentialRef = randomUUID();
    const linkSecrets = memoryStore();
    const broker = await startCredentialBroker(
      memoryStore(),
      undefined,
      undefined,
      memoryStore(),
      memoryStore(),
      linkSecrets,
    );
    try {
      const call = async (path: string, body: Record<string, string>) =>
        broker.fetchForTest(
          brokerRequest(broker.url, broker.token, path, { body: JSON.stringify(body) }),
        );
      expect(
        (
          await call("/v1/canvas-public-share-secrets/set", {
            credentialRef,
            credential: "owner-secret",
          })
        ).status,
      ).toBe(200);
      expect(
        (await call("/v1/credentials/resolve", { providerInstanceId: credentialRef })).status,
      ).toBe(404);
      expect((await call("/v1/replica-store-credentials/resolve", { credentialRef })).status).toBe(
        404,
      );
      expect(
        await (await call("/v1/canvas-public-share-secrets/resolve", { credentialRef })).json(),
      ).toEqual({ credential: "owner-secret" });
      expect(
        await (await call("/v1/canvas-public-share-secrets/delete", { credentialRef })).json(),
      ).toEqual({ deleted: true });
      expect(await linkSecrets.has(credentialRef)).toBe(false);
    } finally {
      await broker.close();
    }
  });

  it("keeps a desktop provider's key out of reach of every other route that names the same id", async () => {
    const credentialRef = randomUUID();
    const desktopKeys = memoryStore();
    const broker = await startCredentialBroker(
      memoryStore(),
      undefined,
      undefined,
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      desktopKeys,
    );
    try {
      const call = async (path: string, body: Record<string, string>) =>
        broker.fetchForTest(
          brokerRequest(broker.url, broker.token, path, { body: JSON.stringify(body) }),
        );
      expect(
        (
          await call("/v1/desktop-provider-credentials/set", {
            credentialRef,
            credential: "desktop-api-key",
          })
        ).status,
      ).toBe(200);
      expect(
        (await call("/v1/credentials/resolve", { providerInstanceId: credentialRef })).status,
      ).toBe(404);
      for (const route of [
        "/v1/replica-store-credentials/resolve",
        "/v1/canvas-public-share-secrets/resolve",
      ]) {
        expect((await call(route, { credentialRef })).status).toBe(404);
      }
      expect(
        (await call("/v1/mcp-server-credentials/resolve", { secretId: credentialRef })).status,
      ).toBe(404);
      expect(
        await (await call("/v1/desktop-provider-credentials/resolve", { credentialRef })).json(),
      ).toEqual({ credential: "desktop-api-key" });
      expect(
        (
          await call("/v1/desktop-provider-credentials/resolve", {
            providerInstanceId: credentialRef,
          })
        ).status,
      ).toBe(400);
      expect(
        await (await call("/v1/desktop-provider-credentials/delete", { credentialRef })).json(),
      ).toEqual({ deleted: true });
      expect(await desktopKeys.has(credentialRef)).toBe(false);
    } finally {
      await broker.close();
    }
  });

  it("stores an App Store Connect key that no route, its own included, can read back", async () => {
    const credentialRef = randomUUID();
    const appStoreConnectKeys = memoryStore();
    const broker = await startCredentialBroker(
      memoryStore(),
      undefined,
      undefined,
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      appStoreConnectKeys,
    );
    try {
      const call = async (path: string, body: Record<string, string>) =>
        broker.fetchForTest(
          brokerRequest(broker.url, broker.token, path, { body: JSON.stringify(body) }),
        );
      expect(
        await (
          await call("/v1/app-store-connect-keys/set", { credentialRef, credential: "asc-key" })
        ).json(),
      ).toEqual({ stored: true });
      expect(
        await (await call("/v1/app-store-connect-keys/has", { credentialRef })).json(),
      ).toEqual({ present: true });
      expect((await call("/v1/app-store-connect-keys/resolve", { credentialRef })).status).toBe(
        404,
      );
      expect(
        (await call("/v1/credentials/resolve", { providerInstanceId: credentialRef })).status,
      ).toBe(404);
      for (const route of [
        "/v1/replica-store-credentials/resolve",
        "/v1/canvas-public-share-secrets/resolve",
        "/v1/desktop-provider-credentials/resolve",
      ]) {
        expect((await call(route, { credentialRef })).status).toBe(404);
      }
      expect(
        await (await call("/v1/app-store-connect-keys/delete", { credentialRef })).json(),
      ).toEqual({ deleted: true });
      expect(await appStoreConnectKeys.has(credentialRef)).toBe(false);
    } finally {
      await broker.close();
    }
  });

  it("writes an upload's App Store Connect key file into that upload's private folder only, and removes it", async () => {
    const credentialRef = randomUUID();
    const root = mkdtempSync(join(tmpdir(), "octant-asc-key-files-"));
    const keys = memoryStore();
    const privateKey = "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n";
    await keys.set(
      credentialRef,
      JSON.stringify({
        version: 1,
        issuerId: "30000000-0000-4000-8000-000000000001",
        keyId: "ABCDE12345",
        privateKey,
      }),
    );
    const broker = await startCredentialBroker(
      memoryStore(),
      undefined,
      undefined,
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      keys,
      root,
    );
    const call = async (path: string, body: Record<string, string>) =>
      broker.fetchForTest(
        brokerRequest(broker.url, broker.token, path, { body: JSON.stringify(body) }),
      );
    try {
      const folder = join(root, `upload-${randomUUID()}`);
      mkdirSync(folder, { mode: 0o700 });
      const written = await call("/v1/app-store-connect-keys/write-key-file", {
        credentialRef,
        directory: folder,
      });
      const answer = (await written.json()) as Record<string, string>;
      // The answer names the file and the key's public IDs, never the key.
      expect(answer).toEqual({
        file: join(folder, "AuthKey_ABCDE12345.p8"),
        issuerId: "30000000-0000-4000-8000-000000000001",
        keyId: "ABCDE12345",
      });
      expect(JSON.stringify(answer)).not.toContain("PRIVATE KEY");
      expect(readFileSync(join(folder, "AuthKey_ABCDE12345.p8"), "utf8")).toBe(privateKey);
      expect(statSync(join(folder, "AuthKey_ABCDE12345.p8")).mode & 0o777).toBe(0o600);
      // A second write does not replace a file already there.
      expect(
        (
          await call("/v1/app-store-connect-keys/write-key-file", {
            credentialRef,
            directory: folder,
          })
        ).status,
      ).toBe(409);
      expect(
        await (
          await call("/v1/app-store-connect-keys/remove-key-file", { directory: folder })
        ).json(),
      ).toEqual({ removed: true });
      expect(readdirSync(folder)).toEqual([]);

      // Nowhere else: outside the root, a folder others can read, a link, or a
      // folder not named for an upload.
      const outside = mkdtempSync(join(tmpdir(), "upload-"));
      const open = join(root, `upload-${randomUUID()}`);
      mkdirSync(open, { mode: 0o755 });
      const linked = join(root, `upload-${randomUUID()}`);
      symlinkSync(outside, linked);
      const misnamed = join(root, "checkout");
      mkdirSync(misnamed, { mode: 0o700 });
      for (const directory of [outside, open, linked, misnamed]) {
        expect(
          (await call("/v1/app-store-connect-keys/write-key-file", { credentialRef, directory }))
            .status,
        ).toBe(400);
      }
      expect(readdirSync(outside)).toEqual([]);
      rmSync(outside, { recursive: true, force: true });
    } finally {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces and deletes a sync bucket's key pair", async () => {
    const credentialRef = randomUUID();
    const broker = await startCredentialBroker(
      memoryStore(),
      undefined,
      undefined,
      memoryStore(),
      memoryStore(),
    );
    try {
      const call = async (path: string, body: Record<string, string>) =>
        broker.fetchForTest(
          brokerRequest(broker.url, broker.token, path, { body: JSON.stringify(body) }),
        );
      await call("/v1/replica-store-credentials/set", { credentialRef, credential: "first" });
      expect(
        await (
          await call("/v1/replica-store-credentials/set", { credentialRef, credential: "second" })
        ).json(),
      ).toEqual({ stored: true });
      expect(
        await (await call("/v1/replica-store-credentials/resolve", { credentialRef })).json(),
      ).toEqual({ credential: "second" });

      expect(
        await (await call("/v1/replica-store-credentials/delete", { credentialRef })).json(),
      ).toEqual({ deleted: true });
      expect(
        await (await call("/v1/replica-store-credentials/has", { credentialRef })).json(),
      ).toEqual({ present: false });
      expect((await call("/v1/replica-store-credentials/resolve", { credentialRef })).status).toBe(
        404,
      );
    } finally {
      await broker.close();
    }
  });

  it("does not serve sync bucket routes when the host gave the broker no store for them", async () => {
    const broker = await startCredentialBroker(memoryStore(), undefined, undefined, memoryStore());
    try {
      const response = await broker.fetchForTest(
        brokerRequest(broker.url, broker.token, "/v1/replica-store-credentials/has", {
          body: JSON.stringify({ credentialRef: randomUUID() }),
        }),
      );
      expect(response.status).toBe(404);
    } finally {
      await broker.close();
    }
  });

  it("does not serve device-key routes when the host gave the broker no device-key store", async () => {
    const broker = await startCredentialBroker(memoryStore());
    try {
      const response = await broker.fetchForTest(
        brokerRequest(broker.url, broker.token, "/v1/replica-device-keys/has", {
          body: JSON.stringify({ instanceId: randomUUID() }),
        }),
      );
      expect(response.status).toBe(404);
    } finally {
      await broker.close();
    }
  });
});

describe("App Store Connect request signing", () => {
  const issuerId = "30000000-0000-4000-8000-000000000001";
  const keyId = "ABCDE12345";
  const reference = "op://Developer/App Store Connect/private key";
  const nowMs = Date.parse("2026-10-28T12:00:00.000Z");

  function p256(): string {
    return generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
  }

  async function brokerWith(entry: Record<string, unknown>, readOnePassword: OnePasswordRead) {
    const credentialRef = randomUUID();
    const keys = memoryStore();
    await keys.set(credentialRef, JSON.stringify({ version: 1, issuerId, keyId, ...entry }));
    const root = mkdtempSync(join(tmpdir(), "octant-asc-sign-"));
    const broker = await startCredentialBroker(
      memoryStore(),
      undefined,
      { now: () => nowMs },
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      memoryStore(),
      keys,
      root,
      readOnePassword,
    );
    const call = async (path: string, body: Record<string, string>) =>
      broker.fetchForTest(
        brokerRequest(broker.url, broker.token, path, { body: JSON.stringify(body) }),
      );
    return { broker, call, credentialRef, root };
  }

  function decodeToken(token: string) {
    const [header, claims, signature] = token.split(".");
    if (header === undefined || claims === undefined || signature === undefined) {
      throw new Error("not a JSON Web Token");
    }
    return {
      header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown,
      claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >,
      signingInput: `${header}.${claims}`,
      signature: Buffer.from(signature, "base64url"),
    };
  }

  const neverRead: OnePasswordRead = async () => {
    throw new Error("op must not run for a stored key");
  };

  it("signs an ES256 token from the stored key and answers only that token", async () => {
    const privateKey = p256();
    const { broker, call, credentialRef } = await brokerWith({ privateKey }, neverRead);
    try {
      const response = await call("/v1/app-store-connect-keys/sign-token", { credentialRef });
      expect(response.status).toBe(200);
      const answer = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(answer)).toEqual(["token"]);
      expect(JSON.stringify(answer)).not.toContain("PRIVATE KEY");
      const token = decodeToken(String(answer.token));
      expect(token.header).toEqual({ alg: "ES256", kid: keyId, typ: "JWT" });
      expect(token.claims).toEqual({
        iss: issuerId,
        iat: nowMs / 1_000,
        exp: nowMs / 1_000 + 15 * 60,
        aud: "appstoreconnect-v1",
      });
      // App Store Connect refuses a token that lives longer than twenty minutes.
      expect(Number(token.claims.exp) - Number(token.claims.iat)).toBeLessThanOrEqual(20 * 60);
      expect(
        verify(
          "sha256",
          Buffer.from(token.signingInput),
          { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" },
          token.signature,
        ),
      ).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it("refuses a sign request that names anything but the credential reference", async () => {
    const { broker, call, credentialRef } = await brokerWith({ privateKey: p256() }, neverRead);
    try {
      for (const body of [
        { credentialRef, exp: "99999999999" },
        { credentialRef, aud: "elsewhere" },
        { credentialRef: "not-a-reference" },
      ]) {
        expect((await call("/v1/app-store-connect-keys/sign-token", body)).status).toBe(400);
      }
      expect(
        (await call("/v1/app-store-connect-keys/sign-token", { credentialRef: randomUUID() }))
          .status,
      ).toBe(404);
    } finally {
      await broker.close();
    }
  });

  it("reads a key kept in 1Password with op at each signing and each key-file write, and keeps none of it", async () => {
    const privateKey = p256();
    const reads: string[] = [];
    const readOnePassword: OnePasswordRead = async (asked) => {
      reads.push(asked);
      return { kind: "read", value: privateKey };
    };
    const { broker, call, credentialRef, root } = await brokerWith(
      { onePasswordReference: reference },
      readOnePassword,
    );
    try {
      for (let index = 0; index < 2; index += 1) {
        const answer = (await (
          await call("/v1/app-store-connect-keys/sign-token", { credentialRef })
        ).json()) as Record<string, unknown>;
        const token = decodeToken(String(answer.token));
        expect(
          verify(
            "sha256",
            Buffer.from(token.signingInput),
            { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" },
            token.signature,
          ),
        ).toBe(true);
      }
      const folder = join(root, `upload-${randomUUID()}`);
      mkdirSync(folder, { mode: 0o700 });
      const written = (await (
        await call("/v1/app-store-connect-keys/write-key-file", {
          credentialRef,
          directory: folder,
        })
      ).json()) as Record<string, unknown>;
      expect(written).toEqual({ file: join(folder, `AuthKey_${keyId}.p8`), issuerId, keyId });
      expect(readFileSync(join(folder, `AuthKey_${keyId}.p8`), "utf8")).toBe(privateKey);
      // One op read per operation, nothing cached between them.
      expect(reads).toEqual([reference, reference, reference]);
    } finally {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses as key-source-unavailable when op is missing, signed out, or declined, and asks only once", async () => {
    const cases: ReadonlyArray<OnePasswordRead> = [
      async () => ({ kind: "unavailable" }),
      async () => {
        throw new Error("spawn op ENOENT");
      },
      async () => ({ kind: "read", value: "not a private key" }),
    ];
    for (const answer of cases) {
      let reads = 0;
      const { broker, call, credentialRef, root } = await brokerWith(
        { onePasswordReference: reference },
        async (asked) => {
          reads += 1;
          return await answer(asked);
        },
      );
      try {
        const signed = await call("/v1/app-store-connect-keys/sign-token", { credentialRef });
        expect(signed.status).toBe(424);
        expect(await signed.json()).toEqual({ error: "key-source-unavailable" });
        const folder = join(root, `upload-${randomUUID()}`);
        mkdirSync(folder, { mode: 0o700 });
        const written = await call("/v1/app-store-connect-keys/write-key-file", {
          credentialRef,
          directory: folder,
        });
        expect(await written.json()).toEqual({ error: "key-source-unavailable" });
        expect(readdirSync(folder)).toEqual([]);
        expect(reads).toBe(2);
      } finally {
        await broker.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

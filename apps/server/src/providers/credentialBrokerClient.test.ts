import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { makeCredentialBrokerClient, makeCredentialCleanupClient } from "./credentialBrokerClient";

const providerInstanceId = randomUUID();

function purgeInput(dryRun: boolean) {
  return { dryRun, providerInstanceIds: [providerInstanceId] };
}

describe("makeCredentialBrokerClient", () => {
  it("performs authenticated presence and resolution requests", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ present: true }))
      .mockResolvedValueOnce(Response.json({ credential: "provider-secret" }));
    const resolver = makeCredentialBrokerClient({
      url: "http://127.0.0.1:41000/",
      token: "broker-token",
      fetch,
    });

    await expect(resolver.has(providerInstanceId)).resolves.toBe(true);
    await expect(resolver.resolve(providerInstanceId)).resolves.toBe("provider-secret");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:41000/v1/credentials/has",
      "http://127.0.0.1:41000/v1/credentials/resolve",
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": "broker-token",
        },
        body: JSON.stringify({ providerInstanceId }),
      });
    }
  });

  it("fails closed on redirects without forwarding the broker token", async () => {
    const brokerToken = "redirect-private-broker-token";
    let forwardedToken: string | undefined;
    const target = await listen((request, response) => {
      const header = request.headers["x-octant-credential-broker-token"];
      forwardedToken = Array.isArray(header) ? header.join(",") : header;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ present: true }));
    });
    const broker = await listen((_request, response) => {
      response.writeHead(307, { location: target.url });
      response.end();
    });
    const resolver = makeCredentialBrokerClient({
      url: broker.url,
      token: brokerToken,
    });

    try {
      const failure = await resolver.has(providerInstanceId).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        message: "Octant credential resolution failed.",
      });
      expect(String(failure)).not.toContain(brokerToken);
      expect(forwardedToken).toBeUndefined();
    } finally {
      await broker.close();
      await target.close();
    }
  });

  it("rejects malformed and failed broker responses without exposing secrets or tokens", async () => {
    const fixtureSecret = "fixture-secret-that-must-not-escape";
    const brokerToken = "broker-token-that-must-not-escape";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(fixtureSecret, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ credential: fixtureSecret, diagnostic: brokerToken }));
    const resolver = makeCredentialBrokerClient({
      url: "http://127.0.0.1:41000/",
      token: brokerToken,
      fetch,
    });

    for (const operation of [
      () => resolver.has(providerInstanceId),
      () => resolver.resolve(providerInstanceId),
    ]) {
      const failure = await operation().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(fixtureSecret);
      expect(String(failure)).not.toContain(brokerToken);
    }
  });
});

describe("makeCredentialCleanupClient", () => {
  it("performs an authenticated dry-run purge request and decodes the match count", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ dryRun: true, matchedCount: 3 }));
    const client = makeCredentialCleanupClient({
      url: "http://127.0.0.1:41000/",
      token: "broker-token",
      fetch,
    });

    await expect(client.purge(purgeInput(true))).resolves.toEqual({
      kind: "dry-run",
      matchedCount: 3,
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:41000/v1/credentials/purge",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-octant-credential-broker-token": "broker-token",
        }),
        body: JSON.stringify({
          dryRun: true,
          providerInstanceIds: [providerInstanceId],
          hostIdentityFingerprint: null,
        }),
      }),
    );
  });

  it("forwards selected-store legacy-host evidence without provider credential material", async () => {
    const hostIdentityFingerprint = "a".repeat(64);
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ dryRun: true, matchedCount: 1 }));
    const client = makeCredentialCleanupClient({
      url: "http://127.0.0.1:41000/",
      token: "broker-token",
      fetch,
    });

    await expect(client.purge({ ...purgeInput(true), hostIdentityFingerprint })).resolves.toEqual({
      kind: "dry-run",
      matchedCount: 1,
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:41000/v1/credentials/purge",
      expect.objectContaining({
        body: JSON.stringify({
          dryRun: true,
          providerInstanceIds: [providerInstanceId],
          hostIdentityFingerprint,
        }),
      }),
    );
  });

  it("splits a complete provider inventory into bounded purge batches", async () => {
    const providerInstanceIds = Array.from(
      { length: 129 },
      (_, index) => `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    );
    const hostIdentityFingerprint = "a".repeat(64);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ dryRun: true, matchedCount: 128 }))
      .mockResolvedValueOnce(Response.json({ dryRun: true, matchedCount: 1 }));
    const client = makeCredentialCleanupClient({
      url: "http://127.0.0.1:41000/",
      token: "broker-token",
      fetch,
    });

    await expect(
      client.purge({
        dryRun: true,
        providerInstanceIds,
        hostIdentityFingerprint,
      }),
    ).resolves.toEqual({ kind: "dry-run", matchedCount: 129 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      dryRun: true,
      providerInstanceIds: providerInstanceIds.slice(0, 128),
      hostIdentityFingerprint,
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      dryRun: true,
      providerInstanceIds: providerInstanceIds.slice(128),
      hostIdentityFingerprint: null,
    });
  });

  it.each(["locked", "unavailable", "failed"] as const)(
    "marks a later %s batch indeterminate after an earlier destructive batch completed",
    async (laterFailure) => {
      const providerInstanceIds = Array.from(
        { length: 129 },
        (_, index) => `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      );
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ dryRun: false, deletedCount: 128, failedCount: 0 }))
        .mockResolvedValueOnce(Response.json({ error: laterFailure }, { status: 503 }));
      const client = makeCredentialCleanupClient({
        url: "http://127.0.0.1:41000/",
        token: "broker-token",
        fetch,
      });

      await expect(client.purge({ dryRun: false, providerInstanceIds })).resolves.toEqual({
        kind: "indeterminate",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("decodes a completed purge and a partially failing purge distinctly", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ dryRun: false, deletedCount: 2, failedCount: 0 }))
      .mockResolvedValueOnce(Response.json({ dryRun: false, deletedCount: 1, failedCount: 1 }));
    const client = makeCredentialCleanupClient({
      url: "http://127.0.0.1:41000/",
      token: "broker-token",
      fetch,
    });

    await expect(client.purge(purgeInput(false))).resolves.toEqual({
      kind: "completed",
      deletedCount: 2,
    });
    await expect(client.purge(purgeInput(false))).resolves.toEqual({
      kind: "partial",
      deletedCount: 1,
      failedCount: 1,
    });
  });

  it.each([
    [423, "locked", "locked"],
    [503, "unavailable", "unavailable"],
    [500, "indeterminate", "indeterminate"],
    [500, "failed", "failed"],
    [404, undefined, "failed"],
  ] as const)(
    "maps an HTTP %s purge failure to the %s typed outcome",
    async (status, error, expectedKind) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json(error === undefined ? {} : { error }, { status }));
      const client = makeCredentialCleanupClient({
        url: "http://127.0.0.1:41000/",
        token: "broker-token",
        fetch,
      });

      await expect(client.purge(purgeInput(false))).resolves.toEqual({
        kind: expectedKind,
      });
    },
  );

  it("marks a destructive network failure indeterminate without leaking the broker token", async () => {
    const brokerToken = "cleanup-private-broker-token";
    const fetch = vi.fn().mockRejectedValueOnce(new Error(`connection refused ${brokerToken}`));
    const client = makeCredentialCleanupClient({
      url: "http://127.0.0.1:41000/",
      token: brokerToken,
      fetch,
    });

    const outcome = await client.purge(purgeInput(false));
    expect(outcome).toEqual({ kind: "indeterminate" });
  });

  it("rejects a malformed success payload as failed without exposing raw diagnostics", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ dryRun: true }));
    const client = makeCredentialCleanupClient({
      url: "http://127.0.0.1:41000/",
      token: "broker-token",
      fetch,
    });

    await expect(client.purge(purgeInput(true))).resolves.toEqual({
      kind: "failed",
    });
  });

  it.each([
    [{ dryRun: true, matchedCount: -1 }, true, "failed"],
    [{ dryRun: false, deletedCount: -1, failedCount: 0 }, false, "indeterminate"],
    [{ dryRun: false, deletedCount: 0, failedCount: -1 }, false, "indeterminate"],
  ])(
    "fails closed on a success payload containing a negative cleanup count",
    async (body, dryRun, expectedKind) => {
      const fetch = vi.fn().mockResolvedValueOnce(Response.json(body));
      const client = makeCredentialCleanupClient({
        url: "http://127.0.0.1:41000/",
        token: "broker-token",
        fetch,
      });

      await expect(client.purge(purgeInput(dryRun))).resolves.toEqual({
        kind: expectedKind,
      });
    },
  );
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

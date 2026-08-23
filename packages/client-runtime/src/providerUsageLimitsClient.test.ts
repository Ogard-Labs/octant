import { describe, expect, it, vi } from "vitest";
import {
  createProviderUsageLimitsClient,
  ProviderUsageLimitsClientFailure,
} from "./providerUsageLimitsClient";

const snapshot = {
  version: 1 as const,
  refreshedAt: "2026-08-23T12:00:00.000Z",
  entries: [],
};

describe("ProviderUsageLimitsClient", () => {
  it("lists and explicitly refreshes through authenticated loopback routes", async () => {
    const fetch = vi.fn(async () => Response.json(snapshot));
    const client = createProviderUsageLimitsClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch,
      windowCapability: "capability",
    });

    await expect(client.list()).resolves.toEqual(snapshot);
    await expect(client.refresh()).resolves.toEqual(snapshot);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3000/api/provider-usage-limits",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3000/api/provider-usage-limits/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects non-loopback hosts and malformed responses", async () => {
    expect(() =>
      createProviderUsageLimitsClient({
        baseUrl: "https://example.com",
        fetch: vi.fn(),
        windowCapability: "capability",
      }),
    ).toThrow(ProviderUsageLimitsClientFailure);

    const client = createProviderUsageLimitsClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: vi.fn(async () => Response.json({ version: 1, entries: [], raw: "no" })),
      windowCapability: "capability",
    });
    await expect(client.list()).rejects.toBeInstanceOf(ProviderUsageLimitsClientFailure);
  });

  it("bounds a hanging refresh request and aborts its fetch", async () => {
    let signal: AbortSignal | undefined;
    const client = createProviderUsageLimitsClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: vi.fn(async (_input, init) => {
        signal = init?.signal;
        return new Promise<Response>(() => undefined);
      }),
      requestTimeoutMs: 10,
      windowCapability: "capability",
    });

    const result = await Promise.race([
      client.refresh().then(
        () => "resolved" as const,
        () => "failed" as const,
      ),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    expect(result).toBe("failed");
    expect(signal?.aborted).toBe(true);
  });
});

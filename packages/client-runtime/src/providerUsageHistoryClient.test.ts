import { describe, expect, it, vi } from "vitest";
import { decodeLocalUsageHistoryRequest } from "@octant/contracts";
import {
  createLocalUsageHistoryClient,
  LocalUsageHistoryClientFailure,
} from "./providerUsageHistoryClient";

const request = decodeLocalUsageHistoryRequest({
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-30T23:59:59.999Z",
  timeZone: "UTC",
});

function response(overrides: Record<string, unknown> = {}) {
  const totals = {
    inputTokens: 0,
    totalTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    sessionCount: 0,
    componentCoverage: {
      uncachedInput: { measured: 0, total: 0 },
      cacheRead: { measured: 0, total: 0 },
      cacheWrite: { measured: 0, total: 0 },
      reasoning: { measured: 0, total: 0 },
    },
  };
  return {
    source: "local-provider-history",
    from: request.from,
    to: request.to,
    timeZone: request.timeZone,
    queryAt: "2026-09-30T23:59:59.999Z",
    totals,
    cost: { pricedRecordCount: 0, unpricedRecordCount: 0 },
    providers: [],
    models: [],
    days: [],
    dailyTotals: [],
    coverage: [],
    ...overrides,
  };
}

describe("LocalUsageHistoryClient", () => {
  it("refuses remote history destinations before sending the window capability", () => {
    const fetch = vi.fn();
    expect(() =>
      createLocalUsageHistoryClient({
        baseUrl: "https://example.com",
        fetch,
        windowCapability: "local-capability",
      }),
    ).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds a stalled history read and cancels its fetch", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        (_url: Parameters<typeof globalThis.fetch>[0], options?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );
      const client = createLocalUsageHistoryClient({
        baseUrl: "http://127.0.0.1:13773",
        fetch,
        windowCapability: "local-capability",
      });
      const checked = expect(client.load(request)).rejects.toBeInstanceOf(
        LocalUsageHistoryClientFailure,
      );
      await vi.advanceTimersByTimeAsync(30000);
      await checked;
    } finally {
      vi.useRealTimers();
    }
  });
  it("loads a typed local history response", async () => {
    const fetch = vi.fn(async () => Response.json(response()));
    const client = createLocalUsageHistoryClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    await expect(client.load(request)).resolves.toMatchObject({ source: "local-provider-history" });
  });

  it("rejects a response for a different range or timezone", async () => {
    const fetch = vi.fn(async () => Response.json(response({ timeZone: "Europe/Oslo" })));
    const client = createLocalUsageHistoryClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    await expect(client.load(request)).rejects.toBeInstanceOf(LocalUsageHistoryClientFailure);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { UtcTimestamp } from "@octant/contracts/events";
import { createUsageClient, UsageClientError } from "./usageClient";

const baseUrl = "http://127.0.0.1:4310";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";

const emptyResponse = {
  records: [],
  totals: {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalRequests: 0,
    exactCount: 0,
    estimatedCount: 0,
    reconciledCount: 0,
    staleCount: 0,
    unavailableCount: 0,
  },
  byProvider: [],
  byCategory: [],
  byDay: [],
  byWeek: [],
  cumulative: [],
  topConsumers: [],
  hasMore: false,
  queryAt: "2026-07-24T12:00:00.000Z",
};

describe("UsageClient.query", () => {
  it("posts the query request and decodes the response", async () => {
    const fetch = vi.fn(async () => Response.json(emptyResponse));
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });

    const result = await client.query({});
    expect(result.totals.totalRequests).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/usage/query`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("round-trips custom range and timezone query parameters", async () => {
    const fetch = vi.fn(async () => Response.json(emptyResponse));
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });

    await client.query({
      filter: {
        from: "2026-07-24T00:00:00.000Z" as UtcTimestamp,
        to: "2026-07-24T23:59:59.999Z" as UtcTimestamp,
      },
      timeZone: "Europe/Oslo",
    });
    const requestInit = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(requestInit.body as string)).toEqual({
      filter: {
        from: "2026-07-24T00:00:00.000Z",
        to: "2026-07-24T23:59:59.999Z",
      },
      timeZone: "Europe/Oslo",
    });
  });

  it("throws UsageClientError on a non-ok response", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.query({})).rejects.toBeInstanceOf(UsageClientError);
  });

  it("throws UsageClientError when the response body is invalid", async () => {
    const fetch = vi.fn(async () => Response.json({ unexpected: true }));
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.query({})).rejects.toBeInstanceOf(UsageClientError);
  });

  it("throws UsageClientError when fetch rejects", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network");
    });
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.query({})).rejects.toBeInstanceOf(UsageClientError);
  });
});

describe("UsageClient.export", () => {
  it("returns the CSV body for a confirmed csv export", async () => {
    const fetch = vi.fn(async () => new Response("reconciliationId\nid-1", { status: 200 }));
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });
    const result = await client.export({ format: "csv", confirm: true });
    expect(result.format).toBe("csv");
    expect(result.body).toContain("reconciliationId");
  });

  it("throws UsageClientError on a non-ok response", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 400 }));
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.export({ format: "csv", confirm: true })).rejects.toBeInstanceOf(
      UsageClientError,
    );
  });
});

describe("UsageClient.reset", () => {
  it("decodes a purge result for a confirmed reset", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ purgedCount: 3, occurredAt: "2026-07-24T12:00:00.000Z" }),
    );
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });
    const result = await client.reset({ confirm: true });
    expect(result.purgedCount).toBe(3);
  });

  it("throws UsageClientError on a non-ok response", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 400 }));
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.reset({ confirm: true })).rejects.toBeInstanceOf(UsageClientError);
  });
});

describe("UsageClient.retain", () => {
  it("decodes a purge result for a confirmed retention purge", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ purgedCount: 2, occurredAt: "2026-07-24T12:00:00.000Z" }),
    );
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });
    const result = await client.retain({
      olderThan: "2026-07-24T00:00:00.000Z" as UtcTimestamp,
      confirm: true,
    });
    expect(result.purgedCount).toBe(2);
  });

  it("throws UsageClientError on a non-ok response", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 400 }));
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });
    await expect(
      client.retain({ olderThan: "2026-07-24T00:00:00.000Z" as UtcTimestamp, confirm: true }),
    ).rejects.toBeInstanceOf(UsageClientError);
  });
});

describe("UsageClient.diagnostics", () => {
  const stopReasons = { "end-of-turn": 1, "max-tokens": 0, cancelled: 0, failed: 0, waiting: 0 };
  const report = {
    generatedAt: "2026-11-07T12:00:00.000Z",
    bucket: "day",
    turns: 1,
    diagnosedTurns: 1,
    totals: {
      stopReasons,
      contentFilterStops: 0,
      toolCalls: 0,
      toolFailures: 0,
      unfinishedToolCalls: 0,
      retries: [],
      approvalRequests: 0,
      inputRequests: 0,
      rateLimitWarnings: 0,
      rateLimitExhaustedTurns: 0,
      compactions: 0,
      likelyCacheMisses: 0,
    },
    models: [],
    tools: [],
    failureGroups: [],
    troubledTurns: [],
    cacheMisses: [],
    trend: [
      {
        key: "2026-11-07",
        turns: 1,
        failed: 0,
        cancelled: 0,
        toolCalls: 0,
        toolFailures: 0,
        retries: 0,
      },
    ],
    // A newer host may add a field; the window still reads the report.
    addedLater: true,
  };

  it("posts the request to the diagnostics route and reads the report", async () => {
    const fetch = vi.fn(async () => Response.json(report));
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });

    const result = await client.diagnostics({ bucket: "day", timeZone: "Europe/Oslo" });

    expect(result.turns).toBe(1);
    expect(result.trend[0]?.key).toBe("2026-11-07");
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/usage/diagnostics`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("says a refused read failed rather than returning an empty report", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "no" }, { status: 403 }));
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.diagnostics({})).rejects.toBeInstanceOf(UsageClientError);
  });
});

describe("UsageClient.hostHealth", () => {
  it("reads the host's health history", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        generatedAt: "2026-11-07T12:00:00.000Z",
        resolution: "minute",
        retentionDays: 14,
        processStarts: [],
        samples: [],
      }),
    );
    const client = createUsageClient({ baseUrl, fetch, windowCapability: capability });

    const history = await client.hostHealth({ resolution: "minute" });

    expect(history.retentionDays).toBe(14);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/usage/host-health`,
      expect.objectContaining({ method: "POST" }),
    );
  });
});

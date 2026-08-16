import { describe, expect, it, vi } from "vitest";
import type { UsageDashboardResponse } from "@octant/contracts";
import { createUsageDashboardClient, UsageDashboardClientFailure } from "./usageDashboardClient";

const baseUrl = "http://127.0.0.1:7777";
const windowCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const timestamp = "2026-07-24T12:00:00.000Z";

function dashboardBody(overrides: Record<string, unknown> = {}) {
  return {
    summary: {
      totals: {
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalRequests: 1,
        exactCount: 1,
        estimatedCount: 0,
        reconciledCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      },
      requestsWithUnavailableUsage: 0,
      coverage: [{ quality: "exact", requestCount: 1 }],
      excludedRecordCount: 0,
    },
    activity: [],
    activityTruncated: false,
    breakdown: [],
    detail: [],
    detailTruncated: false,
    hosts: [],
    dimensionSources: [
      { dimension: "cost", status: "unavailable", detail: "No pricing metadata is configured." },
    ],
    timeZone: "UTC",
    queryAt: timestamp,
    ...overrides,
  };
}

function client(fetch: typeof globalThis.fetch) {
  return createUsageDashboardClient({ baseUrl, fetch, windowCapability });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createUsageDashboardClient", () => {
  it("refuses a non-loopback base URL", () => {
    expect(() =>
      createUsageDashboardClient({
        baseUrl: "http://example.test",
        fetch: globalThis.fetch,
        windowCapability,
      }),
    ).toThrow(UsageDashboardClientFailure);
  });

  it("posts the request with the window capability", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(dashboardBody()));

    await client(fetch as unknown as typeof globalThis.fetch).load({ timeZone: "Europe/Oslo" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7777/api/usage/dashboard");
    expect(init.method).toBe("POST");
    expect(init.headers["x-octant-window-capability"]).toBe(windowCapability);
    expect(JSON.parse(init.body as string)).toEqual({ timeZone: "Europe/Oslo" });
  });

  it("returns the decoded host response", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(dashboardBody()));

    const dashboard: UsageDashboardResponse = await client(
      fetch as unknown as typeof globalThis.fetch,
    ).load({});

    expect(dashboard.summary.totals.totalInputTokens).toBe(100);
    expect(dashboard.dimensionSources[0]?.status).toBe("unavailable");
  });

  it("surfaces the host failure message and status", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ message: "Usage dashboard request is unauthorized." }, 401),
      );

    await expect(
      client(fetch as unknown as typeof globalThis.fetch).load({}),
    ).rejects.toMatchObject({ name: "UsageDashboardClientFailure", status: 401 });
  });

  it("reports an unreachable host as status zero", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection refused"));

    await expect(
      client(fetch as unknown as typeof globalThis.fetch).load({}),
    ).rejects.toMatchObject({ status: 0 });
  });

  it("rejects a response that does not satisfy the contract", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(dashboardBody({ timeZone: undefined, promptText: "hi" })));

    await expect(
      client(fetch as unknown as typeof globalThis.fetch).load({}),
    ).rejects.toBeInstanceOf(UsageDashboardClientFailure);
  });

  it("passes the caller's cancellation through to the request", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(dashboardBody()));
    const controller = new AbortController();

    await client(fetch as unknown as typeof globalThis.fetch).load({}, controller.signal);

    const [, init] = fetch.mock.calls[0]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
    controller.abort();
    expect(init.signal.aborted).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  decodeUsageActivityCell,
  decodeUsageBreakdownGroup,
  decodeUsageDashboardRequest,
  decodeUsageDashboardResponse,
  decodeUsageDetailRow,
  decodeUsageDimensionSource,
  decodeUsageHostCoverage,
} from "./usageDashboard";

const ids = {
  reconciliation: "62000000-0000-4000-8000-000000000001",
  provider: "62000000-0000-4000-8000-000000000002",
  project: "62000000-0000-4000-8000-000000000003",
} as const;

const timestamp = "2026-07-24T12:00:00.000Z";

function detailRow(overrides: Record<string, unknown> = {}) {
  return {
    reconciliationId: ids.reconciliation,
    hostId: "local",
    providerInstanceId: ids.provider,
    modelId: "gpt-4o",
    requestShape: "chat-turn",
    subjectType: "chat-thread",
    subjectId: "thread-1",
    quality: "exact",
    inputTokens: 100,
    outputTokens: 50,
    plannedInputTokens: 95,
    varianceTokens: 5,
    attribution: [{ category: "conversation", plannedTokens: 95, quality: "exact" }],
    observedAt: timestamp,
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
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
    activity: [
      {
        date: "2026-07-24",
        inputTokens: 100,
        outputTokens: 50,
        requestCount: 1,
        unavailableRequestCount: 0,
        state: "measured",
      },
    ],
    activityTruncated: false,
    breakdown: [
      {
        dimension: "provider",
        rows: [
          {
            key: ids.provider,
            label: ids.provider,
            availability: "recorded",
            inputTokens: 100,
            outputTokens: 50,
            requestCount: 1,
            unavailableRequestCount: 0,
          },
        ],
        truncated: false,
      },
    ],
    detail: [detailRow()],
    detailTruncated: false,
    hosts: [
      { hostId: "local", requestCount: 1, lastObservedAt: timestamp, status: "contributing" },
    ],
    dimensionSources: [
      { dimension: "provider", status: "recorded", detail: "Recorded per reconciliation." },
    ],
    timeZone: "UTC",
    queryAt: timestamp,
    ...overrides,
  };
}

describe("UsageDimensionSource", () => {
  it("decodes a recorded dimension", () => {
    const source = decodeUsageDimensionSource({
      dimension: "host",
      status: "recorded",
      detail: "Recorded on every usage row.",
    });
    expect(source.dimension).toBe("host");
    expect(source.status).toBe("recorded");
  });

  it("rejects an unknown dimension", () => {
    expect(() =>
      decodeUsageDimensionSource({ dimension: "vibes", status: "recorded", detail: "n/a" }),
    ).toThrow();
  });

  it("requires a detail so an unavailable dimension is always explained", () => {
    expect(() =>
      decodeUsageDimensionSource({ dimension: "cost", status: "unavailable" }),
    ).toThrow();
  });
});

describe("UsageActivityCell", () => {
  it("keeps no-activity and unavailable as distinct states", () => {
    expect(
      decodeUsageActivityCell({
        date: "2026-07-24",
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 0,
        unavailableRequestCount: 0,
        state: "no-activity",
      }).state,
    ).toBe("no-activity");
    expect(
      decodeUsageActivityCell({
        date: "2026-07-24",
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 2,
        unavailableRequestCount: 2,
        state: "unavailable",
      }).state,
    ).toBe("unavailable");
  });

  it("rejects a malformed day key", () => {
    expect(() =>
      decodeUsageActivityCell({
        date: "24-07-2026",
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 0,
        unavailableRequestCount: 0,
        state: "no-activity",
      }),
    ).toThrow();
  });

  it("rejects negative token counts", () => {
    expect(() =>
      decodeUsageActivityCell({
        date: "2026-07-24",
        inputTokens: -1,
        outputTokens: 0,
        requestCount: 0,
        unavailableRequestCount: 0,
        state: "measured",
      }),
    ).toThrow();
  });
});

describe("UsageBreakdownGroup", () => {
  it("decodes a group with an unavailable bucket", () => {
    const group = decodeUsageBreakdownGroup({
      dimension: "project",
      rows: [
        {
          key: "",
          label: "Unavailable",
          availability: "unavailable",
          inputTokens: 10,
          outputTokens: 5,
          requestCount: 1,
          unavailableRequestCount: 0,
        },
      ],
      truncated: true,
    });
    expect(group.rows[0]!.availability).toBe("unavailable");
    expect(group.truncated).toBe(true);
  });

  it("rejects a row without a display label", () => {
    expect(() =>
      decodeUsageBreakdownGroup({
        dimension: "model",
        rows: [
          {
            key: "gpt-4o",
            label: "",
            availability: "recorded",
            inputTokens: 0,
            outputTokens: 0,
            requestCount: 0,
            unavailableRequestCount: 0,
          },
        ],
        truncated: false,
      }),
    ).toThrow();
  });
});

describe("UsageDetailRow", () => {
  it("decodes a row with optional attribution dimensions", () => {
    const row = decodeUsageDetailRow(detailRow({ mode: "chat", projectId: ids.project }));
    expect(row.mode).toBe("chat");
    expect(row.projectId).toBe(ids.project);
  });

  it("omits attribution the host never recorded rather than defaulting it", () => {
    const row = decodeUsageDetailRow(detailRow());
    expect(row.mode).toBeUndefined();
    expect(row.projectId).toBeUndefined();
    expect(row.reasoningTokens).toBeUndefined();
  });

  it("rejects an unknown mode", () => {
    expect(() => decodeUsageDetailRow(detailRow({ mode: "sketch" }))).toThrow();
  });
});

describe("UsageHostCoverage", () => {
  it("decodes a stale host", () => {
    const host = decodeUsageHostCoverage({
      hostId: "workstation",
      requestCount: 3,
      lastObservedAt: timestamp,
      status: "stale",
    });
    expect(host.status).toBe("stale");
  });

  it("rejects a status outside the contract", () => {
    expect(() =>
      decodeUsageHostCoverage({
        hostId: "workstation",
        requestCount: 0,
        lastObservedAt: timestamp,
        status: "unreachable",
      }),
    ).toThrow();
  });
});

describe("UsageDashboardRequest", () => {
  it("decodes an empty request", () => {
    expect(decodeUsageDashboardRequest({})).toEqual({});
  });

  it("bounds the detail and breakdown limits", () => {
    expect(() => decodeUsageDashboardRequest({ detailLimit: 201 })).toThrow();
    expect(() => decodeUsageDashboardRequest({ breakdownLimit: 0 })).toThrow();
  });

  it("rejects an inverted date range", () => {
    expect(() =>
      decodeUsageDashboardRequest({
        filter: { from: "2026-07-24T12:00:00.000Z", to: "2026-07-23T12:00:00.000Z" },
      }),
    ).toThrow();
  });

  it("rejects unknown request fields", () => {
    expect(() => decodeUsageDashboardRequest({ includePrompts: true })).toThrow();
  });
});

describe("UsageDashboardResponse", () => {
  it("decodes a complete response", () => {
    const decoded = decodeUsageDashboardResponse(response());
    expect(decoded.summary.totals.totalRequests).toBe(1);
    expect(decoded.activity).toHaveLength(1);
    expect(decoded.detail).toHaveLength(1);
    expect(decoded.hosts[0]!.status).toBe("contributing");
    expect(decoded.latencyStats).toEqual({ measurements: [] });
  });

  it("rejects a response carrying fields outside the contract", () => {
    expect(() => decodeUsageDashboardResponse(response({ promptText: "hello" }))).toThrow();
  });

  it("requires an explicit time zone so day buckets are interpretable", () => {
    const { timeZone: _omitted, ...withoutTimeZone } = response();
    expect(() => decodeUsageDashboardResponse(withoutTimeZone)).toThrow();
  });
});

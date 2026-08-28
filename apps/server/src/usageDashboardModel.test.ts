import { describe, expect, it } from "vitest";
import { decodeUsageDashboardResponse } from "@octant/contracts";
import { buildUsageDashboard, type UsageDashboardSourceRow } from "./usageDashboardModel";

const ids = {
  provider: "63000000-0000-4000-8000-000000000001",
  otherProvider: "63000000-0000-4000-8000-000000000002",
  project: "63000000-0000-4000-8000-000000000003",
  reconciliation: "63000000-0000-4000-8000-000000000004",
} as const;

const queryAt = "2026-07-24T12:00:00.000Z";

function row(overrides: Partial<UsageDashboardSourceRow> = {}): UsageDashboardSourceRow {
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
    observedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

function build(rows: ReadonlyArray<UsageDashboardSourceRow>, overrides = {}) {
  return buildUsageDashboard(rows, {
    queryAt,
    timeZone: "UTC",
    detailLimit: 50,
    breakdownLimit: 10,
    ...overrides,
  });
}

describe("buildUsageDashboard summary", () => {
  it("produces a contract-valid response", () => {
    expect(() => decodeUsageDashboardResponse(build([row()]))).not.toThrow();
  });

  it("totals only the dimensions a provider actually reported", () => {
    const dashboard = build([row({ reasoningTokens: 11 }), row({ reconciliationId: "b" })]);
    expect(dashboard.summary.totals.totalInputTokens).toBe(200);
    expect(dashboard.summary.totals.totalReasoningTokens).toBe(11);
    expect(dashboard.summary.totals.totalCacheReadInputTokens).toBeUndefined();
  });

  it("reports unavailable requests separately from zero usage", () => {
    const dashboard = build([
      row({ quality: "unavailable", inputTokens: 0, outputTokens: 0 }),
      row({ reconciliationId: "b" }),
    ]);
    expect(dashboard.summary.requestsWithUnavailableUsage).toBe(1);
    expect(dashboard.summary.totals.unavailableCount).toBe(1);
    expect(dashboard.summary.coverage).toContainEqual({ quality: "unavailable", requestCount: 1 });
  });

  it("names the highest-usage day and provider/model pair", () => {
    const dashboard = build([
      row({ observedAt: "2026-07-22T10:00:00.000Z", inputTokens: 10, outputTokens: 10 }),
      row({
        reconciliationId: "b",
        observedAt: "2026-07-24T10:00:00.000Z",
        providerInstanceId: ids.otherProvider,
        modelId: "claude-sonnet",
        inputTokens: 500,
        outputTokens: 100,
      }),
    ]);
    expect(dashboard.summary.peakDay).toEqual({
      date: "2026-07-24",
      totalTokens: 600,
      requestCount: 1,
    });
    expect(dashboard.summary.peakModel).toEqual({
      providerInstanceId: ids.otherProvider,
      modelId: "claude-sonnet",
      totalTokens: 600,
      requestCount: 1,
    });
  });

  it("has no peak when nothing was recorded", () => {
    const dashboard = build([]);
    expect(dashboard.summary.peakDay).toBeUndefined();
    expect(dashboard.summary.peakModel).toBeUndefined();
    expect(dashboard.summary.totals.totalRequests).toBe(0);
  });
});

describe("buildUsageDashboard fail-closed handling", () => {
  it("excludes a negative record from every total", () => {
    const dashboard = build([row(), row({ reconciliationId: "b", outputTokens: -5 })]);
    expect(dashboard.summary.excludedRecordCount).toBe(1);
    expect(dashboard.summary.totals.totalRequests).toBe(1);
    expect(dashboard.summary.totals.totalOutputTokens).toBe(50);
  });

  it("excludes a record whose addition would overflow a total", () => {
    const dashboard = build([
      row({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }),
      row({ reconciliationId: "b", inputTokens: 10, outputTokens: 0 }),
    ]);
    expect(dashboard.summary.excludedRecordCount).toBe(1);
    expect(dashboard.summary.totals.totalInputTokens).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("excludes a malformed timestamp and an unknown quality", () => {
    const dashboard = build([
      row({ observedAt: "yesterday" }),
      row({ reconciliationId: "b", quality: "probably-fine" }),
    ]);
    expect(dashboard.summary.excludedRecordCount).toBe(2);
    expect(dashboard.summary.totals.totalRequests).toBe(0);
  });

  it("carries unreadable durable rows into the excluded count", () => {
    const dashboard = build([row()], { unreadableRecordCount: 3 });
    expect(dashboard.summary.excludedRecordCount).toBe(3);
    expect(dashboard.summary.totals.totalRequests).toBe(1);
  });
});

describe("buildUsageDashboard activity", () => {
  it("distinguishes no activity from unavailable usage", () => {
    const dashboard = build([
      row({ observedAt: "2026-07-22T10:00:00.000Z" }),
      row({
        reconciliationId: "b",
        observedAt: "2026-07-24T10:00:00.000Z",
        quality: "unavailable",
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
    expect(dashboard.activity.map((cell) => [cell.date, cell.state])).toEqual([
      ["2026-07-22", "measured"],
      ["2026-07-23", "no-activity"],
      ["2026-07-24", "unavailable"],
    ]);
  });

  it("marks a day with mixed measurement as partially unavailable", () => {
    const dashboard = build([
      row(),
      row({ reconciliationId: "b", quality: "unavailable", inputTokens: 0, outputTokens: 0 }),
    ]);
    expect(dashboard.activity[0]!.state).toBe("partially-unavailable");
    expect(dashboard.activity[0]!.unavailableRequestCount).toBe(1);
  });

  it("buckets by the requested time zone", () => {
    const dashboard = build([row({ observedAt: "2026-07-24T02:00:00.000Z" })], {
      timeZone: "America/Los_Angeles",
    });
    expect(dashboard.activity[0]!.date).toBe("2026-07-23");
  });

  it("truncates a range longer than a year and says so", () => {
    const dashboard = build([
      row({ observedAt: "2020-01-01T10:00:00.000Z" }),
      row({ reconciliationId: "b", observedAt: "2026-07-24T10:00:00.000Z" }),
    ]);
    expect(dashboard.activityTruncated).toBe(true);
    expect(dashboard.activity.length).toBe(371);
    expect(dashboard.activity[dashboard.activity.length - 1]!.date).toBe("2026-07-24");
  });
});

describe("buildUsageDashboard breakdown", () => {
  it("groups every recorded dimension", () => {
    const dashboard = build([row({ mode: "chat", projectId: ids.project })]);
    expect(dashboard.breakdown.map((group) => group.dimension)).toEqual([
      "provider",
      "model",
      "host",
      "mode",
      "project",
      "thread",
      "request-shape",
      "context-category",
    ]);
  });

  it("labels a missing dimension as unavailable instead of dropping the usage", () => {
    const dashboard = build([row({ subjectType: "canvas", subjectId: "canvas-1" })]);
    const project = dashboard.breakdown.find((group) => group.dimension === "project");
    expect(project?.rows).toEqual([
      {
        key: "",
        label: "Unavailable",
        availability: "unavailable",
        inputTokens: 100,
        outputTokens: 50,
        requestCount: 1,
        unavailableRequestCount: 0,
      },
    ]);
  });

  it("keeps planned tokens only on the context-category dimension", () => {
    const dashboard = build([row()]);
    const category = dashboard.breakdown.find((group) => group.dimension === "context-category");
    expect(category?.rows[0]?.plannedTokens).toBe(95);
    const provider = dashboard.breakdown.find((group) => group.dimension === "provider");
    expect(provider?.rows[0]?.plannedTokens).toBeUndefined();
  });

  it("sorts by token total and truncates at the requested limit", () => {
    const dashboard = build(
      [
        row({ modelId: "small", inputTokens: 1, outputTokens: 1 }),
        row({ reconciliationId: "b", modelId: "large", inputTokens: 900, outputTokens: 1 }),
        row({ reconciliationId: "c", modelId: "medium", inputTokens: 50, outputTokens: 1 }),
      ],
      { breakdownLimit: 2 },
    );
    const models = dashboard.breakdown.find((group) => group.dimension === "model");
    expect(models?.rows.map((entry) => entry.key)).toEqual(["large", "medium"]);
    expect(models?.truncated).toBe(true);
  });
});

describe("buildUsageDashboard detail and hosts", () => {
  it("returns the newest rows first and flags truncation", () => {
    const dashboard = build(
      [
        row({ observedAt: "2026-07-22T10:00:00.000Z" }),
        row({ reconciliationId: "b", observedAt: "2026-07-24T10:00:00.000Z" }),
      ],
      { detailLimit: 1 },
    );
    expect(dashboard.detail).toHaveLength(1);
    expect(dashboard.detail[0]!.observedAt).toBe("2026-07-24T10:00:00.000Z");
    expect(dashboard.detailTruncated).toBe(true);
  });

  it("omits detail attribution the host never recorded", () => {
    const dashboard = build([row({ subjectType: "canvas" })]);
    expect(dashboard.detail[0]!.mode).toBeUndefined();
    expect(dashboard.detail[0]!.projectId).toBeUndefined();
  });

  it("reports a host whose newest record aged past the stale threshold", () => {
    const dashboard = build([
      row({ hostId: "workstation", observedAt: "2026-07-20T10:00:00.000Z" }),
      row({ reconciliationId: "b", hostId: "local", observedAt: "2026-07-24T10:00:00.000Z" }),
    ]);
    expect(dashboard.hosts).toEqual([
      {
        hostId: "local",
        requestCount: 1,
        lastObservedAt: "2026-07-24T10:00:00.000Z",
        status: "contributing",
      },
      {
        hostId: "workstation",
        requestCount: 1,
        lastObservedAt: "2026-07-20T10:00:00.000Z",
        status: "stale",
      },
    ]);
  });
});

describe("buildUsageDashboard dimension sources", () => {
  it("declares component and cost attribution unavailable", () => {
    const sources = build([row()]).dimensionSources;
    expect(sources.find((source) => source.dimension === "component")?.status).toBe("unavailable");
    expect(sources.find((source) => source.dimension === "cost")?.status).toBe("unavailable");
  });

  it("downgrades Project attribution when a row could not be placed in one", () => {
    const allPlaced = build([row({ mode: "chat", projectId: ids.project })]);
    expect(allPlaced.dimensionSources.find((s) => s.dimension === "project")?.status).toBe(
      "recorded",
    );
    const withUnplaced = build([
      row({ mode: "work", subjectType: "work-thread", projectId: ids.project }),
      row({ mode: "chat", subjectType: "chat-thread" }),
    ]);
    expect(withUnplaced.dimensionSources.find((s) => s.dimension === "project")?.status).toBe(
      "partial",
    );
  });

  it("downgrades mode attribution when a subject has no mode", () => {
    const dashboard = build([row({ subjectType: "canvas" })]);
    expect(dashboard.dimensionSources.find((s) => s.dimension === "mode")?.status).toBe("partial");
  });

  it("always explains every dimension", () => {
    const sources = build([]).dimensionSources;
    expect(sources).toHaveLength(10);
    for (const source of sources) {
      expect(source.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("buildUsageDashboard cache statistics", () => {
  it("reports prompt-cache reuse per provider instance and across them", () => {
    const dashboard = build([
      row({ cacheReadInputTokens: 300, cacheWriteInputTokens: 100 }),
      row({
        reconciliationId: "b",
        providerInstanceId: ids.otherProvider,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 100,
      }),
    ]);
    expect(dashboard.cacheStats.providerTokenCaches).toEqual([
      {
        providerInstanceId: ids.provider,
        requestCount: 1,
        cacheReadInputTokens: 300,
        cacheWriteInputTokens: 100,
        hitRatio: 0.75,
      },
      {
        providerInstanceId: ids.otherProvider,
        requestCount: 1,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 100,
        hitRatio: 0,
      },
    ]);
    expect(dashboard.cacheStats.tokenCacheHitRatio).toBe(0.6);
  });

  it("leaves reuse unavailable rather than zero when no provider reported cache tokens", () => {
    const dashboard = build([row()]);
    expect(dashboard.cacheStats.providerTokenCaches).toEqual([]);
    expect(dashboard.cacheStats.tokenCacheHitRatio).toBeUndefined();
  });

  it("passes the host's own cache readings through to the renderer", () => {
    const dashboard = build([row()], {
      cacheStats: [
        {
          key: "github-catalogue",
          label: "GitHub catalogue",
          hitCount: 4,
          missCount: 1,
          hitRatio: 0.8,
          failureStreak: 0,
        },
      ],
    });
    expect(() => decodeUsageDashboardResponse(dashboard)).not.toThrow();
    expect(dashboard.cacheStats.caches[0]?.hitCount).toBe(4);
  });
});

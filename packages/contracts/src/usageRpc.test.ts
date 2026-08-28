import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import {
  decodeUsageQueryFilter,
  decodeUsageQueryRequest,
  decodeUsageQueryResponse,
  decodeUsageTimeBucket,
  decodeUsageTopConsumer,
  decodeUsageExportRequest,
  decodeUsageResetRequest,
  decodeUsageRetentionRequest,
  decodeUsagePurgeResult,
  type UsageQueryResponse,
} from "./usageRpc";

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const timestamp = decodeUtcTimestamp("2026-07-24T12:00:00.000Z");

describe("UsageQueryFilter", () => {
  it("accepts hostId, requestShape, and category filters", () => {
    const filter = decodeUsageQueryFilter({
      hostId: "local",
      requestShape: "chat-turn",
      category: "conversation",
      mode: "chat",
      projectId: "project-1",
    });
    expect(filter.hostId).toBe("local");
    expect(filter.requestShape).toBe("chat-turn");
    expect(filter.category).toBe("conversation");
    expect(filter.mode).toBe("chat");
    expect(filter.projectId).toBe("project-1");
  });

  it("accepts a bounded custom range and rejects an inverted range", () => {
    const filter = decodeUsageQueryFilter({
      from: "2026-07-24T00:00:00.000Z",
      to: "2026-07-24T23:59:59.999Z",
    });
    expect(filter.from).toBe("2026-07-24T00:00:00.000Z");
    expect(() =>
      decodeUsageQueryFilter({
        from: "2026-07-25T00:00:00.000Z",
        to: "2026-07-24T23:59:59.999Z",
      }),
    ).toThrow();
  });

  it("round-trips the viewing timezone on a query request", () => {
    const request = decodeUsageQueryRequest({
      filter: { from: "2026-07-24T00:00:00.000Z", to: "2026-07-24T23:59:59.999Z" },
      timeZone: "Europe/Oslo",
    });
    expect(request.timeZone).toBe("Europe/Oslo");
  });

  it("rejects excess properties", () => {
    expect(() => decodeUsageQueryFilter({ extra: true })).toThrow();
  });
});

describe("UsageQueryResponse", () => {
  const baseResponse: UsageQueryResponse = {
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
    queryAt: timestamp,
    latencyStats: { measurements: [] },
  };

  it("decodes a response with time buckets, cumulative, and top consumers", () => {
    const response = decodeUsageQueryResponse({
      ...baseResponse,
      byDay: [
        {
          bucketStart: timestamp,
          inputTokens: 10,
          outputTokens: 5,
          requestCount: 1,
          exactCount: 1,
          estimatedCount: 0,
          reconciledCount: 0,
          staleCount: 0,
          unavailableCount: 0,
        },
      ],
      byWeek: [
        {
          bucketStart: timestamp,
          inputTokens: 10,
          outputTokens: 5,
          requestCount: 1,
          exactCount: 1,
          estimatedCount: 0,
          reconciledCount: 0,
          staleCount: 0,
          unavailableCount: 0,
        },
      ],
      cumulative: [
        {
          bucketStart: timestamp,
          cumulativeInputTokens: 10,
          cumulativeOutputTokens: 5,
          cumulativeRequests: 1,
        },
      ],
      topConsumers: [
        {
          subjectType: "chat-thread",
          subjectId: "thread-1",
          inputTokens: 10,
          outputTokens: 5,
          requestCount: 1,
        },
      ],
    });
    expect(response.byDay).toHaveLength(1);
    expect(response.byWeek).toHaveLength(1);
    expect(response.cumulative).toHaveLength(1);
    expect(response.topConsumers).toHaveLength(1);
    expect(response.topConsumers[0]!.subjectId).toBe("thread-1");
  });

  it("keeps advanced totals absent when no provider measured them", () => {
    const response = decodeUsageQueryResponse(baseResponse);
    expect(response.totals.totalReasoningTokens).toBeUndefined();
    expect(response.totals.totalCacheReadInputTokens).toBeUndefined();
    expect(response.totals.totalProviderExecutionDurationMs).toBeUndefined();
  });

  it("defaults missing host latency observations to an empty reading", () => {
    const { latencyStats: _latencyStats, ...withoutLatencyStats } = baseResponse;
    const response = decodeUsageQueryResponse(withoutLatencyStats);
    expect(response.latencyStats).toEqual({ measurements: [] });
  });

  it("rejects excess properties on the response", () => {
    expect(() => decodeUsageQueryResponse({ ...baseResponse, extra: true })).toThrow();
  });
});

describe("UsageTimeBucket", () => {
  it("decodes a valid bucket", () => {
    const bucket = decodeUsageTimeBucket({
      bucketStart: timestamp,
      inputTokens: 10,
      outputTokens: 5,
      requestCount: 1,
      exactCount: 1,
      estimatedCount: 0,
      reconciledCount: 0,
      staleCount: 0,
      unavailableCount: 0,
    });
    expect(bucket.bucketStart).toBe(timestamp);
    expect(bucket.requestCount).toBe(1);
  });

  it("rejects negative request counts", () => {
    expect(() =>
      decodeUsageTimeBucket({
        bucketStart: timestamp,
        inputTokens: 10,
        outputTokens: 5,
        requestCount: -1,
        exactCount: 0,
        estimatedCount: 0,
        reconciledCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      }),
    ).toThrow();
  });
});

describe("UsageTopConsumer", () => {
  it("decodes a valid consumer", () => {
    const consumer = decodeUsageTopConsumer({
      subjectType: "chat-thread",
      subjectId: "thread-1",
      inputTokens: 10,
      outputTokens: 5,
      requestCount: 1,
    });
    expect(consumer.subjectType).toBe("chat-thread");
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeUsageTopConsumer({
        subjectType: "chat-thread",
        subjectId: "thread-1",
        inputTokens: 10,
        outputTokens: 5,
        requestCount: 1,
        extra: true,
      }),
    ).toThrow();
  });
});

describe("UsageExportRequest", () => {
  it("requires confirmation and a format", () => {
    const request = decodeUsageExportRequest({
      format: "csv",
      confirm: true,
    });
    expect(request.format).toBe("csv");
    expect(request.confirm).toBe(true);
  });

  it("rejects export without confirmation", () => {
    expect(() => decodeUsageExportRequest({ format: "csv", confirm: false })).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() => decodeUsageExportRequest({ format: "csv", confirm: true, extra: true })).toThrow();
  });
});

describe("UsageResetRequest", () => {
  it("requires confirmation", () => {
    const request = decodeUsageResetRequest({ confirm: true });
    expect(request.confirm).toBe(true);
  });

  it("rejects reset without confirmation", () => {
    expect(() => decodeUsageResetRequest({ confirm: false })).toThrow();
  });
});

describe("UsageRetentionRequest", () => {
  it("requires confirmation and an olderThan threshold", () => {
    const request = decodeUsageRetentionRequest({
      olderThan: timestamp,
      confirm: true,
    });
    expect(request.olderThan).toBe(timestamp);
    expect(request.confirm).toBe(true);
  });

  it("rejects retention without confirmation", () => {
    expect(() => decodeUsageRetentionRequest({ olderThan: timestamp, confirm: false })).toThrow();
  });
});

describe("UsagePurgeResult", () => {
  it("decodes a valid purge result", () => {
    const result = decodeUsagePurgeResult({
      purgedCount: 3,
      occurredAt: timestamp,
    });
    expect(result.purgedCount).toBe(3);
    expect(result.occurredAt).toBe(timestamp);
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeUsagePurgeResult({ purgedCount: 3, occurredAt: timestamp, extra: true }),
    ).toThrow();
  });
});

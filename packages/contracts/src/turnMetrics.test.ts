import { describe, expect, it } from "vitest";
import {
  decodeSessionMetrics,
  decodeTurnMetrics,
  decodeTurnMetricsRecord,
  decodeTurnMetricsSummary,
} from "./turnMetrics";

const timed = {
  precision: "exact",
  wallMs: 9_000,
  timeToFirstTokenMs: 800,
  decodeOutputTokens: 120,
  decodeMs: 4_000,
  toolMs: 0,
  modelCalls: 1,
} as const;

const record = {
  threadId: "62000000-0000-4000-8000-000000000001",
  mode: "code",
  providerInstanceId: "62000000-0000-4000-8000-000000000002",
  modelId: "model-a",
  stopReason: "end-of-turn",
  metrics: timed,
  startedAt: "2026-10-06T12:00:00.000Z",
  endedAt: "2026-10-06T12:00:09.000Z",
} as const;

describe("turn metrics", () => {
  it("carries timing only when the turn could be timed", () => {
    expect(decodeTurnMetrics(timed)).toEqual(timed);
    expect(decodeTurnMetrics({ precision: "unavailable", wallMs: 5_000 })).toEqual({
      precision: "unavailable",
      wallMs: 5_000,
    });
    expect(() => decodeTurnMetrics({ ...timed, precision: "unavailable" })).toThrow();
    expect(() => decodeTurnMetrics({ precision: "exact", wallMs: 5_000 })).toThrow();
  });

  it("refuses a decode window of no time, which no speed can be read from", () => {
    expect(() => decodeTurnMetrics({ ...timed, decodeMs: 0 })).toThrow();
  });

  it("refuses a session that counts more measured turns than turns", () => {
    const session = {
      turns: 1,
      measuredTurns: 2,
      precision: "exact",
      decodeOutputTokens: 1,
      decodeMs: 1,
      toolMs: 0,
      timeToFirstTokenTotalMs: 1,
    };

    expect(() => decodeSessionMetrics(session)).toThrow();
    expect(() => decodeSessionMetrics({ ...session, measuredTurns: 0 })).toThrow();
    expect(decodeSessionMetrics({ ...session, measuredTurns: 1 }).precision).toBe("exact");
  });

  it("refuses a recorded turn that ended before it started", () => {
    expect(decodeTurnMetricsRecord(record).stopReason).toBe("end-of-turn");
    expect(() =>
      decodeTurnMetricsRecord({ ...record, endedAt: "2026-10-06T11:59:59.000Z" }),
    ).toThrow();
  });

  it("keeps usage absent on a turn whose provider reported none", () => {
    expect(decodeTurnMetricsRecord(record).usage).toBeUndefined();
    expect(
      decodeTurnMetricsRecord({ ...record, usage: { inputTokens: 5, outputTokens: 1 } }).usage,
    ).toEqual({ inputTokens: 5, outputTokens: 1 });
  });

  it("bounds the recent tail a read returns", () => {
    const summary = {
      turns: Array.from({ length: 51 }, () => record),
      turnCount: 51,
      metrics: {
        turns: 51,
        measuredTurns: 51,
        precision: "exact",
        decodeOutputTokens: 1,
        decodeMs: 1,
        toolMs: 0,
        timeToFirstTokenTotalMs: 1,
      },
    };

    expect(() => decodeTurnMetricsSummary(summary)).toThrow();
    expect(decodeTurnMetricsSummary({ ...summary, turns: [record], turnCount: 51 }).turnCount).toBe(
      51,
    );
  });
});

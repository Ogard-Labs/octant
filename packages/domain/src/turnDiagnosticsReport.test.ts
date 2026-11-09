import {
  MAX_DIAGNOSTICS_SAME_PROMPT_PAIRS,
  MAX_DIAGNOSTICS_SAME_PROMPTS,
  decodeTurnDiagnosticsReport,
  type TurnDiagnostics,
  type TurnMetricsRecord,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { buildTurnDiagnosticsReport, likelyCacheMisses, percentile } from "./turnDiagnosticsReport";

const threadA = "00000000-0000-4000-8000-00000000000a";
const threadB = "00000000-0000-4000-8000-00000000000b";
const providerA = "00000000-0000-4000-8000-000000000001";
const providerB = "00000000-0000-4000-8000-000000000002";

const minute = (minutes: number): string =>
  new Date(Date.UTC(2026, 10, 7, 22, 0, 0) + minutes * 60_000).toISOString();

function turn(
  startMinute: number,
  overrides: Partial<Record<keyof TurnMetricsRecord, unknown>> = {},
): TurnMetricsRecord {
  return {
    threadId: threadA,
    mode: "code",
    providerInstanceId: providerA,
    modelId: "model-a",
    stopReason: "end-of-turn",
    usage: { inputTokens: 10_000, outputTokens: 200, cacheReadInputTokens: 9_000 },
    metrics: {
      precision: "exact",
      wallMs: 10_000,
      timeToFirstTokenMs: 1_000,
      decodeOutputTokens: 200,
      decodeMs: 4_000,
      toolMs: 0,
      modelCalls: 1,
    },
    diagnostics: { toolCalls: 0, toolFailures: 0 },
    startedAt: minute(startMinute),
    endedAt: minute(startMinute + 1),
    ...overrides,
  } as TurnMetricsRecord;
}

const options = { generatedAt: minute(600), bucket: "day", timeZone: "UTC" } as const;

describe("the turn diagnostics report", () => {
  it("counts how turns ended and groups failures by cause, newest message kept", () => {
    const failed = (startMinute: number, message: string, diagnostics?: Partial<TurnDiagnostics>) =>
      turn(startMinute, {
        stopReason: "failed",
        diagnostics: {
          toolCalls: 0,
          toolFailures: 0,
          failure: { category: "rate-limited", message },
          ...diagnostics,
        },
      });
    const report = buildTurnDiagnosticsReport(
      [
        turn(0),
        failed(10, "Too many requests."),
        failed(20, "Slow down."),
        turn(30, {
          stopReason: "failed",
          diagnostics: {
            toolCalls: 0,
            toolFailures: 0,
            failure: {
              category: "provider-failed",
              process: { stage: "launch", kind: "exited", exitCode: 1 },
            },
          },
        }),
        turn(40, { stopReason: "cancelled" }),
      ],
      options,
    );

    expect(report.totals.stopReasons).toEqual({
      "end-of-turn": 1,
      "max-tokens": 0,
      cancelled: 1,
      failed: 3,
      waiting: 0,
    });
    expect(report.failureGroups).toEqual([
      {
        category: "rate-limited",
        count: 2,
        firstAt: minute(11),
        lastAt: minute(21),
        lastMessage: "Slow down.",
      },
      {
        category: "provider-failed",
        processKind: "exited",
        count: 1,
        firstAt: minute(31),
        lastAt: minute(31),
      },
    ]);
    expect(report.troubledTurns.map((troubled) => troubled.stopReason)).toEqual([
      "cancelled",
      "failed",
      "failed",
      "failed",
    ]);
    expect(report.models[0]?.rateLimitedTurns).toBe(2);
    expect(() => decodeTurnDiagnosticsReport(report)).not.toThrow();
  });

  it("counts a turn recorded before diagnostics toward its ending and speed, not toward tool totals", () => {
    const report = buildTurnDiagnosticsReport(
      [
        turn(0, { diagnostics: undefined, stopReason: "failed" }),
        turn(10, { diagnostics: { toolCalls: 4, toolFailures: 1 } }),
      ],
      options,
    );

    expect(report.turns).toBe(2);
    expect(report.diagnosedTurns).toBe(1);
    expect(report.totals.stopReasons.failed).toBe(1);
    expect(report.totals.toolCalls).toBe(4);
    expect(report.totals.timeToFirstTokenMs?.count).toBe(2);
  });

  it("ranks tools by failures and sums them across turns", () => {
    const withTools = (startMinute: number, tools: TurnDiagnostics["tools"]) =>
      turn(startMinute, {
        diagnostics: {
          toolCalls: tools?.reduce((sum, tally) => sum + tally.calls, 0) ?? 0,
          toolFailures: tools?.reduce((sum, tally) => sum + tally.failed, 0) ?? 0,
          tools,
        },
      });
    const report = buildTurnDiagnosticsReport(
      [
        withTools(0, [
          { toolName: "Read", calls: 9, failed: 0, unfinished: 0, totalMs: 900, maxMs: 200 },
          { toolName: "Bash", calls: 2, failed: 1, unfinished: 0, totalMs: 5_000, maxMs: 4_000 },
        ]),
        withTools(10, [
          {
            toolName: "Bash",
            calls: 3,
            failed: 1,
            unfinished: 1,
            nonZeroExits: 2,
            totalMs: 1_000,
            maxMs: 600,
          },
        ]),
      ],
      options,
    );

    expect(report.tools).toEqual([
      {
        toolName: "Bash",
        turns: 2,
        calls: 5,
        failed: 2,
        unfinished: 1,
        nonZeroExits: 2,
        totalMs: 6_000,
        maxMs: 4_000,
      },
      {
        toolName: "Read",
        turns: 1,
        calls: 9,
        failed: 0,
        unfinished: 0,
        nonZeroExits: 0,
        totalMs: 900,
        maxMs: 200,
      },
    ]);
    expect(report.totals.unfinishedToolCalls).toBe(1);
  });

  it("counts the turns whose per-tool tallies were cut, so the tool figures can be called partial", () => {
    const cut = (startMinute: number, truncated: boolean) =>
      turn(startMinute, {
        diagnostics: {
          toolCalls: 40,
          toolFailures: 0,
          tools: [
            { toolName: "Read", calls: 30, failed: 0, unfinished: 0, totalMs: 900, maxMs: 200 },
          ],
          ...(truncated ? { toolsTruncated: true as const } : {}),
        },
      });
    const report = buildTurnDiagnosticsReport(
      [cut(0, true), cut(10, false), cut(20, true)],
      options,
    );

    expect(report.totals.toolTalliesTruncatedTurns).toBe(2);
    expect(report.totals.toolCalls).toBe(120);
  });

  it("states speed percentiles per model only over turns that measured them", () => {
    const timed = (startMinute: number, ttft: number, tokens: number) =>
      turn(startMinute, {
        providerInstanceId: providerB,
        metrics: {
          precision: "exact",
          wallMs: 5_000,
          timeToFirstTokenMs: ttft,
          decodeOutputTokens: tokens,
          decodeMs: 2_000,
          toolMs: 0,
          modelCalls: 1,
        },
      });
    const report = buildTurnDiagnosticsReport(
      [
        timed(0, 500, 100),
        timed(10, 700, 200),
        timed(20, 3_000, 300),
        turn(30, {
          providerInstanceId: providerB,
          metrics: { precision: "unavailable", wallMs: 2_000 },
        }),
      ],
      options,
    );

    const row = report.models[0];
    expect(row?.turns).toBe(4);
    expect(row?.timeToFirstTokenMs).toEqual({ count: 3, p50: 700, p95: 3_000, max: 3_000 });
    expect(row?.decodeTokensPerSecond).toEqual({ count: 3, p50: 100, p95: 150, max: 150 });
    expect(row?.wallMs?.count).toBe(4);
  });

  it("weighs the cache hit rate over turns that reported cache figures, and states none when no turn did", () => {
    const report = buildTurnDiagnosticsReport(
      [
        turn(0, { usage: { inputTokens: 10_000, outputTokens: 10, cacheReadInputTokens: 9_000 } }),
        turn(10, { usage: { inputTokens: 5_000, outputTokens: 10 } }),
        turn(20, {
          modelId: "model-quiet",
          usage: { inputTokens: 5_000, outputTokens: 10 },
        }),
      ],
      options,
    );

    const cached = report.models.find((row) => row.modelId === "model-a");
    expect(cached?.inputTokens).toBe(15_000);
    expect(cached?.cache).toEqual({ inputTokens: 10_000, readTokens: 9_000, writeTokens: 0 });
    expect(report.models.find((row) => row.modelId === "model-quiet")?.cache).toBeUndefined();
  });

  it("places day buckets in the reader's time zone", () => {
    // 23:06 UTC on 7 November is already 8 November in Oslo (UTC+1).
    const report = buildTurnDiagnosticsReport([turn(0), turn(65)], {
      ...options,
      timeZone: "Europe/Oslo",
    });

    expect(report.trend.map((bucket) => [bucket.key, bucket.turns])).toEqual([
      ["2026-11-07", 1],
      ["2026-11-08", 1],
    ]);
  });

  it("uses UTC hours for hour buckets", () => {
    const report = buildTurnDiagnosticsReport([turn(0), turn(70)], { ...options, bucket: "hour" });

    expect(report.trend.map((bucket) => bucket.key)).toEqual([
      "2026-11-07T22:00:00Z",
      "2026-11-07T23:00:00Z",
    ]);
  });
});

describe("likely prompt-cache misses", () => {
  const cold = { inputTokens: 10_000, outputTokens: 100, cacheReadInputTokens: 0 };

  it("flags a large prompt that read nothing soon after a cached turn in the same thread", () => {
    const misses = likelyCacheMisses([turn(0), turn(3, { usage: cold })]);

    expect(misses).toEqual([
      {
        threadId: threadA,
        providerInstanceId: providerA,
        modelId: "model-a",
        endedAt: minute(4),
        inputTokens: 10_000,
        gapMs: 120_000,
      },
    ]);
  });

  it("does not flag a miss after the cache would have expired, on another model, another thread, or a small prompt", () => {
    expect(likelyCacheMisses([turn(0), turn(7, { usage: cold })])).toEqual([]);
    expect(likelyCacheMisses([turn(0), turn(3, { usage: cold, modelId: "model-b" })])).toEqual([]);
    expect(likelyCacheMisses([turn(0), turn(3, { usage: cold, threadId: threadB })])).toEqual([]);
    expect(
      likelyCacheMisses([turn(0), turn(3, { usage: { ...cold, inputTokens: 1_000 } })]),
    ).toEqual([]);
  });

  it("does not flag a turn whose provider reported no cache figures", () => {
    expect(
      likelyCacheMisses([turn(0), turn(3, { usage: { inputTokens: 10_000, outputTokens: 1 } })]),
    ).toEqual([]);
  });
});

describe("the same-prompt list", () => {
  const digest = (character: string) => character.repeat(64);

  it("groups turns by digest and keeps only prompts sent to two or more provider and model pairs", () => {
    const report = buildTurnDiagnosticsReport(
      [
        turn(0, { promptDigest: digest("a") }),
        turn(10, { promptDigest: digest("a"), modelId: "model-b", threadId: threadB }),
        turn(20, { promptDigest: digest("a"), modelId: "model-b", stopReason: "failed" }),
        turn(30, { promptDigest: digest("b") }),
        turn(40, { promptDigest: digest("b") }),
        turn(50),
        turn(60, { providerInstanceId: providerB }),
      ],
      options,
    );

    expect(report.samePrompt).toHaveLength(1);
    const entry = report.samePrompt[0];
    expect(entry?.promptDigest).toBe(digest("a"));
    expect(entry?.threadId).toBe(threadA);
    expect(entry?.lastSentAt).toBe(minute(20));
    expect(entry?.pairs.map((pair) => [pair.modelId, pair.turns, pair.failedTurns])).toEqual([
      ["model-b", 2, 1],
      ["model-a", 1, 0],
    ]);
    expect(entry?.pairs[1]?.decodeTokensPerSecondP50).toBe(50);
    expect(entry?.pairs[1]?.timeToFirstTokenP50Ms).toBe(1_000);
    expect(entry?.pairs[1]?.outputTokens).toBe(200);
    expect(decodeTurnDiagnosticsReport(report).samePrompt).toHaveLength(1);
  });

  it("counts the same model on two provider instances as two pairs", () => {
    const report = buildTurnDiagnosticsReport(
      [
        turn(0, { promptDigest: digest("c") }),
        turn(5, { promptDigest: digest("c"), providerInstanceId: providerB }),
      ],
      options,
    );
    expect(report.samePrompt[0]?.pairs).toHaveLength(2);
  });

  it("lists the newest prompts first and cuts the list and each entry's pairs to their bounds", () => {
    const hex = (index: number) => index.toString(16).padStart(64, "0");
    const records: TurnMetricsRecord[] = [];
    for (let index = 0; index < 55; index += 1) {
      records.push(turn(index * 2, { promptDigest: hex(index), modelId: "model-a" }));
      records.push(turn(index * 2 + 1, { promptDigest: hex(index), modelId: "model-b" }));
    }
    for (let index = 0; index < 10; index += 1) {
      records.push(turn(200 + index, { promptDigest: hex(0), modelId: `model-extra-${index}` }));
    }
    const report = buildTurnDiagnosticsReport(records, options);

    expect(report.samePrompt).toHaveLength(MAX_DIAGNOSTICS_SAME_PROMPTS);
    expect(report.samePrompt[0]?.promptDigest).toBe(hex(0));
    expect(report.samePrompt[0]?.pairs).toHaveLength(MAX_DIAGNOSTICS_SAME_PROMPT_PAIRS);
    expect(report.samePrompt[1]?.promptDigest).toBe(hex(54));
  });
});

describe("nearest-rank percentile", () => {
  it("returns an observed value and nothing over no values", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBeUndefined();
  });
});

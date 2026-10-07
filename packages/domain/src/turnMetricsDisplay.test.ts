import {
  decodeUtcTimestamp,
  type TurnMetricsRecord,
  type TurnMetricsSummary,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  costOfTurns,
  formatCacheHit,
  formatCostUsd,
  formatSeconds,
  formatTokenCount,
  formatTokensPerSecond,
  speedFiguresOfSession,
  speedFiguresOfTurn,
  threadStats,
  threadStatsInputOf,
  threadStatsLine,
  turnDetail,
} from "./turnMetricsDisplay";

const exact = {
  precision: "exact",
  decodeOutputTokens: 410,
  decodeMs: 10_000,
  firstTokenMs: 900,
  turns: 1,
} as const;

function record(overrides: Partial<TurnMetricsRecord> = {}): TurnMetricsRecord {
  return {
    threadId: "0b6f7ac4-4d7e-4d07-8f35-2f64d7a2e3a1",
    mode: "code",
    providerInstanceId: "codex" as never,
    modelId: "gpt-5.6-luna" as never,
    stopReason: "end-of-turn",
    usage: { inputTokens: 100_000, cacheReadInputTokens: 80_000, outputTokens: 10_000 },
    metrics: {
      precision: "exact",
      wallMs: 12_000,
      timeToFirstTokenMs: 900,
      decodeOutputTokens: 410,
      decodeMs: 10_000,
      toolMs: 0,
      modelCalls: 1,
    },
    startedAt: decodeUtcTimestamp("2026-10-06T10:00:00.000Z"),
    endedAt: decodeUtcTimestamp("2026-10-06T10:00:12.000Z"),
    ...overrides,
  };
}

describe("token counts", () => {
  it("reads thousands and millions in at most three figures", () => {
    expect(formatTokenCount(842)).toBe("842");
    expect(formatTokenCount(3_100)).toBe("3.1k");
    expect(formatTokenCount(3_000)).toBe("3k");
    expect(formatTokenCount(48_213)).toBe("48k");
    expect(formatTokenCount(1_240_000)).toBe("1.2M");
  });

  it("does not print a thousand-thousand as k", () => {
    expect(formatTokenCount(999_600)).toBe("1M");
    expect(formatTokenCount(9_960)).toBe("10k");
  });
});

describe("cache hit", () => {
  it("shows a whole percentage for an ordinary share", () => {
    expect(formatCacheHit(0.92)).toBe("92%");
    expect(formatCacheHit(0.5)).toBe("50%");
  });

  it("never rounds a partial hit up to 100", () => {
    expect(formatCacheHit(0.995)).toBe("99.5%");
    expect(formatCacheHit(0.9995)).toBe("99.95%");
    expect(formatCacheHit(0.99999)).toBe(">99.99%");
    expect(formatCacheHit(1)).toBe("100%");
  });

  it("does not show a tiny hit as zero", () => {
    expect(formatCacheHit(0.001)).toBe("<1%");
    expect(formatCacheHit(0)).toBe("0%");
  });
});

describe("speed", () => {
  it("uses whole numbers from ten and one decimal below", () => {
    expect(formatTokensPerSecond(41.4, "exact")).toBe("41 tok/s");
    expect(formatTokensPerSecond(10, "exact")).toBe("10 tok/s");
    expect(formatTokensPerSecond(9.96, "exact")).toBe("10 tok/s");
    expect(formatTokensPerSecond(9.94, "exact")).toBe("9.9 tok/s");
    expect(formatTokensPerSecond(3.04, "exact")).toBe("3.0 tok/s");
  });

  it("marks an approximate speed with a tilde", () => {
    expect(formatTokensPerSecond(41.4, "approximate")).toBe("~41 tok/s");
  });
});

describe("durations and cost", () => {
  it("reads sub-second spans in tenths and says so when shorter", () => {
    expect(formatSeconds(912)).toBe("0.9 s");
    expect(formatSeconds(20)).toBe("<0.1 s");
    expect(formatSeconds(2_400)).toBe("2.4 s");
    expect(formatSeconds(41_000)).toBe("41 s");
    expect(formatSeconds(125_000)).toBe("2 m 05 s");
    expect(formatSeconds(9_960)).toBe("10 s");
  });

  it("states cents and floors anything cheaper", () => {
    expect(formatCostUsd(0.026)).toBe("$0.03");
    expect(formatCostUsd(0.001)).toBe("<$0.01");
  });
});

describe("the thread line", () => {
  it("states every figure the provider reported, in order", () => {
    const line = threadStatsLine({
      usage: { inputTokens: 48_000, outputTokens: 3_100, cacheReadInputTokens: 44_160 },
      speed: exact,
      cost: { amountUsd: 0.026, estimated: true },
    });
    expect(line).toBe(
      "↑ 48k in · ↓ 3.1k out · cache 92% · 41 tok/s · 0.9 s first token · $0.03 est.",
    );
  });

  it("leaves out the cache share when the provider reported no cache figure", () => {
    const stats = threadStats({ usage: { inputTokens: 48_000, outputTokens: 3_100 } });
    expect(stats.map((stat) => stat.key)).toEqual(["input", "output"]);
  });

  it("leaves out the cache share when nothing was sent", () => {
    const stats = threadStats({
      usage: { inputTokens: 0, outputTokens: 12, cacheReadInputTokens: 0 },
    });
    expect(stats.map((stat) => stat.key)).toEqual(["output"]);
  });

  it("leaves out speed and first token when timing is unavailable", () => {
    const stats = threadStats({
      usage: { inputTokens: 10, outputTokens: 10 },
      speed: { precision: "unavailable", turns: 1 },
    });
    expect(stats.map((stat) => stat.key)).toEqual(["input", "output"]);
  });

  it("tilde-marks an approximate speed and explains it in the hint", () => {
    const stats = threadStats({ speed: { ...exact, precision: "approximate" } });
    const speed = stats.find((stat) => stat.key === "speed");
    expect(speed?.text).toBe("~41 tok/s");
    expect(speed?.hint).toContain("per turn");
    expect(speed?.hint).toContain("tool time");
  });

  it("gives an exact speed no hint", () => {
    const speed = threadStats({ speed: exact }).find((stat) => stat.key === "speed");
    expect(speed?.hint).toBeUndefined();
  });

  it("says est. for an estimate and drops it for a provider-reported cost", () => {
    const estimated = threadStats({ cost: { amountUsd: 1.234, estimated: true } });
    const reported = threadStats({ cost: { amountUsd: 1.234, estimated: false } });
    expect(estimated[0]?.text).toBe("$1.23 est.");
    expect(reported[0]?.text).toBe("$1.23");
  });

  it("says when a cost covers only the latest turns", () => {
    const [cost] = threadStats({ cost: { amountUsd: 2, estimated: true, latestTurns: 50 } });
    expect(cost?.hint).toContain("latest 50 turns");
  });

  it("states nothing for a provider that reported nothing", () => {
    expect(threadStats({})).toEqual([]);
    expect(threadStats(threadStatsInputOf(undefined))).toEqual([]);
  });

  it("averages first-token time over the measured turns of a thread", () => {
    const figures = speedFiguresOfSession({
      turns: 4,
      measuredTurns: 2,
      precision: "exact",
      decodeOutputTokens: 800,
      decodeMs: 20_000,
      toolMs: 0,
      timeToFirstTokenTotalMs: 3_000,
    });
    expect(figures?.firstTokenMs).toBe(1_500);
    const first = threadStats({ speed: figures }).find((stat) => stat.key === "first-token");
    expect(first?.hint).toBe("Average over 2 turns.");
  });

  it("has no session speed before any turn was measured", () => {
    expect(
      speedFiguresOfSession({
        turns: 3,
        measuredTurns: 0,
        precision: "unavailable",
        decodeOutputTokens: 0,
        decodeMs: 0,
        toolMs: 0,
        timeToFirstTokenTotalMs: 0,
      }),
    ).toBeUndefined();
  });
});

describe("thread cost", () => {
  it("prices each turn on its own model", () => {
    const cost = costOfTurns([{ modelId: "gpt-5.6-luna", usage: record().usage }], true);
    expect(cost?.estimated).toBe(true);
    expect(cost?.amountUsd).toBeCloseTo(0.0176, 6);
  });

  it("lets a provider-reported cost win and drops est.", () => {
    const cost = costOfTurns(
      [{ modelId: "unpriced-model", usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.4 } }],
      true,
    );
    expect(cost).toEqual({ amountUsd: 0.4, estimated: false });
  });

  it("is absent when a turn used a model with no price", () => {
    const cost = costOfTurns(
      [
        { modelId: "gpt-5.6-luna", usage: record().usage },
        { modelId: "some-local-model", usage: { inputTokens: 5, outputTokens: 5 } },
      ],
      true,
    );
    expect(cost).toBeUndefined();
  });

  it("is absent when no turn reported usage", () => {
    expect(costOfTurns([{ modelId: "gpt-5.6-luna" }], true)).toBeUndefined();
  });

  it("is an estimate when any turn was estimated", () => {
    const cost = costOfTurns(
      [
        { modelId: "x", usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.1 } },
        { modelId: "gpt-5.6-luna", usage: record().usage },
      ],
      true,
    );
    expect(cost?.estimated).toBe(true);
  });

  it("notes the latest turns when the summary holds only the tail", () => {
    const summary: TurnMetricsSummary = {
      turns: [record()],
      turnCount: 80,
      usage: { inputTokens: 1, outputTokens: 1 },
      metrics: {
        turns: 80,
        measuredTurns: 1,
        precision: "exact",
        decodeOutputTokens: 410,
        decodeMs: 10_000,
        toolMs: 0,
        timeToFirstTokenTotalMs: 900,
      },
    };
    expect(threadStatsInputOf(summary).cost?.latestTurns).toBe(1);
  });
});

describe("one turn", () => {
  it("lists tokens, timing, and an estimated cost", () => {
    const detail = turnDetail(record());
    expect(detail.tokens.map((row) => [row.label, row.value])).toEqual([
      ["Input", "100,000"],
      ["Cache read", "80,000"],
      ["Output", "10,000"],
      ["Cache hit", "80%"],
    ]);
    expect(detail.timing.map((row) => row.label)).toEqual([
      "First token",
      "Speed",
      "Model time",
      "Total time",
      "Ended",
    ]);
    expect(detail.cost?.value).toBe("$0.02 est.");
  });

  it("shows cache write, reasoning, tool time, requests, and retries only when present", () => {
    const detail = turnDetail(
      record({
        usage: {
          inputTokens: 1_000,
          cacheReadInputTokens: 600,
          cacheWriteInputTokens: 100,
          outputTokens: 500,
          reasoningTokens: 200,
        },
        metrics: {
          precision: "exact",
          wallMs: 30_000,
          timeToFirstTokenMs: 500,
          decodeOutputTokens: 500,
          decodeMs: 5_000,
          toolMs: 20_000,
          modelCalls: 3,
          retries: 2,
        },
      }),
    );
    const labels = [...detail.tokens, ...detail.timing].map((row) => row.label);
    expect(labels).toContain("Cache write");
    expect(labels).toContain("Reasoning");
    expect(labels).toContain("Tool time");
    expect(labels).toContain("Model requests");
    expect(labels).toContain("Retries");
  });

  it("hides what a turn without usage or timing cannot say", () => {
    const detail = turnDetail(
      record({ usage: undefined, metrics: { precision: "unavailable", wallMs: 4_000 } }),
    );
    expect(detail.tokens).toEqual([]);
    expect(detail.timing.map((row) => row.label)).toEqual(["Total time", "Ended"]);
    expect(detail.cost).toBeUndefined();
    expect(detail.notes).toHaveLength(2);
  });

  it("explains an approximate speed on its row", () => {
    const detail = turnDetail(
      record({
        metrics: {
          precision: "approximate",
          wallMs: 9_000,
          timeToFirstTokenMs: 400,
          decodeOutputTokens: 200,
          decodeMs: 4_000,
          toolMs: 1_000,
          modelCalls: 1,
        },
      }),
    );
    const speed = detail.timing.find((row) => row.key === "speed");
    expect(speed?.value).toBe("~50 tok/s");
    expect(speed?.hint).toContain("tool time");
  });

  it("derives a turn's figures from its own metrics", () => {
    expect(speedFiguresOfTurn(record().metrics)?.firstTokenMs).toBe(900);
    expect(speedFiguresOfTurn(undefined)).toBeUndefined();
  });
});

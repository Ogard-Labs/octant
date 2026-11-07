import {
  decodeBenchmarkCellId,
  type BenchmarkCell,
  type BenchmarkCellMetrics,
  type BenchmarkCheck,
  type BenchmarkRun,
  type TurnMetricsRecord,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  benchmarkBudgetDecision,
  benchmarkCellMetrics,
  benchmarkLeaderboard,
  benchmarkRunStatusAfter,
  nextBenchmarkCells,
  planBenchmarkCells,
  scoreBenchmarkChecks,
} from "./benchmarkPolicy";

const caseA = { caseId: "63000000-0000-4000-8000-00000000000a" } as { readonly caseId: never };
const caseB = { caseId: "63000000-0000-4000-8000-00000000000b" } as { readonly caseId: never };

function counter() {
  let next = 0;
  return () => decodeBenchmarkCellId(`63000000-0000-4000-8000-${String(++next).padStart(12, "0")}`);
}

describe("planning benchmark cells", () => {
  it("orders cells repetition first, then case, then contender, so an early stop compares every contender", () => {
    const cells = planBenchmarkCells([caseA, caseB], ["x", "y"], 2, counter());
    expect(cells).toHaveLength(8);
    expect(
      cells.map(
        (cell) => `${cell.repetition}:${String(cell.caseId).slice(-1)}:${cell.contenderIndex}`,
      ),
    ).toEqual(["1:a:0", "1:a:1", "1:b:0", "1:b:1", "2:a:0", "2:a:1", "2:b:0", "2:b:1"]);
    expect(cells.every((cell) => cell.state === "queued" && cell.checks.length === 0)).toBe(true);
    expect(new Set(cells.map((cell) => cell.cellId)).size).toBe(8);
  });
});

describe("scoring benchmark checks", () => {
  const score = (check: BenchmarkCheck, answer: string) => scoreBenchmarkChecks([check], answer)[0];

  it("honours case sensitivity for contains and not-contains", () => {
    expect(score({ kind: "contains", text: "Hello", caseSensitive: true }, "hello")?.passed).toBe(
      false,
    );
    expect(score({ kind: "contains", text: "Hello", caseSensitive: false }, "hello")?.passed).toBe(
      true,
    );
    expect(
      score({ kind: "not-contains", text: "secret", caseSensitive: false }, "A SECRET")?.passed,
    ).toBe(false);
    expect(
      score({ kind: "not-contains", text: "secret", caseSensitive: true }, "A SECRET")?.passed,
    ).toBe(true);
  });

  it("matches a regular expression with its flags", () => {
    expect(score({ kind: "matches", pattern: "^ab+c$", flags: "" }, "abbc")?.passed).toBe(true);
    expect(score({ kind: "matches", pattern: "^abc$", flags: "" }, "ABC")?.passed).toBe(false);
    expect(score({ kind: "matches", pattern: "^abc$", flags: "i" }, "ABC")?.passed).toBe(true);
  });

  it("fails a pattern that does not compile, with a reason, instead of throwing", () => {
    expect(score({ kind: "matches", pattern: "(unclosed", flags: "" }, "x")).toEqual({
      index: 0,
      passed: false,
      detail: "invalid pattern",
    });
  });

  it("compares equals exactly unless it is told to trim", () => {
    expect(score({ kind: "equals", text: "42", trim: false }, " 42\n")?.passed).toBe(false);
    expect(score({ kind: "equals", text: "42", trim: true }, " 42\n")?.passed).toBe(true);
  });

  it("accepts valid JSON and refuses prose", () => {
    expect(score({ kind: "valid-json" }, ' {"a": [1, 2]} ')?.passed).toBe(true);
    expect(score({ kind: "valid-json" }, "here is json: {}")?.passed).toBe(false);
  });

  it("leaves worktree checks to the runner and keeps each result at its check's position", () => {
    const results = scoreBenchmarkChecks(
      [
        { kind: "command-exits-zero", command: "bun test", timeoutSeconds: 60 },
        { kind: "contains", text: "ok", caseSensitive: false },
        { kind: "max-files-changed", count: 2 },
      ],
      "ok",
    );
    expect(results).toEqual([{ index: 1, passed: true }]);
  });

  it("reads only the first 200,000 characters of an answer", () => {
    const answer = `${"a".repeat(200_000)}tail`;
    expect(score({ kind: "contains", text: "tail", caseSensitive: true }, answer)?.passed).toBe(
      false,
    );
  });
});

function runOf(cells: ReadonlyArray<BenchmarkCell>, providers: ReadonlyArray<string>) {
  return {
    cells,
    contenders: providers.map((providerInstanceId) => ({ providerInstanceId, modelId: "m" })),
  } as unknown as Pick<BenchmarkRun, "cells" | "contenders">;
}

function queued(index: number, contenderIndex: number): BenchmarkCell {
  return {
    cellId: `63000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    caseId: caseA.caseId,
    contenderIndex,
    repetition: 1,
    state: "queued",
    checks: [],
  } as unknown as BenchmarkCell;
}

describe("choosing the benchmark cells to start", () => {
  it("starts at most two cells per provider instance and passes over a busy provider", () => {
    const run = runOf([queued(1, 0), queued(2, 0), queued(3, 0), queued(4, 1)], ["p1", "p2"]);
    const next = nextBenchmarkCells(run, { byProvider: new Map(), total: 0 });
    expect(next.map((cell) => cell.cellId.slice(-1))).toEqual(["1", "2", "4"]);
  });

  it("counts cells already running on the host and stops at four in all", () => {
    const run = runOf(
      [queued(1, 0), queued(2, 1), queued(3, 2), queued(4, 3), queued(5, 4)],
      ["p1", "p2", "p3", "p4", "p5"],
    );
    const next = nextBenchmarkCells(run, { byProvider: new Map([["p1", 1]]), total: 2 });
    expect(next).toHaveLength(2);
    const none = nextBenchmarkCells(run, { byProvider: new Map(), total: 4 });
    expect(none).toHaveLength(0);
  });

  it("holds a cell back while its provider already runs two", () => {
    const run = runOf([queued(1, 0)], ["p1"]);
    expect(nextBenchmarkCells(run, { byProvider: new Map([["p1", 2]]), total: 2 })).toEqual([]);
  });
});

describe("benchmark budget", () => {
  it("allows the first cells before anything has settled", () => {
    expect(benchmarkBudgetDecision({ maxTokens: 10 }, { tokens: 0, costUsd: 0 }, 0, 0)).toEqual({
      decision: "start",
    });
  });

  it("stops when what was spent plus the mean cell for every cell in flight would pass the token limit", () => {
    const budget = { maxTokens: 1_000 };
    expect(benchmarkBudgetDecision(budget, { tokens: 800, costUsd: 0 }, 4, 0).decision).toBe(
      "start",
    );
    const stopped = benchmarkBudgetDecision(budget, { tokens: 800, costUsd: 0 }, 4, 1);
    expect(stopped.decision).toBe("stop");
  });

  it("stops on the cost limit by the same estimate", () => {
    const budget = { maxCostUsd: 1 };
    expect(benchmarkBudgetDecision(budget, { tokens: 0, costUsd: 0.7 }, 3, 0).decision).toBe(
      "start",
    );
    expect(benchmarkBudgetDecision(budget, { tokens: 0, costUsd: 0.7 }, 3, 1).decision).toBe(
      "stop",
    );
  });
});

describe("benchmark run status", () => {
  it("is finished only when no cell is queued or running", () => {
    expect(benchmarkRunStatusAfter({ cells: [queued(1, 0)] })).toBe("running");
    expect(benchmarkRunStatusAfter({ cells: [{ ...queued(1, 0), state: "answered" }] })).toBe(
      "finished",
    );
  });
});

describe("benchmark leaderboard", () => {
  const settled = (
    index: number,
    contenderIndex: number,
    overrides: Partial<BenchmarkCell>,
  ): BenchmarkCell =>
    ({ ...queued(index, contenderIndex), state: "answered", ...overrides }) as BenchmarkCell;

  it("computes pass rate, judge and star means, percentiles, tokens, cost, tool failures, and counts", () => {
    const thread = (n: number) => `64000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const cells = [
      settled(1, 0, {
        threadId: thread(1),
        checks: [
          { index: 0, passed: true },
          { index: 1, passed: false },
        ],
        judge: { status: "scored", score: 8, reason: "ok", judgeThreadId: thread(90) },
        rating: { stars: 4, ratedAt: "2026-11-07T10:00:00.000Z" } as never,
      }),
      settled(2, 0, {
        threadId: thread(2),
        checks: [{ index: 0, passed: true }],
        judge: { status: "scored", score: 6, reason: "ok", judgeThreadId: thread(91) },
      }),
      settled(3, 0, { state: "failed", threadId: thread(3) }),
      settled(4, 0, { state: "blocked-on-approval" }),
      settled(5, 1, { threadId: thread(5), checks: [{ index: 0, passed: false }] }),
    ];
    const metrics = new Map<string, BenchmarkCellMetrics>([
      [
        thread(1),
        {
          stopReason: "end-of-turn",
          wallMs: 1,
          timeToFirstTokenMs: 100,
          tokensPerSecond: 50,
          totalTokens: 300,
          costUsd: 0.01,
          toolCalls: 4,
          toolFailures: 1,
        },
      ],
      [
        thread(2),
        {
          stopReason: "end-of-turn",
          wallMs: 1,
          timeToFirstTokenMs: 300,
          tokensPerSecond: 30,
          totalTokens: 100,
          costUsd: 0.03,
          toolCalls: 0,
          toolFailures: 0,
        },
      ],
      [thread(3), { stopReason: "failed", wallMs: 1, timeToFirstTokenMs: 200, totalTokens: 200 }],
      [thread(5), { stopReason: "end-of-turn", wallMs: 1 }],
    ]);
    const rows = benchmarkLeaderboard(runOf(cells, ["p1", "p2"]), metrics);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      contenderIndex: 0,
      cells: 4,
      answered: 2,
      checkPassRate: 2 / 3,
      meanJudgeScore: 7,
      meanStars: 4,
      firstTokenP50Ms: 200,
      firstTokenP95Ms: 300,
      tokensPerSecondP50: 30,
      tokensPerSecondP95: 50,
      totalTokens: 600,
      meanTokens: 200,
      toolFailureRate: 1 / 4,
      failedCount: 1,
      blockedCount: 1,
    });
    expect(rows[0]?.totalCostUsd).toBeCloseTo(0.04);
    expect(rows[1]).toMatchObject({ contenderIndex: 1, cells: 1, answered: 1, checkPassRate: 0 });
    expect(rows[1]?.totalCostUsd).toBeUndefined();
    expect(rows[1]?.toolFailureRate).toBeUndefined();
  });
});

describe("benchmark cell metrics", () => {
  it("reads speed, tokens, cost, and tool failures from the recorded turn", () => {
    const record = {
      threadId: "64000000-0000-4000-8000-000000000001",
      mode: "chat",
      providerInstanceId: "63000000-0000-4000-8000-000000000020",
      modelId: "m",
      stopReason: "end-of-turn",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 },
      metrics: {
        precision: "exact",
        wallMs: 5_000,
        timeToFirstTokenMs: 400,
        decodeOutputTokens: 100,
        decodeMs: 2_000,
        toolMs: 0,
        modelCalls: 1,
      },
      diagnostics: { toolCalls: 2, toolFailures: 1 },
      startedAt: "2026-11-07T10:00:00.000Z",
      endedAt: "2026-11-07T10:00:05.000Z",
    } as unknown as TurnMetricsRecord;
    expect(benchmarkCellMetrics(record)).toEqual({
      stopReason: "end-of-turn",
      wallMs: 5_000,
      timeToFirstTokenMs: 400,
      tokensPerSecond: 50,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.02,
      toolCalls: 2,
      toolFailures: 1,
    });
  });
});

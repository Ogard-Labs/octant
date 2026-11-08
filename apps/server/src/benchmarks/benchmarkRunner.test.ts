import { decodeTurnMetricsRecord, type TurnMetricsRecord } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { deterministicUuid } from "../deterministicUuid";
import type {
  BenchmarkChatPort,
  BenchmarkTurnInput,
  BenchmarkTurnReading,
  BenchmarkTurnStart,
} from "./benchmarkChatPort";
import { BENCHMARKS_PROJECT_ID } from "./benchmarkChatPort";
import { createWorkerPatternMatcher } from "./benchmarkPatternMatcher";
import { BenchmarkRunner, benchmarkCellIdentity } from "./benchmarkRunner";
import {
  BENCHMARK_TEST_NOW,
  benchmarkIds,
  openBenchmarkTestStore,
  removeBenchmarkTestStores,
  sampleRun,
  sampleSuite,
} from "./benchmarkTestSupport";

afterEach(removeBenchmarkTestStores);

interface FakeTurn {
  readonly turnId: string;
  outcome: Extract<BenchmarkTurnReading, { status: "turn" }>["outcome"];
  answer?: string;
  failureMessage?: string;
  failureCode?: string;
}

/** A Chat that answers only when the test lets a turn finish. */
class FakeChat implements BenchmarkChatPort {
  readonly starts: BenchmarkTurnInput[] = [];
  readonly archived: string[] = [];
  readonly interrupted: string[] = [];
  readonly turns = new Map<string, FakeTurn>();
  startBehavior: (input: BenchmarkTurnInput) => BenchmarkTurnStart = (input) => {
    const turnId = deterministicUuid(`turn:${input.threadId}`);
    this.turns.set(input.threadId, { turnId, outcome: "streaming" });
    return { status: "started", turnId };
  };

  async startTurn(input: BenchmarkTurnInput): Promise<BenchmarkTurnStart> {
    this.starts.push(input);
    return this.startBehavior(input);
  }

  readTurn(threadId: string): BenchmarkTurnReading {
    const turn = this.turns.get(threadId);
    if (turn === undefined) return { status: "gone" };
    return {
      status: "turn",
      turnId: turn.turnId,
      attemptId: "attempt",
      outcome: turn.outcome,
      ...(turn.failureMessage === undefined ? {} : { failureMessage: turn.failureMessage }),
      ...(turn.failureCode === undefined ? {} : { failureCode: turn.failureCode }),
    };
  }

  readAnswer(threadId: string): string | undefined {
    return this.turns.get(threadId)?.answer;
  }

  async interruptTurn(threadId: string): Promise<void> {
    this.interrupted.push(threadId);
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId);
  }

  finish(threadId: string, answer: string): void {
    const turn = this.turns.get(threadId);
    if (turn === undefined) throw new Error("no such turn");
    turn.outcome = "completed";
    turn.answer = answer;
  }
}

const matcher = createWorkerPatternMatcher(300);

function setup(options: { readonly timeoutMs?: number } = {}) {
  const clock = { now: BENCHMARK_TEST_NOW };
  const opened = openBenchmarkTestStore(() => clock.now);
  const chat = new FakeChat();
  const metrics = new Map<string, TurnMetricsRecord[]>();
  const runner = new BenchmarkRunner({
    chat,
    projection: opened.projection,
    store: opened.store,
    turnMetrics: { forThread: (threadId) => metrics.get(threadId) ?? [] },
    projectId: BENCHMARKS_PROJECT_ID,
    matchPattern: matcher,
    clock: () => clock.now,
    ...(options.timeoutMs === undefined ? {} : { turnTimeoutMs: options.timeoutMs }),
  });
  return { ...opened, chat, metrics, runner, clock };
}

function record(threadId: string, tokens: number): TurnMetricsRecord {
  return decodeTurnMetricsRecord({
    threadId,
    mode: "chat",
    providerInstanceId: benchmarkIds.providerA,
    modelId: "model-a",
    stopReason: "end-of-turn",
    usage: { inputTokens: tokens - 10, outputTokens: 10 },
    metrics: { precision: "unavailable", wallMs: 1_000 },
    startedAt: BENCHMARK_TEST_NOW,
    endedAt: BENCHMARK_TEST_NOW,
  });
}

function threadOf(cellId: string): string {
  return benchmarkCellIdentity(cellId).threadId;
}

describe("benchmark runner", () => {
  it("starts queued cells as turns in the Benchmarks Project on the contender's model and effort", async () => {
    const { store, chat, runner, projection } = setup();
    const run = sampleRun();
    store.runStarted({
      run: { ...run, contenders: [{ ...run.contenders[0]!, effort: "high" }] },
    });

    await runner.tick();

    const started = projection.run(benchmarkIds.run)!;
    expect(started.cells.map((cell) => cell.state)).toEqual(["running", "running"]);
    expect(chat.starts).toHaveLength(2);
    expect(chat.starts[0]).toMatchObject({
      projectId: BENCHMARKS_PROJECT_ID,
      providerInstanceId: benchmarkIds.providerA,
      modelId: "model-a",
      effort: "high",
      prompt: "Say hello.",
      title: "Smoke · Greeting · model-a",
    });
    expect(started.cells[0]?.threadId).toBe(threadOf(String(run.cells[0]!.cellId)));
    expect(chat.starts[0]?.submissionId).toBe(
      benchmarkCellIdentity(String(run.cells[0]!.cellId)).submissionId,
    );
  });

  it("settles a cell with its check results when the turn completes, then archives the thread", async () => {
    const { store, chat, runner, projection } = setup();
    const run = sampleRun();
    store.runStarted({ run });
    await runner.tick();
    const thread = threadOf(String(run.cells[0]!.cellId));
    chat.finish(thread, "Well, HELLO there");

    await runner.tick();

    const cell = projection.run(benchmarkIds.run)!.cells[0]!;
    expect(cell.state).toBe("answered");
    expect(cell.checks).toEqual([{ index: 0, passed: true }]);
    expect(chat.archived).toContain(thread);
  });

  it("finishes the run once every cell has settled", async () => {
    const { store, chat, runner, projection } = setup();
    const run = sampleRun();
    store.runStarted({ run });
    await runner.tick();
    for (const cell of run.cells) chat.finish(threadOf(String(cell.cellId)), "hello");
    await runner.tick();
    expect(projection.run(benchmarkIds.run)?.status).toBe("finished");
  });

  it("settles a cell failed with the refusal's sentence when Chat refuses the turn", async () => {
    const { store, chat, runner, projection } = setup();
    chat.startBehavior = () => ({
      status: "refused",
      message: "The Project spend ceiling is reached.",
    });
    store.runStarted({ run: sampleRun() });

    await runner.tick();

    const run = projection.run(benchmarkIds.run)!;
    expect(run.cells.map((cell) => cell.state)).toEqual(["failed", "failed"]);
    expect(run.cells[0]?.failureReason).toBe("The Project spend ceiling is reached.");
    expect(run.status).toBe("finished");
  });

  it("leaves a cell queued while Chat has no capacity for it yet", async () => {
    const { store, chat, runner, projection } = setup();
    chat.startBehavior = () => ({ status: "waiting", message: "Waiting for capacity." });
    store.runStarted({ run: sampleRun() });

    await runner.tick();

    const run = projection.run(benchmarkIds.run)!;
    expect(run.cells.map((cell) => cell.state)).toEqual(["queued", "queued"]);
    expect(run.status).toBe("running");
  });

  it("stops on the budget: queued cells are skipped and the run ends budget-reached", async () => {
    const { store, chat, runner, projection, metrics } = setup();
    const run = sampleRun({ repetitions: 3, budget: { maxTokens: 1_000 } });
    store.runStarted({ run });
    await runner.tick();
    const first = String(run.cells[0]!.cellId);
    const second = String(run.cells[1]!.cellId);
    metrics.set(threadOf(first), [record(threadOf(first), 900)]);
    metrics.set(threadOf(second), [record(threadOf(second), 900)]);
    chat.finish(threadOf(first), "hello");
    chat.finish(threadOf(second), "42");

    await runner.tick();

    const ended = projection.run(benchmarkIds.run)!;
    expect(ended.status).toBe("budget-reached");
    expect(ended.endReason).toContain("token budget");
    expect(ended.cells.filter((cell) => cell.state === "skipped-budget")).toHaveLength(4);
    expect(chat.starts).toHaveLength(2);
  });

  it("limits a provider instance to two running cells", async () => {
    const { store, chat, runner } = setup();
    store.runStarted({ run: sampleRun({ repetitions: 3 }) });
    await runner.tick();
    expect(chat.starts).toHaveLength(2);
  });

  it("resumes a running cell after a restart by waiting on the thread it already has", async () => {
    const { store, chat, projection, metrics, clock } = setup();
    const run = sampleRun();
    store.runStarted({ run });
    const first = new BenchmarkRunner({
      chat,
      projection,
      store,
      turnMetrics: { forThread: () => [] },
      projectId: BENCHMARKS_PROJECT_ID,
      matchPattern: matcher,
      clock: () => clock.now,
    });
    await first.tick();
    const startsBefore = chat.starts.length;
    chat.finish(threadOf(String(run.cells[0]!.cellId)), "hello");

    const restarted = new BenchmarkRunner({
      chat,
      projection,
      store,
      turnMetrics: { forThread: (id) => metrics.get(id) ?? [] },
      projectId: BENCHMARKS_PROJECT_ID,
      matchPattern: matcher,
      clock: () => clock.now,
    });
    await restarted.tick();

    const cells = projection.run(benchmarkIds.run)!.cells;
    expect(cells[0]?.state).toBe("answered");
    expect(cells[1]?.state).toBe("running");
    expect(chat.starts).toHaveLength(startsBefore);
  });

  it("interrupts a turn that runs past the time limit and settles it failed as timed out", async () => {
    const { store, chat, runner, projection, clock } = setup({ timeoutMs: 60_000 });
    const run = sampleRun();
    store.runStarted({ run });
    await runner.tick();
    clock.now = "2026-11-07T10:05:00.000Z";

    await runner.tick();

    const cell = projection.run(benchmarkIds.run)!.cells[0]!;
    expect(cell.state).toBe("failed");
    expect(cell.failureReason).toBe("timed out");
    expect(chat.interrupted).toContain(threadOf(String(run.cells[0]!.cellId)));
  });

  it("settles a Code case failed with the later-version reason and skips the judge", async () => {
    const { store, runner, projection, chat } = setup();
    const base = sampleSuite();
    const suite = sampleSuite({
      cases: [
        {
          caseId: benchmarkIds.caseA,
          kind: "code",
          title: "Fix",
          prompt: "Fix it.",
          checks: [{ kind: "max-files-changed", count: 2 }],
          code: { codeProjectId: "66400000-0000-4000-8000-000000000001", ref: "main" },
        },
      ],
    });
    expect(base.cases).toHaveLength(2);
    store.runStarted({ run: sampleRun({ suite }) });

    await runner.tick();

    const cell = projection.run(benchmarkIds.run)!.cells[0]!;
    expect(cell.state).toBe("failed");
    expect(cell.failureReason).toBe("Code cases arrive in a later version");
    expect(chat.starts).toHaveLength(0);
  });

  it("cancels a run: running turns are interrupted, queued cells cancelled, and the run ends cancelled", async () => {
    const { store, chat, runner, projection } = setup();
    const run = sampleRun({ repetitions: 3 });
    store.runStarted({ run });
    await runner.tick();

    const cancelled = await runner.cancel(benchmarkIds.run);

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cells.every((cell) => cell.state === "cancelled")).toBe(true);
    expect(chat.interrupted).toHaveLength(2);
    expect(projection.runningRuns()).toEqual([]);
  });

  it("fails a check whose pattern never returns within the deadline and still scores the other cells", async () => {
    const { store, chat, runner, projection } = setup();
    const suite = sampleSuite({
      cases: [
        {
          caseId: benchmarkIds.caseA,
          kind: "prompt",
          title: "Greeting",
          prompt: "Say hello.",
          checks: [{ kind: "matches", pattern: "(a+)+$", flags: "" }],
        },
        {
          caseId: benchmarkIds.caseB,
          kind: "prompt",
          title: "Number",
          prompt: "Say 42.",
          checks: [{ kind: "contains", text: "42", caseSensitive: true }],
        },
      ],
    });
    const run = sampleRun({ suite });
    store.runStarted({ run });
    await runner.tick();
    chat.finish(threadOf(String(run.cells[0]!.cellId)), `${"a".repeat(40)}!`);
    chat.finish(threadOf(String(run.cells[1]!.cellId)), "42");
    const began = Date.now();

    await runner.tick();

    expect(Date.now() - began).toBeLessThan(2_000);
    const cells = projection.run(benchmarkIds.run)!.cells;
    expect(cells[0]).toMatchObject({
      state: "answered",
      checks: [{ index: 0, passed: false, detail: "pattern took too long" }],
    });
    expect(cells[1]).toMatchObject({ state: "answered", checks: [{ index: 0, passed: true }] });
  });

  it("archives the threads of settled cells again when the host starts, including a cell that never recorded its thread", async () => {
    const { store, chat, runner } = setup();
    const run = sampleRun();
    store.runStarted({ run });
    store.cellSettled({
      runId: run.runId,
      cellId: run.cells[0]!.cellId,
      state: "failed",
      failureReason: "refused",
      checks: [],
      settledAt: BENCHMARK_TEST_NOW as never,
    });

    const stop = runner.start();
    await runner.tick();
    stop();

    expect(chat.archived).toContain(threadOf(String(run.cells[0]!.cellId)));
    expect(chat.archived).not.toContain(threadOf(String(run.cells[1]!.cellId)));
  });

  it("counts each cell started in a pass once when it projects the budget", async () => {
    const { store, chat, runner, projection, metrics } = setup();
    const run = sampleRun({ repetitions: 2, budget: { maxTokens: 400 } });
    store.runStarted({ run });
    await runner.tick();
    for (const cell of run.cells.slice(0, 2)) {
      const thread = threadOf(String(cell.cellId));
      metrics.set(thread, [record(thread, 100)]);
      chat.finish(thread, "hello");
    }

    await runner.tick();

    // 200 tokens spent over 2 cells, 100 each: two more cells project to 300 and 400, within 400.
    const cells = projection.run(benchmarkIds.run)!.cells;
    expect(cells.slice(2).map((cell) => cell.state)).toEqual(["running", "running"]);
    expect(chat.starts).toHaveLength(4);
  });

  it("puts a cell back to queued when Chat had no capacity for its attempt, then retries it on its own turn", async () => {
    const { store, chat, runner, projection } = setup();
    const run = sampleRun();
    store.runStarted({ run });
    await runner.tick();
    const thread = threadOf(String(run.cells[0]!.cellId));
    const turn = chat.turns.get(thread)!;
    turn.outcome = "interrupted";
    turn.failureCode = "capacity-unavailable";
    turn.failureMessage = "Waited for a free request slot.";

    await runner.tick();

    const requeued = projection.run(benchmarkIds.run)!.cells[0]!;
    expect(requeued.state).toBe("queued");
    expect(requeued.failureReason).toBeUndefined();
    expect(chat.starts).toHaveLength(2);

    await runner.tick();

    expect(projection.run(benchmarkIds.run)!.cells[0]?.state).toBe("running");
    expect(chat.starts).toHaveLength(3);
  });

  it("still fails a cell Chat interrupted for another reason, such as a spend ceiling", async () => {
    const { store, chat, runner, projection } = setup();
    const run = sampleRun();
    store.runStarted({ run });
    await runner.tick();
    const turn = chat.turns.get(threadOf(String(run.cells[0]!.cellId)))!;
    turn.outcome = "interrupted";
    turn.failureCode = "spend-ceiling-exhausted";
    turn.failureMessage = "The Project spend ceiling is reached.";

    await runner.tick();

    expect(projection.run(benchmarkIds.run)!.cells[0]).toMatchObject({
      state: "failed",
      failureReason: "The Project spend ceiling is reached.",
    });
  });
});

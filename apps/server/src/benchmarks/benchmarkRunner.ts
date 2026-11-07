import {
  BENCHMARK_FAILURE_REASON_CHARS,
  decodeUtcTimestamp,
  type BenchmarkCell,
  type BenchmarkRun,
  type BenchmarkSettledCellState,
  type ProjectId,
  type TurnMetricsRecord,
} from "@octant/contracts";
import {
  BENCHMARK_CONCURRENCY_LIMITS,
  benchmarkBudgetDecision,
  benchmarkCellMetrics,
  benchmarkRunStatusAfter,
  boundedBenchmarkReason,
  nextBenchmarkCells,
  scoreBenchmarkChecks,
  type BenchmarkPatternMatcher,
} from "@octant/domain";
import { deterministicUuid } from "../deterministicUuid";
import type { BenchmarkChatPort } from "./benchmarkChatPort";
import type { BenchmarkEventStore } from "./benchmarkEventStore";
import type { BenchmarkProjection } from "./benchmarkProjection";

export const BENCHMARK_TICK_MS = 2_000;
/** A turn still running after this long is interrupted and settles failed. */
export const BENCHMARK_TURN_TIMEOUT_MS = 30 * 60_000;

const CODE_CASES_LATER = "Code cases arrive in a later version";

export interface BenchmarkRunnerOptions {
  readonly chat: BenchmarkChatPort;
  readonly projection: Pick<BenchmarkProjection, "run" | "runs" | "runningRuns">;
  readonly store: Pick<BenchmarkEventStore, "cellStarted" | "cellSettled" | "runEnded">;
  readonly turnMetrics: {
    readonly forThread: (threadId: string) => ReadonlyArray<TurnMetricsRecord>;
  };
  readonly projectId: ProjectId;
  /** Tests a hand-written pattern under a deadline; the runner never matches one itself. */
  readonly matchPattern: BenchmarkPatternMatcher;
  readonly clock: () => string;
  readonly tickMs?: number;
  readonly turnTimeoutMs?: number;
}

/** The deterministic identities of one cell's thread and turn submission. */
export function benchmarkCellIdentity(cellId: string): {
  readonly threadId: string;
  readonly submissionId: string;
} {
  return {
    threadId: deterministicUuid(`benchmark-cell-thread:${cellId}`),
    submissionId: deterministicUuid(`benchmark-cell:${cellId}`),
  };
}

/**
 * Runs the cells of every running benchmark run. Each tick settles the cells
 * whose turns ended, decides whether the budget allows another cell, and
 * starts the cells the concurrency limits allow, as ordinary Chat turns in the
 * Benchmarks Project. It never bypasses Chat admission: a turn the host would
 * refuse a person is refused here, and a turn the capacity scheduler has no
 * room for yet leaves its cell queued.
 *
 * All state is in the journal. A restart resumes a running run from the
 * projection: a cell with a thread keeps waiting on it, and a cell without one
 * is still queued, so starting it again finds the thread and turn it may
 * already have created through their deterministic identities.
 */
export class BenchmarkRunner {
  readonly #options: BenchmarkRunnerOptions;
  readonly #starting = new Set<string>();
  #chain: Promise<unknown> = Promise.resolve();
  #tickPending = false;
  #stopped = false;

  constructor(options: BenchmarkRunnerOptions) {
    this.#options = options;
  }

  /** Starts ticking and resumes any running run now; the returned function stops it. */
  start(): () => void {
    this.#stopped = false;
    const timer = setInterval(() => void this.tick(), this.#options.tickMs ?? BENCHMARK_TICK_MS);
    timer.unref();
    void this.#exclusive(() => this.#archiveSettled()).catch(() => undefined);
    void this.tick();
    return () => {
      this.#stopped = true;
      clearInterval(timer);
    };
  }

  /** Asks for a pass soon, after a run is started. */
  kick(): void {
    void this.tick();
  }

  /** One pass. A pass already waiting makes another redundant; failures never reach the host. */
  async tick(): Promise<void> {
    if (this.#stopped || this.#tickPending) return;
    this.#tickPending = true;
    try {
      await this.#exclusive(() => this.#tick());
    } catch {
      // The next tick reads the journal again and carries on.
    } finally {
      this.#tickPending = false;
    }
  }

  /** Stops a run: running turns are interrupted, queued cells are cancelled, and the run ends. */
  cancel(runId: string): Promise<BenchmarkRun | undefined> {
    return this.#exclusive(() => this.#cancel(runId));
  }

  /**
   * A settled cell's thread is archived best effort, so a failed archive leaves
   * it active. Each start tries again for every settled cell, by the cell's
   * fixed thread identity, so a cell refused after its thread was made is
   * covered too. Archiving a thread that is gone or already archived does nothing.
   */
  async #archiveSettled(): Promise<void> {
    for (const run of this.#options.projection.runs()) {
      for (const cell of run.cells) {
        if (this.#stopped) return;
        if (cell.state === "queued" || cell.state === "running") continue;
        await this.#options.chat.archiveThread(benchmarkCellIdentity(String(cell.cellId)).threadId);
      }
    }
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(work, work);
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #tick(): Promise<void> {
    const runs = this.#options.projection.runningRuns();
    if (runs.length === 0) return;
    const counts = this.#runningCounts(runs);
    for (const { runId } of runs) {
      if (this.#stopped) return;
      await this.#advance(runId, counts);
    }
  }

  #runningCounts(runs: ReadonlyArray<BenchmarkRun>): {
    readonly byProvider: Map<string, number>;
    total: number;
  } {
    const byProvider = new Map<string, number>();
    let total = 0;
    for (const run of runs) {
      for (const cell of run.cells) {
        if (cell.state !== "running") continue;
        const provider = run.contenders[cell.contenderIndex]?.providerInstanceId;
        if (provider === undefined) continue;
        byProvider.set(String(provider), (byProvider.get(String(provider)) ?? 0) + 1);
        total += 1;
      }
    }
    return { byProvider, total };
  }

  async #advance(
    runId: string,
    counts: { readonly byProvider: Map<string, number>; total: number },
  ): Promise<void> {
    const initial = this.#options.projection.run(runId);
    if (initial === undefined) return;
    for (const cell of initial.cells) {
      if (cell.state !== "running") continue;
      const settled = await this.#reconcile(runId, String(cell.cellId));
      if (settled) {
        const provider = initial.contenders[cell.contenderIndex]?.providerInstanceId;
        if (provider !== undefined) {
          counts.byProvider.set(
            String(provider),
            Math.max(0, (counts.byProvider.get(String(provider)) ?? 0) - 1),
          );
          counts.total = Math.max(0, counts.total - 1);
        }
      }
    }
    await this.#startCells(runId, counts);
    this.#endIfDone(runId);
  }

  /** Settles a running cell whose turn ended. Returns whether the cell settled. */
  async #reconcile(runId: string, cellId: string): Promise<boolean> {
    const run = this.#options.projection.run(runId);
    const cell = run?.cells.find((candidate) => String(candidate.cellId) === cellId);
    if (run === undefined || cell === undefined || cell.state !== "running") return false;
    if (cell.threadId === undefined) return false;
    const { chat } = this.#options;
    const reading = chat.readTurn(cell.threadId, benchmarkCellIdentity(cellId).submissionId);
    if (reading.status === "gone") {
      this.#settle(run, cell, "failed", "The cell's thread is gone.");
      return true;
    }
    if (reading.status === "no-turn") {
      this.#settle(run, cell, "failed", "The cell's turn was lost.");
      await chat.archiveThread(cell.threadId);
      return true;
    }
    if (reading.outcome === "completed") {
      const answer = chat.readAnswer(cell.threadId, reading.turnId);
      const benchmarkCase = run.cases.find((candidate) => candidate.caseId === cell.caseId);
      if (answer === undefined || benchmarkCase === undefined) {
        this.#settle(run, cell, "failed", "The turn finished without an answer.");
      } else {
        this.#settle(
          run,
          cell,
          "answered",
          undefined,
          await scoreBenchmarkChecks(benchmarkCase.checks, answer, this.#options.matchPattern),
        );
      }
      await chat.archiveThread(cell.threadId);
      return true;
    }
    if (
      reading.outcome === "failed" ||
      reading.outcome === "interrupted" ||
      reading.outcome === "cancelled"
    ) {
      this.#settle(run, cell, "failed", reading.failureMessage ?? `The turn ${reading.outcome}.`);
      await chat.archiveThread(cell.threadId);
      return true;
    }
    const startedMs = cell.startedAt === undefined ? Number.NaN : Date.parse(cell.startedAt);
    const elapsed = Date.parse(this.#options.clock()) - startedMs;
    if (elapsed > (this.#options.turnTimeoutMs ?? BENCHMARK_TURN_TIMEOUT_MS)) {
      await chat.interruptTurn(cell.threadId, reading.turnId);
      this.#settle(run, cell, "failed", "timed out");
      await chat.archiveThread(cell.threadId);
      return true;
    }
    return false;
  }

  async #startCells(
    runId: string,
    counts: { readonly byProvider: Map<string, number>; total: number },
  ): Promise<void> {
    const run = this.#options.projection.run(runId);
    if (run === undefined || run.status !== "running") return;
    const candidates = nextBenchmarkCells(run, counts, BENCHMARK_CONCURRENCY_LIMITS);
    let startedNow = 0;
    for (const candidate of candidates) {
      const current = this.#options.projection.run(runId);
      if (current === undefined || current.status !== "running") return;
      const spent = this.#spent(current);
      const runningInRun =
        current.cells.filter((cell) => cell.state === "running").length + startedNow;
      const decision = benchmarkBudgetDecision(
        current.budget,
        { tokens: spent.tokens, costUsd: spent.costUsd },
        spent.measured,
        runningInRun,
      );
      if (decision.decision === "stop") {
        this.#skipQueued(current, decision.reason);
        return;
      }
      const outcome = await this.#startCell(current, candidate);
      if (outcome === "started") {
        startedNow += 1;
        const provider = current.contenders[candidate.contenderIndex]?.providerInstanceId;
        if (provider !== undefined) {
          counts.byProvider.set(
            String(provider),
            (counts.byProvider.get(String(provider)) ?? 0) + 1,
          );
          counts.total += 1;
        }
      } else if (outcome === "waiting") {
        // Capacity is full for every cell alike; the next tick tries again.
        return;
      }
    }
  }

  async #startCell(
    run: BenchmarkRun,
    cell: BenchmarkCell,
  ): Promise<"started" | "waiting" | "settled" | "skipped"> {
    const cellId = String(cell.cellId);
    if (this.#starting.has(cellId)) return "skipped";
    this.#starting.add(cellId);
    try {
      const contender = run.contenders[cell.contenderIndex];
      const benchmarkCase = run.cases.find((candidate) => candidate.caseId === cell.caseId);
      if (contender === undefined || benchmarkCase === undefined) {
        this.#settle(run, cell, "failed", "The cell's case or contender is missing.");
        return "settled";
      }
      if (benchmarkCase.kind === "code") {
        this.#settle(run, cell, "failed", CODE_CASES_LATER);
        return "settled";
      }
      const { threadId, submissionId } = benchmarkCellIdentity(cellId);
      const started = await this.#options.chat.startTurn({
        threadId,
        title: threadTitle(run.suiteName, benchmarkCase.title, String(contender.modelId)),
        projectId: this.#options.projectId,
        providerInstanceId: contender.providerInstanceId,
        modelId: contender.modelId,
        ...(contender.effort === undefined ? {} : { effort: contender.effort }),
        prompt: benchmarkCase.prompt,
        submissionId,
      });
      if (started.status === "waiting") return "waiting";
      if (started.status === "refused") {
        this.#settle(run, cell, "failed", started.message);
        await this.#options.chat.archiveThread(threadId);
        return "settled";
      }
      this.#options.store.cellStarted({
        runId: run.runId,
        cellId: cell.cellId,
        threadId,
        turnId: started.turnId,
        startedAt: decodeUtcTimestamp(this.#options.clock()),
      });
      return "started";
    } finally {
      this.#starting.delete(cellId);
    }
  }

  /** Tokens and cost of the cells that settled, and how many of them reported usage. */
  #spent(run: BenchmarkRun): { tokens: number; costUsd: number; measured: number } {
    let tokens = 0;
    let costUsd = 0;
    let measured = 0;
    for (const cell of run.cells) {
      if (cell.threadId === undefined) continue;
      if (cell.state === "queued" || cell.state === "running") continue;
      const record = this.#options.turnMetrics.forThread(cell.threadId).at(-1);
      if (record === undefined) continue;
      const metrics = benchmarkCellMetrics(record);
      if (metrics.totalTokens === undefined) continue;
      measured += 1;
      tokens += metrics.totalTokens;
      costUsd += metrics.costUsd ?? 0;
    }
    return { tokens, costUsd, measured };
  }

  #skipQueued(run: BenchmarkRun, reason: string): void {
    for (const cell of run.cells) {
      if (cell.state === "queued") this.#settle(run, cell, "skipped-budget", reason);
    }
  }

  #endIfDone(runId: string): void {
    const run = this.#options.projection.run(runId);
    if (run === undefined || run.status !== "running") return;
    if (benchmarkRunStatusAfter(run) !== "finished") return;
    const skipped = run.cells.find((cell) => cell.state === "skipped-budget");
    this.#options.store.runEnded({
      runId: run.runId,
      status: skipped === undefined ? "finished" : "budget-reached",
      ...(skipped?.failureReason === undefined ? {} : { endReason: skipped.failureReason }),
      endedAt: decodeUtcTimestamp(this.#options.clock()),
    });
  }

  async #cancel(runId: string): Promise<BenchmarkRun | undefined> {
    const run = this.#options.projection.run(runId);
    if (run === undefined || run.status !== "running") return run;
    for (const cell of run.cells) {
      if (cell.state !== "running") continue;
      const settled = await this.#reconcile(runId, String(cell.cellId));
      if (settled) continue;
      const current = this.#options.projection.run(runId);
      const live = current?.cells.find((candidate) => candidate.cellId === cell.cellId);
      if (current === undefined || live === undefined || live.state !== "running") continue;
      if (live.threadId !== undefined) {
        const reading = this.#options.chat.readTurn(
          live.threadId,
          benchmarkCellIdentity(String(live.cellId)).submissionId,
        );
        if (reading.status === "turn") {
          await this.#options.chat.interruptTurn(live.threadId, reading.turnId);
        }
        await this.#options.chat.archiveThread(live.threadId);
      }
      this.#settle(current, live, "cancelled", "Cancelled by a person.");
    }
    const latest = this.#options.projection.run(runId);
    if (latest !== undefined) {
      for (const cell of latest.cells) {
        if (cell.state === "queued")
          this.#settle(latest, cell, "cancelled", "Cancelled by a person.");
      }
    }
    this.#options.store.runEnded({
      runId: run.runId,
      status: "cancelled",
      endReason: "Cancelled by a person.",
      endedAt: decodeUtcTimestamp(this.#options.clock()),
    });
    return this.#options.projection.run(runId);
  }

  #settle(
    run: BenchmarkRun,
    cell: BenchmarkCell,
    state: BenchmarkSettledCellState,
    failureReason?: string,
    checks: BenchmarkCell["checks"] = [],
  ): void {
    this.#options.store.cellSettled({
      runId: run.runId,
      cellId: cell.cellId,
      state,
      ...(failureReason === undefined
        ? {}
        : { failureReason: boundedBenchmarkReason(failureReason, BENCHMARK_FAILURE_REASON_CHARS) }),
      checks,
      settledAt: decodeUtcTimestamp(this.#options.clock()),
    });
  }
}

function threadTitle(suiteName: string, caseTitle: string, modelId: string): string {
  return boundedBenchmarkReason(`${suiteName} · ${caseTitle} · ${modelId}`, 200);
}

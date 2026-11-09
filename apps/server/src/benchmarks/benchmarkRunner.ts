import {
  BENCHMARK_FAILURE_REASON_CHARS,
  BENCHMARK_JUDGE_REASON_CHARS,
  decodeUtcTimestamp,
  type BenchmarkCell,
  type BenchmarkRun,
  type BenchmarkCheckResult,
  type BenchmarkSettledCellState,
  type PermissionMode,
  type ProjectId,
  type TurnMetricsRecord,
} from "@octant/contracts";
import {
  BENCHMARK_APPROVAL_WAIT_MS,
  BENCHMARK_COMMAND_MAX_SECONDS,
  BENCHMARK_CONCURRENCY_LIMITS,
  benchmarkBudgetDecision,
  benchmarkCellMetrics,
  benchmarkCheckDescription,
  benchmarkCodeBranch,
  benchmarkCommandResult,
  benchmarkExecutionLevel,
  benchmarkFilesChangedResult,
  isBenchmarkCodeOnlyCheck,
  benchmarkCellsOwingJudgement,
  benchmarkJudgePrompt,
  benchmarkOverhead,
  benchmarkRunStatusAfter,
  boundedBenchmarkReason,
  nextBenchmarkCells,
  nextBenchmarkJudgements,
  parseBenchmarkJudgeReply,
  scoreBenchmarkChecks,
  type BenchmarkPatternMatcher,
} from "@octant/domain";
import { deterministicUuid } from "../deterministicUuid";
import { CAPACITY_UNAVAILABLE_FAILURE_CODE, type BenchmarkChatPort } from "./benchmarkChatPort";
import type { BenchmarkCheckCommandPort, BenchmarkCheckSession } from "./benchmarkCheckCommand";
import type { BenchmarkCodePort, BenchmarkCodeResult } from "./benchmarkCodePort";
import type { BenchmarkEventStore } from "./benchmarkEventStore";
import type { BenchmarkProjection } from "./benchmarkProjection";

export const BENCHMARK_TICK_MS = 2_000;
/** How long stopping waits for aborted check commands to end. */
export const BENCHMARK_STOP_WAIT_MS = 5_000;
/** A turn still running after this long is interrupted and settles failed. */
export const BENCHMARK_TURN_TIMEOUT_MS = 30 * 60_000;

const CODE_UNAVAILABLE = "Code cases cannot run on this host.";

export interface BenchmarkRunnerOptions {
  readonly chat: BenchmarkChatPort;
  readonly projection: Pick<BenchmarkProjection, "run" | "runs" | "runningRuns">;
  readonly store: Pick<
    BenchmarkEventStore,
    "cellStarted" | "cellRequeued" | "cellSettled" | "cellJudged" | "runEnded"
  >;
  readonly turnMetrics: {
    readonly forThread: (threadId: string) => ReadonlyArray<TurnMetricsRecord>;
  };
  readonly projectId: ProjectId;
  /** Code cells; absent where the host cannot run them, and they then fail with a sentence. */
  readonly code?: BenchmarkCodePort;
  /** Runs a Code case's check commands in the cell's worktree, confined. */
  readonly checkCommand?: BenchmarkCheckCommandPort;
  /** The mode a new thread in this Code Project starts in; absent when it is not an active Code Project. */
  readonly projectMode?: (projectId: ProjectId) => PermissionMode | undefined;
  /** How long a turn may wait on an approval before its cell is blocked. */
  readonly approvalWaitMs?: number;
  /** Tests a hand-written pattern under a deadline; the runner never matches one itself. */
  readonly matchPattern: BenchmarkPatternMatcher;
  readonly clock: () => string;
  readonly tickMs?: number;
  readonly turnTimeoutMs?: number;
  readonly stopWaitMs?: number;
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
 * The deterministic identities of one cell's judge thread and turn submission.
 * They are derived from the cell id alone, so a restart finds the judge turn it
 * already started, and a purge finds the thread even when no event names it.
 */
export function benchmarkJudgeIdentity(cellId: string): {
  readonly threadId: string;
  readonly submissionId: string;
} {
  return {
    threadId: deterministicUuid(`benchmark-judge-thread:${cellId}`),
    submissionId: deterministicUuid(`benchmark-judge:${cellId}`),
  };
}

/** A judge turn that ended, one way or another, has nothing left to wait for. */
function turnEnded(outcome: string): boolean {
  return (
    outcome === "completed" ||
    outcome === "failed" ||
    outcome === "interrupted" ||
    outcome === "cancelled"
  );
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
 *
 * When the run's suite names a judge, an answered cell then owes a score. The
 * judge is one more Chat turn in the same Project, on the judge's own model,
 * started under the same concurrency limits and found again after a restart by
 * its own deterministic identity. The run is not finished until every judgement
 * it owes has settled.
 */
export class BenchmarkRunner {
  readonly #options: BenchmarkRunnerOptions;
  readonly #starting = new Set<string>();
  /** When a judge turn was first seen running, for its time limit; a restart starts the clock again. */
  readonly #judgeSeen = new Map<string, number>();
  /** Cells put back to queued in this pass; they wait for the next tick to try again. */
  readonly #requeued = new Set<string>();
  /** When this process first saw a Code turn park on an approval nothing journaled dated. */
  readonly #approvalSince = new Map<string, number>();
  /** What a Code turn was last seen waiting on, so a turn that ends while parked ends the cell as blocked. */
  readonly #approvalSeen = new Map<string, string>();
  /** Code cells this process has already read once; a first sight says nothing about how long a wait has lasted. */
  readonly #sighted = new Set<string>();
  /** Check commands running in the background for Code cells whose turns finished. */
  readonly #checking = new Map<
    string,
    {
      readonly controller: AbortController;
      done: Promise<void>;
      result?: { readonly checks: ReadonlyArray<BenchmarkCheckResult> };
    }
  >();
  #chain: Promise<unknown> = Promise.resolve();
  #tickPending = false;
  #stopped = false;

  constructor(options: BenchmarkRunnerOptions) {
    this.#options = options;
  }

  /**
   * Starts ticking and resumes any running run now. The returned function stops
   * it: it aborts every check command still running, which makes the confined
   * port end each command's process group, waits a bounded time for them to end,
   * and resolves. No further command of a check sequence starts after the abort.
   */
  start(): () => Promise<void> {
    this.#stopped = false;
    const timer = setInterval(() => void this.tick(), this.#options.tickMs ?? BENCHMARK_TICK_MS);
    timer.unref();
    void this.#exclusive(async () => {
      // No check is running when the host starts, so any private folder a crash
      // left behind is stale.
      const checks = this.#options.checkCommand;
      if (checks?.sweep !== undefined) await checks.sweep().catch(() => undefined);
      await this.#archiveSettled();
    }).catch(() => undefined);
    void this.tick();
    return async () => {
      this.#stopped = true;
      clearInterval(timer);
      const running = [...this.#checking.values()];
      for (const entry of running) entry.controller.abort();
      if (running.length > 0) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled(running.map((entry) => entry.done)),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, this.#options.stopWaitMs ?? BENCHMARK_STOP_WAIT_MS);
            deadline.unref();
          }),
        ]);
        if (deadline !== undefined) clearTimeout(deadline);
      }
      // Whatever those commands reported was cut short; a later start checks again.
      this.#checking.clear();
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
        await this.#archiveCell(run, cell);
        // A judge still owed (for instance waiting to retry for capacity) stays
        // active: Chat refuses to retry on an archived thread.
        const judgeSettled = run.status !== "running" || cell.judge !== undefined;
        if (run.judge !== undefined && cell.state === "answered" && judgeSettled) {
          await this.#options.chat.archiveThread(
            benchmarkJudgeIdentity(String(cell.cellId)).threadId,
          );
        }
      }
    }
  }

  /** Archives a settled cell's thread through the port of its own mode. */
  async #archiveCell(run: BenchmarkRun, cell: BenchmarkCell): Promise<void> {
    const threadId = benchmarkCellIdentity(String(cell.cellId)).threadId;
    const benchmarkCase = run.cases.find((candidate) => candidate.caseId === cell.caseId);
    if (benchmarkCase?.kind === "code") await this.#options.code?.archiveThread(threadId);
    else await this.#options.chat.archiveThread(threadId);
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
    this.#requeued.clear();
    for (const { runId } of runs) {
      if (this.#stopped) return;
      await this.#advance(runId, counts);
    }
  }

  /** Whether the judge turn of this cell is started and has not ended. */
  #judgeInFlight(cellId: string): boolean {
    const reading = this.#options.chat.readTurn(
      benchmarkJudgeIdentity(cellId).threadId,
      benchmarkJudgeIdentity(cellId).submissionId,
    );
    return reading.status === "turn" && !turnEnded(reading.outcome);
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
      // A judge turn in flight takes the same room a contender's cell does.
      if (run.judge === undefined) continue;
      const judgeProvider = String(run.judge.providerInstanceId);
      for (const cell of benchmarkCellsOwingJudgement(run)) {
        if (!this.#judgeInFlight(String(cell.cellId))) continue;
        byProvider.set(judgeProvider, (byProvider.get(judgeProvider) ?? 0) + 1);
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
    await this.#judge(runId, counts);
    await this.#startCells(runId, counts);
    this.#endIfDone(runId);
  }

  /**
   * Settles the judgements whose turns ended, then starts the owed ones the
   * limits allow. Each runs on the judge's thread, which the cell's identity
   * fixes, so a judge turn begun before a restart is waited on, not repeated.
   */
  async #judge(
    runId: string,
    counts: { readonly byProvider: Map<string, number>; total: number },
  ): Promise<void> {
    const run = this.#options.projection.run(runId);
    if (run?.judge === undefined || run.status !== "running") return;
    const judgeProvider = String(run.judge.providerInstanceId);
    const inFlight = new Set<string>();
    for (const cell of benchmarkCellsOwingJudgement(run)) {
      const cellId = String(cell.cellId);
      // Only a turn that was counted as running frees a place when it settles.
      const counted = this.#judgeInFlight(cellId);
      const outcome = await this.#reconcileJudge(run, cell);
      if (outcome === "running") inFlight.add(cellId);
      if (outcome === "settled" && counted) {
        counts.byProvider.set(
          judgeProvider,
          Math.max(0, (counts.byProvider.get(judgeProvider) ?? 0) - 1),
        );
        counts.total = Math.max(0, counts.total - 1);
      }
    }
    const current = this.#options.projection.run(runId);
    if (current === undefined || current.status !== "running") return;
    for (const cell of nextBenchmarkJudgements(current, inFlight, counts)) {
      const outcome = await this.#startJudge(current, cell);
      if (outcome === "started") {
        counts.byProvider.set(judgeProvider, (counts.byProvider.get(judgeProvider) ?? 0) + 1);
        counts.total += 1;
      } else if (outcome === "waiting") {
        return;
      }
    }
  }

  /**
   * Records the judgement of a cell whose judge turn ended. A turn still running
   * past the time limit is interrupted and judged failed.
   */
  async #reconcileJudge(
    run: BenchmarkRun,
    cell: BenchmarkCell,
  ): Promise<"running" | "settled" | "not-started"> {
    const cellId = String(cell.cellId);
    const { chat } = this.#options;
    const { threadId, submissionId } = benchmarkJudgeIdentity(cellId);
    const reading = chat.readTurn(threadId, submissionId);
    if (reading.status !== "turn") return "not-started";
    // Chat had no room for the judge's attempt: ask again on the same turn later
    // rather than recording a failed judgement for a lack of capacity.
    if (
      reading.outcome === "interrupted" &&
      reading.failureCode === CAPACITY_UNAVAILABLE_FAILURE_CODE
    ) {
      return "not-started";
    }
    if (reading.outcome === "completed") {
      const reply = chat.readAnswer(threadId, reading.turnId);
      const parsed = reply === undefined ? undefined : parseBenchmarkJudgeReply(reply);
      this.#recordJudgement(
        run,
        cell,
        parsed === undefined || parsed.status === "failed"
          ? {
              status: "failed",
              reason: parsed?.reason ?? "The judge did not answer in the expected form",
            }
          : {
              status: "scored",
              score: parsed.score,
              reason: parsed.reason,
              judgeThreadId: threadId,
            },
      );
      await chat.archiveThread(threadId);
      return "settled";
    }
    if (turnEnded(reading.outcome)) {
      this.#recordJudgement(run, cell, {
        status: "failed",
        reason: boundedBenchmarkReason(
          reading.failureMessage ?? `The judge's turn ${reading.outcome}.`,
          BENCHMARK_JUDGE_REASON_CHARS,
        ),
      });
      await chat.archiveThread(threadId);
      return "settled";
    }
    const seen = this.#judgeSeen.get(cellId) ?? Date.parse(this.#options.clock());
    this.#judgeSeen.set(cellId, seen);
    if (
      Date.parse(this.#options.clock()) - seen >
      (this.#options.turnTimeoutMs ?? BENCHMARK_TURN_TIMEOUT_MS)
    ) {
      await chat.interruptTurn(threadId, reading.turnId);
      this.#recordJudgement(run, cell, { status: "failed", reason: "The judge timed out" });
      await chat.archiveThread(threadId);
      return "settled";
    }
    return "running";
  }

  async #startJudge(
    run: BenchmarkRun,
    cell: BenchmarkCell,
  ): Promise<"started" | "waiting" | "settled"> {
    const { chat } = this.#options;
    const judge = run.judge;
    const benchmarkCase = run.cases.find((candidate) => candidate.caseId === cell.caseId);
    const isCode = benchmarkCase?.kind === "code";
    const candidate =
      cell.threadId === undefined || isCode
        ? undefined
        : this.#candidateAnswer(cell.threadId, String(cell.cellId));
    const codeResult =
      cell.threadId === undefined || !isCode || this.#options.code === undefined
        ? undefined
        : await this.#options.code.readResult(
            cell.threadId,
            benchmarkCellIdentity(String(cell.cellId)).submissionId,
          );
    if (
      judge === undefined ||
      benchmarkCase === undefined ||
      (isCode ? codeResult === undefined : candidate === undefined)
    ) {
      this.#recordJudgement(run, cell, {
        status: "failed",
        reason: "The answer to judge could not be read",
      });
      return "settled";
    }
    const { threadId, submissionId } = benchmarkJudgeIdentity(String(cell.cellId));
    const started = await chat.startTurn({
      threadId,
      // The title never names the contender, so nothing about it reaches the judge.
      title: boundedBenchmarkReason(`Judge · ${run.suiteName} · ${benchmarkCase.title}`, 200),
      projectId: this.#options.projectId,
      providerInstanceId: judge.providerInstanceId,
      modelId: judge.modelId,
      prompt: benchmarkJudgePrompt({
        rubric: judge.rubric,
        casePrompt: benchmarkCase.prompt,
        referenceAnswer: benchmarkCase.referenceAnswer,
        // A Code cell has no answer to read: the judge gets the change and the checks.
        ...(codeResult === undefined
          ? { candidateAnswer: candidate }
          : {
              code: {
                diff: codeResult.diff,
                checks: cell.checks.flatMap((result) => {
                  const check = benchmarkCase.checks[result.index];
                  return check === undefined
                    ? []
                    : [
                        {
                          description: benchmarkCheckDescription(check),
                          passed: result.passed,
                          detail: result.detail,
                        },
                      ];
                }),
              },
            }),
      }),
      submissionId,
    });
    if (started.status === "waiting") return "waiting";
    if (started.status === "refused") {
      this.#recordJudgement(run, cell, {
        status: "failed",
        reason: boundedBenchmarkReason(started.message, BENCHMARK_JUDGE_REASON_CHARS),
      });
      await chat.archiveThread(threadId);
      return "settled";
    }
    this.#judgeSeen.set(String(cell.cellId), Date.parse(this.#options.clock()));
    return "started";
  }

  /** The cell's answer, read again from its own (archived) thread so a restart can judge it. */
  #candidateAnswer(cellThreadId: string, cellId: string): string | undefined {
    const { chat } = this.#options;
    const reading = chat.readTurn(cellThreadId, benchmarkCellIdentity(cellId).submissionId);
    return reading.status === "turn" ? chat.readAnswer(cellThreadId, reading.turnId) : undefined;
  }

  #recordJudgement(
    run: BenchmarkRun,
    cell: BenchmarkCell,
    judge: NonNullable<BenchmarkCell["judge"]>,
  ): void {
    this.#judgeSeen.delete(String(cell.cellId));
    this.#options.store.cellJudged({ runId: run.runId, cellId: cell.cellId, judge });
  }

  /** Tokens and cost of the judge turns so far, kept apart from every contender. */
  #overhead(run: BenchmarkRun): { tokens: number; costUsd: number } {
    if (run.judge === undefined) return { tokens: 0, costUsd: 0 };
    const turns = run.cells.flatMap((cell) => {
      const record = this.#options.turnMetrics
        .forThread(benchmarkJudgeIdentity(String(cell.cellId)).threadId)
        .at(-1);
      return record === undefined ? [] : [benchmarkCellMetrics(record)];
    });
    return benchmarkOverhead(turns);
  }

  /** Settles a running cell whose turn ended. Returns whether the cell settled. */
  async #reconcile(runId: string, cellId: string): Promise<boolean> {
    const run = this.#options.projection.run(runId);
    const cell = run?.cells.find((candidate) => String(candidate.cellId) === cellId);
    if (run === undefined || cell === undefined || cell.state !== "running") return false;
    if (cell.threadId === undefined) return false;
    const reconcileCase = run.cases.find((candidate) => candidate.caseId === cell.caseId);
    if (reconcileCase?.kind === "code") return this.#reconcileCode(run, cell, reconcileCase);
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
      reading.outcome === "interrupted" &&
      reading.failureCode === CAPACITY_UNAVAILABLE_FAILURE_CODE
    ) {
      // Chat had no room for the attempt. The cell goes back to queued and is
      // retried on its existing turn at a later tick, never failed for it.
      this.#options.store.cellRequeued({ runId: run.runId, cellId: cell.cellId });
      this.#requeued.add(cellId);
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
    for (const candidate of candidates) {
      if (this.#requeued.has(String(candidate.cellId))) continue;
      const current = this.#options.projection.run(runId);
      if (current === undefined || current.status !== "running") return;
      const spent = this.#spent(current);
      // A cell started earlier in this pass is already running in `current`.
      const runningInRun = current.cells.filter((cell) => cell.state === "running").length;
      const decision = benchmarkBudgetDecision(
        current.budget,
        { tokens: spent.tokens, costUsd: spent.costUsd },
        spent.measured,
        runningInRun,
        this.#overhead(current),
      );
      if (decision.decision === "stop") {
        this.#skipQueued(current, decision.reason);
        return;
      }
      const outcome = await this.#startCell(current, candidate);
      if (outcome === "started") {
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
        return await this.#startCodeCell(run, cell, contender, benchmarkCase);
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

  async #startCodeCell(
    run: BenchmarkRun,
    cell: BenchmarkCell,
    contender: BenchmarkRun["contenders"][number],
    benchmarkCase: BenchmarkRun["cases"][number],
  ): Promise<"started" | "waiting" | "settled"> {
    const { code } = this.#options;
    const target = benchmarkCase.code;
    if (code === undefined || target === undefined || this.#options.projectMode === undefined) {
      this.#settle(run, cell, "failed", CODE_UNAVAILABLE);
      return "settled";
    }
    const projectMode = this.#options.projectMode(target.codeProjectId);
    if (projectMode === undefined) {
      this.#settle(run, cell, "failed", "The Code Project is gone or is no longer a Code Project.");
      return "settled";
    }
    // The Project's own level is a ceiling, as for a routine, and Full access
    // is never reached by a pick alone; start already refused such a run.
    const level = benchmarkExecutionLevel(run.executionLevel, projectMode);
    if (level.status === "refused") {
      this.#settle(run, cell, "failed", level.message);
      return "settled";
    }
    const cellId = String(cell.cellId);
    const { threadId, submissionId } = benchmarkCellIdentity(cellId);
    const pinnedCommit = run.codeCommits?.find(
      (pin) => pin.caseId === benchmarkCase.caseId,
    )?.commit;
    const started = await code.startTurn({
      threadId,
      title: threadTitle(run.suiteName, benchmarkCase.title, String(contender.modelId)),
      codeProjectId: target.codeProjectId,
      ref: target.ref,
      // Every cell of the case starts from the commit the run pinned at start.
      ...(pinnedCommit === undefined ? {} : { commit: pinnedCommit }),
      branch: benchmarkCodeBranch(String(run.runId), cellId),
      providerInstanceId: contender.providerInstanceId,
      modelId: contender.modelId,
      ...(contender.effort === undefined ? {} : { effort: contender.effort }),
      prompt: benchmarkCase.prompt,
      submissionId,
      executionPolicy: level.executionPolicy,
      autoApprove: level.autoApprove,
    });
    if (started.status === "waiting") return "waiting";
    if (started.status === "refused") {
      this.#settle(run, cell, "failed", started.message);
      await code.archiveThread(threadId);
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
  }

  /**
   * Settles a running Code cell. A finished turn hands its checks to a
   * background run, because a check command may take minutes and must not hold
   * the other cells; the cell settles on a later pass once they are done. A
   * turn parked on an approval past the limit is interrupted and blocked.
   */
  async #reconcileCode(
    run: BenchmarkRun,
    cell: BenchmarkCell,
    benchmarkCase: BenchmarkRun["cases"][number],
  ): Promise<boolean> {
    const { code } = this.#options;
    const threadId = cell.threadId;
    if (code === undefined || threadId === undefined) return false;
    const cellId = String(cell.cellId);
    const submissionId = benchmarkCellIdentity(cellId).submissionId;
    const pending = this.#checking.get(cellId);
    if (pending !== undefined) {
      if (pending.result === undefined) return false;
      this.#checking.delete(cellId);
      this.#settle(run, cell, "answered", undefined, pending.result.checks);
      await code.archiveThread(threadId);
      return true;
    }
    const reading = await code.readTurn(threadId, submissionId);
    if (reading.status === "gone") {
      this.#settle(run, cell, "failed", "The cell's thread is gone.");
      return true;
    }
    if (reading.status === "no-turn") {
      this.#settle(run, cell, "failed", "The cell's turn was lost.");
      await code.archiveThread(threadId);
      return true;
    }
    if (reading.state === "completed") {
      this.#approvalSince.delete(cellId);
      const controller = new AbortController();
      const entry: {
        readonly controller: AbortController;
        done: Promise<void>;
        result?: { readonly checks: ReadonlyArray<BenchmarkCheckResult> };
      } = { controller, done: Promise.resolve() };
      this.#checking.set(cellId, entry);
      entry.done = this.#codeChecks(cell, benchmarkCase, controller.signal).then(
        (checks) => {
          entry.result = { checks };
        },
        () => {
          entry.result = {
            checks: [{ index: 0, passed: false, detail: "The checks could not be run." }],
          };
        },
      );
      return false;
    }
    if (reading.state === "interrupted" || reading.state === "failed") {
      this.#approvalSince.delete(cellId);
      // A turn that ends while an approval waits (a provider-inactivity timeout,
      // an interrupt) was blocked by it, not broken: say so, with what it asked.
      const waitedOn = this.#approvalSeen.get(cellId);
      this.#approvalSeen.delete(cellId);
      if (waitedOn !== undefined) {
        this.#settle(
          run,
          cell,
          "blocked-on-approval",
          `The turn ended while waiting for an approval nobody gave: ${waitedOn}`,
        );
      } else {
        this.#settle(run, cell, "failed", reading.failureMessage ?? `The turn ${reading.state}.`);
      }
      await code.archiveThread(threadId);
      return true;
    }
    const now = Date.parse(this.#options.clock());
    const startedMs = cell.startedAt === undefined ? Number.NaN : Date.parse(cell.startedAt);
    if (reading.awaitingApproval) {
      this.#approvalSeen.set(cellId, reading.approvalSummary ?? "a request for approval");
      // The wait began when the journal says the approval was asked. Without
      // that, a turn this process saw run and then park is timed from the
      // moment it parked; one first met already parked (after a restart) is
      // timed from the cell's start, an upper bound, so a restart never grants
      // another ten minutes.
      const journaled =
        reading.waitingSince === undefined ? Number.NaN : Date.parse(reading.waitingSince);
      const since = Number.isNaN(journaled)
        ? (this.#approvalSince.get(cellId) ?? (this.#sighted.has(cellId) ? now : startedMs))
        : journaled;
      if (Number.isNaN(journaled)) this.#approvalSince.set(cellId, since);
      if (now - since >= (this.#options.approvalWaitMs ?? BENCHMARK_APPROVAL_WAIT_MS)) {
        this.#approvalSince.delete(cellId);
        const asked = this.#approvalSeen.get(cellId);
        this.#approvalSeen.delete(cellId);
        await code.interruptTurn(threadId, submissionId);
        this.#settle(
          run,
          cell,
          "blocked-on-approval",
          `The turn waited 10 minutes for an approval nobody gave${asked === undefined ? "." : `: ${asked}`}`,
        );
        await code.archiveThread(threadId);
        return true;
      }
    } else {
      this.#approvalSince.delete(cellId);
      this.#approvalSeen.delete(cellId);
    }
    this.#sighted.add(cellId);
    if (now - startedMs > (this.#options.turnTimeoutMs ?? BENCHMARK_TURN_TIMEOUT_MS)) {
      await code.interruptTurn(threadId, submissionId);
      this.#settle(run, cell, "failed", "timed out");
      await code.archiveThread(threadId);
      return true;
    }
    return false;
  }

  /**
   * Scores a finished Code turn: the answer-text checks on its reply, the file
   * count from what the host observed, and each command in the cell's worktree
   * through the confined shell. Results keep the case's own order.
   */
  async #codeChecks(
    cell: BenchmarkCell,
    benchmarkCase: BenchmarkRun["cases"][number],
    signal: AbortSignal,
  ): Promise<ReadonlyArray<BenchmarkCheckResult>> {
    const { code, checkCommand } = this.#options;
    const result: BenchmarkCodeResult =
      code === undefined || cell.threadId === undefined
        ? { reply: undefined, diff: undefined }
        : await code.readResult(
            cell.threadId,
            benchmarkCellIdentity(String(cell.cellId)).submissionId,
          );
    const results: BenchmarkCheckResult[] = [
      ...(await scoreBenchmarkChecks(
        benchmarkCase.checks,
        result.reply ?? "",
        this.#options.matchPattern,
      )),
    ];
    // One private folder serves the whole sequence and is removed after it,
    // however it ends: finished, aborted by a stop or a cancel, or failed.
    let session: BenchmarkCheckSession | undefined;
    try {
      for (const [index, check] of benchmarkCase.checks.entries()) {
        if (!isBenchmarkCodeOnlyCheck(check)) continue;
        if (check.kind === "max-files-changed") {
          results.push(benchmarkFilesChangedResult(index, check.count, result.diff?.total));
          continue;
        }
        if (check.kind !== "command-exits-zero") continue;
        // Once stopped or cancelled, no further command of the sequence starts.
        if (signal.aborted) {
          results.push(
            benchmarkCommandResult(index, {
              status: "unavailable",
              message: "The check was cancelled.",
            }),
          );
          continue;
        }
        const root =
          code === undefined || cell.threadId === undefined
            ? undefined
            : await code.worktreeRoot(cell.threadId);
        if (checkCommand === undefined || root === undefined) {
          results.push(
            benchmarkCommandResult(index, {
              status: "unavailable",
              message:
                checkCommand === undefined
                  ? "Check commands cannot run on this host."
                  : "The cell's worktree is not available.",
            }),
          );
          continue;
        }
        if (session === undefined) {
          try {
            session = await checkCommand.open();
          } catch {
            results.push(
              benchmarkCommandResult(index, {
                status: "unavailable",
                message: "The check's private folder could not be made.",
              }),
            );
            continue;
          }
        }
        results.push(
          benchmarkCommandResult(
            index,
            await session.run({
              command: check.command,
              cwd: root,
              timeoutMs: Math.min(check.timeoutSeconds, BENCHMARK_COMMAND_MAX_SECONDS) * 1_000,
              signal,
            }),
          ),
        );
      }
    } finally {
      await session?.close().catch(() => undefined);
    }
    return results.sort((a, b) => a.index - b.index);
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
      const liveCase = current.cases.find((candidate) => candidate.caseId === live.caseId);
      if (live.threadId !== undefined && liveCase?.kind === "code") {
        this.#checking.get(String(live.cellId))?.controller.abort();
        this.#checking.delete(String(live.cellId));
        this.#approvalSince.delete(String(live.cellId));
        this.#approvalSeen.delete(String(live.cellId));
        await this.#options.code?.interruptTurn(
          live.threadId,
          benchmarkCellIdentity(String(live.cellId)).submissionId,
        );
        await this.#options.code?.archiveThread(live.threadId);
      } else if (live.threadId !== undefined) {
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
    // A judge turn in flight for an answered cell keeps spending unless it is stopped.
    for (const cell of benchmarkCellsOwingJudgement(run)) {
      const { threadId, submissionId } = benchmarkJudgeIdentity(String(cell.cellId));
      const reading = this.#options.chat.readTurn(threadId, submissionId);
      if (reading.status === "turn" && !turnEnded(reading.outcome)) {
        await this.#options.chat.interruptTurn(threadId, reading.turnId);
      }
      await this.#options.chat.archiveThread(threadId);
      this.#judgeSeen.delete(String(cell.cellId));
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

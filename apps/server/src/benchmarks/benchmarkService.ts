import {
  MAX_BENCHMARK_CELLS,
  decodeBenchmarkCellId,
  decodeBenchmarkRun,
  decodeBenchmarkRunId,
  decodeBenchmarkSuite,
  decodeUtcTimestamp,
  type BenchmarkCellMetrics,
  type BenchmarkCellRateRequest,
  type BenchmarkRating,
  type BenchmarkRun,
  type BenchmarkRunCancelRequest,
  type BenchmarkRunPurgeRequest,
  type BenchmarkRunReadRequest,
  type BenchmarkRunReadResponse,
  type BenchmarkRunsListRequest,
  type BenchmarkRunsListResponse,
  type BenchmarkRunStartRequest,
  type BenchmarkSuite,
  type BenchmarkSuiteDeleteRequest,
  type BenchmarkSuiteSaveRequest,
  type PermissionMode,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderModelId,
  type TurnMetricsRecord,
  type WindowId,
} from "@octant/contracts";
import {
  benchmarkCellCount,
  benchmarkCodeBranch,
  benchmarkExecutionLevel,
  benchmarkCellMetrics,
  benchmarkLeaderboard,
  benchmarkOverhead,
  planBenchmarkCells,
  summarizeBenchmarkRun,
} from "@octant/domain";
import type { BenchmarkEventStore } from "./benchmarkEventStore";
import { benchmarkCellIdentity, benchmarkJudgeIdentity } from "./benchmarkRunner";
import type { BenchmarkProjection } from "./benchmarkProjection";

/** A refusal is a value the route answers with its own status. */
export type BenchmarkRefusal = {
  readonly status: "refused";
  readonly reason: "not-found" | "conflict" | "invalid" | "unavailable";
  readonly message: string;
};
export type BenchmarkOutcome<T> = { readonly status: "ok"; readonly value: T } | BenchmarkRefusal;

export interface BenchmarkServiceOptions {
  readonly projection: Pick<BenchmarkProjection, "suites" | "suite" | "runs" | "run">;
  readonly store: Pick<
    BenchmarkEventStore,
    "suiteSaved" | "suiteDeleted" | "runStarted" | "runPurged" | "cellRated"
  >;
  readonly turnMetrics: {
    readonly forThread: (threadId: string) => ReadonlyArray<TurnMetricsRecord>;
  };
  readonly runner: {
    readonly cancel: (runId: string) => Promise<BenchmarkRun | undefined>;
    readonly kick: () => void;
  };
  /** Whether the provider instance exists, is enabled, and offers the model. */
  readonly contenderAvailable: (
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ) => boolean;
  /** Creates the Benchmarks Chat Project once; refuses when it cannot be used. */
  readonly ensureProject: (
    windowId: WindowId,
  ) => Promise<
    { readonly status: "ready" } | { readonly status: "refused"; readonly message: string }
  >;
  /** Purges one cell thread through the ordinary thread purge path. */
  readonly purgeThread: (
    threadId: string,
    mode: "chat" | "code",
  ) => Promise<"purged" | "absent" | "failed">;
  /** What a run with Code cases needs of the host; absent where Code cells cannot run. */
  readonly codeCases?: {
    /** The mode a new thread starts in; absent unless it is an active Code Project. */
    readonly projectMode: (projectId: ProjectId) => PermissionMode | undefined;
    /** Resolves the ref to the commit every cell of the case will start from. */
    readonly checkRef: (
      projectId: ProjectId,
      ref: string,
    ) => Promise<
      | { readonly status: "ok"; readonly commit: string }
      | { readonly status: "refused"; readonly message: string }
    >;
    /** Removes a cell's managed worktree; a missing one is "absent", which counts as done. */
    readonly removeWorktree: (
      threadId: string,
      branch: string,
    ) => Promise<"removed" | "absent" | { readonly status: "refused"; readonly message: string }>;
  };
  readonly clock: () => string;
  readonly uuid: () => string;
}

/**
 * The commands behind the benchmark routes. Authority is the route's: only a
 * local window reaches a command that changes anything. What lives here is the
 * validation every caller shares, applied before anything is journaled.
 */
export class BenchmarkService {
  readonly #options: BenchmarkServiceOptions;
  #starts: Promise<unknown> = Promise.resolve();

  constructor(options: BenchmarkServiceOptions) {
    this.#options = options;
  }

  listSuites(): ReadonlyArray<BenchmarkSuite> {
    return this.#options.projection.suites();
  }

  saveSuite(request: BenchmarkSuiteSaveRequest): BenchmarkOutcome<BenchmarkSuite> {
    const { projection, store, clock } = this.#options;
    const existing = projection.suite(String(request.suiteId));
    if (existing === undefined && request.expectedRevision !== undefined) {
      return refused("not-found", "That suite no longer exists.");
    }
    if (existing !== undefined && request.expectedRevision !== existing.revision) {
      return refused(
        "conflict",
        "The suite changed since it was opened. Reload it and edit again.",
      );
    }
    const now = decodeUtcTimestamp(clock());
    const suite = decodeBenchmarkSuite({
      suiteId: request.suiteId,
      revision: (existing?.revision ?? 0) + 1,
      name: request.name,
      ...(request.description === undefined ? {} : { description: request.description }),
      cases: request.cases,
      ...(request.judge === undefined ? {} : { judge: request.judge }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    store.suiteSaved({ suite });
    return ok(suite);
  }

  deleteSuite(
    request: BenchmarkSuiteDeleteRequest,
  ): BenchmarkOutcome<{ readonly suiteId: BenchmarkSuite["suiteId"] }> {
    if (this.#options.projection.suite(String(request.suiteId)) === undefined) {
      return refused("not-found", "That suite does not exist.");
    }
    this.#options.store.suiteDeleted({ suiteId: request.suiteId });
    return ok({ suiteId: request.suiteId });
  }

  listRuns(request: BenchmarkRunsListRequest): BenchmarkRunsListResponse {
    return {
      runs: this.#options.projection
        .runs()
        .filter((run) => request.suiteId === undefined || run.suiteId === request.suiteId)
        .map(summarizeBenchmarkRun),
    };
  }

  readRun(request: BenchmarkRunReadRequest): BenchmarkOutcome<BenchmarkRunReadResponse> {
    const run = this.#options.projection.run(runKey(request.runId));
    if (run === undefined) return refused("not-found", "That run does not exist.");
    const metricsByThread = new Map<string, BenchmarkCellMetrics>();
    const cellMetrics: Array<{
      cellId: BenchmarkRun["cells"][number]["cellId"];
      metrics: BenchmarkCellMetrics;
    }> = [];
    for (const cell of run.cells) {
      if (cell.threadId === undefined) continue;
      const record = this.#options.turnMetrics.forThread(cell.threadId).at(-1);
      if (record === undefined) continue;
      const metrics = benchmarkCellMetrics(record);
      metricsByThread.set(cell.threadId, metrics);
      cellMetrics.push({ cellId: cell.cellId, metrics });
    }
    // The judge's turns are the run's overhead, never a contender's figures.
    const judgeTurns =
      run.judge === undefined
        ? []
        : run.cells.flatMap((cell) => {
            const record = this.#options.turnMetrics
              .forThread(benchmarkJudgeIdentity(String(cell.cellId)).threadId)
              .at(-1);
            return record === undefined ? [] : [benchmarkCellMetrics(record)];
          });
    return ok({
      run,
      leaderboard: benchmarkLeaderboard(run, metricsByThread),
      overhead: benchmarkOverhead(judgeTurns),
      cellMetrics,
    });
  }

  /** Stars for one cell; rating again replaces the earlier rating. */
  rateCell(request: BenchmarkCellRateRequest): BenchmarkOutcome<{
    readonly runId: BenchmarkRun["runId"];
    readonly cellId: BenchmarkRun["cells"][number]["cellId"];
    readonly rating: BenchmarkRating;
  }> {
    const run = this.#options.projection.run(runKey(request.runId));
    if (run === undefined) return refused("not-found", "That run does not exist.");
    const cell = run.cells.find((candidate) => candidate.cellId === request.cellId);
    if (cell === undefined) return refused("not-found", "That cell is not in the run.");
    if (cell.state !== "answered") {
      return refused("conflict", "Only an answered cell can be rated.");
    }
    const rating: BenchmarkRating = {
      stars: request.stars,
      ...(request.note === undefined || request.note === "" ? {} : { note: request.note }),
      ratedAt: decodeUtcTimestamp(this.#options.clock()),
    };
    this.#options.store.cellRated({ runId: run.runId, cellId: cell.cellId, rating });
    return ok({ runId: run.runId, cellId: cell.cellId, rating });
  }

  /**
   * Starts are one at a time. The check for a run that already exists, the
   * wait for the Project, and the journaling must not interleave, or two
   * identical starts would each journal a run.
   */
  startRun(
    windowId: WindowId,
    request: BenchmarkRunStartRequest,
  ): Promise<BenchmarkOutcome<BenchmarkRun>> {
    const result = this.#starts.then(
      () => this.#startRun(windowId, request),
      () => this.#startRun(windowId, request),
    );
    this.#starts = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #startRun(
    windowId: WindowId,
    request: BenchmarkRunStartRequest,
  ): Promise<BenchmarkOutcome<BenchmarkRun>> {
    const { projection, store, clock, uuid } = this.#options;
    const existing = projection.run(runKey(request.runId));
    if (existing !== undefined) {
      return existing.suiteId === request.suiteId
        ? ok(existing)
        : refused("conflict", "That run id belongs to another suite.");
    }
    const suite = projection.suite(String(request.suiteId));
    if (suite === undefined) return refused("not-found", "That suite does not exist.");
    // A suite can come from someone else's file; its commands run on this host,
    // so a person must have read them before the run starts.
    if (
      request.confirmedCommands !== true &&
      suite.cases.some((candidate) =>
        candidate.checks.some((check) => check.kind === "command-exits-zero"),
      )
    ) {
      return refused(
        "invalid",
        "This suite runs commands on this Mac. Read them and confirm before starting the run.",
      );
    }
    const cells = benchmarkCellCount(
      suite.cases.length,
      request.contenders.length,
      request.repetitions,
    );
    if (cells > MAX_BENCHMARK_CELLS) {
      return refused(
        "invalid",
        `This run would make ${cells} cells; a run holds at most ${MAX_BENCHMARK_CELLS}.`,
      );
    }
    const unavailable = request.contenders.findIndex(
      (contender) =>
        !this.#options.contenderAvailable(contender.providerInstanceId, contender.modelId),
    );
    if (unavailable >= 0) {
      return refused(
        "invalid",
        `Contender ${unavailable + 1} is not an enabled provider model on this host.`,
      );
    }
    const codeChecked = await this.#checkCodeCases(suite.cases, request.executionLevel);
    if (codeChecked.status === "refused") return codeChecked;
    const project = await this.#options.ensureProject(windowId);
    if (project.status === "refused") return refused("unavailable", project.message);
    const run = decodeBenchmarkRun({
      runId: decodeBenchmarkRunId(runKey(request.runId)),
      suiteId: suite.suiteId,
      suiteRevision: suite.revision,
      suiteName: suite.name,
      cases: suite.cases,
      ...(suite.judge === undefined ? {} : { judge: suite.judge }),
      contenders: request.contenders,
      repetitions: request.repetitions,
      budget: request.budget,
      ...(request.executionLevel === undefined ? {} : { executionLevel: request.executionLevel }),
      ...(codeChecked.commits.length === 0 ? {} : { codeCommits: codeChecked.commits }),
      status: "running",
      startedAt: decodeUtcTimestamp(clock()),
      cells: planBenchmarkCells(suite.cases, request.contenders, request.repetitions, () =>
        decodeBenchmarkCellId(uuid()),
      ),
    });
    store.runStarted({ run });
    this.#options.runner.kick();
    return ok(run);
  }

  /**
   * Everything a Code case needs, checked before any cell runs: a host that can
   * run it, a Code Project that exists, a level the Project allows, and a ref
   * that resolves. The first problem refuses the whole run with a sentence.
   */
  async #checkCodeCases(
    cases: BenchmarkSuite["cases"],
    executionLevel: BenchmarkRunStartRequest["executionLevel"],
  ): Promise<
    | BenchmarkRefusal
    | {
        readonly status: "ok";
        readonly commits: ReadonlyArray<{
          readonly caseId: BenchmarkSuite["cases"][number]["caseId"];
          readonly commit: string;
        }>;
      }
  > {
    const codeCases = cases.filter((candidate) => candidate.code !== undefined);
    if (codeCases.length === 0) return { status: "ok", commits: [] };
    const support = this.#options.codeCases;
    if (support === undefined) {
      return refused("unavailable", "Code cases cannot run on this host.");
    }
    // The ref is read once per Project and ref, and every case on it is pinned
    // to that commit, so the cells of a run compare on the same files.
    const checked = new Map<string, string>();
    const commits: Array<{
      readonly caseId: BenchmarkSuite["cases"][number]["caseId"];
      readonly commit: string;
    }> = [];
    for (const benchmarkCase of codeCases) {
      const target = benchmarkCase.code;
      if (target === undefined) continue;
      const mode = support.projectMode(target.codeProjectId);
      if (mode === undefined) {
        return refused(
          "invalid",
          `The Code Project for "${benchmarkCase.title}" does not exist or is not a Code Project.`,
        );
      }
      const level = benchmarkExecutionLevel(executionLevel, mode);
      if (level.status === "refused") return refused("invalid", level.message);
      const key = `${String(target.codeProjectId)}\0${target.ref}`;
      let commit = checked.get(key);
      if (commit === undefined) {
        const ref = await support.checkRef(target.codeProjectId, target.ref);
        if (ref.status === "refused") {
          return refused("invalid", `"${benchmarkCase.title}": ${ref.message}`);
        }
        commit = ref.commit;
        checked.set(key, commit);
      }
      // Only a full SHA-1 can be pinned; any other form keeps resolving per cell.
      if (/^[a-f0-9]{40}$/.test(commit)) commits.push({ caseId: benchmarkCase.caseId, commit });
    }
    return { status: "ok", commits };
  }

  async cancelRun(request: BenchmarkRunCancelRequest): Promise<BenchmarkOutcome<BenchmarkRun>> {
    const run = await this.#options.runner.cancel(runKey(request.runId));
    return run === undefined ? refused("not-found", "That run does not exist.") : ok(run);
  }

  async purgeRun(
    request: BenchmarkRunPurgeRequest,
  ): Promise<BenchmarkOutcome<{ readonly runId: BenchmarkRun["runId"] }>> {
    const run = this.#options.projection.run(runKey(request.runId));
    if (run === undefined) return refused("not-found", "That run does not exist.");
    if (run.status === "running") {
      return refused("conflict", "Cancel the run before purging it.");
    }
    // A cell refused after its thread was made never recorded the thread, so
    // every cell's fixed thread identity is purged. A thread that was never made
    // is "absent", which counts as done.
    for (const cell of run.cells) {
      const isCode =
        run.cases.find((candidate) => candidate.caseId === cell.caseId)?.kind === "code";
      const cellThreadId = cell.threadId ?? benchmarkCellIdentity(String(cell.cellId)).threadId;
      if (isCode) {
        // The worktree goes first: once the thread is purged nothing names it.
        const removal =
          this.#options.codeCases === undefined
            ? "absent"
            : await this.#options.codeCases.removeWorktree(
                cellThreadId,
                benchmarkCodeBranch(String(run.runId), String(cell.cellId)),
              );
        if (typeof removal === "object") {
          return refused(
            "unavailable",
            `A cell's worktree could not be removed, so the run was kept: ${removal.message}`,
          );
        }
      }
      // The judge's thread is found by its fixed identity too; it is absent when
      // the suite had no judge or the cell never reached it. It is a Chat thread.
      const threads: Array<readonly [string, "chat" | "code"]> = [
        [benchmarkCellIdentity(String(cell.cellId)).threadId, isCode ? "code" : "chat"],
        [benchmarkJudgeIdentity(String(cell.cellId)).threadId, "chat"],
      ];
      if (cell.threadId !== undefined) threads.push([cell.threadId, isCode ? "code" : "chat"]);
      const seen = new Set<string>();
      for (const [threadId, mode] of threads) {
        if (seen.has(threadId)) continue;
        seen.add(threadId);
        if ((await this.#options.purgeThread(threadId, mode)) === "failed") {
          return refused("unavailable", "A cell thread could not be purged, so the run was kept.");
        }
      }
    }
    this.#options.store.runPurged({ runId: run.runId });
    return ok({ runId: run.runId });
  }
}

/**
 * A run id is a UUID, and the contract accepts either case. The branch a Code
 * cell works on is derived from it, so the host keeps one canonical lower-case
 * form and every lookup folds to it.
 */
function runKey(runId: BenchmarkRun["runId"]): string {
  return String(runId).toLowerCase();
}

function ok<T>(value: T): BenchmarkOutcome<T> {
  return { status: "ok", value };
}

function refused(reason: BenchmarkRefusal["reason"], message: string): BenchmarkRefusal {
  return { status: "refused", reason, message };
}

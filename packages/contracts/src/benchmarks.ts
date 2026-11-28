import { Effect, Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { TurnStopReason } from "./turnMetrics";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedText = (maximum: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isFinite());

export const MAX_BENCHMARK_CASES = 100;
export const MAX_BENCHMARK_CHECKS = 20;
export const MAX_BENCHMARK_CONTENDERS = 8;
export const MAX_BENCHMARK_REPETITIONS = 5;
export const MAX_BENCHMARK_PROMPT_CHARS = 20_000;
export const MAX_BENCHMARK_PATTERN_CHARS = 200;
export const MAX_BENCHMARK_CELLS = 2_000;
export const BENCHMARK_JUDGE_REASON_CHARS = 512;
export const BENCHMARK_STAR_NOTE_CHARS = 512;
/** The longest reason a cell or run keeps for how it ended. */
export const BENCHMARK_FAILURE_REASON_CHARS = 200;
/** The longest detail one check result keeps. */
export const BENCHMARK_CHECK_DETAIL_CHARS = 200;

export const BenchmarkSuiteId = brandedUuid("BenchmarkSuiteId");
export type BenchmarkSuiteId = typeof BenchmarkSuiteId.Type;
export const BenchmarkCaseId = brandedUuid("BenchmarkCaseId");
export type BenchmarkCaseId = typeof BenchmarkCaseId.Type;
export const BenchmarkRunId = brandedUuid("BenchmarkRunId");
export type BenchmarkRunId = typeof BenchmarkRunId.Type;
export const BenchmarkCellId = brandedUuid("BenchmarkCellId");
export type BenchmarkCellId = typeof BenchmarkCellId.Type;

// ── Checks ─────────────────────────────────────────────────────────────────

const CheckText = boundedText(2_000);

export const BenchmarkRegexFlags = Schema.Literals(["", "i", "m", "s", "im", "is", "ms", "ims"]);
export type BenchmarkRegexFlags = typeof BenchmarkRegexFlags.Type;

/**
 * One deterministic check on an answer. The first five read the answer text of
 * a prompt case; the last two belong to Code cases and are scored by the
 * runner against the cell's worktree, so a prompt case refuses them.
 */
export const BenchmarkCheck = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("contains"),
    text: CheckText,
    caseSensitive: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("not-contains"),
    text: CheckText,
    caseSensitive: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("matches"),
    pattern: boundedText(MAX_BENCHMARK_PATTERN_CHARS),
    flags: BenchmarkRegexFlags,
  }),
  Schema.Struct({
    kind: Schema.Literal("equals"),
    text: CheckText,
    trim: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("valid-json") }),
  Schema.Struct({
    kind: Schema.Literal("command-exits-zero"),
    command: boundedText(1_000),
    timeoutSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("max-files-changed"),
    count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  }),
]);
export type BenchmarkCheck = typeof BenchmarkCheck.Type;

export const BENCHMARK_CODE_ONLY_CHECK_KINDS: ReadonlyArray<BenchmarkCheck["kind"]> = [
  "command-exits-zero",
  "max-files-changed",
];

export const BenchmarkCheckResult = Schema.Struct({
  index: NonNegativeInt,
  passed: Schema.Boolean,
  /** A short reason, never the answer. */
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(BENCHMARK_CHECK_DETAIL_CHARS))),
});
export type BenchmarkCheckResult = typeof BenchmarkCheckResult.Type;

// ── Suites ─────────────────────────────────────────────────────────────────

export const BenchmarkCase = Schema.Struct({
  caseId: BenchmarkCaseId,
  kind: Schema.Literals(["prompt", "code"]),
  title: boundedText(120),
  prompt: boundedText(MAX_BENCHMARK_PROMPT_CHARS),
  checks: Schema.Array(BenchmarkCheck).check(Schema.isMaxLength(MAX_BENCHMARK_CHECKS)),
  referenceAnswer: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_BENCHMARK_PROMPT_CHARS)),
  ),
  rubric: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
  /** Code cases only: the Code Project and the branch or tag the task starts from. */
  code: Schema.optional(
    Schema.Struct({
      codeProjectId: ProjectId,
      ref: boundedText(200),
    }),
  ),
}).check(
  Schema.makeFilter((value) => {
    if ((value.kind === "code") !== (value.code !== undefined)) {
      return "A Code case names its Code Project and ref, and a prompt case does not.";
    }
    if (
      value.kind === "prompt" &&
      value.checks.some((check) => BENCHMARK_CODE_ONLY_CHECK_KINDS.includes(check.kind))
    ) {
      return "A prompt case cannot carry a check that runs in a worktree.";
    }
    return true;
  }),
);
export type BenchmarkCase = typeof BenchmarkCase.Type;

export const BenchmarkJudge = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  rubric: boundedText(2_000),
});
export type BenchmarkJudge = typeof BenchmarkJudge.Type;

const SuiteCases = Schema.Array(BenchmarkCase).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_BENCHMARK_CASES),
  Schema.makeFilter((cases) =>
    new Set(cases.map((candidate) => candidate.caseId)).size === cases.length
      ? true
      : "Case ids must be unique within a suite.",
  ),
);

export const DEFAULT_BENCHMARK_PASS_THRESHOLD = 0.8;
export const BenchmarkSuiteKind = Schema.Literals(["chat", "work", "code"]);
export type BenchmarkSuiteKind = typeof BenchmarkSuiteKind.Type;
const BenchmarkPassThreshold = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);

const BenchmarkSuiteV1 = Schema.Struct({
  suiteId: BenchmarkSuiteId,
  revision: PositiveInt,
  name: boundedText(80),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  cases: SuiteCases,
  judge: Schema.optional(BenchmarkJudge),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
});

export const BenchmarkSuite = Schema.Struct({
  ...BenchmarkSuiteV1.fields,
  passThreshold: BenchmarkPassThreshold.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_BENCHMARK_PASS_THRESHOLD)),
  ),
  kind: BenchmarkSuiteKind.pipe(Schema.withDecodingDefaultType(Effect.succeed("chat"))),
  projectId: Schema.optional(ProjectId),
});
export type BenchmarkSuite = typeof BenchmarkSuite.Type;

// ── Runs ───────────────────────────────────────────────────────────────────

export const BenchmarkContender = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  effort: Schema.optional(boundedText(40)),
});
export type BenchmarkContender = typeof BenchmarkContender.Type;

export const BenchmarkBudget = Schema.Struct({
  maxTokens: Schema.optional(PositiveInt),
  maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0), Schema.isFinite())),
}).check(
  Schema.makeFilter((budget) =>
    budget.maxTokens !== undefined || budget.maxCostUsd !== undefined
      ? true
      : "A run needs a token or cost budget.",
  ),
);
export type BenchmarkBudget = typeof BenchmarkBudget.Type;

/** Only Code cases use the level; a prompt run carries none. */
export const BenchmarkExecutionLevel = Schema.Literals(["auto", "accept-edits", "full-access"]);
export type BenchmarkExecutionLevel = typeof BenchmarkExecutionLevel.Type;

/**
 * `answered` means the turn completed with an answer; the checks then score
 * it. The other settled states end the cell without an answer.
 */
export const BenchmarkCellState = Schema.Literals([
  "queued",
  "running",
  "answered",
  "failed",
  "blocked-on-approval",
  "cancelled",
  "skipped-budget",
]);
export type BenchmarkCellState = typeof BenchmarkCellState.Type;

export const BENCHMARK_SETTLED_CELL_STATES = [
  "answered",
  "failed",
  "blocked-on-approval",
  "cancelled",
  "skipped-budget",
] as const;
export const BenchmarkSettledCellState = Schema.Literals(BENCHMARK_SETTLED_CELL_STATES);
export type BenchmarkSettledCellState = typeof BenchmarkSettledCellState.Type;

export const BenchmarkJudgeResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("scored"),
    score: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    reason: Schema.String.check(Schema.isMaxLength(BENCHMARK_JUDGE_REASON_CHARS)),
    judgeThreadId: GuidString,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.String.check(Schema.isMaxLength(BENCHMARK_JUDGE_REASON_CHARS)),
  }),
]);
export type BenchmarkJudgeResult = typeof BenchmarkJudgeResult.Type;

export const BenchmarkRating = Schema.Struct({
  stars: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(BENCHMARK_STAR_NOTE_CHARS))),
  ratedAt: UtcTimestamp,
});
export type BenchmarkRating = typeof BenchmarkRating.Type;

export const BenchmarkCell = Schema.Struct({
  cellId: BenchmarkCellId,
  caseId: BenchmarkCaseId,
  contenderIndex: NonNegativeInt,
  repetition: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_BENCHMARK_REPETITIONS }),
  ),
  state: BenchmarkCellState,
  threadId: Schema.optional(GuidString),
  turnId: Schema.optional(GuidString),
  startedAt: Schema.optional(UtcTimestamp),
  settledAt: Schema.optional(UtcTimestamp),
  failureReason: Schema.optional(
    Schema.String.check(Schema.isMaxLength(BENCHMARK_FAILURE_REASON_CHARS)),
  ),
  checks: Schema.Array(BenchmarkCheckResult),
  judge: Schema.optional(BenchmarkJudgeResult),
  rating: Schema.optional(BenchmarkRating),
});
export type BenchmarkCell = typeof BenchmarkCell.Type;

export const BenchmarkRunStatus = Schema.Literals([
  "running",
  "finished",
  "cancelled",
  "budget-reached",
  "failed",
]);
export type BenchmarkRunStatus = typeof BenchmarkRunStatus.Type;

export const BenchmarkRunEndStatus = Schema.Literals([
  "finished",
  "cancelled",
  "budget-reached",
  "failed",
]);
export type BenchmarkRunEndStatus = typeof BenchmarkRunEndStatus.Type;

/**
 * The commit a Code case's ref resolved to when the run started, so every cell
 * of that case starts from the same files even if the branch moves meanwhile.
 */
export const BenchmarkCodeCommit = Schema.Struct({
  caseId: BenchmarkCaseId,
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
});
export type BenchmarkCodeCommit = typeof BenchmarkCodeCommit.Type;

/**
 * One execution of a suite. It snapshots the suite's cases and judge at start,
 * so editing or deleting the suite later never rewrites what a finished run
 * measured. Every cell is planned at start, so the count is exact.
 */
export const BenchmarkRun = Schema.Struct({
  runId: BenchmarkRunId,
  suiteId: BenchmarkSuiteId,
  suiteRevision: PositiveInt,
  suiteName: boundedText(80),
  cases: SuiteCases,
  judge: Schema.optional(BenchmarkJudge),
  contenders: Schema.Array(BenchmarkContender).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_BENCHMARK_CONTENDERS),
  ),
  repetitions: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_BENCHMARK_REPETITIONS }),
  ),
  budget: BenchmarkBudget,
  executionLevel: Schema.optional(BenchmarkExecutionLevel),
  /** Absent on a run started before refs were pinned; its cells then resolve the ref each time. */
  codeCommits: Schema.optional(
    Schema.Array(BenchmarkCodeCommit).check(Schema.isMaxLength(MAX_BENCHMARK_CASES)),
  ),
  status: BenchmarkRunStatus,
  startedAt: UtcTimestamp,
  endedAt: Schema.optional(UtcTimestamp),
  endReason: Schema.optional(
    Schema.String.check(Schema.isMaxLength(BENCHMARK_FAILURE_REASON_CHARS)),
  ),
  cells: Schema.Array(BenchmarkCell).check(Schema.isMaxLength(MAX_BENCHMARK_CELLS)),
}).check(
  Schema.makeFilter((run) => {
    if (run.cells.length !== run.cases.length * run.contenders.length * run.repetitions) {
      return "A run holds one cell per case, contender, and repetition.";
    }
    const caseIds = new Set(run.cases.map((candidate) => String(candidate.caseId)));
    const cellIds = new Set(run.cells.map((cell) => String(cell.cellId)));
    if (cellIds.size !== run.cells.length) return "Cell ids must be unique within a run.";
    const outside = run.cells.some(
      (cell) =>
        !caseIds.has(String(cell.caseId)) ||
        cell.contenderIndex >= run.contenders.length ||
        cell.repetition > run.repetitions,
    );
    if (outside) return "A cell must name a case, contender, and repetition of its run.";
    const codeCaseIds = new Set(
      run.cases
        .filter((candidate) => candidate.kind === "code")
        .map((candidate) => String(candidate.caseId)),
    );
    const pinned = run.codeCommits ?? [];
    if (
      new Set(pinned.map((pin) => String(pin.caseId))).size !== pinned.length ||
      pinned.some((pin) => !codeCaseIds.has(String(pin.caseId)))
    ) {
      return "A pinned commit names each Code case of the run at most once.";
    }
    return true;
  }),
);
export type BenchmarkRun = typeof BenchmarkRun.Type;

// ── Figures ────────────────────────────────────────────────────────────────

/**
 * What the host measured for one cell's turn, read from its turn metrics. Absent
 * fields were not reported, which is not the same as zero.
 */
export const BenchmarkCellMetrics = Schema.Struct({
  stopReason: TurnStopReason,
  wallMs: NonNegativeInt,
  timeToFirstTokenMs: Schema.optional(NonNegativeInt),
  tokensPerSecond: Schema.optional(NonNegativeNumber),
  inputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  totalTokens: Schema.optional(NonNegativeInt),
  costUsd: Schema.optional(NonNegativeNumber),
  toolCalls: Schema.optional(NonNegativeInt),
  toolFailures: Schema.optional(NonNegativeInt),
});
export type BenchmarkCellMetrics = typeof BenchmarkCellMetrics.Type;

export const BenchmarkLeaderboardRow = Schema.Struct({
  contenderIndex: NonNegativeInt,
  cells: NonNegativeInt,
  answered: NonNegativeInt,
  /** Passed checks over all checks, across answered cells; absent when none were scored. */
  checkPassRate: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  meanJudgeScore: Schema.optional(NonNegativeNumber),
  meanStars: Schema.optional(NonNegativeNumber),
  firstTokenP50Ms: Schema.optional(NonNegativeNumber),
  firstTokenP95Ms: Schema.optional(NonNegativeNumber),
  tokensPerSecondP50: Schema.optional(NonNegativeNumber),
  tokensPerSecondP95: Schema.optional(NonNegativeNumber),
  totalTokens: NonNegativeInt,
  meanTokens: Schema.optional(NonNegativeNumber),
  totalCostUsd: Schema.optional(NonNegativeNumber),
  /** Failed tool calls over all tool calls; absent when no tool ran. */
  toolFailureRate: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
  failedCount: NonNegativeInt,
  blockedCount: NonNegativeInt,
});
export type BenchmarkLeaderboardRow = typeof BenchmarkLeaderboardRow.Type;

export const BenchmarkRunSummary = Schema.Struct({
  runId: BenchmarkRunId,
  suiteId: BenchmarkSuiteId,
  suiteName: boundedText(80),
  suiteRevision: PositiveInt,
  status: BenchmarkRunStatus,
  startedAt: UtcTimestamp,
  endedAt: Schema.optional(UtcTimestamp),
  endReason: Schema.optional(
    Schema.String.check(Schema.isMaxLength(BENCHMARK_FAILURE_REASON_CHARS)),
  ),
  contenderCount: PositiveInt,
  repetitions: PositiveInt,
  cellCount: NonNegativeInt,
  /** Cells that are no longer queued or running. */
  settledCount: NonNegativeInt,
  answeredCount: NonNegativeInt,
  failedCount: NonNegativeInt,
});
export type BenchmarkRunSummary = typeof BenchmarkRunSummary.Type;

// ── Routes ─────────────────────────────────────────────────────────────────

export const BENCHMARK_ROUTE_PATHS = {
  advice: "/api/benchmarks/advice",
  suitesList: "/api/benchmarks/suites/list",
  suitesSave: "/api/benchmarks/suites/save",
  suitesDelete: "/api/benchmarks/suites/delete",
  runsList: "/api/benchmarks/runs/list",
  runsRead: "/api/benchmarks/runs/read",
  runsStart: "/api/benchmarks/runs/start",
  runsCancel: "/api/benchmarks/runs/cancel",
  runsPurge: "/api/benchmarks/runs/purge",
  cellsRate: "/api/benchmarks/cells/rate",
  suitesHistory: "/api/benchmarks/suites/history",
  runsExport: "/api/benchmarks/runs/export",
} as const;

export const BenchmarkAdviceRequest = Schema.Union([
  Schema.Struct({ suiteId: BenchmarkSuiteId }),
  Schema.Struct({ projectId: ProjectId, kind: BenchmarkSuiteKind }),
]);
export type BenchmarkAdviceRequest = typeof BenchmarkAdviceRequest.Type;

export const BenchmarkModelAdvice = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  effort: Schema.optional(boundedText(40)),
  passRate: BenchmarkPassThreshold,
  costPerPass: Schema.optional(NonNegativeNumber),
  medianMs: Schema.optional(NonNegativeNumber),
  runAt: UtcTimestamp,
  stale: Schema.Boolean,
});
export type BenchmarkModelAdvice = typeof BenchmarkModelAdvice.Type;

export const BenchmarkAdviceResponse = Schema.Struct({
  suites: Schema.Array(
    Schema.Struct({
      suiteId: BenchmarkSuiteId,
      name: boundedText(80),
      models: Schema.Array(BenchmarkModelAdvice),
    }),
  ),
});
export type BenchmarkAdviceResponse = typeof BenchmarkAdviceResponse.Type;
export const decodeBenchmarkAdviceRequest = Schema.decodeUnknownSync(
  BenchmarkAdviceRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkAdviceResponse = Schema.decodeUnknownSync(
  BenchmarkAdviceResponse,
  STRICT_DECODE_OPTIONS,
);

/** The most runs one history read returns, newest first. */
export const MAX_BENCHMARK_HISTORY_RUNS = 50;

export const BenchmarkSuitesListRequest = Schema.Struct({});
export type BenchmarkSuitesListRequest = typeof BenchmarkSuitesListRequest.Type;
export const BenchmarkSuitesListResponse = Schema.Struct({
  suites: Schema.Array(BenchmarkSuite),
});
export type BenchmarkSuitesListResponse = typeof BenchmarkSuitesListResponse.Type;

/**
 * The person's edit of a suite. The caller mints `suiteId` and each `caseId`.
 * An edit names the revision it was made from, and the host refuses it when
 * the suite moved on; a new suite names none.
 */
export const BenchmarkSuiteSaveRequest = Schema.Struct({
  suiteId: BenchmarkSuiteId,
  expectedRevision: Schema.optional(PositiveInt),
  name: boundedText(80),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  cases: SuiteCases,
  judge: Schema.optional(BenchmarkJudge),
  passThreshold: Schema.optional(BenchmarkPassThreshold),
  kind: Schema.optional(BenchmarkSuiteKind),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type BenchmarkSuiteSaveRequest = typeof BenchmarkSuiteSaveRequest.Type;
export const BenchmarkSuiteSaveResponse = Schema.Struct({ suite: BenchmarkSuite });
export type BenchmarkSuiteSaveResponse = typeof BenchmarkSuiteSaveResponse.Type;

export const BenchmarkSuiteDeleteRequest = Schema.Struct({ suiteId: BenchmarkSuiteId });
export type BenchmarkSuiteDeleteRequest = typeof BenchmarkSuiteDeleteRequest.Type;
export const BenchmarkSuiteDeleteResponse = Schema.Struct({
  suiteId: BenchmarkSuiteId,
});
export type BenchmarkSuiteDeleteResponse = typeof BenchmarkSuiteDeleteResponse.Type;

export const BenchmarkRunsListRequest = Schema.Struct({
  suiteId: Schema.optional(BenchmarkSuiteId),
});
export type BenchmarkRunsListRequest = typeof BenchmarkRunsListRequest.Type;
export const BenchmarkRunsListResponse = Schema.Struct({
  runs: Schema.Array(BenchmarkRunSummary),
});
export type BenchmarkRunsListResponse = typeof BenchmarkRunsListResponse.Type;

export const BenchmarkRunReadRequest = Schema.Struct({ runId: BenchmarkRunId });
export type BenchmarkRunReadRequest = typeof BenchmarkRunReadRequest.Type;
/**
 * What the judge turns cost, kept apart from every contender: judging is the
 * run's own overhead, not a model's. Figures a provider did not report count
 * as nothing here, so the sum can only understate.
 */
export const BenchmarkOverhead = Schema.Struct({
  turns: NonNegativeInt,
  tokens: NonNegativeInt,
  costUsd: NonNegativeNumber,
});
export type BenchmarkOverhead = typeof BenchmarkOverhead.Type;

export const BenchmarkRunReadResponse = Schema.Struct({
  run: BenchmarkRun,
  leaderboard: Schema.Array(BenchmarkLeaderboardRow),
  /** Absent from a host that predates judge scoring. */
  overhead: Schema.optional(BenchmarkOverhead),
  cellMetrics: Schema.Array(
    Schema.Struct({ cellId: BenchmarkCellId, metrics: BenchmarkCellMetrics }),
  ),
});
export type BenchmarkRunReadResponse = typeof BenchmarkRunReadResponse.Type;

export const BenchmarkHistoryRequest = Schema.Struct({ suiteId: BenchmarkSuiteId });
export type BenchmarkHistoryRequest = typeof BenchmarkHistoryRequest.Type;
/** One contender's figures in one run: the leaderboard row without the percentile tails. */
export const BenchmarkHistoryRow = Schema.Struct({
  contender: BenchmarkContender,
  cells: NonNegativeInt,
  answered: NonNegativeInt,
  checkPassRate: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  meanJudgeScore: Schema.optional(NonNegativeNumber),
  meanStars: Schema.optional(NonNegativeNumber),
  firstTokenP50Ms: Schema.optional(NonNegativeNumber),
  tokensPerSecondP50: Schema.optional(NonNegativeNumber),
  totalTokens: NonNegativeInt,
  totalCostUsd: Schema.optional(NonNegativeNumber),
  failedCount: NonNegativeInt,
});
export type BenchmarkHistoryRow = typeof BenchmarkHistoryRow.Type;
export const BenchmarkHistoryRun = Schema.Struct({
  runId: BenchmarkRunId,
  startedAt: UtcTimestamp,
  status: BenchmarkRunStatus,
  suiteRevision: PositiveInt,
  rows: Schema.Array(BenchmarkHistoryRow),
});
export type BenchmarkHistoryRun = typeof BenchmarkHistoryRun.Type;
export const BenchmarkHistoryResponse = Schema.Struct({
  suiteId: BenchmarkSuiteId,
  runs: Schema.Array(BenchmarkHistoryRun).check(Schema.isMaxLength(MAX_BENCHMARK_HISTORY_RUNS)),
});
export type BenchmarkHistoryResponse = typeof BenchmarkHistoryResponse.Type;

export const BenchmarkExportFormat = Schema.Literals(["json", "csv"]);
export type BenchmarkExportFormat = typeof BenchmarkExportFormat.Type;
export const BenchmarkRunExportRequest = Schema.Struct({
  runId: BenchmarkRunId,
  format: BenchmarkExportFormat,
});
export type BenchmarkRunExportRequest = typeof BenchmarkRunExportRequest.Type;
/** A file the client saves. It never carries answer text. */
export const BenchmarkRunExportResponse = Schema.Struct({
  fileName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  contentType: Schema.String,
  content: Schema.String,
});
export type BenchmarkRunExportResponse = typeof BenchmarkRunExportResponse.Type;

/** The caller mints `runId`, so a retried start finds the run it already made. */
export const BenchmarkRunStartRequest = Schema.Struct({
  runId: BenchmarkRunId,
  suiteId: BenchmarkSuiteId,
  contenders: Schema.Array(BenchmarkContender).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_BENCHMARK_CONTENDERS),
  ),
  repetitions: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_BENCHMARK_REPETITIONS }),
  ),
  budget: BenchmarkBudget,
  executionLevel: Schema.optional(BenchmarkExecutionLevel),
  /**
   * The suite revision whose check commands a person read before starting. A
   * suite with a `command-exits-zero` check is refused unless this equals the
   * suite's current revision, so an edit after reading needs a new confirmation.
   */
  confirmedSuiteRevision: Schema.optional(PositiveInt),
});
export type BenchmarkRunStartRequest = typeof BenchmarkRunStartRequest.Type;
export const BenchmarkRunStartResponse = Schema.Struct({ run: BenchmarkRun });
export type BenchmarkRunStartResponse = typeof BenchmarkRunStartResponse.Type;

export const BenchmarkRunCancelRequest = Schema.Struct({ runId: BenchmarkRunId });
export type BenchmarkRunCancelRequest = typeof BenchmarkRunCancelRequest.Type;
export const BenchmarkRunCancelResponse = Schema.Struct({ run: BenchmarkRun });
export type BenchmarkRunCancelResponse = typeof BenchmarkRunCancelResponse.Type;

export const BenchmarkRunPurgeRequest = Schema.Struct({ runId: BenchmarkRunId });
export type BenchmarkRunPurgeRequest = typeof BenchmarkRunPurgeRequest.Type;
export const BenchmarkRunPurgeResponse = Schema.Struct({ runId: BenchmarkRunId });
export type BenchmarkRunPurgeResponse = typeof BenchmarkRunPurgeResponse.Type;

/** The person's stars for one cell. Rating again replaces the earlier rating. */
export const BenchmarkCellRateRequest = Schema.Struct({
  runId: BenchmarkRunId,
  cellId: BenchmarkCellId,
  stars: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(BENCHMARK_STAR_NOTE_CHARS))),
});
export type BenchmarkCellRateRequest = typeof BenchmarkCellRateRequest.Type;
export const BenchmarkCellRateResponse = Schema.Struct({
  runId: BenchmarkRunId,
  cellId: BenchmarkCellId,
  rating: BenchmarkRating,
});
export type BenchmarkCellRateResponse = typeof BenchmarkCellRateResponse.Type;

// ── Journal events ─────────────────────────────────────────────────────────

export const BENCHMARK_SUITE_AGGREGATE_TYPE = "benchmark-suite";
export const BENCHMARK_RUN_AGGREGATE_TYPE = "benchmark-run";

export const BENCHMARK_EVENT_NAMES = {
  suiteSaved: "benchmark-suite-saved@1",
  suiteDeleted: "benchmark-suite-deleted@1",
  runStarted: "benchmark-run-started@1",
  cellStarted: "benchmark-cell-started@1",
  cellRequeued: "benchmark-cell-requeued@1",
  cellSettled: "benchmark-cell-settled@1",
  cellJudged: "benchmark-cell-judged@1",
  cellRated: "benchmark-cell-rated@1",
  runEnded: "benchmark-run-ended@1",
  runPurged: "benchmark-run-purged@1",
} as const;

/**
 * Prompt text sits in suite and run events because the person wrote it as a
 * definition. An answer never does: it stays in the cell's thread.
 */
export const BenchmarkSuiteSaved = Schema.Struct({ suite: BenchmarkSuite });
export type BenchmarkSuiteSaved = typeof BenchmarkSuiteSaved.Type;
export const BenchmarkSuiteSavedV1 = Schema.Struct({ suite: BenchmarkSuiteV1 });
export const BenchmarkSuiteSavedV2 = Schema.Struct({
  suite: Schema.Struct({
    ...BenchmarkSuiteV1.fields,
    passThreshold: BenchmarkPassThreshold,
    kind: BenchmarkSuiteKind,
    projectId: Schema.optional(ProjectId),
  }),
});
export const BenchmarkSuiteDeleted = Schema.Struct({ suiteId: BenchmarkSuiteId });
export type BenchmarkSuiteDeleted = typeof BenchmarkSuiteDeleted.Type;
export const BenchmarkRunStarted = Schema.Struct({ run: BenchmarkRun });
export type BenchmarkRunStarted = typeof BenchmarkRunStarted.Type;
export const BenchmarkCellStarted = Schema.Struct({
  runId: BenchmarkRunId,
  cellId: BenchmarkCellId,
  threadId: GuidString,
  turnId: Schema.optional(GuidString),
  startedAt: UtcTimestamp,
});
export type BenchmarkCellStarted = typeof BenchmarkCellStarted.Type;
/**
 * A cell whose turn Chat could not admit for lack of capacity goes back to
 * queued. It keeps its thread, so starting it again retries the turn it has
 * rather than sending a second one.
 */
export const BenchmarkCellRequeued = Schema.Struct({
  runId: BenchmarkRunId,
  cellId: BenchmarkCellId,
});
export type BenchmarkCellRequeued = typeof BenchmarkCellRequeued.Type;
export const BenchmarkCellSettled = Schema.Struct({
  runId: BenchmarkRunId,
  cellId: BenchmarkCellId,
  state: BenchmarkSettledCellState,
  failureReason: Schema.optional(
    Schema.String.check(Schema.isMaxLength(BENCHMARK_FAILURE_REASON_CHARS)),
  ),
  checks: Schema.Array(BenchmarkCheckResult),
  settledAt: UtcTimestamp,
});
export type BenchmarkCellSettled = typeof BenchmarkCellSettled.Type;
export const BenchmarkCellJudged = Schema.Struct({
  runId: BenchmarkRunId,
  cellId: BenchmarkCellId,
  judge: BenchmarkJudgeResult,
});
export type BenchmarkCellJudged = typeof BenchmarkCellJudged.Type;
export const BenchmarkCellRated = Schema.Struct({
  runId: BenchmarkRunId,
  cellId: BenchmarkCellId,
  rating: BenchmarkRating,
});
export type BenchmarkCellRated = typeof BenchmarkCellRated.Type;
export const BenchmarkRunEnded = Schema.Struct({
  runId: BenchmarkRunId,
  status: BenchmarkRunEndStatus,
  endReason: Schema.optional(
    Schema.String.check(Schema.isMaxLength(BENCHMARK_FAILURE_REASON_CHARS)),
  ),
  endedAt: UtcTimestamp,
});
export type BenchmarkRunEnded = typeof BenchmarkRunEnded.Type;
export const BenchmarkRunPurged = Schema.Struct({ runId: BenchmarkRunId });
export type BenchmarkRunPurged = typeof BenchmarkRunPurged.Type;

export const decodeBenchmarkSuite = Schema.decodeUnknownSync(BenchmarkSuite, STRICT_DECODE_OPTIONS);
export const decodeBenchmarkRun = Schema.decodeUnknownSync(BenchmarkRun, STRICT_DECODE_OPTIONS);
export const decodeBenchmarkCheck = Schema.decodeUnknownSync(BenchmarkCheck, STRICT_DECODE_OPTIONS);
export const decodeBenchmarkSuiteId = Schema.decodeUnknownSync(
  BenchmarkSuiteId,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkCaseId = Schema.decodeUnknownSync(
  BenchmarkCaseId,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunId = Schema.decodeUnknownSync(BenchmarkRunId, STRICT_DECODE_OPTIONS);
export const decodeBenchmarkCellId = Schema.decodeUnknownSync(
  BenchmarkCellId,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkSuitesListRequest = Schema.decodeUnknownSync(
  BenchmarkSuitesListRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkSuitesListResponse = Schema.decodeUnknownSync(
  BenchmarkSuitesListResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkSuiteSaveRequest = Schema.decodeUnknownSync(
  BenchmarkSuiteSaveRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkSuiteSaveResponse = Schema.decodeUnknownSync(
  BenchmarkSuiteSaveResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkSuiteDeleteRequest = Schema.decodeUnknownSync(
  BenchmarkSuiteDeleteRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkSuiteDeleteResponse = Schema.decodeUnknownSync(
  BenchmarkSuiteDeleteResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunsListRequest = Schema.decodeUnknownSync(
  BenchmarkRunsListRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunsListResponse = Schema.decodeUnknownSync(
  BenchmarkRunsListResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunReadRequest = Schema.decodeUnknownSync(
  BenchmarkRunReadRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunReadResponse = Schema.decodeUnknownSync(
  BenchmarkRunReadResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunStartRequest = Schema.decodeUnknownSync(
  BenchmarkRunStartRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunStartResponse = Schema.decodeUnknownSync(
  BenchmarkRunStartResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunCancelRequest = Schema.decodeUnknownSync(
  BenchmarkRunCancelRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunCancelResponse = Schema.decodeUnknownSync(
  BenchmarkRunCancelResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunPurgeRequest = Schema.decodeUnknownSync(
  BenchmarkRunPurgeRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunPurgeResponse = Schema.decodeUnknownSync(
  BenchmarkRunPurgeResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkCellRateRequest = Schema.decodeUnknownSync(
  BenchmarkCellRateRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkCellRateResponse = Schema.decodeUnknownSync(
  BenchmarkCellRateResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkHistoryRequest = Schema.decodeUnknownSync(
  BenchmarkHistoryRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkHistoryResponse = Schema.decodeUnknownSync(
  BenchmarkHistoryResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunExportRequest = Schema.decodeUnknownSync(
  BenchmarkRunExportRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeBenchmarkRunExportResponse = Schema.decodeUnknownSync(
  BenchmarkRunExportResponse,
  STRICT_DECODE_OPTIONS,
);

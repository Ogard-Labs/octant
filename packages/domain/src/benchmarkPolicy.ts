import {
  MAX_BENCHMARK_HISTORY_RUNS,
  BENCHMARK_CHECK_DETAIL_CHARS,
  BENCHMARK_CODE_ONLY_CHECK_KINDS,
  BENCHMARK_FAILURE_REASON_CHARS,
  BENCHMARK_JUDGE_REASON_CHARS,
  type BenchmarkBudget,
  type BenchmarkCase,
  type BenchmarkCell,
  type BenchmarkCellId,
  type BenchmarkCellMetrics,
  type BenchmarkCheck,
  type BenchmarkCheckResult,
  type BenchmarkHistoryRun,
  type BenchmarkLeaderboardRow,
  type BenchmarkOverhead,
  type BenchmarkRun,
  type BenchmarkExecutionLevel,
  type BenchmarkRunSummary,
  type PermissionMode,
  type ProviderExecutionPolicy,
  type TurnMetricsRecord,
} from "@octant/contracts";
import {
  clampWorkAccess,
  threadAccessOf,
  workAccessOfPermissionMode,
  permissionModeOfWorkAccess,
} from "./guardrailPolicy";
import { percentile } from "./turnDiagnosticsReport";

/** At most two cells at once per provider instance and four per host. */
export const BENCHMARK_CONCURRENCY_LIMITS = { perProvider: 2, perHost: 4 } as const;

/** An answer longer than this is cut before any check reads it. */
export const BENCHMARK_ANSWER_CHECK_CHARS = 50_000;

/**
 * Tests a pattern the person wrote against an answer. Matching a hand-written
 * regular expression can run without end, so the domain never does it: the host
 * supplies a matcher that bounds the time and refuses with a reason when it is
 * exceeded.
 */
export type BenchmarkPatternMatcher = (
  pattern: string,
  flags: string,
  text: string,
) => Promise<{ readonly matched: boolean } | { readonly refused: string }>;

export function benchmarkCellCount(
  caseCount: number,
  contenderCount: number,
  repetitions: number,
): number {
  return caseCount * contenderCount * repetitions;
}

/**
 * Every cell of a run, queued. Repetition-major, then case, then contender, so
 * a run that stops early has still compared every contender on the cases it
 * reached.
 */
export function planBenchmarkCells(
  cases: ReadonlyArray<Pick<BenchmarkCase, "caseId">>,
  contenders: ReadonlyArray<unknown>,
  repetitions: number,
  newId: () => BenchmarkCellId,
): ReadonlyArray<BenchmarkCell> {
  const cells: BenchmarkCell[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const benchmarkCase of cases) {
      for (let contenderIndex = 0; contenderIndex < contenders.length; contenderIndex += 1) {
        cells.push({
          cellId: newId(),
          caseId: benchmarkCase.caseId,
          contenderIndex,
          repetition,
          state: "queued",
          checks: [],
        });
      }
    }
  }
  return cells;
}

export function isBenchmarkCodeOnlyCheck(check: BenchmarkCheck): boolean {
  return BENCHMARK_CODE_ONLY_CHECK_KINDS.includes(check.kind);
}

/**
 * Scores the answer-text checks. A check that runs in a worktree is skipped
 * here and scored by the runner; the result keeps the check's own position, so
 * the two sets of results interleave back into the case's order.
 */
export async function scoreBenchmarkChecks(
  checks: ReadonlyArray<BenchmarkCheck>,
  answer: string,
  matchPattern: BenchmarkPatternMatcher,
): Promise<ReadonlyArray<BenchmarkCheckResult>> {
  const text =
    answer.length > BENCHMARK_ANSWER_CHECK_CHARS
      ? answer.slice(0, BENCHMARK_ANSWER_CHECK_CHARS)
      : answer;
  const results: BenchmarkCheckResult[] = [];
  for (const [index, check] of checks.entries()) {
    if (isBenchmarkCodeOnlyCheck(check)) continue;
    results.push(await scoreOne(check, text, index, matchPattern));
  }
  return results;
}

async function scoreOne(
  check: BenchmarkCheck,
  answer: string,
  index: number,
  matchPattern: BenchmarkPatternMatcher,
): Promise<BenchmarkCheckResult> {
  switch (check.kind) {
    case "contains": {
      const found = check.caseSensitive
        ? answer.includes(check.text)
        : answer.toLowerCase().includes(check.text.toLowerCase());
      return found ? { index, passed: true } : { index, passed: false, detail: "text not found" };
    }
    case "not-contains": {
      const found = check.caseSensitive
        ? answer.includes(check.text)
        : answer.toLowerCase().includes(check.text.toLowerCase());
      return found ? { index, passed: false, detail: "text found" } : { index, passed: true };
    }
    case "matches": {
      try {
        // Compiling is bounded; only matching is not.
        new RegExp(check.pattern, check.flags);
      } catch {
        return { index, passed: false, detail: "invalid pattern" };
      }
      const outcome = await matchPattern(check.pattern, check.flags, answer);
      if ("refused" in outcome) return { index, passed: false, detail: outcome.refused };
      return outcome.matched
        ? { index, passed: true }
        : { index, passed: false, detail: "no match" };
    }
    case "equals": {
      const same = check.trim ? answer.trim() === check.text.trim() : answer === check.text;
      return same ? { index, passed: true } : { index, passed: false, detail: "answer differs" };
    }
    case "valid-json": {
      try {
        JSON.parse(answer.trim());
        return { index, passed: true };
      } catch {
        return { index, passed: false, detail: "not valid JSON" };
      }
    }
    default:
      // Worktree checks never reach here: scoreBenchmarkChecks skips them.
      return { index, passed: false, detail: "check runs in a worktree" };
  }
}

export interface BenchmarkRunningCounts {
  /** Cells running now on this host, by provider instance id. */
  readonly byProvider: ReadonlyMap<string, number>;
  /** Cells running now on this host across every run. */
  readonly total: number;
}

/**
 * The queued cells that may start now, in plan order. A cell whose provider is
 * at its limit is passed over, not waited for, so one busy provider does not
 * hold back the others.
 */
export function nextBenchmarkCells(
  run: Pick<BenchmarkRun, "cells" | "contenders">,
  running: BenchmarkRunningCounts,
  limits: { readonly perProvider: number; readonly perHost: number } = BENCHMARK_CONCURRENCY_LIMITS,
): ReadonlyArray<BenchmarkCell> {
  const started = new Map(running.byProvider);
  let total = running.total;
  const next: BenchmarkCell[] = [];
  for (const cell of run.cells) {
    if (total >= limits.perHost) break;
    if (cell.state !== "queued") continue;
    const provider = run.contenders[cell.contenderIndex]?.providerInstanceId;
    if (provider === undefined) continue;
    const key = String(provider);
    const active = started.get(key) ?? 0;
    if (active >= limits.perProvider) continue;
    started.set(key, active + 1);
    total += 1;
    next.push(cell);
  }
  return next;
}

/**
 * The cells whose answer still owes a judge score: answered, in a run whose
 * suite names a judge, with no judge result journaled yet. In plan order.
 */
export function benchmarkCellsOwingJudgement(
  run: Pick<BenchmarkRun, "cells" | "judge">,
): ReadonlyArray<BenchmarkCell> {
  if (run.judge === undefined) return [];
  return run.cells.filter((cell) => cell.state === "answered" && cell.judge === undefined);
}

/**
 * The owed judgements that may start now. A judge turn counts against the same
 * limits as a contender's cell, on the judge's own provider instance, so
 * `running` must already include the judge turns in flight.
 */
export function nextBenchmarkJudgements(
  run: Pick<BenchmarkRun, "cells" | "judge">,
  inFlight: ReadonlySet<string>,
  running: BenchmarkRunningCounts,
  limits: { readonly perProvider: number; readonly perHost: number } = BENCHMARK_CONCURRENCY_LIMITS,
): ReadonlyArray<BenchmarkCell> {
  if (run.judge === undefined) return [];
  const key = String(run.judge.providerInstanceId);
  let active = running.byProvider.get(key) ?? 0;
  let total = running.total;
  const next: BenchmarkCell[] = [];
  for (const cell of benchmarkCellsOwingJudgement(run)) {
    if (inFlight.has(String(cell.cellId))) continue;
    if (total >= limits.perHost || active >= limits.perProvider) break;
    active += 1;
    total += 1;
    next.push(cell);
  }
  return next;
}

export type BenchmarkBudgetDecision =
  | { readonly decision: "start" }
  | { readonly decision: "stop"; readonly reason: string };

/**
 * Whether another cell may start. A cell is estimated at the mean of the cells
 * that settled with usage; with none settled yet the first cells are allowed,
 * because nothing is known. The run stops when what was spent, plus that
 * estimate for every cell running and the one about to start, would pass a limit.
 * What the judge turns cost (`overhead`) counts as spent.
 */
export function benchmarkBudgetDecision(
  budget: BenchmarkBudget,
  spent: { readonly tokens: number; readonly costUsd: number },
  settledCount: number,
  runningCount: number,
  overhead: { readonly tokens: number; readonly costUsd: number } = { tokens: 0, costUsd: 0 },
): BenchmarkBudgetDecision {
  if (settledCount <= 0) return { decision: "start" };
  const inFlight = runningCount + 1;
  // Judging is paid for by the same budget, and every further cell brings its
  // own judging, so the mean per cell includes it.
  const tokens = spent.tokens + overhead.tokens;
  const costUsd = spent.costUsd + overhead.costUsd;
  if (budget.maxTokens !== undefined) {
    const projected = tokens + (tokens / settledCount) * inFlight;
    if (projected > budget.maxTokens) {
      return { decision: "stop", reason: "The next cell would pass the token budget." };
    }
  }
  if (budget.maxCostUsd !== undefined) {
    const projected = costUsd + (costUsd / settledCount) * inFlight;
    if (projected > budget.maxCostUsd) {
      return { decision: "stop", reason: "The next cell would pass the cost budget." };
    }
  }
  return { decision: "start" };
}

/**
 * A run is finished once no cell is waiting or running and every judgement it
 * owes has settled.
 */
export function benchmarkRunStatusAfter(
  run: Pick<BenchmarkRun, "cells" | "judge">,
): "running" | "finished" {
  if (run.cells.some((cell) => cell.state === "queued" || cell.state === "running")) {
    return "running";
  }
  return benchmarkCellsOwingJudgement(run).length > 0 ? "running" : "finished";
}

/** A candidate answer longer than this is cut before the judge reads it. */
export const BENCHMARK_JUDGE_ANSWER_CHARS = 50_000;

/** The most files a Code cell's diff summary names; the count is always the whole total. */
export const BENCHMARK_CODE_DIFF_FILES = 100;

/** A check command's output is cut to this many bytes before anything is kept. */
export const BENCHMARK_COMMAND_OUTPUT_BYTES = 4 * 1024;

/** The longest a check command may run, whatever the case asks for. */
export const BENCHMARK_COMMAND_MAX_SECONDS = 600;

/** A Code turn parked on an approval this long ends its cell as blocked. */
export const BENCHMARK_APPROVAL_WAIT_MS = 10 * 60_000;

/** The files a Code turn changed: paths and line counts, never diff text. */
export interface BenchmarkCodeDiffSummary {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly insertions: number;
    readonly deletions: number;
  }>;
  /** Every path that changed, including those `files` leaves out. */
  readonly total: number;
}

/** One check and how it came out, as the judge reads it. */
export interface BenchmarkCodeCheckLine {
  readonly description: string;
  readonly passed: boolean;
  readonly detail?: string | undefined;
}

/**
 * What the judge is asked. It is built only from the rubric, the case, and the
 * answer, so it cannot name the contender, its provider, or its model. A Code
 * case has no answer to read: the judge gets the diff summary and the check
 * results instead.
 */
export function benchmarkJudgePrompt(input: {
  readonly rubric: string;
  readonly casePrompt: string;
  readonly referenceAnswer?: string | undefined;
  readonly candidateAnswer?: string | undefined;
  readonly code?:
    | {
        readonly diff: BenchmarkCodeDiffSummary | undefined;
        readonly checks: ReadonlyArray<BenchmarkCodeCheckLine>;
      }
    | undefined;
}): string {
  const parts = [
    "You are grading one answer to a task. Judge it only against the rubric below.",
    `Rubric:\n${input.rubric}`,
    `Task given to the answerer:\n${input.casePrompt}`,
  ];
  if (input.referenceAnswer !== undefined && input.referenceAnswer !== "") {
    parts.push(`Reference answer:\n${input.referenceAnswer}`);
  }
  if (input.code !== undefined) {
    parts.push(
      `Change the answerer made to the repository:\n${benchmarkDiffText(input.code.diff)}`,
    );
    parts.push(
      `Check results:\n${
        input.code.checks.length === 0
          ? "No checks were set for this task."
          : input.code.checks
              .map(
                (check) =>
                  `- ${check.passed ? "passed" : "failed"}: ${check.description}${
                    check.detail === undefined || check.detail === "" ? "" : ` (${check.detail})`
                  }`,
              )
              .join("\n")
      }`,
    );
  } else {
    const answer = input.candidateAnswer ?? "";
    const cut = answer.length > BENCHMARK_JUDGE_ANSWER_CHARS;
    parts.push(
      `Answer to grade${cut ? " (cut at 50,000 characters)" : ""}:\n${
        cut ? answer.slice(0, BENCHMARK_JUDGE_ANSWER_CHARS) : answer
      }`,
    );
  }
  parts.push(
    `Reply with exactly one JSON object and nothing else: {"score": <integer from 1 to 10>, "reason": "<at most ${BENCHMARK_JUDGE_REASON_CHARS} characters>"}`,
  );
  return parts.join("\n\n");
}

/** The diff summary as short lines: one per file, then how many more there were. */
export function benchmarkDiffText(diff: BenchmarkCodeDiffSummary | undefined): string {
  if (diff === undefined) return "The files that changed could not be read.";
  if (diff.total === 0) return "No files changed.";
  const shown = diff.files.slice(0, BENCHMARK_CODE_DIFF_FILES);
  const lines = shown.map((file) => `${file.path} +${file.insertions} -${file.deletions}`);
  const left = diff.total - shown.length;
  if (left > 0) lines.push(`and ${left} more ${left === 1 ? "file" : "files"}`);
  return `${diff.total} ${diff.total === 1 ? "file" : "files"} changed\n${lines.join("\n")}`;
}

/** A check in words, for the judge. */
export function benchmarkCheckDescription(check: BenchmarkCheck): string {
  switch (check.kind) {
    case "command-exits-zero":
      return `the command "${check.command}" exits 0`;
    case "max-files-changed":
      return `at most ${check.count} files changed`;
    case "contains":
      return `the answer contains "${check.text}"`;
    case "not-contains":
      return `the answer does not contain "${check.text}"`;
    case "matches":
      return `the answer matches /${check.pattern}/${check.flags}`;
    case "equals":
      return `the answer equals "${check.text}"`;
    case "valid-json":
      return "the answer is valid JSON";
  }
}

/** The branch a Code cell works on: fixed by the run and the cell, so a restart finds it again. */
export function benchmarkCodeBranch(runId: string, cellId: string): string {
  const hex = (id: string) => id.replace(/-/g, "").toLowerCase();
  return `benchmark/${hex(runId).slice(0, 8)}/${hex(cellId).slice(0, 12)}`;
}

export type BenchmarkExecutionLevelDecision =
  | {
      readonly status: "ok";
      readonly mode: PermissionMode;
      readonly executionPolicy: ProviderExecutionPolicy;
      readonly autoApprove: boolean;
      /** True when the Project's own level lowered what the run asked for. */
      readonly clamped: boolean;
    }
  | { readonly status: "refused"; readonly message: string };

/**
 * The level a Code cell's thread starts at. A run asks for Auto, Accept edits,
 * or Full access, and asks first when it names nothing. The Project's own level
 * is a ceiling the same way it is for a routine: a thread takes the lower of
 * the two. Full access is never reached by a pick alone, so a run that asks for
 * it where the Project does not already hold it is refused whole.
 */
export function benchmarkExecutionLevel(
  picked: BenchmarkExecutionLevel | undefined,
  projectMode: PermissionMode,
): BenchmarkExecutionLevelDecision {
  const asked =
    picked === undefined ? "ask-first" : picked === "accept-edits" ? "auto-accept-edits" : picked;
  // Plan holds no level a run could use, so a Plan Project asks first.
  const project = workAccessOfPermissionMode(projectMode) ?? "ask-first";
  if (asked === "full-access" && project !== "full-access") {
    return {
      status: "refused",
      message:
        "Full access is not allowed in this Code Project, so the run was not started. Pick a lower level or turn Full access on for the Project first.",
    };
  }
  const level = clampWorkAccess(project, asked);
  const mode = permissionModeOfWorkAccess(level);
  const access = threadAccessOf(mode);
  return {
    status: "ok",
    mode,
    executionPolicy: access.executionPolicy,
    autoApprove: access.autoApprove,
    clamped: level !== asked,
  };
}

/** A worktree check on the number of files the turn changed. */
export function benchmarkFilesChangedResult(
  index: number,
  limit: number,
  changed: number | undefined,
): BenchmarkCheckResult {
  if (changed === undefined) {
    return { index, passed: false, detail: "the files that changed were not observed" };
  }
  return changed <= limit
    ? { index, passed: true, detail: `${changed} files changed` }
    : { index, passed: false, detail: `${changed} files changed, more than ${limit}` };
}

/** How a check command ended. The output is whatever it printed, cut by the host. */
export type BenchmarkCommandOutcome =
  | { readonly status: "exited"; readonly exitCode: number; readonly output: string }
  | { readonly status: "timed-out"; readonly output: string }
  | { readonly status: "unavailable"; readonly message: string };

/**
 * A worktree check on a command. Only the first 4 KB of output is read and only
 * 200 characters of it are kept, as the detail of a failure.
 */
export function benchmarkCommandResult(
  index: number,
  outcome: BenchmarkCommandOutcome,
): BenchmarkCheckResult {
  if (outcome.status === "unavailable") {
    return {
      index,
      passed: false,
      detail: boundedBenchmarkReason(outcome.message, BENCHMARK_CHECK_DETAIL_CHARS),
    };
  }
  const output = outcome.output.slice(0, BENCHMARK_COMMAND_OUTPUT_BYTES);
  if (outcome.status === "exited" && outcome.exitCode === 0) return { index, passed: true };
  const lead = outcome.status === "timed-out" ? "timed out" : `exit ${outcome.exitCode}`;
  const tail = boundedBenchmarkReason(output, BENCHMARK_CHECK_DETAIL_CHARS);
  return {
    index,
    passed: false,
    detail: boundedBenchmarkReason(
      tail === "" ? lead : `${lead}: ${tail}`,
      BENCHMARK_CHECK_DETAIL_CHARS,
    ),
  };
}

export type BenchmarkJudgeReading =
  | { readonly status: "scored"; readonly score: number; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

const JUDGE_UNPARSEABLE = "The judge did not answer in the expected form";

/**
 * Reads the judge's reply strictly. The first top-level JSON object in the text
 * is the answer, so prose around it is allowed; its score must be an integer
 * from 1 to 10 and its reason a string, which is cut to the stored bound. Any
 * other shape is a failed judgement, never a guessed score.
 */
export function parseBenchmarkJudgeReply(text: string): BenchmarkJudgeReading {
  const failed = { status: "failed", reason: JUDGE_UNPARSEABLE } as const;
  const json = firstJsonObject(text);
  if (json === undefined) return failed;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return failed;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return failed;
  const { score, reason } = value as { score?: unknown; reason?: unknown };
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 10) {
    return failed;
  }
  if (typeof reason !== "string") return failed;
  return {
    status: "scored",
    score,
    reason: boundedBenchmarkReason(reason, BENCHMARK_JUDGE_REASON_CHARS),
  };
}

/** The text of the first balanced `{...}`, reading strings so braces inside them do not count. */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * Sums the figures of the judge turns. A turn that reported no usage still
 * counts as a turn.
 */
export function benchmarkOverhead(
  judgeTurns: ReadonlyArray<BenchmarkCellMetrics>,
): BenchmarkOverhead {
  let tokens = 0;
  let costUsd = 0;
  for (const metrics of judgeTurns) {
    tokens += metrics.totalTokens ?? 0;
    costUsd += metrics.costUsd ?? 0;
  }
  return { turns: judgeTurns.length, tokens, costUsd };
}

/** Keeps a reason inside the stored bound, on one line. */
export function boundedBenchmarkReason(
  reason: string,
  maximum: number = BENCHMARK_FAILURE_REASON_CHARS,
): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maximum) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

/** One cell's figures, read from the turn the host recorded for its thread. */
export function benchmarkCellMetrics(record: TurnMetricsRecord): BenchmarkCellMetrics {
  const { metrics, usage, diagnostics } = record;
  const tokensPerSecond =
    metrics.decodeOutputTokens !== undefined && metrics.decodeMs !== undefined
      ? Math.round((metrics.decodeOutputTokens / metrics.decodeMs) * 10_000) / 10
      : undefined;
  const cost = usage?.costUsd ?? usage?.estimatedCostUsd ?? undefined;
  return {
    stopReason: record.stopReason,
    wallMs: metrics.wallMs,
    ...(metrics.timeToFirstTokenMs === undefined
      ? {}
      : { timeToFirstTokenMs: metrics.timeToFirstTokenMs }),
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
    ...(usage === undefined
      ? {}
      : {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
        }),
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(diagnostics === undefined
      ? {}
      : { toolCalls: diagnostics.toolCalls, toolFailures: diagnostics.toolFailures }),
  };
}

function mean(values: ReadonlyArray<number>): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * One row per contender. Figures that were not measured are absent, never
 * zero: a contender with no tool calls has no failure rate, and one whose
 * provider reported no cost has no cost.
 */
export function benchmarkLeaderboard(
  run: Pick<BenchmarkRun, "cells" | "contenders">,
  metricsByThread: ReadonlyMap<string, BenchmarkCellMetrics>,
): ReadonlyArray<BenchmarkLeaderboardRow> {
  return run.contenders.map((_, contenderIndex) => {
    const cells = run.cells.filter((cell) => cell.contenderIndex === contenderIndex);
    const answeredCells = cells.filter((cell) => cell.state === "answered");
    let passed = 0;
    let scored = 0;
    for (const cell of answeredCells) {
      for (const check of cell.checks) {
        scored += 1;
        if (check.passed) passed += 1;
      }
    }
    const judgeScores = cells.flatMap((cell) =>
      cell.judge?.status === "scored" ? [cell.judge.score] : [],
    );
    const stars = cells.flatMap((cell) => (cell.rating === undefined ? [] : [cell.rating.stars]));
    const measured = cells.flatMap((cell) => {
      const metrics = cell.threadId === undefined ? undefined : metricsByThread.get(cell.threadId);
      return metrics === undefined ? [] : [metrics];
    });
    const firstTokens = measured.flatMap((metrics) =>
      metrics.timeToFirstTokenMs === undefined ? [] : [metrics.timeToFirstTokenMs],
    );
    const speeds = measured.flatMap((metrics) =>
      metrics.tokensPerSecond === undefined ? [] : [metrics.tokensPerSecond],
    );
    const tokens = measured.flatMap((metrics) =>
      metrics.totalTokens === undefined ? [] : [metrics.totalTokens],
    );
    const costs = measured.flatMap((metrics) =>
      metrics.costUsd === undefined ? [] : [metrics.costUsd],
    );
    const toolCalls = measured.reduce((sum, metrics) => sum + (metrics.toolCalls ?? 0), 0);
    const toolFailures = measured.reduce((sum, metrics) => sum + (metrics.toolFailures ?? 0), 0);
    const meanJudgeScore = mean(judgeScores);
    const meanStars = mean(stars);
    const firstTokenP50Ms = percentile(firstTokens, 0.5);
    const firstTokenP95Ms = percentile(firstTokens, 0.95);
    const tokensPerSecondP50 = percentile(speeds, 0.5);
    const tokensPerSecondP95 = percentile(speeds, 0.95);
    const meanTokens = mean(tokens);
    const totalCostUsd = costs.length === 0 ? undefined : costs.reduce((a, b) => a + b, 0);
    return {
      contenderIndex,
      cells: cells.length,
      answered: answeredCells.length,
      ...(scored === 0 ? {} : { checkPassRate: passed / scored }),
      ...(meanJudgeScore === undefined ? {} : { meanJudgeScore }),
      ...(meanStars === undefined ? {} : { meanStars }),
      ...(firstTokenP50Ms === undefined ? {} : { firstTokenP50Ms }),
      ...(firstTokenP95Ms === undefined ? {} : { firstTokenP95Ms }),
      ...(tokensPerSecondP50 === undefined ? {} : { tokensPerSecondP50 }),
      ...(tokensPerSecondP95 === undefined ? {} : { tokensPerSecondP95 }),
      totalTokens: tokens.reduce((a, b) => a + b, 0),
      ...(meanTokens === undefined ? {} : { meanTokens }),
      ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
      ...(toolCalls === 0 ? {} : { toolFailureRate: toolFailures / toolCalls }),
      failedCount: cells.filter((cell) => cell.state === "failed").length,
      blockedCount: cells.filter((cell) => cell.state === "blocked-on-approval").length,
    };
  });
}

export function summarizeBenchmarkRun(run: BenchmarkRun): BenchmarkRunSummary {
  return {
    runId: run.runId,
    suiteId: run.suiteId,
    suiteName: run.suiteName,
    suiteRevision: run.suiteRevision,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(run.endReason === undefined ? {} : { endReason: run.endReason }),
    contenderCount: run.contenders.length,
    repetitions: run.repetitions,
    cellCount: run.cells.length,
    settledCount: run.cells.filter((cell) => cell.state !== "queued" && cell.state !== "running")
      .length,
    answeredCount: run.cells.filter((cell) => cell.state === "answered").length,
    failedCount: run.cells.filter((cell) => cell.state === "failed").length,
  };
}

/**
 * A suite's runs, newest first and at most the history limit, each reduced to
 * one row per contender by the leaderboard function. Contenders are identified
 * by what they are, so a page can follow one model across runs.
 */
export function benchmarkHistory(
  runs: ReadonlyArray<BenchmarkRun>,
  metricsForRun: (run: BenchmarkRun) => ReadonlyMap<string, BenchmarkCellMetrics>,
): ReadonlyArray<BenchmarkHistoryRun> {
  return [...runs]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .slice(0, MAX_BENCHMARK_HISTORY_RUNS)
    .map((run) => {
      const leaderboard = benchmarkLeaderboard(run, metricsForRun(run));
      return {
        runId: run.runId,
        startedAt: run.startedAt,
        status: run.status,
        suiteRevision: run.suiteRevision,
        rows: leaderboard.flatMap((row) => {
          const contender = run.contenders[row.contenderIndex];
          if (contender === undefined) return [];
          return [
            {
              contender,
              cells: row.cells,
              answered: row.answered,
              ...(row.checkPassRate === undefined ? {} : { checkPassRate: row.checkPassRate }),
              ...(row.meanJudgeScore === undefined ? {} : { meanJudgeScore: row.meanJudgeScore }),
              ...(row.meanStars === undefined ? {} : { meanStars: row.meanStars }),
              ...(row.firstTokenP50Ms === undefined
                ? {}
                : { firstTokenP50Ms: row.firstTokenP50Ms }),
              ...(row.tokensPerSecondP50 === undefined
                ? {}
                : { tokensPerSecondP50: row.tokensPerSecondP50 }),
              totalTokens: row.totalTokens,
              ...(row.totalCostUsd === undefined ? {} : { totalCostUsd: row.totalCostUsd }),
              failedCount: row.failedCount,
            },
          ];
        }),
      };
    });
}

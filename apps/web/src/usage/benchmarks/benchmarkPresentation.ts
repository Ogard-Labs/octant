import { ParseResult } from "effect";
import {
  decodeBenchmarkSuite,
  decodeBenchmarkSuiteSaveRequest,
  MAX_BENCHMARK_CELLS,
  type BenchmarkCase,
  type BenchmarkCellState,
  type BenchmarkCheck,
  type BenchmarkLeaderboardRow,
  type BenchmarkRegexFlags,
  type BenchmarkRunStatus,
  type BenchmarkSuite,
  type BenchmarkSuiteSaveRequest,
  type TurnDiagnosticsReport,
} from "@octant/contracts";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBarListBlock,
  type CanvasChartBlock,
} from "@octant/contracts/canvas";

/** What a cell's state is called on the page, beside its icon. */
export const CELL_STATE_WORDS: Readonly<Record<BenchmarkCellState, string>> = {
  queued: "Queued",
  running: "Running",
  answered: "Answered",
  failed: "Failed",
  "blocked-on-approval": "Blocked on approval",
  cancelled: "Cancelled",
  "skipped-budget": "Skipped, budget reached",
};

export const RUN_STATUS_WORDS: Readonly<Record<BenchmarkRunStatus, string>> = {
  running: "Running",
  finished: "Finished",
  cancelled: "Cancelled",
  "budget-reached": "Budget reached",
  failed: "Failed",
};

export const READ_ONLY_WINDOW_SENTENCE = "Only this Mac's window can edit benchmarks.";

/** Reads in the same words everywhere on the page: a figure never measured is a dash. */
export const NO_FIGURE = "—";

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return NO_FIGURE;
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

export function formatTokens(tokens: number | undefined): string {
  return tokens === undefined ? NO_FIGURE : tokens.toLocaleString("en");
}

export function formatRatio(ratio: number | undefined): string {
  if (ratio === undefined) return NO_FIGURE;
  if (ratio > 0 && ratio < 0.01) return "<1%";
  return `${Math.round(ratio * 100)}%`;
}

export function formatSpeed(value: number | undefined): string {
  return value === undefined ? NO_FIGURE : `${value.toFixed(value < 10 ? 1 : 0)} tok/s`;
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return NO_FIGURE;
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/** The judge's own cost, kept apart from every contender's figures. */
export function formatOverhead(overhead: {
  readonly turns: number;
  readonly tokens: number;
  readonly costUsd: number;
}): string {
  const tokens = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(overhead.tokens);
  const cost =
    overhead.costUsd < 0.01 ? formatUsd(overhead.costUsd) : `$${overhead.costUsd.toFixed(2)}`;
  return `Judge: ${overhead.turns} ${overhead.turns === 1 ? "turn" : "turns"} · ${tokens} tokens · ${cost}`;
}

export function formatScore(value: number | undefined): string {
  return value === undefined ? NO_FIGURE : value.toFixed(1);
}

// ── Contenders ─────────────────────────────────────────────────────────────

export interface ContenderNames {
  readonly instanceName: (instanceId: string) => string;
  readonly modelName: (instanceId: string, modelId: string) => string;
}

/** A contender as the page holds it before the contract brands its ids. */
export interface ContenderRef {
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly effort?: string | undefined;
}

export function contenderLabel(contender: ContenderRef, names: ContenderNames): string {
  const instanceId = String(contender.providerInstanceId);
  const modelId = String(contender.modelId);
  const base = `${names.instanceName(instanceId)} · ${names.modelName(instanceId, modelId)}`;
  return contender.effort === undefined ? base : `${base} (${contender.effort})`;
}

export function contenderKey(instanceId: string, modelId: string): string {
  return `${instanceId}\u0000${modelId}`;
}

// ── Leaderboard ────────────────────────────────────────────────────────────

export type LeaderboardColumn =
  | "contender"
  | "checkPassRate"
  | "meanJudgeScore"
  | "meanStars"
  | "firstTokenP50Ms"
  | "firstTokenP95Ms"
  | "tokensPerSecondP50"
  | "tokensPerSecondP95"
  | "totalTokens"
  | "totalCostUsd"
  | "toolFailureRate"
  | "failedCount";

export type SortDirection = "ascending" | "descending";

/** Which way is better for a column, so its first click puts the best contender on top. */
export const COLUMN_BEST_FIRST: Readonly<Record<LeaderboardColumn, SortDirection>> = {
  contender: "ascending",
  checkPassRate: "descending",
  meanJudgeScore: "descending",
  meanStars: "descending",
  firstTokenP50Ms: "ascending",
  firstTokenP95Ms: "ascending",
  tokensPerSecondP50: "descending",
  tokensPerSecondP95: "descending",
  totalTokens: "ascending",
  totalCostUsd: "ascending",
  toolFailureRate: "ascending",
  failedCount: "ascending",
};

/**
 * Orders rows by one column. A contender with no reading for it goes last in
 * either direction, because a missing figure is not the best or the worst.
 */
export function sortLeaderboard(
  rows: ReadonlyArray<BenchmarkLeaderboardRow>,
  column: LeaderboardColumn,
  direction: SortDirection,
  labelOf: (row: BenchmarkLeaderboardRow) => string,
): ReadonlyArray<BenchmarkLeaderboardRow> {
  const sign = direction === "ascending" ? 1 : -1;
  const reading = (row: BenchmarkLeaderboardRow): number | string | undefined =>
    column === "contender" ? labelOf(row) : row[column];
  return [...rows].sort((left, right) => {
    const a = reading(left);
    const b = reading(right);
    if (a === undefined && b === undefined) return left.contenderIndex - right.contenderIndex;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    const order =
      typeof a === "string" && typeof b === "string"
        ? a.localeCompare(b)
        : Number(a) === Number(b)
          ? 0
          : Number(a) < Number(b)
            ? -1
            : 1;
    return order === 0 ? left.contenderIndex - right.contenderIndex : order * sign;
  });
}

export interface LeaderboardHeadline {
  readonly label: string;
  readonly contender: string;
  readonly reading: string;
}

/** The best pass rate, the fastest typical first token, and the cheapest run. */
export function leaderboardHeadline(
  rows: ReadonlyArray<BenchmarkLeaderboardRow>,
  labelOf: (row: BenchmarkLeaderboardRow) => string,
): ReadonlyArray<LeaderboardHeadline> {
  const best = (
    pick: (row: BenchmarkLeaderboardRow) => number | undefined,
    better: "high" | "low",
  ): BenchmarkLeaderboardRow | undefined => {
    let winner: BenchmarkLeaderboardRow | undefined;
    for (const row of rows) {
      const value = pick(row);
      if (value === undefined) continue;
      const current = winner === undefined ? undefined : pick(winner);
      if (current === undefined || (better === "high" ? value > current : value < current)) {
        winner = row;
      }
    }
    return winner;
  };
  const headlines: LeaderboardHeadline[] = [];
  const passing = best((row) => row.checkPassRate, "high");
  if (passing !== undefined) {
    headlines.push({
      label: "Best pass rate",
      contender: labelOf(passing),
      reading: formatRatio(passing.checkPassRate),
    });
  }
  const fastest = best((row) => row.firstTokenP50Ms, "low");
  if (fastest !== undefined) {
    headlines.push({
      label: "Fastest first token",
      contender: labelOf(fastest),
      reading: formatDuration(fastest.firstTokenP50Ms),
    });
  }
  const cheapest = best((row) => row.totalCostUsd, "low");
  if (cheapest !== undefined) {
    headlines.push({
      label: "Cheapest",
      contender: labelOf(cheapest),
      reading: formatUsd(cheapest.totalCostUsd),
    });
  }
  return headlines;
}

export interface ComparisonBlocks {
  readonly passRate: CanvasBarListBlock | undefined;
  readonly speed: CanvasBarListBlock | undefined;
  readonly cost: CanvasBarListBlock | undefined;
}

/** Ranked bars for the comparisons a table of figures makes hard to see. */
export function comparisonBlocks(
  rows: ReadonlyArray<BenchmarkLeaderboardRow>,
  labelOf: (row: BenchmarkLeaderboardRow) => string,
): ComparisonBlocks {
  return {
    passRate: barList(
      "pass-rate",
      rows.flatMap((row) =>
        row.checkPassRate === undefined ? [] : [{ label: labelOf(row), value: row.checkPassRate }],
      ),
      "Check pass rate",
      undefined,
      "percent",
    ),
    speed: barList(
      "speed",
      rows.flatMap((row) =>
        row.tokensPerSecondP50 === undefined
          ? []
          : [
              {
                label: labelOf(row),
                value: row.tokensPerSecondP50,
                ...(row.tokensPerSecondP95 === undefined
                  ? {}
                  : { secondaryValue: row.tokensPerSecondP95 }),
              },
            ],
      ),
      "Typical (p50), tokens per second",
      "Fast (p95), tokens per second",
      "number",
    ),
    cost: barList(
      "cost",
      rows.flatMap((row) =>
        row.totalCostUsd === undefined ? [] : [{ label: labelOf(row), value: row.totalCostUsd }],
      ),
      "Cost, US dollars",
      undefined,
      "number",
    ),
  };
}

function barList(
  id: string,
  rows: ReadonlyArray<{
    readonly label: string;
    readonly value: number;
    readonly secondaryValue?: number;
  }>,
  valueLabel: string,
  secondaryLabel: string | undefined,
  format: "number" | "percent",
): CanvasBarListBlock | undefined {
  if (rows.length === 0) return undefined;
  // Every block passes the Canvas schema before it is drawn, so a label past a
  // bound drops that one chart rather than breaking the page.
  try {
    const block = decodeCanvasBlock({
      blockId: `benchmarks-${id}`,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "bar-list",
      rows,
      valueLabel,
      ...(secondaryLabel === undefined ? {} : { secondaryLabel }),
      format,
      scale: "neutral",
    });
    return block.kind === "bar-list" ? block : undefined;
  } catch {
    return undefined;
  }
}

// ── Estimate ───────────────────────────────────────────────────────────────

export interface CostEstimate {
  readonly cells: number;
  /** Absent when no contender has history to price a turn from. */
  readonly usd: number | undefined;
  /** Contenders the estimate could not price. */
  readonly unpriced: ReadonlyArray<ContenderRef>;
}

/**
 * Cells times each contender's mean cost per turn, read from the diagnostics
 * report's model rows. A contender that cannot be priced is left out and named,
 * so the figure is never a quiet undercount.
 */
export function estimateRunCost(input: {
  readonly report: TurnDiagnosticsReport | undefined;
  readonly contenders: ReadonlyArray<ContenderRef>;
  readonly caseCount: number;
  readonly repetitions: number;
}): CostEstimate {
  const perContender = input.caseCount * input.repetitions;
  let usd: number | undefined;
  const unpriced: ContenderRef[] = [];
  for (const contender of input.contenders) {
    const row = input.report?.models.find(
      (candidate) =>
        String(candidate.providerInstanceId) === String(contender.providerInstanceId) &&
        String(candidate.modelId) === String(contender.modelId),
    );
    // The cost sum covers only the turns that reported one, so the mean divides
    // by that count; a row with none cannot price the contender.
    const priced = row?.costTurns;
    if (row === undefined || row.costUsd === undefined || priced === undefined || priced === 0) {
      unpriced.push(contender);
      continue;
    }
    usd = (usd ?? 0) + (row.costUsd / priced) * perContender;
  }
  return { cells: perContender * input.contenders.length, usd, unpriced };
}

export function cellCountWithinLimit(cells: number): boolean {
  return cells <= MAX_BENCHMARK_CELLS;
}

// ── Suite drafts ───────────────────────────────────────────────────────────

export type CheckKind = BenchmarkCheck["kind"];

export const CHECK_KIND_WORDS: Readonly<Record<CheckKind, string>> = {
  contains: "Contains text",
  "not-contains": "Does not contain text",
  matches: "Matches pattern",
  equals: "Equals text",
  "valid-json": "Is valid JSON",
  "command-exits-zero": "Command exits with zero",
  "max-files-changed": "Changes at most this many files",
};

export const PROMPT_CHECK_KINDS: ReadonlyArray<CheckKind> = [
  "contains",
  "not-contains",
  "matches",
  "equals",
  "valid-json",
];
export const CODE_CHECK_KINDS: ReadonlyArray<CheckKind> = [
  ...PROMPT_CHECK_KINDS,
  "command-exits-zero",
  "max-files-changed",
];

export const REGEX_FLAGS: ReadonlyArray<BenchmarkRegexFlags> = [
  "",
  "i",
  "m",
  "s",
  "im",
  "is",
  "ms",
  "ims",
];

export interface CheckDraft {
  readonly key: string;
  readonly kind: CheckKind;
  readonly text: string;
  readonly caseSensitive: boolean;
  readonly pattern: string;
  readonly flags: BenchmarkRegexFlags;
  readonly trim: boolean;
  readonly command: string;
  readonly timeoutSeconds: string;
  readonly count: string;
}

export interface CaseDraft {
  readonly key: string;
  readonly caseId: string;
  readonly kind: "prompt" | "code";
  readonly title: string;
  readonly prompt: string;
  readonly referenceAnswer: string;
  readonly rubric: string;
  readonly codeProjectId: string;
  readonly ref: string;
  readonly checks: ReadonlyArray<CheckDraft>;
}

export interface JudgeDraft {
  readonly enabled: boolean;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly rubric: string;
}

export interface SuiteDraft {
  readonly suiteId: string;
  readonly expectedRevision: number | undefined;
  readonly name: string;
  readonly description: string;
  readonly cases: ReadonlyArray<CaseDraft>;
  readonly judge: JudgeDraft;
}

export function mintId(): string {
  return globalThis.crypto.randomUUID();
}

export function blankCheck(kind: CheckKind = "contains"): CheckDraft {
  return {
    key: mintId(),
    kind,
    text: "",
    caseSensitive: false,
    pattern: "",
    flags: "",
    trim: true,
    command: "",
    timeoutSeconds: "60",
    count: "5",
  };
}

export function blankCase(kind: "prompt" | "code" = "prompt"): CaseDraft {
  return {
    key: mintId(),
    caseId: mintId(),
    kind,
    title: "",
    prompt: "",
    referenceAnswer: "",
    rubric: "",
    codeProjectId: "",
    ref: "main",
    checks: [],
  };
}

export function blankSuiteDraft(): SuiteDraft {
  return {
    suiteId: mintId(),
    expectedRevision: undefined,
    name: "",
    description: "",
    cases: [blankCase()],
    judge: { enabled: false, providerInstanceId: "", modelId: "", rubric: "" },
  };
}

function checkToDraft(check: BenchmarkCheck): CheckDraft {
  const base = blankCheck(check.kind);
  switch (check.kind) {
    case "contains":
    case "not-contains":
      return { ...base, text: check.text, caseSensitive: check.caseSensitive };
    case "matches":
      return { ...base, pattern: check.pattern, flags: check.flags };
    case "equals":
      return { ...base, text: check.text, trim: check.trim };
    case "valid-json":
      return base;
    case "command-exits-zero":
      return {
        ...base,
        command: check.command,
        timeoutSeconds: String(check.timeoutSeconds),
      };
    case "max-files-changed":
      return { ...base, count: String(check.count) };
  }
}

function caseToDraft(benchmarkCase: BenchmarkCase, keepIds: boolean): CaseDraft {
  const base = blankCase(benchmarkCase.kind);
  return {
    ...base,
    caseId: keepIds ? String(benchmarkCase.caseId) : base.caseId,
    title: benchmarkCase.title,
    prompt: benchmarkCase.prompt,
    referenceAnswer: benchmarkCase.referenceAnswer ?? "",
    rubric: benchmarkCase.rubric ?? "",
    codeProjectId: benchmarkCase.code === undefined ? "" : String(benchmarkCase.code.codeProjectId),
    ref: benchmarkCase.code?.ref ?? "main",
    checks: benchmarkCase.checks.map(checkToDraft),
  };
}

/** A saved suite opened for editing; the draft names the revision it was made from. */
export function suiteToDraft(suite: BenchmarkSuite): SuiteDraft {
  return {
    suiteId: String(suite.suiteId),
    expectedRevision: suite.revision,
    name: suite.name,
    description: suite.description ?? "",
    cases: suite.cases.map((benchmarkCase) => caseToDraft(benchmarkCase, true)),
    judge:
      suite.judge === undefined
        ? { enabled: false, providerInstanceId: "", modelId: "", rubric: "" }
        : {
            enabled: true,
            providerInstanceId: String(suite.judge.providerInstanceId),
            modelId: String(suite.judge.modelId),
            rubric: suite.judge.rubric,
          },
  };
}

/** An imported suite becomes a new one: fresh ids, no revision to answer for. */
export function importedSuiteToDraft(suite: BenchmarkSuite): SuiteDraft {
  const draft = suiteToDraft(suite);
  return {
    ...draft,
    suiteId: mintId(),
    expectedRevision: undefined,
    cases: suite.cases.map((benchmarkCase) => caseToDraft(benchmarkCase, false)),
  };
}

const SUITE_NAME_LIMIT = 80;

/**
 * A suite imported next to one of the same name gets a suffix, so the two rows
 * can be told apart. The base shrinks before the suffix does, so the result
 * still fits the name limit.
 */
export function nameForImportedSuite(name: string, existing: ReadonlyArray<string>): string {
  const taken = new Set(existing);
  if (!taken.has(name)) return name;
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? " (imported)" : ` (imported ${attempt})`;
    const candidate = `${name.slice(0, SUITE_NAME_LIMIT - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type DraftResult =
  | { readonly status: "ok"; readonly request: BenchmarkSuiteSaveRequest }
  | { readonly status: "invalid"; readonly message: string };

function wholeNumber(text: string): number | undefined {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;
}

function checkToRaw(
  check: CheckDraft,
  where: string,
): { readonly raw: unknown } | { readonly message: string } {
  switch (check.kind) {
    case "contains":
    case "not-contains":
      if (check.text.trim() === "") return { message: `${where} needs the text to look for.` };
      return {
        raw: { kind: check.kind, text: check.text.trim(), caseSensitive: check.caseSensitive },
      };
    case "equals":
      if (check.text.trim() === "") return { message: `${where} needs the text to compare to.` };
      // The contract stores trimmed text only, so an exact match on surrounding
      // space cannot be saved; saying so beats trimming it behind the person's back.
      if (!check.trim && check.text !== check.text.trim()) {
        return {
          message: `${where} has spaces around its text, and surrounding spaces can't be matched exactly. Remove them or tick "Ignore surrounding space".`,
        };
      }
      return { raw: { kind: "equals", text: check.text.trim(), trim: check.trim } };
    case "matches": {
      if (check.pattern.trim() === "") return { message: `${where} needs a pattern.` };
      try {
        new RegExp(check.pattern.trim(), check.flags);
      } catch {
        return { message: `${where} has a pattern that is not a valid regular expression.` };
      }
      return { raw: { kind: "matches", pattern: check.pattern.trim(), flags: check.flags } };
    }
    case "valid-json":
      return { raw: { kind: "valid-json" } };
    case "command-exits-zero": {
      if (check.command.trim() === "") return { message: `${where} needs a command.` };
      const seconds = wholeNumber(check.timeoutSeconds);
      if (seconds === undefined || seconds < 1 || seconds > 600) {
        return { message: `${where} needs a time limit between 1 and 600 seconds.` };
      }
      return { raw: { kind: check.kind, command: check.command.trim(), timeoutSeconds: seconds } };
    }
    case "max-files-changed": {
      const count = wholeNumber(check.count);
      if (count === undefined || count > 10_000) {
        return { message: `${where} needs a whole number of files, 0 to 10,000.` };
      }
      return { raw: { kind: check.kind, count } };
    }
  }
}

/**
 * The person's edit as a save request. Every refusal is a sentence that names
 * the case and check, and the contract has the last word on the whole shape.
 */
export function draftToSaveRequest(draft: SuiteDraft): DraftResult {
  if (draft.name.trim() === "") return invalid("The suite needs a name.");
  if (draft.cases.length === 0) return invalid("The suite needs at least one case.");
  const cases: unknown[] = [];
  for (const [caseIndex, candidate] of draft.cases.entries()) {
    const label =
      candidate.title.trim() === "" ? `Case ${caseIndex + 1}` : `Case "${candidate.title.trim()}"`;
    if (candidate.title.trim() === "") return invalid(`${label} needs a title.`);
    if (candidate.prompt.trim() === "") return invalid(`${label} needs a prompt.`);
    if (candidate.kind === "code") {
      if (candidate.codeProjectId === "") return invalid(`${label} needs a Code Project.`);
      if (candidate.ref.trim() === "") return invalid(`${label} needs a branch or tag.`);
    }
    const checks: unknown[] = [];
    for (const [checkIndex, check] of candidate.checks.entries()) {
      const where = `Check ${checkIndex + 1} of ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
      if (candidate.kind === "prompt" && !PROMPT_CHECK_KINDS.includes(check.kind)) {
        return invalid(
          `${where} runs in a worktree, so only a Code case can have it. Remove it or make this a Code case.`,
        );
      }
      const outcome = checkToRaw(check, where);
      if ("message" in outcome) return invalid(outcome.message);
      checks.push(outcome.raw);
    }
    cases.push({
      caseId: candidate.caseId,
      kind: candidate.kind,
      title: candidate.title.trim(),
      prompt: candidate.prompt.trim(),
      checks,
      ...(candidate.referenceAnswer.trim() === ""
        ? {}
        : { referenceAnswer: candidate.referenceAnswer }),
      ...(candidate.rubric.trim() === "" ? {} : { rubric: candidate.rubric.trim() }),
      ...(candidate.kind === "code"
        ? { code: { codeProjectId: candidate.codeProjectId, ref: candidate.ref.trim() } }
        : {}),
    });
  }
  if (draft.judge.enabled) {
    if (draft.judge.providerInstanceId === "" || draft.judge.modelId === "") {
      return invalid("The judge needs a provider instance and a model.");
    }
    if (draft.judge.rubric.trim() === "") return invalid("The judge needs a rubric.");
  }
  try {
    return {
      status: "ok",
      request: decodeBenchmarkSuiteSaveRequest({
        suiteId: draft.suiteId,
        ...(draft.expectedRevision === undefined
          ? {}
          : { expectedRevision: draft.expectedRevision }),
        name: draft.name.trim(),
        ...(draft.description.trim() === "" ? {} : { description: draft.description.trim() }),
        cases,
        ...(draft.judge.enabled
          ? {
              judge: {
                providerInstanceId: draft.judge.providerInstanceId,
                modelId: draft.judge.modelId,
                rubric: draft.judge.rubric.trim(),
              },
            }
          : {}),
      }),
    };
  } catch (error) {
    return invalid(`The suite does not fit the benchmark format: ${decodeFailure(error)}`);
  }
}

function invalid(message: string): DraftResult {
  return { status: "invalid", message };
}

/** The first thing a failed decode says, as a plain clause with its path. */
export function decodeFailure(error: unknown): string {
  let first: { readonly path: ReadonlyArray<PropertyKey>; readonly message: string } | undefined;
  if (ParseResult.isParseError(error)) {
    try {
      first = ParseResult.ArrayFormatter.formatErrorSync(error)[0];
    } catch {
      first = undefined;
    }
  }
  if (first !== undefined) {
    const path = first.path.map(String).join(".");
    return path === "" ? `${first.message}.` : `${path}: ${first.message}.`;
  }
  const text = error instanceof Error ? error.message : String(error);
  return `${(text.split("\n")[0] ?? "").slice(0, 200)}.`;
}

export type ImportResult =
  | { readonly status: "ok"; readonly draft: SuiteDraft }
  | { readonly status: "invalid"; readonly message: string };

/** Reads a suite file or pasted JSON through the contract; a failure is one sentence. */
export function importSuiteJson(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid", message: "This is not JSON, so it cannot be a benchmark suite." };
  }
  try {
    return { status: "ok", draft: importedSuiteToDraft(decodeBenchmarkSuite(parsed)) };
  } catch (error) {
    return {
      status: "invalid",
      message: `This is not a benchmark suite: ${decodeFailure(error)}`,
    };
  }
}

export function exportSuiteJson(suite: BenchmarkSuite): string {
  return `${JSON.stringify(suite, null, 2)}\n`;
}

export function exportFileName(suite: BenchmarkSuite): string {
  const slug = suite.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug === "" ? "benchmark-suite" : slug}.json`;
}

// ── History ────────────────────────────────────────────────────────────────

export interface HistoryRunLike {
  readonly runId: string;
  readonly startedAt: string;
  readonly rows: ReadonlyArray<{
    readonly contender: ContenderRef;
    readonly checkPassRate?: number | undefined;
    readonly meanJudgeScore?: number | undefined;
  }>;
}

/** The same model with the same effort is one line, whichever run it ran in. */
export function historyContenderKey(contender: ContenderRef): string {
  return `${contenderKey(String(contender.providerInstanceId), String(contender.modelId))}\u0000${contender.effort ?? ""}`;
}

export interface HistoryChart {
  readonly block: CanvasChartBlock | undefined;
  /** Some contender has no reading in every run, so the chart leaves it out. */
  readonly leftOut: boolean;
}

export interface HistoryCharts {
  readonly checkPassRate: HistoryChart;
  readonly judgeScore: HistoryChart;
}

export const HISTORY_LEFT_OUT_NOTE =
  "Shown only where a model ran in every run; see the table for all.";

/**
 * Check pass rate and mean judge score per contender over the suite's runs,
 * oldest on the left. The Canvas chart places points by position and has no
 * gap, so a contender is drawn only when it has a reading in every run;
 * drawing it over fewer points would put it at another run's position. The
 * others are reported as left out, and the table still lists them. Each block
 * passes the Canvas schema, so one that does not fit is dropped rather than
 * breaking the page.
 */
export function historyCharts(
  runs: ReadonlyArray<HistoryRunLike>,
  names: ContenderNames,
): HistoryCharts {
  const oldestFirst = [...runs].reverse();
  const seen = new Set<string>();
  const labels = oldestFirst.map((run) => {
    const base = new Date(run.startedAt).toLocaleString("en", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    let label = base;
    for (let n = 2; seen.has(label); n += 1) label = `${base} (${n})`;
    seen.add(label);
    return label;
  });
  const build = (
    id: string,
    title: string,
    format: "percent" | "number",
    pick: (row: HistoryRunLike["rows"][number]) => number | undefined,
  ): HistoryChart => {
    const byContender = new Map<
      string,
      { label: string; points: Array<{ x: string; y: number }> }
    >();
    oldestFirst.forEach((run, runIndex) => {
      for (const row of run.rows) {
        const value = pick(row);
        if (value === undefined) continue;
        const key = historyContenderKey(row.contender);
        const entry = byContender.get(key) ?? {
          label: contenderLabel(row.contender, names),
          points: [],
        };
        entry.points.push({ x: labels[runIndex] ?? run.startedAt, y: value });
        byContender.set(key, entry);
      }
    });
    const complete = [...byContender.values()].filter(
      (entry) => entry.points.length === oldestFirst.length,
    );
    const leftOut = complete.length < byContender.size;
    if (complete.length === 0) return { block: undefined, leftOut };
    try {
      const block = decodeCanvasBlock({
        blockId: `benchmarks-history-${id}`,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "chart",
        chartType: "line",
        title,
        format,
        series: complete.map((entry, index) => ({
          seriesId: `contender-${index + 1}`,
          label: entry.label,
          points: entry.points,
        })),
      });
      return { block: block.kind === "chart" ? block : undefined, leftOut };
    } catch {
      return { block: undefined, leftOut };
    }
  };
  return {
    checkPassRate: build(
      "check-pass-rate",
      "Check pass rate by run",
      "percent",
      (row) => row.checkPassRate,
    ),
    judgeScore: build(
      "judge-score",
      "Mean judge score by run",
      "number",
      (row) => row.meanJudgeScore,
    ),
  };
}

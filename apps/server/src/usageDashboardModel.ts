import type {
  UsageActivityCell,
  UsageActivityState,
  UsageAttributionDimension,
  UsageAttributionEntry,
  UsageBreakdownGroup,
  UsageBreakdownRow,
  UsageCoverageSlice,
  UsageDashboardResponse,
  UsageDetailRow,
  UsageDimensionSource,
  UsageHostCoverage,
  UsageQuality,
} from "@octant/contracts";

/**
 * One durable usage row as the host read it, before the dashboard decides
 * whether it may enter an aggregate. Optional fields are absent — never zero —
 * when the host has no recorded source for that dimension.
 */
export interface UsageDashboardSourceRow {
  readonly reconciliationId: string;
  readonly hostId: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly requestShape: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly quality: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly plannedInputTokens: number;
  readonly varianceTokens: number;
  readonly reasoningTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly providerExecutionDurationMs?: number;
  readonly attribution: ReadonlyArray<UsageAttributionEntry>;
  readonly observedAt: string;
  readonly mode?: string;
  readonly projectId?: string;
}

export interface BuildUsageDashboardOptions {
  readonly queryAt: string;
  readonly timeZone: string;
  readonly detailLimit: number;
  readonly breakdownLimit: number;
  /** Rows the host could not even read (malformed JSON, unsupported schema). */
  readonly unreadableRecordCount?: number;
  /** True when the durable scan hit its bound before exhausting the range. */
  readonly scanTruncated?: boolean;
  readonly staleThresholdMs?: number;
}

/** Matches `classifyUsageQuality`, so a host and a record age out together. */
const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** One year of daily cells keeps a heatmap bounded without hiding a normal year. */
const MAX_ACTIVITY_CELLS = 371;

const DAY_MS = 24 * 60 * 60 * 1000;

const QUALITIES: ReadonlyArray<UsageQuality> = [
  "exact",
  "estimated",
  "reconciled",
  "stale",
  "unavailable",
];

const UNAVAILABLE_LABEL = "Unavailable";

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Accumulator {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  unavailableRequestCount: number;
  plannedTokens: number;
}

function emptyAccumulator(): Accumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    unavailableRequestCount: 0,
    plannedTokens: 0,
  };
}

interface GlobalTotals extends Accumulator {
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  providerExecutionDurationMs?: number;
}

/**
 * Build the attributed dashboard read model from durable usage rows.
 *
 * The renderer receives finished aggregates because attribution is a host
 * judgement: only the host knows which rows are trustworthy, which dimension it
 * actually recorded, and which measurement never arrived. A row that is
 * malformed, negative, or would overflow a total is excluded whole and counted,
 * so a contradictory record can never quietly move a number.
 */
export function buildUsageDashboard(
  rows: ReadonlyArray<UsageDashboardSourceRow>,
  options: BuildUsageDashboardOptions,
): UsageDashboardResponse {
  const totals: GlobalTotals = emptyAccumulator();
  const coverage = new Map<UsageQuality, number>(QUALITIES.map((quality) => [quality, 0]));
  const byDay = new Map<string, Accumulator>();
  const dimensions = new Map<UsageAttributionDimension, Map<string, BreakdownBucket>>();
  const hosts = new Map<string, { requestCount: number; lastObservedAt: string }>();
  const providerModels = new Map<
    string,
    { providerInstanceId: string; modelId: string; totals: Accumulator }
  >();
  const detail: Array<UsageDetailRow> = [];
  const accepted: Array<UsageDashboardSourceRow> = [];

  let excludedRecordCount = options.unreadableRecordCount ?? 0;
  let sawUnplacedProject = false;
  let sawModelessSubject = false;

  for (const row of rows) {
    if (!isStructurallyValid(row) || !fitsWithoutOverflow(totals, row)) {
      excludedRecordCount += 1;
      continue;
    }
    accepted.push(row);
    if (row.projectId === undefined) sawUnplacedProject = true;
    if (row.mode === undefined) sawModelessSubject = true;

    const unavailable = row.quality === "unavailable" ? 1 : 0;
    addToAccumulator(totals, row, unavailable);
    addOptional(totals, "reasoningTokens", row.reasoningTokens);
    addOptional(totals, "cacheReadInputTokens", row.cacheReadInputTokens);
    addOptional(totals, "cacheWriteInputTokens", row.cacheWriteInputTokens);
    addOptional(totals, "providerExecutionDurationMs", row.providerExecutionDurationMs);
    coverage.set(row.quality as UsageQuality, (coverage.get(row.quality as UsageQuality) ?? 0) + 1);

    const day = dayKey(row.observedAt, options.timeZone);
    addToAccumulator(bucket(byDay, day, emptyAccumulator), row, unavailable);

    addDimension(dimensions, "provider", row.providerInstanceId, row, unavailable);
    addDimension(dimensions, "model", row.modelId, row, unavailable);
    addDimension(dimensions, "host", row.hostId, row, unavailable);
    addDimension(dimensions, "request-shape", row.requestShape, row, unavailable);
    addDimension(dimensions, "thread", `${row.subjectType}/${row.subjectId}`, row, unavailable);
    addDimension(dimensions, "mode", row.mode, row, unavailable);
    addDimension(dimensions, "project", row.projectId, row, unavailable);
    for (const entry of row.attribution) {
      const categoryBucket = addDimension(
        dimensions,
        "context-category",
        entry.category,
        row,
        unavailable,
      );
      categoryBucket.totals.plannedTokens += entry.plannedTokens;
    }

    const providerModelKey = `${row.providerInstanceId}\u0000${row.modelId}`;
    addToAccumulator(
      bucket(providerModels, providerModelKey, () => ({
        providerInstanceId: row.providerInstanceId,
        modelId: row.modelId,
        totals: emptyAccumulator(),
      })).totals,
      row,
      unavailable,
    );

    const host = hosts.get(row.hostId);
    if (host === undefined) {
      hosts.set(row.hostId, { requestCount: 1, lastObservedAt: row.observedAt });
    } else {
      hosts.set(row.hostId, {
        requestCount: host.requestCount + 1,
        lastObservedAt: host.lastObservedAt > row.observedAt ? host.lastObservedAt : row.observedAt,
      });
    }
  }

  const orderedDetail = [...accepted].sort((left, right) =>
    right.observedAt.localeCompare(left.observedAt),
  );
  for (const row of orderedDetail.slice(0, options.detailLimit)) {
    detail.push(toDetailRow(row));
  }

  const activity = buildActivity(byDay);
  const peakDay = findPeakDay(byDay);
  const peakModel = findPeakModel(providerModels);

  return {
    summary: {
      totals: {
        totalInputTokens: totals.inputTokens,
        totalOutputTokens: totals.outputTokens,
        ...(totals.reasoningTokens === undefined
          ? {}
          : { totalReasoningTokens: totals.reasoningTokens }),
        ...(totals.cacheReadInputTokens === undefined
          ? {}
          : { totalCacheReadInputTokens: totals.cacheReadInputTokens }),
        ...(totals.cacheWriteInputTokens === undefined
          ? {}
          : { totalCacheWriteInputTokens: totals.cacheWriteInputTokens }),
        ...(totals.providerExecutionDurationMs === undefined
          ? {}
          : { totalProviderExecutionDurationMs: totals.providerExecutionDurationMs }),
        totalRequests: totals.requestCount,
        exactCount: coverage.get("exact") ?? 0,
        estimatedCount: coverage.get("estimated") ?? 0,
        reconciledCount: coverage.get("reconciled") ?? 0,
        staleCount: coverage.get("stale") ?? 0,
        unavailableCount: coverage.get("unavailable") ?? 0,
      },
      requestsWithUnavailableUsage: totals.unavailableRequestCount,
      coverage: QUALITIES.map(
        (quality): UsageCoverageSlice => ({
          quality,
          requestCount: coverage.get(quality) ?? 0,
        }),
      ),
      ...(peakDay === undefined ? {} : { peakDay }),
      ...(peakModel === undefined ? {} : { peakModel }),
      excludedRecordCount,
    },
    activity: activity.cells,
    activityTruncated: activity.truncated,
    breakdown: buildBreakdown(dimensions, options.breakdownLimit),
    detail,
    detailTruncated: (options.scanTruncated ?? false) || accepted.length > options.detailLimit,
    scanTruncated: options.scanTruncated ?? false,
    hosts: buildHostCoverage(hosts, options),
    dimensionSources: buildDimensionSources({ sawUnplacedProject, sawModelessSubject }),
    timeZone: options.timeZone,
    queryAt: options.queryAt as UsageDashboardResponse["queryAt"],
  };
}

interface BreakdownBucket {
  readonly key: string;
  readonly available: boolean;
  readonly totals: Accumulator;
}

function addDimension(
  dimensions: Map<UsageAttributionDimension, Map<string, BreakdownBucket>>,
  dimension: UsageAttributionDimension,
  value: string | undefined,
  row: UsageDashboardSourceRow,
  unavailable: number,
): BreakdownBucket {
  let group = dimensions.get(dimension);
  if (group === undefined) {
    group = new Map<string, BreakdownBucket>();
    dimensions.set(dimension, group);
  }
  const key = value ?? "";
  let entry = group.get(key);
  if (entry === undefined) {
    entry = { key, available: value !== undefined, totals: emptyAccumulator() };
    group.set(key, entry);
  }
  addToAccumulator(entry.totals, row, unavailable);
  return entry;
}

function bucket<T>(store: Map<string, T>, key: string, create: () => T): T {
  const existing = store.get(key);
  if (existing !== undefined) return existing;
  const created = create();
  store.set(key, created);
  return created;
}

function addToAccumulator(
  target: Accumulator,
  row: UsageDashboardSourceRow,
  unavailable: number,
): void {
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.requestCount += 1;
  target.unavailableRequestCount += unavailable;
}

function addOptional(
  target: GlobalTotals,
  key:
    | "reasoningTokens"
    | "cacheReadInputTokens"
    | "cacheWriteInputTokens"
    | "providerExecutionDurationMs",
  value: number | undefined,
): void {
  if (value === undefined) return;
  target[key] = (target[key] ?? 0) + value;
}

/**
 * A row is admissible only if every fact it carries is a finite non-negative
 * integer with a well-formed timestamp. Contradictory rows are rejected rather
 * than clamped, because a clamped value looks measured.
 */
function isStructurallyValid(row: UsageDashboardSourceRow): boolean {
  if (!QUALITIES.includes(row.quality as UsageQuality)) return false;
  if (!TIMESTAMP_PATTERN.test(row.observedAt)) return false;
  if (Number.isNaN(new Date(row.observedAt).getTime())) return false;
  if (!Number.isSafeInteger(row.varianceTokens)) return false;
  const counts = [
    row.inputTokens,
    row.outputTokens,
    row.plannedInputTokens,
    row.reasoningTokens,
    row.cacheReadInputTokens,
    row.cacheWriteInputTokens,
    row.providerExecutionDurationMs,
  ];
  for (const value of counts) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) return false;
  }
  for (const entry of row.attribution) {
    if (!Number.isSafeInteger(entry.plannedTokens) || entry.plannedTokens < 0) return false;
  }
  return true;
}

/**
 * Group accumulators are subsets of the global totals, so checking the global
 * sums is sufficient to prove no accumulator can overflow.
 */
function fitsWithoutOverflow(totals: GlobalTotals, row: UsageDashboardSourceRow): boolean {
  const additions: ReadonlyArray<readonly [number, number | undefined]> = [
    [totals.inputTokens, row.inputTokens],
    [totals.outputTokens, row.outputTokens],
    [totals.requestCount, 1],
    [totals.reasoningTokens ?? 0, row.reasoningTokens],
    [totals.cacheReadInputTokens ?? 0, row.cacheReadInputTokens],
    [totals.cacheWriteInputTokens ?? 0, row.cacheWriteInputTokens],
    [totals.providerExecutionDurationMs ?? 0, row.providerExecutionDurationMs],
  ];
  for (const [current, addition] of additions) {
    if (addition === undefined) continue;
    if (current + addition > Number.MAX_SAFE_INTEGER) return false;
  }
  return true;
}

function toDetailRow(row: UsageDashboardSourceRow): UsageDetailRow {
  return {
    reconciliationId: row.reconciliationId as UsageDetailRow["reconciliationId"],
    hostId: row.hostId as UsageDetailRow["hostId"],
    providerInstanceId: row.providerInstanceId as UsageDetailRow["providerInstanceId"],
    modelId: row.modelId as UsageDetailRow["modelId"],
    requestShape: row.requestShape,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    ...(row.mode === undefined ? {} : { mode: row.mode as UsageDetailRow["mode"] }),
    ...(row.projectId === undefined
      ? {}
      : { projectId: row.projectId as UsageDetailRow["projectId"] }),
    quality: row.quality as UsageQuality,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    plannedInputTokens: row.plannedInputTokens,
    varianceTokens: row.varianceTokens,
    ...(row.reasoningTokens === undefined ? {} : { reasoningTokens: row.reasoningTokens }),
    ...(row.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: row.cacheReadInputTokens }),
    ...(row.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: row.cacheWriteInputTokens }),
    ...(row.providerExecutionDurationMs === undefined
      ? {}
      : { providerExecutionDurationMs: row.providerExecutionDurationMs }),
    attribution: row.attribution,
    observedAt: row.observedAt as UsageDetailRow["observedAt"],
  };
}

/**
 * Fill every calendar day between the first and last recorded day so a gap is
 * visibly "no activity" rather than a missing column, and label a day whose
 * requests all lack provider usage as unavailable rather than as zero tokens.
 */
function buildActivity(byDay: ReadonlyMap<string, Accumulator>): {
  readonly cells: ReadonlyArray<UsageActivityCell>;
  readonly truncated: boolean;
} {
  const keys = [...byDay.keys()].sort();
  if (keys.length === 0) return { cells: [], truncated: false };

  const allDays = enumerateDays(keys[0]!, keys[keys.length - 1]!);
  const truncated = allDays.length > MAX_ACTIVITY_CELLS;
  const visible = truncated ? allDays.slice(allDays.length - MAX_ACTIVITY_CELLS) : allDays;

  const cells = visible.map((date): UsageActivityCell => {
    const totals = byDay.get(date);
    if (totals === undefined) {
      return {
        date,
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 0,
        unavailableRequestCount: 0,
        state: "no-activity",
      };
    }
    return {
      date,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      requestCount: totals.requestCount,
      unavailableRequestCount: totals.unavailableRequestCount,
      state: activityState(totals),
    };
  });
  return { cells, truncated };
}

function activityState(totals: Accumulator): UsageActivityState {
  if (totals.requestCount === 0) return "no-activity";
  if (totals.unavailableRequestCount === 0) return "measured";
  if (totals.unavailableRequestCount >= totals.requestCount) return "unavailable";
  return "partially-unavailable";
}

function enumerateDays(first: string, last: string): ReadonlyArray<string> {
  const days: Array<string> = [];
  let cursor = Date.parse(`${first}T00:00:00.000Z`);
  const end = Date.parse(`${last}T00:00:00.000Z`);
  if (Number.isNaN(cursor) || Number.isNaN(end)) return [first];
  while (cursor <= end) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return days;
}

function findPeakDay(
  byDay: ReadonlyMap<string, Accumulator>,
): UsageDashboardResponse["summary"]["peakDay"] {
  let peak: { date: string; totals: Accumulator } | undefined;
  for (const [date, totals] of byDay) {
    const tokens = totals.inputTokens + totals.outputTokens;
    if (peak === undefined || tokens > peak.totals.inputTokens + peak.totals.outputTokens) {
      peak = { date, totals };
    }
  }
  if (peak === undefined) return undefined;
  return {
    date: peak.date,
    totalTokens: peak.totals.inputTokens + peak.totals.outputTokens,
    requestCount: peak.totals.requestCount,
  };
}

function findPeakModel(
  models: ReadonlyMap<string, { providerInstanceId: string; modelId: string; totals: Accumulator }>,
): UsageDashboardResponse["summary"]["peakModel"] {
  let peak: { providerInstanceId: string; modelId: string; totals: Accumulator } | undefined;
  for (const entry of models.values()) {
    const tokens = entry.totals.inputTokens + entry.totals.outputTokens;
    if (peak === undefined || tokens > peak.totals.inputTokens + peak.totals.outputTokens) {
      peak = entry;
    }
  }
  if (peak === undefined) return undefined;
  type PeakModel = NonNullable<UsageDashboardResponse["summary"]["peakModel"]>;
  return {
    providerInstanceId: peak.providerInstanceId as PeakModel["providerInstanceId"],
    modelId: peak.modelId as PeakModel["modelId"],
    totalTokens: peak.totals.inputTokens + peak.totals.outputTokens,
    requestCount: peak.totals.requestCount,
  };
}

const BREAKDOWN_ORDER: ReadonlyArray<UsageAttributionDimension> = [
  "provider",
  "model",
  "host",
  "mode",
  "project",
  "thread",
  "request-shape",
  "context-category",
];

function buildBreakdown(
  dimensions: ReadonlyMap<UsageAttributionDimension, Map<string, BreakdownBucket>>,
  limit: number,
): ReadonlyArray<UsageBreakdownGroup> {
  const groups: Array<UsageBreakdownGroup> = [];
  for (const dimension of BREAKDOWN_ORDER) {
    const buckets = dimensions.get(dimension);
    if (buckets === undefined || buckets.size === 0) continue;
    const sorted = [...buckets.values()].sort(compareBuckets);
    const rows = sorted.slice(0, limit).map(
      (entry): UsageBreakdownRow => ({
        key: entry.key,
        label: entry.available ? entry.key : UNAVAILABLE_LABEL,
        availability: entry.available ? "recorded" : "unavailable",
        inputTokens: entry.totals.inputTokens,
        outputTokens: entry.totals.outputTokens,
        requestCount: entry.totals.requestCount,
        unavailableRequestCount: entry.totals.unavailableRequestCount,
        ...(dimension === "context-category" ? { plannedTokens: entry.totals.plannedTokens } : {}),
      }),
    );
    groups.push({ dimension, rows, truncated: sorted.length > rows.length });
  }
  return groups;
}

function compareBuckets(left: BreakdownBucket, right: BreakdownBucket): number {
  const leftTokens = left.totals.inputTokens + left.totals.outputTokens;
  const rightTokens = right.totals.inputTokens + right.totals.outputTokens;
  if (rightTokens !== leftTokens) return rightTokens - leftTokens;
  if (right.totals.requestCount !== left.totals.requestCount) {
    return right.totals.requestCount - left.totals.requestCount;
  }
  return left.key.localeCompare(right.key);
}

function buildHostCoverage(
  hosts: ReadonlyMap<string, { requestCount: number; lastObservedAt: string }>,
  options: BuildUsageDashboardOptions,
): ReadonlyArray<UsageHostCoverage> {
  const threshold = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const queryTime = new Date(options.queryAt).getTime();
  return [...hosts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hostId, facts]): UsageHostCoverage => {
      const age = queryTime - new Date(facts.lastObservedAt).getTime();
      return {
        hostId: hostId as UsageHostCoverage["hostId"],
        requestCount: facts.requestCount,
        lastObservedAt: facts.lastObservedAt as UsageHostCoverage["lastObservedAt"],
        status: Number.isFinite(age) && age > threshold ? "stale" : "contributing",
      };
    });
}

/**
 * State, per dimension, what this host can actually attribute. Reporting a
 * dimension as unavailable is the honest alternative to estimating it: the
 * dashboard would otherwise imply a precision the ledger never recorded.
 */
function buildDimensionSources(observed: {
  readonly sawUnplacedProject: boolean;
  readonly sawModelessSubject: boolean;
}): ReadonlyArray<UsageDimensionSource> {
  return [
    {
      dimension: "provider",
      status: "recorded",
      detail: "Every reconciliation records the provider instance that served the request.",
    },
    {
      dimension: "model",
      status: "recorded",
      detail: "Every reconciliation records the model id that served the request.",
    },
    {
      dimension: "host",
      status: "partial",
      detail:
        "Each row records the host that observed it. This host reports only its own projection, so another host's usage is absent until multi-host composition is authorized.",
    },
    {
      dimension: "mode",
      status: observed.sawModelessSubject ? "partial" : "recorded",
      detail:
        "Mode is resolved from the subject aggregate type, and from the host's own thread record for a Work or Code thread bound to no Project. A subject that is not a thread has no recorded mode.",
    },
    {
      dimension: "project",
      status: observed.sawUnplacedProject ? "partial" : "recorded",
      detail:
        "Project is resolved from the host's own ownership records for Chat, Work, and Code threads. A thread filed under no Project, and a subject that is not a thread, has no Project to report.",
    },
    {
      dimension: "thread",
      status: "recorded",
      detail:
        "Threads are identified by their immutable subject reference. No thread title or transcript text enters the projection.",
    },
    {
      dimension: "request-shape",
      status: "recorded",
      detail: "Each reconciliation records the request shape the runtime executed.",
    },
    {
      dimension: "context-category",
      status: "partial",
      detail:
        "Category totals come from the planned context composition, not provider-reported per-category actuals.",
    },
    {
      dimension: "component",
      status: "unavailable",
      detail:
        "The usage ledger stores category totals only; no skill, plugin, tool, or MCP component id is recorded against a reconciliation.",
    },
    {
      dimension: "cost",
      status: "unavailable",
      detail:
        "No reviewed or user-supplied pricing metadata exists on this host, so monetary cost is never estimated.",
    },
  ];
}

function dayKey(timestamp: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export const usageDashboardLimits = { MAX_ACTIVITY_CELLS, DEFAULT_STALE_THRESHOLD_MS };

import type {
  UsageCumulativePoint,
  UsageQuality,
  UsageRecord,
  UsageTimeBucket,
  UsageTopConsumer,
} from "@octant/contracts";

export interface UsageAggregation {
  readonly totals: UsageDimensionTotals;
  readonly byDay: ReadonlyArray<UsageTimeBucket>;
  readonly byWeek: ReadonlyArray<UsageTimeBucket>;
  readonly cumulative: ReadonlyArray<UsageCumulativePoint>;
  readonly topConsumers: ReadonlyArray<UsageTopConsumer>;
}

export interface UsageDimensionTotals {
  readonly totalReasoningTokens?: number;
  readonly totalCacheReadInputTokens?: number;
  readonly totalCacheWriteInputTokens?: number;
  readonly totalProviderExecutionDurationMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function dateParts(
  timestamp: string,
  timeZone: string,
): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: values.year!, month: values.month!, day: values.day! };
}

function startOfDay(timestamp: string, timeZone: string): string {
  const parts = dateParts(timestamp, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`;
}

function startOfWeek(timestamp: string, timeZone: string): string {
  const parts = dateParts(timestamp, timeZone);
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString();
}

interface RunningTotals {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  exactCount: number;
  estimatedCount: number;
  reconciledCount: number;
  staleCount: number;
  unavailableCount: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  providerExecutionDurationMs?: number;
}

function emptyTotals(): RunningTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    exactCount: 0,
    estimatedCount: 0,
    reconciledCount: 0,
    staleCount: 0,
    unavailableCount: 0,
  };
}

function addRecord(totals: RunningTotals, record: UsageRecord): void {
  totals.inputTokens += record.inputTokens;
  totals.outputTokens += record.outputTokens;
  totals.requestCount += 1;
  const quality = record.quality as UsageQuality;
  switch (quality) {
    case "exact":
      totals.exactCount += 1;
      break;
    case "estimated":
      totals.estimatedCount += 1;
      break;
    case "reconciled":
      totals.reconciledCount += 1;
      break;
    case "stale":
      totals.staleCount += 1;
      break;
    case "unavailable":
      totals.unavailableCount += 1;
      break;
  }
  addOptional(totals, "reasoningTokens", record.reasoningTokens);
  addOptional(totals, "cacheReadInputTokens", record.cacheReadInputTokens);
  addOptional(totals, "cacheWriteInputTokens", record.cacheWriteInputTokens);
  addOptional(totals, "providerExecutionDurationMs", record.providerExecutionDurationMs);
}

function addOptional(
  totals: RunningTotals,
  key: keyof Pick<
    RunningTotals,
    | "reasoningTokens"
    | "cacheReadInputTokens"
    | "cacheWriteInputTokens"
    | "providerExecutionDurationMs"
  >,
  value: number | undefined,
): void {
  if (value !== undefined) totals[key] = (totals[key] ?? 0) + value;
}

function toBucket(bucketStart: string, totals: RunningTotals): UsageTimeBucket {
  return {
    bucketStart: bucketStart as UsageTimeBucket["bucketStart"],
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    ...(totals.reasoningTokens === undefined ? {} : { reasoningTokens: totals.reasoningTokens }),
    ...(totals.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: totals.cacheReadInputTokens }),
    ...(totals.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: totals.cacheWriteInputTokens }),
    ...(totals.providerExecutionDurationMs === undefined
      ? {}
      : { providerExecutionDurationMs: totals.providerExecutionDurationMs }),
    requestCount: totals.requestCount,
    exactCount: totals.exactCount,
    estimatedCount: totals.estimatedCount,
    reconciledCount: totals.reconciledCount,
    staleCount: totals.staleCount,
    unavailableCount: totals.unavailableCount,
  };
}

function bucketRecords(
  records: ReadonlyArray<UsageRecord>,
  bucketStart: (timestamp: string) => string,
): ReadonlyArray<UsageTimeBucket> {
  const buckets = new Map<string, RunningTotals>();
  for (const record of records) {
    const key = bucketStart(record.observedAt);
    let totals = buckets.get(key);
    if (totals === undefined) {
      totals = emptyTotals();
      buckets.set(key, totals);
    }
    addRecord(totals, record);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, totals]) => toBucket(key, totals));
}

function buildCumulative(
  byDay: ReadonlyArray<UsageTimeBucket>,
): ReadonlyArray<UsageCumulativePoint> {
  let cumulativeInput = 0;
  let cumulativeOutput = 0;
  let cumulativeRequests = 0;
  return byDay.map((bucket) => {
    cumulativeInput += bucket.inputTokens;
    cumulativeOutput += bucket.outputTokens;
    cumulativeRequests += bucket.requestCount;
    return {
      bucketStart: bucket.bucketStart,
      cumulativeInputTokens: cumulativeInput,
      cumulativeOutputTokens: cumulativeOutput,
      cumulativeRequests: cumulativeRequests,
    };
  });
}

function buildTopConsumers(
  records: ReadonlyArray<UsageRecord>,
  limit: number,
): ReadonlyArray<UsageTopConsumer> {
  const consumers = new Map<string, UsageTopConsumer>();
  for (const record of records) {
    const key = `${record.subject.aggregateType}\u0000${record.subject.aggregateId}`;
    const existing = consumers.get(key);
    if (existing === undefined) {
      consumers.set(key, {
        subjectType: record.subject.aggregateType,
        subjectId: record.subject.aggregateId,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        requestCount: 1,
      });
    } else {
      consumers.set(key, {
        ...existing,
        inputTokens: existing.inputTokens + record.inputTokens,
        outputTokens: existing.outputTokens + record.outputTokens,
        requestCount: existing.requestCount + 1,
      });
    }
  }
  return [...consumers.values()]
    .sort((a, b) => b.requestCount - a.requestCount || b.inputTokens - a.inputTokens)
    .slice(0, limit);
}

export function aggregateUsage(
  records: ReadonlyArray<UsageRecord>,
  topConsumerLimit = 10,
  timeZone = "UTC",
): UsageAggregation {
  const byDay = bucketRecords(records, (timestamp) => startOfDay(timestamp, timeZone));
  const byWeek = bucketRecords(records, (timestamp) => startOfWeek(timestamp, timeZone));
  const cumulative = buildCumulative(byDay);
  const topConsumers = buildTopConsumers(records, topConsumerLimit);
  const totals = [...records].reduce((running, record) => {
    addRecord(running, record);
    return running;
  }, emptyTotals());
  return {
    totals: {
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
    },
    byDay,
    byWeek,
    cumulative,
    topConsumers,
  };
}

export const usageAggregationIntervals = { DAY_MS, WEEK_MS };

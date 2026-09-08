import { Effect } from "effect";
import {
  decodeLocalUsageHistoryResponse,
  type LocalUsageHistoryCostTotals,
  type LocalUsageHistoryCoverage,
  type LocalUsageHistoryGroup,
  type LocalUsageHistoryRecord,
  type LocalUsageHistoryRequest,
  type LocalUsageHistoryResponse,
  type LocalUsageHistoryTokenTotals,
} from "@octant/contracts";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";

const MAX_RECORDS = 20_000;
const MAX_GROUPS = 256;
const MAX_DAYS = 512;

interface TotalsAccumulator {
  inputTokens: number;
  outputTokens: number;
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  requestCount: number;
  sessions: Set<string>;
  uncachedMeasured: number;
  cacheReadMeasured: number;
  cacheWriteMeasured: number;
  reasoningMeasured: number;
  costs: CostAccumulator;
  overflowed: boolean;
}

interface CostAccumulator {
  providerRecordedUsd: number;
  apiEstimateUsd: number;
  providerRecordedMeasured: number;
  apiEstimateMeasured: number;
  unpricedRecordCount: number;
}

function accumulator(): TotalsAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    requestCount: 0,
    sessions: new Set(),
    uncachedMeasured: 0,
    cacheReadMeasured: 0,
    cacheWriteMeasured: 0,
    reasoningMeasured: 0,
    overflowed: false,
    costs: {
      providerRecordedUsd: 0,
      apiEstimateUsd: 0,
      providerRecordedMeasured: 0,
      apiEstimateMeasured: 0,
      unpricedRecordCount: 0,
    },
  };
}

export async function readLocalUsageHistoryDashboard(input: {
  readonly sources: ReadonlyArray<ProviderLocalUsageHistorySource>;
  readonly request: LocalUsageHistoryRequest;
  readonly queryAt: string;
  readonly signal?: AbortSignal;
}): Promise<LocalUsageHistoryResponse> {
  const results = await Promise.all(
    input.sources.map((source) =>
      Effect.runPromise(
        source.read(input.request, input.signal),
        input.signal === undefined ? {} : { signal: input.signal },
      ).catch((error) => {
        if (input.signal?.aborted) throw error;
        return {
          records: [],
          coverage: failedCoverage(source.sourceKind),
        };
      }),
    ),
  );
  const deduplicated = deduplicate(results.flatMap((result) => result.records));
  const truncatedByRecordLimit = deduplicated.length > MAX_RECORDS;
  const records = deduplicated.slice(0, MAX_RECORDS);
  const coverage = results.map((result) => result.coverage);
  const totals = accumulator();
  const providers = new Map<string, TotalsAccumulator>();
  const models = new Map<
    string,
    { readonly providerKey: string; readonly modelId: string; readonly totals: TotalsAccumulator }
  >();
  const days = new Map<
    string,
    { readonly day: string; readonly providerKey: string; readonly totals: TotalsAccumulator }
  >();
  const dailyTotals = new Map<string, TotalsAccumulator>();
  for (const record of records) {
    add(totals, record);
    addTo(providers, record.providerKey, record);
    const modelKey = `${record.providerKey}\0${record.modelId}`;
    const model = models.get(modelKey);
    if (model === undefined) {
      const created = {
        providerKey: record.providerKey,
        modelId: record.modelId,
        totals: accumulator(),
      };
      models.set(modelKey, created);
      add(created.totals, record);
    } else add(model.totals, record);
    const day = dayKey(record.observedAt, input.request.timeZone);
    const overall = dailyTotals.get(day);
    if (overall === undefined) {
      const created = accumulator();
      dailyTotals.set(day, created);
      add(created, record);
    } else add(overall, record);
    const dayKeyValue = `${day}\0${record.providerKey}`;
    const dayGroup = days.get(dayKeyValue);
    if (dayGroup === undefined) {
      const created = { day, providerKey: record.providerKey, totals: accumulator() };
      days.set(dayKeyValue, created);
      add(created.totals, record);
    } else add(dayGroup.totals, record);
  }
  const aggregateTotals = tokenTotals(totals);
  const truncationDetails = [
    ...(truncatedByRecordLimit ? ["The bounded local history scan reached its record limit."] : []),
    ...(providers.size > MAX_GROUPS || models.size > MAX_GROUPS
      ? ["The bounded local history response reached its group limit."]
      : []),
    ...(days.size > MAX_DAYS || dailyTotals.size > MAX_DAYS
      ? ["The bounded local history response reached its day limit."]
      : []),
    ...(totals.overflowed ? ["A local history total exceeded safe integer arithmetic."] : []),
  ];
  const sourceCoverage =
    truncationDetails.length === 0
      ? coverage
      : coverage.map((entry) => ({
          ...entry,
          truncated: true,
          status: "partial" as const,
          detail: truncationDetails.join(" "),
        }));
  return decodeLocalUsageHistoryResponse({
    source: "local-provider-history",
    from: input.request.from,
    to: input.request.to,
    timeZone: input.request.timeZone,
    queryAt: input.queryAt,
    totals: aggregateTotals,
    cost: costTotals(totals.costs),
    providers: [...providers.entries()]
      .slice(0, MAX_GROUPS)
      .map(([key, value]) => group(key, key, key, value)),
    models: [...models.values()]
      .slice(0, MAX_GROUPS)
      .map((value) =>
        group(
          `${value.providerKey}/${value.modelId}`,
          value.modelId,
          value.providerKey,
          value.totals,
        ),
      ),
    days: [...days.values()].slice(0, MAX_DAYS).map((value) => ({
      day: value.day,
      providerKey: value.providerKey,
      totals: tokenTotals(value.totals),
      cost: costTotals(value.totals.costs),
    })),
    dailyTotals: [...dailyTotals.entries()].slice(0, MAX_DAYS).map(([day, value]) => ({
      day,
      providerKey: "all",
      totals: tokenTotals(value),
      cost: costTotals(value.costs),
    })),
    coverage: sourceCoverage,
  });
}

function addTo(
  store: Map<string, TotalsAccumulator>,
  key: string,
  record: LocalUsageHistoryRecord,
): void {
  const current = store.get(key);
  if (current === undefined) {
    const created = accumulator();
    store.set(key, created);
    add(created, record);
  } else add(current, record);
}

function add(target: TotalsAccumulator, record: LocalUsageHistoryRecord): void {
  target.inputTokens = addNumber(target, target.inputTokens, record.inputTokens);
  target.outputTokens = addNumber(target, target.outputTokens, record.outputTokens);
  target.requestCount = addNumber(target, target.requestCount, 1);
  target.sessions.add(record.sourceSessionId);
  if (record.uncachedInputTokens !== undefined) {
    target.uncachedInputTokens = addNumber(
      target,
      target.uncachedInputTokens,
      record.uncachedInputTokens,
    );
    target.uncachedMeasured = addNumber(target, target.uncachedMeasured, 1);
  }
  if (record.cacheReadInputTokens !== undefined) {
    target.cacheReadInputTokens = addNumber(
      target,
      target.cacheReadInputTokens,
      record.cacheReadInputTokens,
    );
    target.cacheReadMeasured = addNumber(target, target.cacheReadMeasured, 1);
  }
  if (record.cacheWriteInputTokens !== undefined) {
    target.cacheWriteInputTokens = addNumber(
      target,
      target.cacheWriteInputTokens,
      record.cacheWriteInputTokens,
    );
    target.cacheWriteMeasured = addNumber(target, target.cacheWriteMeasured, 1);
  }
  if (record.reasoningTokens !== undefined) {
    target.reasoningTokens = addNumber(target, target.reasoningTokens, record.reasoningTokens);
    target.reasoningMeasured = addNumber(target, target.reasoningMeasured, 1);
  }
  const cost = record.cost;
  if (cost === undefined)
    target.costs.unpricedRecordCount = addNumber(target, target.costs.unpricedRecordCount, 1);
  else if (cost.kind === "provider-recorded") {
    target.costs.providerRecordedUsd = addNumber(
      target,
      target.costs.providerRecordedUsd,
      cost.amount,
    );
    target.costs.providerRecordedMeasured = addNumber(
      target,
      target.costs.providerRecordedMeasured,
      1,
    );
  } else {
    target.costs.apiEstimateUsd = addNumber(target, target.costs.apiEstimateUsd, cost.amount);
    target.costs.apiEstimateMeasured = addNumber(target, target.costs.apiEstimateMeasured, 1);
  }
}

function addNumber(target: TotalsAccumulator, left: number, right: number): number {
  const next = left + right;
  if (!Number.isFinite(next) || next < 0 || next > Number.MAX_SAFE_INTEGER) {
    target.overflowed = true;
    return Number.MAX_SAFE_INTEGER;
  }
  return next;
}

function tokenTotals(value: TotalsAccumulator): LocalUsageHistoryTokenTotals {
  const totalTokens =
    value.inputTokens > Number.MAX_SAFE_INTEGER - value.outputTokens
      ? ((value.overflowed = true), Number.MAX_SAFE_INTEGER)
      : value.inputTokens + value.outputTokens;
  return {
    inputTokens: value.inputTokens,
    totalTokens,
    outputTokens: value.outputTokens,
    ...(value.uncachedMeasured === value.requestCount
      ? { uncachedInputTokens: value.uncachedInputTokens }
      : {}),
    ...(value.cacheReadMeasured === value.requestCount
      ? { cacheReadInputTokens: value.cacheReadInputTokens }
      : {}),
    ...(value.cacheWriteMeasured === value.requestCount
      ? { cacheWriteInputTokens: value.cacheWriteInputTokens }
      : {}),
    ...(value.reasoningMeasured === value.requestCount
      ? { reasoningTokens: value.reasoningTokens }
      : {}),
    requestCount: value.requestCount,
    sessionCount: value.sessions.size,
    componentCoverage: {
      uncachedInput: { measured: value.uncachedMeasured, total: value.requestCount },
      cacheRead: { measured: value.cacheReadMeasured, total: value.requestCount },
      cacheWrite: { measured: value.cacheWriteMeasured, total: value.requestCount },
      reasoning: { measured: value.reasoningMeasured, total: value.requestCount },
    },
  };
}

function costTotals(value: CostAccumulator): LocalUsageHistoryCostTotals {
  return {
    ...(value.providerRecordedMeasured === 0
      ? {}
      : { providerRecordedUsd: value.providerRecordedUsd }),
    ...(value.apiEstimateMeasured === 0 ? {} : { apiEstimateUsd: value.apiEstimateUsd }),
    pricedRecordCount: safeAdd(value.providerRecordedMeasured, value.apiEstimateMeasured),
    unpricedRecordCount: value.unpricedRecordCount,
    providerRecordedRecordCount: value.providerRecordedMeasured,
    apiEstimateRecordCount: value.apiEstimateMeasured,
  };
}

function group(
  key: string,
  label: string,
  providerKey: string,
  totals: TotalsAccumulator,
): LocalUsageHistoryGroup {
  return { key, label, providerKey, totals: tokenTotals(totals), cost: costTotals(totals.costs) };
}

function deduplicate(
  records: ReadonlyArray<LocalUsageHistoryRecord>,
): ReadonlyArray<LocalUsageHistoryRecord> {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.sourceKind}\0${record.sourceSessionId}\0${record.sourceEventId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dayKey(timestamp: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
  } catch {
    return timestamp.slice(0, 10);
  }
}

function safeAdd(left: number, right: number): number {
  const next = left + right;
  return Number.isFinite(next) && next >= 0 && next <= Number.MAX_SAFE_INTEGER
    ? next
    : Number.MAX_SAFE_INTEGER;
}

function failedCoverage(sourceKind: string): LocalUsageHistoryCoverage {
  return {
    sourceKind,
    sourceInstallationId: "unavailable",
    status: "failed",
    scannedFileCount: 0,
    acceptedRecordCount: 0,
    omittedRecordCount: 0,
    truncated: false,
    detail: "The local provider history source failed.",
  };
}

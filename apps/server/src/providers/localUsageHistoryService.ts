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
  excludedRecordCount: number;
  overflowed: boolean;
}

interface CostAccumulator {
  providerRecordedUsd: number;
  apiEstimateUsd: number;
  providerRecordedMeasured: number;
  apiEstimateMeasured: number;
  unpricedRecordCount: number;
  excludedRecordCount: number;
  cacheSavingsUsd: number;
  cacheSavingsMeasured: number;
  pricingReferences: Map<string, { readonly revision: string; readonly source: string }>;
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
    excludedRecordCount: 0,
    overflowed: false,
    costs: {
      providerRecordedUsd: 0,
      apiEstimateUsd: 0,
      providerRecordedMeasured: 0,
      apiEstimateMeasured: 0,
      unpricedRecordCount: 0,
      excludedRecordCount: 0,
      cacheSavingsUsd: 0,
      cacheSavingsMeasured: 0,
      pricingReferences: new Map(),
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
    if (!add(totals, record)) continue;
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

function add(target: TotalsAccumulator, record: LocalUsageHistoryRecord): boolean {
  if (!recordFits(target, record)) {
    target.overflowed = true;
    target.excludedRecordCount += 1;
    target.costs.excludedRecordCount += 1;
    return false;
  }
  target.inputTokens += record.inputTokens;
  target.outputTokens += record.outputTokens;
  target.requestCount += 1;
  target.sessions.add(
    `${record.sourceKind}\0${record.sourceInstallationId}\0${record.sourceSessionId}`,
  );
  if (record.uncachedInputTokens !== undefined) {
    target.uncachedInputTokens += record.uncachedInputTokens;
    target.uncachedMeasured += 1;
  }
  if (record.cacheReadInputTokens !== undefined) {
    target.cacheReadInputTokens += record.cacheReadInputTokens;
    target.cacheReadMeasured += 1;
  }
  if (record.cacheWriteInputTokens !== undefined) {
    target.cacheWriteInputTokens += record.cacheWriteInputTokens;
    target.cacheWriteMeasured += 1;
  }
  if (record.reasoningTokens !== undefined) {
    target.reasoningTokens += record.reasoningTokens;
    target.reasoningMeasured += 1;
  }
  const cost = record.cost;
  if (cost === undefined) target.costs.unpricedRecordCount += 1;
  else if (cost.kind === "provider-recorded") {
    target.costs.providerRecordedUsd += cost.amount;
    target.costs.providerRecordedMeasured += 1;
  } else {
    target.costs.apiEstimateUsd += cost.amount;
    target.costs.apiEstimateMeasured += 1;
    const cacheSavingsUsd = cost.cacheSavingsUsd;
    if (cacheSavingsUsd !== undefined && Number.isFinite(cacheSavingsUsd)) {
      target.costs.cacheSavingsUsd += cacheSavingsUsd;
      target.costs.cacheSavingsMeasured += 1;
    }
    if (cost.pricingRevision !== undefined && cost.pricingSource !== undefined) {
      const key = `${cost.pricingRevision}\0${cost.pricingSource}`;
      if (target.costs.pricingReferences.size < 8 || target.costs.pricingReferences.has(key)) {
        target.costs.pricingReferences.set(key, {
          revision: cost.pricingRevision,
          source: cost.pricingSource,
        });
      }
    }
  }
  return true;
}

function recordFits(target: TotalsAccumulator, record: LocalUsageHistoryRecord): boolean {
  const nextInput = target.inputTokens + record.inputTokens;
  const nextOutput = target.outputTokens + record.outputTokens;
  if (
    !safeSum(target.inputTokens, record.inputTokens) ||
    !safeSum(target.outputTokens, record.outputTokens)
  )
    return false;
  if (!safeSum(nextInput, nextOutput) || !safeSum(target.requestCount, 1)) return false;
  if (
    record.uncachedInputTokens !== undefined &&
    !safeSum(target.uncachedInputTokens, record.uncachedInputTokens)
  )
    return false;
  if (
    record.cacheReadInputTokens !== undefined &&
    !safeSum(target.cacheReadInputTokens, record.cacheReadInputTokens)
  )
    return false;
  if (
    record.cacheWriteInputTokens !== undefined &&
    !safeSum(target.cacheWriteInputTokens, record.cacheWriteInputTokens)
  )
    return false;
  if (
    record.reasoningTokens !== undefined &&
    !safeSum(target.reasoningTokens, record.reasoningTokens)
  )
    return false;
  if (record.cost !== undefined) {
    const current =
      record.cost.kind === "provider-recorded"
        ? target.costs.providerRecordedUsd
        : target.costs.apiEstimateUsd;
    if (!safeSum(current, record.cost.amount)) return false;
    if (
      record.cost.kind === "api-estimate" &&
      record.cost.cacheSavingsUsd !== undefined &&
      !safeSignedSum(target.costs.cacheSavingsUsd, record.cost.cacheSavingsUsd)
    )
      return false;
  }
  return true;
}

function safeSum(left: number, right: number): boolean {
  const next = left + right;
  return Number.isFinite(next) && next >= 0 && next <= Number.MAX_SAFE_INTEGER;
}

function safeSignedSum(left: number, right: number): boolean {
  const next = left + right;
  return Number.isFinite(next) && Math.abs(next) <= Number.MAX_SAFE_INTEGER;
}

function tokenTotals(value: TotalsAccumulator): LocalUsageHistoryTokenTotals {
  const totalTokens = value.inputTokens + value.outputTokens;
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
    ...(value.excludedRecordCount === 0 ? {} : { excludedRecordCount: value.excludedRecordCount }),
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
    ...(value.excludedRecordCount === 0 ? {} : { excludedRecordCount: value.excludedRecordCount }),
    ...(value.cacheSavingsMeasured === 0
      ? {}
      : {
          cacheSavingsUsd: value.cacheSavingsUsd,
          cacheSavingsRecordCount: value.cacheSavingsMeasured,
        }),
    ...(value.pricingReferences.size === 0
      ? {}
      : { pricingReferences: [...value.pricingReferences.values()] }),
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
    const key = `${record.sourceKind}\0${record.sourceInstallationId}\0${record.sourceSessionId}\0${record.sourceEventId}`;
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

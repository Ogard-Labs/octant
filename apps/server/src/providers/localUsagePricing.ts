/**
 * Pure, versioned API-equivalent pricing for local provider history.
 *
 * Rates are a checked-in snapshot of the standard token pricing pages. This
 * module never fetches pricing or provider state; callers must treat the result
 * as an estimate and keep provider-recorded costs separate.
 */

export type PricingProvider = "openai" | "anthropic";
export type CacheWriteDuration = "5-minute" | "1-hour";

export interface PricingSource {
  readonly provider: PricingProvider;
  readonly url: string;
  readonly basis: "standard-api-token-rates";
  readonly accessedAt: "2026-09-09";
}

export interface PricingUsageCost {
  readonly amount: number;
  readonly currency: "USD";
  readonly kind: "api-estimate" | "provider-recorded";
}

/** Structural shape shared with LocalUsageHistoryRecord without coupling this module to its package. */
export interface PricingUsageRecord {
  readonly modelId: string;
  readonly inputTokens: number;
  readonly uncachedInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly cacheWriteDuration?: CacheWriteDuration;
  readonly outputTokens: number;
  /** Reasoning is a subset of output for the supported API billing tables. */
  readonly reasoningTokens?: number;
  readonly cost?: PricingUsageCost;
}

export type UnpricedReason =
  | "unknown-provider"
  | "unknown-model"
  | "invalid-token-counts"
  | "missing-input-breakdown"
  | "inconsistent-input-breakdown"
  | "missing-cache-read-rate"
  | "missing-cache-write"
  | "unsupported-cache-write"
  | "missing-cache-write-duration"
  | "unsupported-cache-read"
  | "long-context-rate-unavailable"
  | "overflow";

export interface ApiEquivalentEstimate {
  readonly kind: "api-estimate";
  readonly amount: number;
  readonly currency: "USD";
  readonly pricingRevision: string;
  readonly source: PricingSource;
}

export interface UnpricedEstimate {
  readonly kind: "unpriced";
  readonly reason: UnpricedReason;
  readonly pricingRevision: string;
  readonly source: PricingSource;
}

export type PricingResult = ApiEquivalentEstimate | UnpricedEstimate;

export type ResolvedUsageCost =
  | { readonly kind: "provider-recorded"; readonly cost: PricingUsageCost }
  | {
      readonly kind: "api-estimate";
      readonly cost: PricingUsageCost;
      readonly estimate?: ApiEquivalentEstimate;
    }
  | { readonly kind: "unpriced"; readonly estimate: UnpricedEstimate };

export const LOCAL_PRICING_REVISION = "2026-09-09";

export const LOCAL_PRICING_SOURCES = {
  openai: {
    provider: "openai",
    url: "https://developers.openai.com/api/docs/pricing",
    basis: "standard-api-token-rates",
    accessedAt: "2026-09-09",
  },
  anthropic: {
    provider: "anthropic",
    url: "https://platform.claude.com/docs/en/about-claude/pricing",
    basis: "standard-api-token-rates",
    accessedAt: "2026-09-09",
  },
} satisfies Record<PricingProvider, PricingSource>;

interface PriceTier {
  readonly inputPerMillion: number;
  readonly cachedInputPerMillion?: number;
  readonly cacheWrite5mPerMillion?: number;
  readonly cacheWrite1hPerMillion?: number;
  readonly outputPerMillion: number;
}

interface ModelPricing {
  readonly short: PriceTier;
  readonly long?: PriceTier;
  readonly longContextThreshold?: number;
  readonly maxInputTokens?: number;
  readonly cacheWriteDurationRequired?: boolean;
}

const OPENAI = new Map<string, ModelPricing>([
  [
    "gpt-5.6-sol",
    {
      short: {
        inputPerMillion: 4,
        cachedInputPerMillion: 0.4,
        cacheWrite5mPerMillion: 5,
        outputPerMillion: 20,
      },
      long: {
        inputPerMillion: 8,
        cachedInputPerMillion: 0.8,
        cacheWrite5mPerMillion: 10,
        outputPerMillion: 30,
      },
      longContextThreshold: 272_000,
    },
  ],
  [
    "gpt-5.6-terra",
    {
      short: {
        inputPerMillion: 2,
        cachedInputPerMillion: 0.2,
        cacheWrite5mPerMillion: 2.5,
        outputPerMillion: 12,
      },
      long: {
        inputPerMillion: 4,
        cachedInputPerMillion: 0.4,
        cacheWrite5mPerMillion: 5,
        outputPerMillion: 18,
      },
      longContextThreshold: 272_000,
    },
  ],
  [
    "gpt-5.6-luna",
    {
      short: {
        inputPerMillion: 0.2,
        cachedInputPerMillion: 0.02,
        cacheWrite5mPerMillion: 0.25,
        outputPerMillion: 1.2,
      },
      long: {
        inputPerMillion: 0.4,
        cachedInputPerMillion: 0.04,
        cacheWrite5mPerMillion: 0.5,
        outputPerMillion: 1.8,
      },
      longContextThreshold: 272_000,
    },
  ],
  [
    "gpt-5.5",
    {
      short: { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 },
      maxInputTokens: 272_000,
    },
  ],
  [
    "gpt-5.5-pro",
    { short: { inputPerMillion: 30, outputPerMillion: 180 }, maxInputTokens: 272_000 },
  ],
  [
    "gpt-5.4",
    {
      short: { inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15 },
      maxInputTokens: 272_000,
    },
  ],
  [
    "gpt-5.4-pro",
    { short: { inputPerMillion: 30, outputPerMillion: 180 }, maxInputTokens: 272_000 },
  ],
  [
    "gpt-5.4-mini",
    { short: { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 } },
  ],
  [
    "gpt-5.4-nano",
    { short: { inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.25 } },
  ],
  [
    "gpt-5.2",
    { short: { inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 } },
  ],
  ["gpt-5.2-pro", { short: { inputPerMillion: 21, outputPerMillion: 168 } }],
  [
    "gpt-5.1",
    { short: { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 } },
  ],
  [
    "gpt-5",
    { short: { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 } },
  ],
  [
    "gpt-5-mini",
    { short: { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 } },
  ],
  [
    "gpt-5-nano",
    { short: { inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 } },
  ],
  ["gpt-5-pro", { short: { inputPerMillion: 15, outputPerMillion: 120 } }],
  ["gpt-4.1", { short: { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 } }],
  [
    "gpt-4.1-mini",
    { short: { inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6 } },
  ],
  [
    "gpt-4.1-nano",
    { short: { inputPerMillion: 0.1, cachedInputPerMillion: 0.025, outputPerMillion: 0.4 } },
  ],
  [
    "gpt-4o",
    { short: { inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10 } },
  ],
  ["gpt-4o-2024-05-13", { short: { inputPerMillion: 5, outputPerMillion: 15 } }],
  [
    "gpt-4o-mini",
    { short: { inputPerMillion: 0.15, cachedInputPerMillion: 0.075, outputPerMillion: 0.6 } },
  ],
  ["o1", { short: { inputPerMillion: 15, cachedInputPerMillion: 7.5, outputPerMillion: 60 } }],
  ["o1-pro", { short: { inputPerMillion: 150, outputPerMillion: 600 } }],
  ["o3-pro", { short: { inputPerMillion: 20, outputPerMillion: 80 } }],
  ["o3", { short: { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 } }],
  [
    "o4-mini",
    { short: { inputPerMillion: 1.1, cachedInputPerMillion: 0.275, outputPerMillion: 4.4 } },
  ],
  [
    "o3-mini",
    { short: { inputPerMillion: 1.1, cachedInputPerMillion: 0.55, outputPerMillion: 4.4 } },
  ],
]);

function claudeRates(
  inputPerMillion: number,
  outputPerMillion: number,
  cachedInputPerMillion: number,
  cacheWrite5mPerMillion: number,
  cacheWrite1hPerMillion: number,
  maxInputTokens?: number,
): ModelPricing {
  return {
    short: {
      inputPerMillion,
      cachedInputPerMillion,
      cacheWrite5mPerMillion,
      cacheWrite1hPerMillion,
      outputPerMillion,
    },
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    cacheWriteDurationRequired: true,
  };
}

const ANTHROPIC = new Map<string, ModelPricing>([
  ["claude-fable-5-1", claudeRates(10, 50, 0.25, 12.5, 20)],
  ["claude-mythos-5-1", claudeRates(10, 50, 0.25, 12.5, 20)],
  ["claude-fable-5", claudeRates(10, 50, 1, 12.5, 20)],
  ["claude-mythos-5", claudeRates(10, 50, 1, 12.5, 20)],
  ["claude-opus-5", claudeRates(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-4-8", claudeRates(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-4-7", claudeRates(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-4-6", claudeRates(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-4-5", claudeRates(5, 25, 0.5, 6.25, 10, 200_000)],
  ["claude-opus-4-1", claudeRates(15, 75, 1.5, 18.75, 30, 200_000)],
  ["claude-opus-4", claudeRates(15, 75, 1.5, 18.75, 30, 200_000)],
  ["claude-sonnet-5", claudeRates(2, 10, 0.2, 2.5, 4)],
  ["claude-sonnet-4-6", claudeRates(3, 15, 0.3, 3.75, 6)],
  ["claude-sonnet-4-5", claudeRates(3, 15, 0.3, 3.75, 6, 200_000)],
  ["claude-sonnet-4", claudeRates(3, 15, 0.3, 3.75, 6, 200_000)],
  ["claude-haiku-4-5", claudeRates(1, 5, 0.1, 1.25, 2)],
  ["claude-haiku-3-5", claudeRates(0.8, 4, 0.08, 1, 1.6, 200_000)],
]);

function pricingTable(provider: PricingProvider): Map<string, ModelPricing> | undefined {
  if (provider === "openai") return OPENAI;
  if (provider === "anthropic") return ANTHROPIC;
  return undefined;
}

function unpriced(provider: PricingProvider, reason: UnpricedReason): UnpricedEstimate {
  return {
    kind: "unpriced",
    reason,
    pricingRevision: LOCAL_PRICING_REVISION,
    source: LOCAL_PRICING_SOURCES[provider],
  };
}

function safeTokenCount(value: number | undefined): value is number {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function tokenCharge(tokens: number, perMillion: number): number {
  return (tokens * perMillion) / 1_000_000;
}

/** Estimates one record from explicit token components using the checked-in standard rates. */
export function estimateApiEquivalentCost(
  provider: PricingProvider,
  record: PricingUsageRecord,
): PricingResult {
  const table = pricingTable(provider);
  if (table === undefined) return unpriced(provider, "unknown-provider");
  const model = table.get(record.modelId);
  if (model === undefined) return unpriced(provider, "unknown-model");
  if (
    !safeTokenCount(record.inputTokens) ||
    !safeTokenCount(record.outputTokens) ||
    !safeTokenCount(record.uncachedInputTokens) ||
    !safeTokenCount(record.cacheReadInputTokens) ||
    !safeTokenCount(record.cacheWriteInputTokens) ||
    !safeTokenCount(record.reasoningTokens) ||
    record.inputTokens === undefined ||
    record.outputTokens === undefined ||
    (record.reasoningTokens !== undefined && record.reasoningTokens > record.outputTokens)
  ) {
    return unpriced(provider, "invalid-token-counts");
  }

  const tier =
    model.longContextThreshold !== undefined && record.inputTokens > model.longContextThreshold
      ? model.long
      : model.short;
  if (tier === undefined) return unpriced(provider, "long-context-rate-unavailable");
  if (model.maxInputTokens !== undefined && record.inputTokens > model.maxInputTokens) {
    return unpriced(provider, "long-context-rate-unavailable");
  }

  const requiresCacheWrite =
    tier.cacheWrite5mPerMillion !== undefined || tier.cacheWrite1hPerMillion !== undefined;
  const writeTokens = record.cacheWriteInputTokens;
  if (requiresCacheWrite && writeTokens === undefined) {
    return unpriced(provider, "missing-cache-write");
  }
  if (!requiresCacheWrite && writeTokens !== undefined && writeTokens > 0) {
    return unpriced(provider, "unsupported-cache-write");
  }
  if (
    writeTokens !== undefined &&
    writeTokens > 0 &&
    model.cacheWriteDurationRequired !== true &&
    record.cacheWriteDuration !== undefined
  ) {
    return unpriced(provider, "unsupported-cache-write");
  }
  if (
    writeTokens !== undefined &&
    writeTokens > 0 &&
    model.cacheWriteDurationRequired === true &&
    record.cacheWriteDuration === undefined
  ) {
    return unpriced(provider, "missing-cache-write-duration");
  }

  const readTokens = record.cacheReadInputTokens;
  if (readTokens !== undefined && readTokens > 0 && tier.cachedInputPerMillion === undefined) {
    return unpriced(provider, "unsupported-cache-read");
  }
  const uncachedTokens = record.uncachedInputTokens;
  if (
    readTokens === undefined &&
    !(uncachedTokens !== undefined && uncachedTokens === record.inputTokens && writeTokens === 0)
  ) {
    return unpriced(provider, "missing-input-breakdown");
  }
  const resolvedRead = readTokens ?? 0;
  const resolvedWrite = writeTokens ?? 0;
  const resolvedUncached = uncachedTokens ?? record.inputTokens - resolvedRead - resolvedWrite;
  if (
    !Number.isSafeInteger(resolvedUncached) ||
    resolvedUncached < 0 ||
    resolvedUncached + resolvedRead + resolvedWrite !== record.inputTokens
  ) {
    return unpriced(provider, "inconsistent-input-breakdown");
  }
  if (
    resolvedWrite > 0 &&
    model.cacheWriteDurationRequired === true &&
    record.cacheWriteDuration === undefined
  ) {
    return unpriced(provider, "missing-cache-write-duration");
  }

  const writeRate =
    model.cacheWriteDurationRequired === true && record.cacheWriteDuration === "1-hour"
      ? tier.cacheWrite1hPerMillion
      : tier.cacheWrite5mPerMillion;
  if (resolvedWrite > 0 && writeRate === undefined) {
    return unpriced(provider, "unsupported-cache-write");
  }
  const amount =
    tokenCharge(resolvedUncached, tier.inputPerMillion) +
    tokenCharge(resolvedRead, tier.cachedInputPerMillion ?? tier.inputPerMillion) +
    tokenCharge(resolvedWrite, writeRate ?? 0) +
    tokenCharge(record.outputTokens, tier.outputPerMillion);
  if (!Number.isFinite(amount) || amount < 0) return unpriced(provider, "overflow");
  return {
    kind: "api-estimate",
    amount,
    currency: "USD",
    pricingRevision: LOCAL_PRICING_REVISION,
    source: LOCAL_PRICING_SOURCES[provider],
  };
}

/** Keeps provider-recorded source costs authoritative and prices only unpriced records. */
export function resolveLocalUsageCost(
  provider: PricingProvider,
  record: PricingUsageRecord,
): ResolvedUsageCost {
  if (record.cost !== undefined) {
    return { kind: record.cost.kind, cost: record.cost };
  }
  const estimate = estimateApiEquivalentCost(provider, record);
  return estimate.kind === "api-estimate"
    ? {
        kind: "api-estimate",
        cost: { amount: estimate.amount, currency: "USD", kind: "api-estimate" },
        estimate,
      }
    : { kind: "unpriced", estimate };
}

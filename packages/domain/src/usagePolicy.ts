import type {
  AttributionQuality,
  ContextEntry,
  UsageAttributionEntry,
  UsageQuality,
} from "@octant/contracts";

export interface UsageClassificationInput {
  readonly hasReconciliation: boolean;
  readonly hasManifest: boolean;
  readonly hasPlan: boolean;
  readonly varianceTokens: number;
  readonly observedAt: string;
  readonly now: string;
  readonly staleThresholdMs?: number;
}

const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function classifyUsageQuality(input: UsageClassificationInput): UsageQuality {
  if (!input.hasReconciliation) {
    return input.hasManifest || input.hasPlan ? "estimated" : "unavailable";
  }

  const observedTime = new Date(input.observedAt).getTime();
  const nowTime = new Date(input.now).getTime();
  const ageMs = nowTime - observedTime;
  const staleThreshold = input.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;

  if (ageMs > staleThreshold) {
    return "stale";
  }

  if (input.varianceTokens === 0) {
    return "exact";
  }

  return "reconciled";
}

export function classifyAttributionQuality(
  entry: ContextEntry,
  hasReconciliation: boolean,
): AttributionQuality {
  if (!hasReconciliation) {
    return "unavailable";
  }

  const tokens = entry.tokens;
  if (tokens.kind === "unknown") {
    return "unavailable";
  }

  const accuracy = tokens.accuracy;
  if (accuracy === "exact-tokenizer" || accuracy === "provider-reported") {
    return "exact";
  }

  return "estimated";
}

export function buildAttribution(
  entries: ReadonlyArray<ContextEntry>,
  hasReconciliation: boolean,
): ReadonlyArray<UsageAttributionEntry> {
  const byCategory = new Map<string, { plannedTokens: number; quality: AttributionQuality }>();

  for (const entry of entries) {
    const category = entry.category;
    const tokens = entry.tokens.kind === "known" ? entry.tokens.tokens : 0;
    const quality = classifyAttributionQuality(entry, hasReconciliation);

    const existing = byCategory.get(category);
    if (existing === undefined) {
      byCategory.set(category, { plannedTokens: tokens, quality });
    } else {
      existing.plannedTokens += tokens;
      if (quality === "unavailable") {
        existing.quality = "unavailable";
      } else if (quality === "estimated" && existing.quality === "exact") {
        existing.quality = "estimated";
      }
    }
  }

  return Array.from(byCategory.entries())
    .map(([category, data]) => ({
      category: category as UsageAttributionEntry["category"],
      plannedTokens: data.plannedTokens,
      quality: data.quality,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

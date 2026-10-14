import type {
  ContextCompactionAvailability,
  ContextEntryId,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts";

export type ContextCompactionRejectionCode =
  | "unsafe-arithmetic"
  | "invalid-value"
  | "request-shape-mismatch";

export class ContextCompactionRejected extends Error {
  override readonly name = "ContextCompactionRejected";

  constructor(
    readonly code: ContextCompactionRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function checkedNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContextCompactionRejected(
      "invalid-value",
      `${label} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new ContextCompactionRejected("unsafe-arithmetic", `${label} exceeds safe arithmetic.`);
  }
  return result;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) {
    throw new ContextCompactionRejected("unsafe-arithmetic", `${label} exceeds safe arithmetic.`);
  }
  return result;
}

export type ContextMaintenanceKind =
  | "duplicate"
  | "superseded"
  | "stale"
  | "reuse-summary"
  | "artifact-reference"
  | "narrow-retrieval"
  | "semantic-summary";

export interface ContextMaintenanceCandidate {
  readonly entryId: ContextEntryId;
  readonly kind: ContextMaintenanceKind;
  readonly priority: number;
}

const maintenanceRank: Readonly<Record<ContextMaintenanceKind, number>> = {
  duplicate: 0,
  superseded: 1,
  stale: 2,
  "reuse-summary": 3,
  "artifact-reference": 4,
  "narrow-retrieval": 5,
  "semantic-summary": 6,
};

export function orderContextMaintenance(
  candidates: ReadonlyArray<ContextMaintenanceCandidate>,
): ReadonlyArray<ContextMaintenanceCandidate> {
  return candidates
    .map((candidate, index) => {
      checkedNonNegativeInteger(candidate.priority, "Maintenance priority");
      return { candidate, index };
    })
    .toSorted(
      (left, right) =>
        maintenanceRank[left.candidate.kind] - maintenanceRank[right.candidate.kind] ||
        left.candidate.priority - right.candidate.priority ||
        left.index - right.index,
    )
    .map(({ candidate }) => candidate);
}

export interface SemanticSummaryMaterial {
  readonly entryId: ContextEntryId;
  readonly sizeTokens: number;
  readonly eligible: boolean;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId?: ProviderModelId;
}

export interface SemanticSummaryEvaluationInput {
  readonly activeProviderInstanceId: ProviderInstanceId;
  readonly activeModelId: ProviderModelId;
  readonly maintenanceProviderInstanceId?: ProviderInstanceId;
  readonly maintenanceModelId?: ProviderModelId;
  readonly crossVendorOptIn: boolean;
  readonly expectedReuseCount: number;
  readonly expectedSavingsPerReuseTokens: number;
  readonly maintenanceCostTokens: number;
  readonly materials: ReadonlyArray<SemanticSummaryMaterial>;
  readonly maxMaterialTokens: number;
}

export type SemanticSummaryDecision =
  | {
      readonly kind: "summarize";
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelId: ProviderModelId;
      readonly sourceEntryIds: ReadonlyArray<ContextEntryId>;
      readonly boundedMaterialTokens: number;
      readonly expectedGrossSavingsTokens: number;
      readonly expectedNetSavingsTokens: number;
    }
  | {
      readonly kind: "skip";
      readonly reason:
        | "cross-vendor-opt-in-required"
        | "no-eligible-material"
        | "material-limit-exceeded"
        | "not-net-positive";
    };

export function evaluateSemanticSummary(
  input: SemanticSummaryEvaluationInput,
): SemanticSummaryDecision {
  const expectedReuseCount = checkedNonNegativeInteger(
    input.expectedReuseCount,
    "Expected reuse count",
  );
  const expectedSavingsPerReuseTokens = checkedNonNegativeInteger(
    input.expectedSavingsPerReuseTokens,
    "Expected savings per reuse",
  );
  const maintenanceCostTokens = checkedNonNegativeInteger(
    input.maintenanceCostTokens,
    "Maintenance cost",
  );
  const maxMaterialTokens = checkedNonNegativeInteger(
    input.maxMaterialTokens,
    "Material token limit",
  );
  if (
    (input.maintenanceProviderInstanceId === undefined) !==
    (input.maintenanceModelId === undefined)
  ) {
    throw new ContextCompactionRejected(
      "invalid-value",
      "A maintenance provider and model must be configured together.",
    );
  }
  const maintenanceProviderInstanceId =
    input.maintenanceProviderInstanceId ?? input.activeProviderInstanceId;
  const maintenanceModelId = input.maintenanceModelId ?? input.activeModelId;
  if (maintenanceProviderInstanceId !== input.activeProviderInstanceId && !input.crossVendorOptIn) {
    return { kind: "skip", reason: "cross-vendor-opt-in-required" };
  }

  const eligibleMaterials = input.materials.filter(
    (material) =>
      material.eligible &&
      material.providerInstanceId === maintenanceProviderInstanceId &&
      (material.modelId === undefined || material.modelId === maintenanceModelId),
  );
  if (eligibleMaterials.length === 0) {
    return { kind: "skip", reason: "no-eligible-material" };
  }
  const boundedMaterialTokens = eligibleMaterials.reduce(
    (total, material) =>
      checkedAdd(
        total,
        checkedNonNegativeInteger(material.sizeTokens, "Material size"),
        "Combined material size",
      ),
    0,
  );
  if (boundedMaterialTokens > maxMaterialTokens) {
    return { kind: "skip", reason: "material-limit-exceeded" };
  }

  const boundedSavingsPerReuseTokens = Math.min(
    expectedSavingsPerReuseTokens,
    boundedMaterialTokens,
  );
  const expectedGrossSavingsTokens = checkedMultiply(
    expectedReuseCount,
    boundedSavingsPerReuseTokens,
    "Expected summary savings",
  );
  if (expectedGrossSavingsTokens <= maintenanceCostTokens) {
    return { kind: "skip", reason: "not-net-positive" };
  }
  return {
    kind: "summarize",
    providerInstanceId: maintenanceProviderInstanceId,
    modelId: maintenanceModelId,
    sourceEntryIds: eligibleMaterials.map((material) => material.entryId),
    boundedMaterialTokens,
    expectedGrossSavingsTokens,
    expectedNetSavingsTokens: expectedGrossSavingsTokens - maintenanceCostTokens,
  };
}

export interface ContextVarianceInput {
  readonly requestShape: string;
  readonly expectedRequestShape: string;
  readonly plannedInputTokens: number;
  readonly actualInputTokens: number;
  readonly currentVarianceReserve: number;
  readonly maxAdjustmentTokens: number;
}

export interface ContextVarianceResult {
  readonly requestShape: string;
  readonly varianceTokens: number;
  readonly reserveAdjustmentTokens: number;
  readonly nextVarianceReserve: number;
}

export function reconcileContextVariance(input: ContextVarianceInput): ContextVarianceResult {
  if (input.requestShape !== input.expectedRequestShape) {
    throw new ContextCompactionRejected(
      "request-shape-mismatch",
      "Usage variance can only update the matching request shape.",
    );
  }
  const planned = checkedNonNegativeInteger(input.plannedInputTokens, "Planned input");
  const actual = checkedNonNegativeInteger(input.actualInputTokens, "Actual input");
  const currentReserve = checkedNonNegativeInteger(
    input.currentVarianceReserve,
    "Current variance reserve",
  );
  const maxAdjustment = checkedNonNegativeInteger(
    input.maxAdjustmentTokens,
    "Maximum reserve adjustment",
  );
  const varianceTokens = actual - planned;
  if (!Number.isSafeInteger(varianceTokens)) {
    throw new ContextCompactionRejected(
      "unsafe-arithmetic",
      "Observed context variance exceeds safe arithmetic.",
    );
  }

  // Planned input excludes reserves: already covered overhead must not be
  // added again on every turn with the same provider framing.
  const uncoveredVariance = varianceTokens >= 0 ? varianceTokens - currentReserve : varianceTokens;
  const reserveAdjustmentTokens =
    uncoveredVariance >= 0
      ? Math.min(uncoveredVariance, maxAdjustment)
      : -Math.min(Math.floor(Math.abs(uncoveredVariance) / 2), maxAdjustment, currentReserve);
  const nextVarianceReserve = checkedAdd(
    currentReserve,
    reserveAdjustmentTokens,
    "Next variance reserve",
  );
  return {
    requestShape: input.requestShape,
    varianceTokens,
    reserveAdjustmentTokens,
    nextVarianceReserve,
  };
}

export interface ContextLengthRecoveryInput {
  readonly currentMarginTokens: number;
  readonly marginIncreaseTokens: number;
  readonly rebuilds: number;
}

export type ContextLengthRecoveryDecision =
  | { readonly kind: "rebuild-once"; readonly nextMarginTokens: number }
  | { readonly kind: "blocked"; readonly reason: "context-length-repeated" };

export function decideContextLengthRecovery(
  input: ContextLengthRecoveryInput,
): ContextLengthRecoveryDecision {
  const currentMargin = checkedNonNegativeInteger(input.currentMarginTokens, "Current margin");
  const marginIncrease = checkedNonNegativeInteger(input.marginIncreaseTokens, "Margin increase");
  if (marginIncrease === 0) {
    throw new ContextCompactionRejected("invalid-value", "Context recovery margin must increase.");
  }
  const rebuilds = checkedNonNegativeInteger(input.rebuilds, "Context rebuild count");
  if (rebuilds >= 1) {
    return { kind: "blocked", reason: "context-length-repeated" };
  }
  return {
    kind: "rebuild-once",
    nextMarginTokens: checkedAdd(currentMargin, marginIncrease, "Context recovery margin"),
  };
}

export interface SessionCompactionItem {
  /** The latest plan's entry for this item; absent for material newer than that plan. */
  readonly entryId?: ContextEntryId;
  readonly kind: "message" | "summary";
  /** The exchange the item belongs to. Items of one exchange are adjacent. */
  readonly exchangeKey: string;
  readonly tokens: number;
  /** False for pinned, excluded, or already summarized entries. */
  readonly summarizable: boolean;
}

export interface SessionCompactionSelectionInput {
  /** The thread's conversation, oldest first. */
  readonly items: ReadonlyArray<SessionCompactionItem>;
  readonly safeInputBudget: number;
  /**
   * What the summary request adds around the material: its instruction, and a
   * header and speaker label per excerpt. Selecting material up to the whole
   * budget without it would overflow the request exactly when a long session
   * most needs compacting.
   */
  readonly summaryFraming: { readonly fixedTokens: number; readonly perItemTokens: number };
}

export type SessionCompactionSelection =
  | {
      readonly kind: "summarize";
      readonly entryIds: ReadonlyArray<ContextEntryId>;
      readonly materialTokens: number;
      readonly throughExchangeKey: string;
    }
  | { readonly kind: "nothing-to-compact" };

/**
 * Picks what a requested compaction summarizes: the conversation before a tail
 * of the most recent exchanges that fit a quarter of the safe input budget,
 * always keeping the latest exchange. Material that does not fit one safe
 * summary request, framing included, is taken from the oldest end as far as it fits, and the rest
 * stays as it was. A selection that would only re-summarize an earlier summary
 * frees nothing, so it is nothing to compact.
 */
export function selectSessionCompaction(
  input: SessionCompactionSelectionInput,
): SessionCompactionSelection {
  const safeInputBudget = checkedNonNegativeInteger(input.safeInputBudget, "Safe input budget");
  const exchanges: Array<{ key: string; items: Array<SessionCompactionItem>; tokens: number }> = [];
  for (const item of input.items) {
    const tokens = checkedNonNegativeInteger(item.tokens, "Conversation item size");
    const last = exchanges.at(-1);
    if (last !== undefined && last.key === item.exchangeKey) {
      last.items.push(item);
      last.tokens = checkedAdd(last.tokens, tokens, "Exchange size");
    } else {
      exchanges.push({ key: item.exchangeKey, items: [item], tokens });
    }
  }
  const latest = exchanges.at(-1);
  if (latest === undefined) return { kind: "nothing-to-compact" };
  const tailBudget = Math.floor(safeInputBudget / 4);
  let tailStart = exchanges.length - 1;
  let tailTokens = latest.tokens;
  while (tailStart > 0) {
    const previous = exchanges[tailStart - 1];
    if (previous === undefined) break;
    const withPrevious = checkedAdd(tailTokens, previous.tokens, "Tail size");
    if (withPrevious > tailBudget) break;
    tailTokens = withPrevious;
    tailStart -= 1;
  }
  const perItemTokens = checkedNonNegativeInteger(
    input.summaryFraming.perItemTokens,
    "Summary framing per item",
  );
  const entryIds: Array<ContextEntryId> = [];
  let materialTokens = 0;
  let requestTokens = checkedNonNegativeInteger(
    input.summaryFraming.fixedTokens,
    "Summary framing",
  );
  let throughExchangeKey: string | undefined;
  const older = exchanges
    .slice(0, tailStart)
    .flatMap((exchange) => exchange.items.map((item) => ({ item, key: exchange.key })));
  for (const { item, key } of older) {
    if (!item.summarizable || item.entryId === undefined) continue;
    const withItem = checkedAdd(
      requestTokens,
      checkedAdd(item.tokens, perItemTokens, "Summary excerpt"),
      "Summary request",
    );
    if (withItem > safeInputBudget) break;
    entryIds.push(item.entryId);
    requestTokens = withItem;
    materialTokens = checkedAdd(materialTokens, item.tokens, "Summary material");
    if (item.kind === "message") throughExchangeKey = key;
  }
  return throughExchangeKey === undefined
    ? { kind: "nothing-to-compact" }
    : { kind: "summarize", entryIds, materialTokens, throughExchangeKey };
}

export interface SessionCompactionFacts {
  readonly principal: "local-window" | "remote-device";
  readonly modeEnabled: boolean;
  /** Who owns the conversation, and so who alone can change what it sends. */
  readonly owner: "host" | "runtime";
  /** The runtime's own compaction, reported by its adapter. Ignored for the host. */
  readonly runtimeCompaction: "supported" | "unsupported" | "unavailable";
  /**
   * Whether a turn on the thread would be admitted, as far as the thread and
   * its Project decide it. A compaction refuses where the next turn would.
   */
  readonly turnAdmission:
    | "admitted"
    | "project-unavailable"
    | "model-options-unsupported"
    | "thread-paused";
  readonly hasSession: boolean;
  readonly compactionRunning: boolean;
  readonly turnRunning: boolean;
  readonly providerAvailable: boolean;
  readonly spendCeilingReached: boolean;
  readonly somethingToCompact: boolean;
}

/**
 * Whether a thread can be compacted now. Permanent refusals come before
 * transient ones, so a window hides the action rather than offering a retry
 * that can never succeed.
 */
export function decideSessionCompaction(
  facts: SessionCompactionFacts,
): ContextCompactionAvailability {
  const refuse = (
    reason: Extract<ContextCompactionAvailability, { status: "refused" }>["reason"],
  ) => ({ status: "refused", reason }) as const;
  if (facts.principal !== "local-window") return refuse("remote-client");
  if (!facts.modeEnabled) return refuse("mode-disabled");
  if (facts.owner === "runtime") {
    if (facts.runtimeCompaction === "unsupported") return refuse("runtime-cannot-compact");
    if (facts.runtimeCompaction === "unavailable") return refuse("runtime-version-unsupported");
  }
  if (facts.turnAdmission !== "admitted") return refuse(facts.turnAdmission);
  if (!facts.hasSession) return refuse("no-session");
  if (facts.compactionRunning) return refuse("compaction-running");
  if (facts.turnRunning) return refuse("turn-running");
  if (!facts.providerAvailable) return refuse("provider-unavailable");
  if (facts.spendCeilingReached) return refuse("spend-ceiling-reached");
  if (!facts.somethingToCompact) return refuse("nothing-to-compact");
  return { status: "available" };
}

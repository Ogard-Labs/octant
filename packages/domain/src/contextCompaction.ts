import type { ContextEntryId, ProviderInstanceId, ProviderModelId } from "@octant/contracts";

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

  const reserveAdjustmentTokens =
    varianceTokens >= 0
      ? Math.min(varianceTokens, maxAdjustment)
      : -Math.min(Math.floor(Math.abs(varianceTokens) / 2), maxAdjustment, currentReserve);
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

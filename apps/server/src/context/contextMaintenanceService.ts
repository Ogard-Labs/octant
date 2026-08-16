import {
  decodeContextSummary,
  decodeTokenMeasurement,
  decodeUsageReconciliation,
  type ContextEntryId,
  type ContextPlanId,
  type ContextSummaryId,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import type {
  ContextDispatchPlan,
  GeneratedContextSummary,
  ContextMaintenanceIdentityPort,
  ContextMaintenancePort,
} from "./contextMaintenancePort";

interface SummaryMaterialFact {
  readonly entryId: ContextEntryId;
  readonly sizeTokens: number;
  readonly eligible: boolean;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId?: ProviderModelId;
}

interface SummaryPolicyInput {
  readonly activeProviderInstanceId: ProviderInstanceId;
  readonly activeModelId: ProviderModelId;
  readonly maintenanceProviderInstanceId?: ProviderInstanceId;
  readonly maintenanceModelId?: ProviderModelId;
  readonly crossVendorOptIn: boolean;
  readonly expectedReuseCount: number;
  readonly expectedSavingsPerReuseTokens: number;
  readonly maintenanceCostTokens: number;
  readonly materials: ReadonlyArray<SummaryMaterialFact>;
  readonly maxMaterialTokens: number;
}

type SummaryPolicyDecision =
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
      readonly reason: string;
    };

interface VariancePolicyInput {
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

interface RecoveryPolicyInput {
  readonly currentMarginTokens: number;
  readonly marginIncreaseTokens: number;
  readonly rebuilds: number;
}

type RecoveryPolicyDecision =
  | { readonly kind: "rebuild-once"; readonly nextMarginTokens: number }
  | { readonly kind: "blocked"; readonly reason: "context-length-repeated" };

export interface ContextMaintenancePolicy {
  readonly evaluateSummary: (input: SummaryPolicyInput) => SummaryPolicyDecision;
  readonly reconcileVariance: (input: VariancePolicyInput) => ContextVarianceResult;
  readonly decideContextLengthRecovery: (input: RecoveryPolicyInput) => RecoveryPolicyDecision;
}

export interface ContextMaintenanceServiceOptions {
  readonly port: ContextMaintenancePort;
  readonly policy: ContextMaintenancePolicy;
  readonly identity: ContextMaintenanceIdentityPort;
}

export interface MaintainContextInput extends SummaryPolicyInput {
  readonly replacedSummaryIds: ReadonlyArray<ContextSummaryId>;
  readonly deterministicFallbackAvailable: boolean;
}

export type ContextMaintenanceResult =
  | { readonly kind: "summary-created"; readonly summaryId: ContextSummaryId }
  | { readonly kind: "deterministic-reduction"; readonly reason: string }
  | {
      readonly kind: "user-decision";
      readonly reason: string;
      readonly remedies: ReadonlyArray<"compact-range" | "exclude-context" | "switch-model">;
    }
  | { readonly kind: "cancelled" };

export interface ReconcileUsageInput extends VariancePolicyInput {
  readonly planId: ContextPlanId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly actualOutputTokens: number;
  readonly reasoningTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly providerExecutionDurationMs?: number;
}

export type UsageReconciliationResult =
  | { readonly kind: "usage-reconciled"; readonly variance: ContextVarianceResult }
  | { readonly kind: "cancelled" };

export type ContextDispatchResult =
  | { readonly kind: "dispatched"; readonly rebuilds: number; readonly marginTokens: number }
  | {
      readonly kind: "blocked";
      readonly reason: "context-length-repeated";
      readonly rebuilds: number;
    }
  | { readonly kind: "cancelled" };

export class ContextLengthRejected extends Error {
  override readonly name = "ContextLengthRejected";

  constructor() {
    super("Provider rejected the request context length.");
  }
}

export class ContextMaintenanceBoundaryError extends Error {
  override readonly name = "ContextMaintenanceBoundaryError";
}

function cancelled(signal: AbortSignal): { readonly kind: "cancelled" } | undefined {
  return signal.aborted ? { kind: "cancelled" } : undefined;
}

export class ContextMaintenanceService {
  readonly #port: ContextMaintenancePort;
  readonly #policy: ContextMaintenancePolicy;
  readonly #identity: ContextMaintenanceIdentityPort;

  constructor(options: ContextMaintenanceServiceOptions) {
    this.#port = options.port;
    this.#policy = options.policy;
    this.#identity = options.identity;
  }

  async maintain(
    input: MaintainContextInput,
    signal: AbortSignal,
  ): Promise<ContextMaintenanceResult> {
    const cancellation = cancelled(signal);
    if (cancellation !== undefined) return cancellation;

    const decision = this.#policy.evaluateSummary(input);
    if (decision.kind === "skip") {
      return input.deterministicFallbackAvailable
        ? { kind: "deterministic-reduction", reason: decision.reason }
        : this.#userDecision(decision.reason);
    }
    this.#assertMaintenanceTarget(input, decision);
    this.#assertBoundedDecision(input, decision);
    const materials = this.#port.loadMaterials(decision.sourceEntryIds);
    this.#assertLoadedMaterials(decision.sourceEntryIds, decision.boundedMaterialTokens, materials);

    let generated: GeneratedContextSummary;
    try {
      generated = await this.#port.generateSummary(
        {
          providerInstanceId: decision.providerInstanceId,
          modelId: decision.modelId,
          materials,
        },
        signal,
      );
    } catch {
      if (signal.aborted) return { kind: "cancelled" };
      return input.deterministicFallbackAvailable
        ? { kind: "deterministic-reduction", reason: "summary-generation-failed" }
        : this.#userDecision("summary-generation-failed");
    }
    const afterGenerationCancellation = cancelled(signal);
    if (afterGenerationCancellation !== undefined) return afterGenerationCancellation;

    let summaryTokens: ReturnType<typeof decodeTokenMeasurement>;
    try {
      summaryTokens = decodeTokenMeasurement(generated.summaryTokens);
    } catch {
      return this.#summaryFallback(input, "summary-usage-invalid");
    }
    if (summaryTokens.kind === "unknown") {
      return this.#summaryFallback(input, "summary-usage-unavailable");
    }
    if (summaryTokens.tokens > decision.boundedMaterialTokens) {
      return this.#summaryFallback(input, "summary-usage-invalid");
    }

    const summary = decodeContextSummary({
      id: this.#identity.summaryId(),
      sourceEntryIds: decision.sourceEntryIds,
      providerInstanceId: decision.providerInstanceId,
      modelId: decision.modelId,
      createdAt: this.#identity.timestamp(),
      usageCount: 0,
      summaryTokens,
      originalTokens: {
        kind: "known",
        tokens: decision.boundedMaterialTokens,
        accuracy: "conservative-heuristic",
      },
      estimatedSavingsTokens: decision.expectedNetSavingsTokens,
      replacedSummaryIds: input.replacedSummaryIds,
    });
    this.#port.writeSummary({ summary, content: generated.content });
    return { kind: "summary-created", summaryId: summary.id };
  }

  reconcileUsage(input: ReconcileUsageInput, signal: AbortSignal): UsageReconciliationResult {
    const cancellation = cancelled(signal);
    if (cancellation !== undefined) return cancellation;
    const variance = this.#policy.reconcileVariance(input);
    const reconciliation = decodeUsageReconciliation({
      id: this.#identity.usageId(),
      planId: input.planId,
      providerInstanceId: input.providerInstanceId,
      modelId: input.modelId,
      requestShape: input.requestShape,
      plannedInputTokens: input.plannedInputTokens,
      actualInputTokens: input.actualInputTokens,
      actualOutputTokens: input.actualOutputTokens,
      ...(input.reasoningTokens === undefined ? {} : { reasoningTokens: input.reasoningTokens }),
      ...(input.cacheReadInputTokens === undefined
        ? {}
        : { cacheReadInputTokens: input.cacheReadInputTokens }),
      ...(input.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteInputTokens: input.cacheWriteInputTokens }),
      ...(input.providerExecutionDurationMs === undefined
        ? {}
        : { providerExecutionDurationMs: input.providerExecutionDurationMs }),
      varianceTokens: variance.varianceTokens,
      observedAt: this.#identity.timestamp(),
    });
    const beforeWriteCancellation = cancelled(signal);
    if (beforeWriteCancellation !== undefined) return beforeWriteCancellation;
    this.#port.writeUsage(reconciliation);
    return { kind: "usage-reconciled", variance };
  }

  async dispatchWithContextRecovery(
    plan: ContextDispatchPlan,
    marginIncreaseTokens: number,
    signal: AbortSignal,
  ): Promise<ContextDispatchResult> {
    const cancellation = cancelled(signal);
    if (cancellation !== undefined) return cancellation;
    try {
      await this.#port.dispatch(plan, signal);
      return { kind: "dispatched", rebuilds: 0, marginTokens: plan.marginTokens };
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled" };
      if (!(error instanceof ContextLengthRejected)) throw error;
    }

    const recovery = this.#policy.decideContextLengthRecovery({
      currentMarginTokens: plan.marginTokens,
      marginIncreaseTokens,
      rebuilds: 0,
    });
    if (recovery.kind === "blocked") {
      return { kind: "blocked", reason: recovery.reason, rebuilds: 0 };
    }
    const rebuiltPlan = this.#port.rebuildContextPlan(plan, recovery.nextMarginTokens);
    if (
      rebuiltPlan.planId !== plan.planId ||
      rebuiltPlan.marginTokens !== recovery.nextMarginTokens ||
      rebuiltPlan.marginTokens <= plan.marginTokens
    ) {
      throw new ContextMaintenanceBoundaryError(
        "The rebuilt context plan changed identity or did not use the exact larger policy margin.",
      );
    }
    try {
      await this.#port.dispatch(rebuiltPlan, signal);
      return { kind: "dispatched", rebuilds: 1, marginTokens: rebuiltPlan.marginTokens };
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled" };
      if (!(error instanceof ContextLengthRejected)) throw error;
      const repeated = this.#policy.decideContextLengthRecovery({
        currentMarginTokens: rebuiltPlan.marginTokens,
        marginIncreaseTokens,
        rebuilds: 1,
      });
      if (repeated.kind !== "blocked") {
        throw new ContextMaintenanceBoundaryError(
          "Context recovery policy attempted more than one rebuild.",
        );
      }
      return { kind: "blocked", reason: repeated.reason, rebuilds: 1 };
    }
  }

  #assertBoundedDecision(
    input: MaintainContextInput,
    decision: Extract<SummaryPolicyDecision, { readonly kind: "summarize" }>,
  ): void {
    const economicValues = [
      input.expectedReuseCount,
      input.expectedSavingsPerReuseTokens,
      input.maintenanceCostTokens,
      input.maxMaterialTokens,
    ];
    if (economicValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new ContextMaintenanceBoundaryError(
        "Summary policy received invalid bounded savings inputs.",
      );
    }
    const eligible = new Map(
      input.materials
        .filter(
          (material) =>
            material.eligible &&
            material.providerInstanceId === decision.providerInstanceId &&
            (material.modelId === undefined || material.modelId === decision.modelId),
        )
        .map((material) => [material.entryId, material.sizeTokens]),
    );
    let total = 0;
    for (const entryId of decision.sourceEntryIds) {
      const size = eligible.get(entryId);
      if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
        throw new ContextMaintenanceBoundaryError(
          "Summary policy selected ineligible or invalid source material.",
        );
      }
      total += size;
      if (!Number.isSafeInteger(total)) {
        throw new ContextMaintenanceBoundaryError("Summary source size exceeds safe arithmetic.");
      }
    }
    if (
      decision.sourceEntryIds.length === 0 ||
      total !== decision.boundedMaterialTokens ||
      total > input.maxMaterialTokens
    ) {
      throw new ContextMaintenanceBoundaryError("Summary policy exceeded its bounded material.");
    }
    const boundedSavingsPerReuse = Math.min(input.expectedSavingsPerReuseTokens, total);
    const expectedGrossSavingsTokens = input.expectedReuseCount * boundedSavingsPerReuse;
    const expectedNetSavingsTokens = expectedGrossSavingsTokens - input.maintenanceCostTokens;
    if (
      !Number.isSafeInteger(expectedGrossSavingsTokens) ||
      expectedNetSavingsTokens <= 0 ||
      decision.expectedGrossSavingsTokens !== expectedGrossSavingsTokens ||
      decision.expectedNetSavingsTokens !== expectedNetSavingsTokens
    ) {
      throw new ContextMaintenanceBoundaryError(
        "Summary policy returned invalid bounded savings economics.",
      );
    }
  }

  #assertMaintenanceTarget(
    input: MaintainContextInput,
    decision: Extract<SummaryPolicyDecision, { readonly kind: "summarize" }>,
  ): void {
    const hasProvider = input.maintenanceProviderInstanceId !== undefined;
    const hasModel = input.maintenanceModelId !== undefined;
    if (hasProvider !== hasModel) {
      throw new ContextMaintenanceBoundaryError(
        "The configured maintenance target must include both provider and model.",
      );
    }
    const expectedProviderInstanceId =
      input.maintenanceProviderInstanceId ?? input.activeProviderInstanceId;
    const expectedModelId = input.maintenanceModelId ?? input.activeModelId;
    if (expectedProviderInstanceId !== input.activeProviderInstanceId && !input.crossVendorOptIn) {
      throw new ContextMaintenanceBoundaryError(
        "The configured maintenance target requires explicit cross-vendor opt-in.",
      );
    }
    if (
      decision.providerInstanceId !== expectedProviderInstanceId ||
      decision.modelId !== expectedModelId
    ) {
      throw new ContextMaintenanceBoundaryError(
        "Summary policy selected a different maintenance target than configured.",
      );
    }
  }

  #assertLoadedMaterials(
    entryIds: ReadonlyArray<ContextEntryId>,
    boundedMaterialTokens: number,
    materials: ReadonlyArray<{ readonly entryId: ContextEntryId; readonly sizeTokens: number }>,
  ): void {
    const exactIds =
      materials.length === entryIds.length &&
      materials.every((material, index) => material.entryId === entryIds[index]);
    const validSizes = materials.every(
      (material) => Number.isSafeInteger(material.sizeTokens) && material.sizeTokens >= 0,
    );
    const total = materials.reduce((sum, material) => sum + material.sizeTokens, 0);
    if (
      !exactIds ||
      !validSizes ||
      !Number.isSafeInteger(total) ||
      total !== boundedMaterialTokens
    ) {
      throw new ContextMaintenanceBoundaryError(
        "Loaded context material does not match the bounded policy decision.",
      );
    }
  }

  #userDecision(reason: string): ContextMaintenanceResult {
    return {
      kind: "user-decision",
      reason,
      remedies: ["compact-range", "exclude-context", "switch-model"],
    };
  }

  #summaryFallback(input: MaintainContextInput, reason: string): ContextMaintenanceResult {
    return input.deterministicFallbackAvailable
      ? { kind: "deterministic-reduction", reason }
      : this.#userDecision(reason);
  }
}

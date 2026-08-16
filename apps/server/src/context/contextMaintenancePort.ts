import type {
  ContextEntryId,
  ContextPlanId,
  ContextSummary,
  ContextSummaryId,
  ProviderInstanceId,
  ProviderModelId,
  TokenMeasurement,
  UsageReconciliation,
} from "@octant/contracts";

export interface ContextMaintenanceMaterial {
  readonly entryId: ContextEntryId;
  readonly content: string;
  readonly sizeTokens: number;
}

export interface GenerateContextSummaryRequest {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly materials: ReadonlyArray<ContextMaintenanceMaterial>;
}

export interface GeneratedContextSummary {
  readonly content: string;
  readonly summaryTokens: TokenMeasurement;
}

export interface StoredContextSummary {
  readonly summary: ContextSummary;
  readonly content: string;
}

export interface ContextDispatchPlan {
  readonly planId: ContextPlanId;
  readonly marginTokens: number;
}

export interface ContextMaintenancePort {
  readonly loadMaterials: (
    entryIds: ReadonlyArray<ContextEntryId>,
  ) => ReadonlyArray<ContextMaintenanceMaterial>;
  readonly generateSummary: (
    request: GenerateContextSummaryRequest,
    signal: AbortSignal,
  ) => Promise<GeneratedContextSummary>;
  readonly writeSummary: (summary: StoredContextSummary) => void;
  readonly writeUsage: (reconciliation: UsageReconciliation) => void;
  readonly rebuildContextPlan: (
    plan: ContextDispatchPlan,
    nextMarginTokens: number,
  ) => ContextDispatchPlan;
  readonly dispatch: (plan: ContextDispatchPlan, signal: AbortSignal) => Promise<void>;
}

export interface ContextMaintenanceIdentityPort {
  readonly summaryId: () => ContextSummaryId;
  readonly usageId: () => UsageReconciliation["id"];
  readonly timestamp: () => UsageReconciliation["observedAt"];
}

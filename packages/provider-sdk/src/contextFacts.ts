import {
  decodeModelContextLimits,
  decodeProviderServiceLimits,
  type ContextConfidence,
  type ContextMetadataSource,
  type ContextTokenizer,
  type ExtendedContextMode,
  type ModelContextLimits,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderServiceLimits,
  type ProviderSessionId,
  type UtcTimestamp,
} from "@octant/contracts";
import type { Effect, Scope } from "effect";

export interface ProviderContextFactsInput {
  readonly instanceId: ProviderInstanceId;
}

export interface ProviderModelLimitEvidence {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly extendedContext?: ExtendedContextMode;
  readonly reasoning?: ModelContextLimits["reasoning"];
  readonly compaction?: ModelContextLimits["compaction"];
  readonly tokenizer?: ContextTokenizer;
  readonly source: ContextMetadataSource;
  readonly confidence: ContextConfidence;
  readonly observedAt: UtcTimestamp;
}

export type ModelLimitMissingField = "context-window" | "max-output";

export type ProviderModelLimitsObservation =
  | { readonly status: "available"; readonly limits: ModelContextLimits }
  | {
      readonly status: "unavailable";
      readonly reason: "incomplete";
      readonly missing: ReadonlyArray<ModelLimitMissingField>;
    };

export interface ProviderUsageObservation {
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId: ProviderSessionId;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly providerExecutionDurationMs?: number;
  readonly accuracy: "provider-reported";
  readonly observedAt: UtcTimestamp;
}

export interface ProviderContextFactsSource {
  readonly observeModelLimits: (
    input: ProviderContextFactsInput,
  ) => Effect.Effect<ReadonlyArray<ProviderModelLimitEvidence>, ProviderFailure, Scope.Scope>;
  readonly observeServiceLimits: (
    input: ProviderContextFactsInput,
  ) => Effect.Effect<ProviderServiceLimits, ProviderFailure, Scope.Scope>;
}

export class ProviderContextFactsRejected extends Error {
  override readonly name = "ProviderContextFactsRejected";
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProviderContextFactsRejected(`${label} must be a positive safe integer.`);
  }
}

export function normalizeModelLimitEvidence(
  evidence: ProviderModelLimitEvidence,
): ProviderModelLimitsObservation {
  const missing: Array<ModelLimitMissingField> = [];
  if (evidence.contextWindow === undefined) missing.push("context-window");
  if (evidence.maxOutput === undefined) missing.push("max-output");
  if (missing.length > 0) return { status: "unavailable", reason: "incomplete", missing };

  assertPositiveSafeInteger(evidence.contextWindow!, "Context window");
  assertPositiveSafeInteger(evidence.maxOutput!, "Maximum output");
  if (evidence.maxOutput! > evidence.contextWindow!) {
    throw new ProviderContextFactsRejected("Maximum output cannot exceed the context window.");
  }

  return {
    status: "available",
    limits: decodeModelContextLimits({
      providerInstanceId: evidence.providerInstanceId,
      modelId: evidence.modelId,
      contextWindow: evidence.contextWindow,
      maxOutput: evidence.maxOutput,
      extendedContext: evidence.extendedContext ?? { kind: "unavailable" },
      reasoning: evidence.reasoning ?? "unknown",
      compaction: evidence.compaction ?? "unknown",
      tokenizer: evidence.tokenizer ?? { kind: "unavailable" },
      source: evidence.source,
      confidence: evidence.confidence,
      conflicts: [],
      verifiedAt: evidence.observedAt,
    }),
  };
}

export function unavailableProviderServiceLimits(
  providerInstanceId: ProviderInstanceId,
  updatedAt: UtcTimestamp,
  source: ContextMetadataSource,
): ProviderServiceLimits {
  return decodeProviderServiceLimits({
    providerInstanceId,
    scope: "provider-instance",
    requests: { status: "unavailable" },
    tokens: { status: "unavailable" },
    concurrency: { status: "unavailable" },
    retry: { status: "inactive" },
    quota: "unavailable",
    source,
    confidence: "unknown",
    updatedAt,
  });
}

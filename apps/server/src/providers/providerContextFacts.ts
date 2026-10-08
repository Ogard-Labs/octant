import {
  decodeProviderServiceLimits,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderObservedState,
  type ProviderRuntimeEvent,
  type ProviderServiceLimits,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  resolveModelContextWindow,
  type ModelContextWindowSource,
} from "@octant/domain/model-context-window";
import {
  ProviderContextFactsRejected,
  type ProviderModelLimitEvidence,
  type ProviderUsageObservation,
} from "@octant/provider-sdk";

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProviderContextFactsRejected(`${label} must be a non-negative safe integer.`);
  }
}

/**
 * Each observed model's window as `resolveModelContextWindow` settles it: what a
 * person set, what the provider reported, what refusals taught, or the
 * built-in profile, labelled with that source. A model none of them names
 * carries no window, so the caller plans with its labelled estimate.
 */
export function modelEvidenceFromObservedState(
  state: ProviderObservedState,
): ReadonlyArray<ProviderModelLimitEvidence> {
  return state.models.map((model) => {
    const resolved = resolveModelContextWindow(model);
    return {
      providerInstanceId: state.instanceId,
      modelId: model.id,
      ...(resolved === undefined
        ? {}
        : {
            contextWindow: resolved.contextWindow,
            ...(resolved.maxOutput === undefined ? {} : { maxOutput: resolved.maxOutput }),
          }),
      reasoning: model.reasoning === "supported" ? "included" : "unknown",
      source:
        resolved?.source ??
        (model.source === "discovered" ? "provider-discovery" : "user-supplied"),
      confidence: modelWindowConfidence(resolved?.source, model.verification === "verified"),
      observedAt: state.observedAt,
    };
  });
}

/**
 * How far a resolved window is trusted. A person's figure and a verified
 * provider's report are firm; a learned or profile window is the best
 * available evidence but may still move.
 */
export function modelWindowConfidence(
  source: ModelContextWindowSource | undefined,
  verified: boolean,
): "high" | "medium" | "low" {
  if (source === "user-supplied") return "high";
  if (source === "observed-evidence" || source === "reviewed-catalog") return "medium";
  return verified ? "high" : "low";
}

export function usageFromRuntimeEvent(
  event: ProviderRuntimeEvent,
): ProviderUsageObservation | undefined {
  if (event.kind !== "usage") return undefined;
  assertNonNegativeSafeInteger(event.inputTokens, "Provider input usage");
  assertNonNegativeSafeInteger(event.outputTokens, "Provider output usage");
  if (event.reasoningTokens !== undefined) {
    assertNonNegativeSafeInteger(event.reasoningTokens, "Provider reasoning usage");
  }
  if (event.cacheReadInputTokens !== undefined) {
    assertNonNegativeSafeInteger(event.cacheReadInputTokens, "Provider cache-read usage");
  }
  if (event.cacheWriteInputTokens !== undefined) {
    assertNonNegativeSafeInteger(event.cacheWriteInputTokens, "Provider cache-write usage");
  }
  if (event.providerExecutionDurationMs !== undefined) {
    assertNonNegativeSafeInteger(event.providerExecutionDurationMs, "Provider execution duration");
  }
  if (event.costUsd !== undefined && (!Number.isFinite(event.costUsd) || event.costUsd < 0)) {
    throw new ProviderContextFactsRejected("Provider cost must be a non-negative finite number.");
  }
  return {
    providerInstanceId: event.instanceId,
    sessionId: event.sessionId,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.reasoningTokens === undefined ? {} : { reasoningTokens: event.reasoningTokens }),
    ...(event.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: event.cacheReadInputTokens }),
    ...(event.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: event.cacheWriteInputTokens }),
    ...(event.providerExecutionDurationMs === undefined
      ? {}
      : { providerExecutionDurationMs: event.providerExecutionDurationMs }),
    ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
    accuracy: "provider-reported",
    observedAt: event.occurredAt,
  };
}

export function serviceLimitsFromFailure(
  providerInstanceId: ProviderInstanceId,
  failure: ProviderFailure,
  now: () => number,
): ProviderServiceLimits {
  const observedAtMs = now();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new ProviderContextFactsRejected(
      "Provider service-limit clock must return a non-negative safe integer timestamp.",
    );
  }
  if (
    failure.retryAfterMs !== undefined &&
    !Number.isSafeInteger(observedAtMs + failure.retryAfterMs)
  ) {
    throw new ProviderContextFactsRejected("Provider retry timestamp exceeds safe arithmetic.");
  }
  const updatedAt = new Date(observedAtMs).toISOString() as UtcTimestamp;
  const retry =
    failure.category === "rate-limited" && failure.retryAfterMs !== undefined
      ? {
          status: "active" as const,
          until: new Date(observedAtMs + failure.retryAfterMs).toISOString(),
        }
      : { status: "inactive" as const };

  return decodeProviderServiceLimits({
    providerInstanceId,
    scope: "provider-instance",
    requests: { status: "unavailable" },
    tokens: { status: "unavailable" },
    concurrency: { status: "unavailable" },
    retry,
    quota: failure.category === "rate-limited" ? "unknown" : "unavailable",
    source: "observed-evidence",
    confidence: failure.category === "rate-limited" ? "high" : "unknown",
    updatedAt,
  });
}

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
  ProviderContextFactsRejected,
  type ProviderModelLimitEvidence,
  type ProviderUsageObservation,
} from "@octant/provider-sdk";

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProviderContextFactsRejected(`${label} must be a non-negative safe integer.`);
  }
}

export function modelEvidenceFromObservedState(
  state: ProviderObservedState,
): ReadonlyArray<ProviderModelLimitEvidence> {
  return state.models.map((model) => ({
    providerInstanceId: state.instanceId,
    modelId: model.id,
    ...(model.contextLimit === undefined ? {} : { contextWindow: model.contextLimit }),
    reasoning: model.reasoning === "supported" ? "included" : "unknown",
    source: model.source === "discovered" ? "provider-discovery" : "user-supplied",
    confidence: model.verification === "verified" ? "high" : "low",
    observedAt: state.observedAt,
  }));
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

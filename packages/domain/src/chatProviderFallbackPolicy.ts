import type { ChatProviderFallback } from "@octant/contracts/chat";
import type {
  ProviderCapabilities,
  ProviderInstanceId,
  ProviderModelId,
  ProviderReadiness,
} from "@octant/contracts/providers";

export type ChatProviderCapabilityName = keyof ProviderCapabilities;

/**
 * What a turn needs from the provider instance it is about to run on.
 *
 * Only the facts a provider reports about itself: the readiness of the
 * instance, the models it currently offers, and the capabilities it declares.
 */
export interface ChatProviderTurnFacts {
  readonly readiness: ProviderReadiness;
  readonly models: ReadonlyArray<ProviderModelId>;
  readonly capabilities: ProviderCapabilities;
}

export interface ChatProviderTurnRequirements {
  readonly modelId: ProviderModelId;
  readonly requiredCapabilities: ReadonlyArray<ChatProviderCapabilityName>;
}

export type ChatProviderTurnRefusal =
  | "provider-unavailable"
  | "model-unavailable"
  | "capability-unavailable";

export type ChatProviderTurnDecision =
  | { readonly kind: "serves" }
  | { readonly kind: "refuses"; readonly reason: ChatProviderTurnRefusal };

/**
 * Whether a provider instance can serve this turn as observed right now.
 *
 * A degraded instance still serves when it offers the model: partial
 * discovery leaves manually configured deployments usable. Every other
 * non-ready readiness refuses, and a capability the instance does not report
 * as supported refuses, so an honestly unsupported capability is never
 * assumed present.
 */
export function chatProviderServesTurn(
  facts: ChatProviderTurnFacts,
  requirements: ChatProviderTurnRequirements,
): ChatProviderTurnDecision {
  if (facts.readiness !== "ready" && facts.readiness !== "degraded") {
    return { kind: "refuses", reason: "provider-unavailable" };
  }
  if (!facts.models.some((model) => String(model) === String(requirements.modelId))) {
    return { kind: "refuses", reason: "model-unavailable" };
  }
  for (const capability of requirements.requiredCapabilities) {
    if (facts.capabilities[capability] !== "supported") {
      return { kind: "refuses", reason: "capability-unavailable" };
    }
  }
  return { kind: "serves" };
}

export interface ChatProviderFallbackInput {
  /**
   * The user's opt-in fallback route. Absent means the thread stays on its own
   * provider and reports why that provider refused the turn.
   */
  readonly preference: ChatProviderFallback | undefined;
  readonly activeProviderInstanceId: ProviderInstanceId;
  readonly requiredCapabilities: ReadonlyArray<ChatProviderCapabilityName>;
  /** The fallback instance's own observed facts, absent when it could not be observed. */
  readonly candidate: ChatProviderTurnFacts | undefined;
}

export type ChatProviderFallbackRefusal =
  | "no-preference"
  | "same-provider"
  | ChatProviderTurnRefusal;

export type ChatProviderFallbackDecision =
  | {
      readonly kind: "selected";
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelId: ProviderModelId;
    }
  | { readonly kind: "refuses"; readonly reason: ChatProviderFallbackRefusal };

/**
 * The route a turn takes when its own provider cannot serve it.
 *
 * Fallback is opt-in and capability-gated: without a preference, or when the
 * named instance cannot honestly serve the same turn, the turn refuses on the
 * thread's own provider rather than degrading silently onto another one. A
 * preference naming the provider that already refused is not a route.
 */
export function selectChatProviderFallback(
  input: ChatProviderFallbackInput,
): ChatProviderFallbackDecision {
  const { preference } = input;
  if (preference === undefined) return { kind: "refuses", reason: "no-preference" };
  if (String(preference.providerInstanceId) === String(input.activeProviderInstanceId)) {
    return { kind: "refuses", reason: "same-provider" };
  }
  if (input.candidate === undefined) {
    return { kind: "refuses", reason: "provider-unavailable" };
  }
  const served = chatProviderServesTurn(input.candidate, {
    modelId: preference.modelId,
    requiredCapabilities: input.requiredCapabilities,
  });
  if (served.kind === "refuses") return { kind: "refuses", reason: served.reason };
  return {
    kind: "selected",
    providerInstanceId: preference.providerInstanceId,
    modelId: preference.modelId,
  };
}

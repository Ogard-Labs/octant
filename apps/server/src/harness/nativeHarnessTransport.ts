import type {
  ProviderFailure,
  ProviderInstanceId,
  ProviderModelId,
  ProviderTurnInput,
} from "@octant/contracts";
import type {
  HarnessEndpointMessage,
  HarnessEndpointRequest,
  HarnessEndpointResponse,
  HarnessEndpointSession,
  HarnessEndpointStreamEvent,
  HarnessEndpointTransport,
  HarnessEndpointUsage,
} from "@octant/provider-sdk/harness-endpoint";

// The transport shapes are the provider-sdk harness endpoint port, so a driver
// supplying an endpoint through the port and the loop consuming it agree on one
// definition. The host-side names stay for the loop and its existing drivers.
export type NativeHarnessMessage = HarnessEndpointMessage;
export type NativeHarnessUsage = HarnessEndpointUsage;
export type NativeHarnessStreamEvent = HarnessEndpointStreamEvent;
export type NativeHarnessRequest = HarnessEndpointRequest;
export type NativeHarnessResponse = HarnessEndpointResponse;
export type NativeHarnessTransportSession = HarnessEndpointSession;
export type NativeHarnessTransport = HarnessEndpointTransport;

/**
 * A token figure only appears in the total once some request has reported it.
 * Cost is stricter: a total is only a cost when every request in it reported
 * one, because a sum with a hole in it would read as the whole charge. The
 * empty total a turn starts from therefore carries a cost of zero.
 */
export function addNativeHarnessUsage(
  total: NativeHarnessUsage,
  step: NativeHarnessUsage,
): NativeHarnessUsage {
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const cacheRead = sum(total.cacheReadInputTokens, step.cacheReadInputTokens);
  const cacheWrite = sum(total.cacheWriteInputTokens, step.cacheWriteInputTokens);
  const reasoning = sum(total.reasoningTokens, step.reasoningTokens);
  const cost =
    total.costUsd === undefined || step.costUsd === undefined
      ? undefined
      : total.costUsd + step.costUsd;
  return {
    inputTokens: total.inputTokens + step.inputTokens,
    outputTokens: total.outputTokens + step.outputTokens,
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

/** The model a lead's request is going to, on which provider instance. */
export interface NativeHarnessLeadTarget {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

/**
 * Where a lead whose model kept failing continues, and why when nowhere. The
 * refusals are the routing vocabulary: the slot has no candidate, none of its
 * candidates is ready, or its circuit breaker is open. `no-other-model` is a
 * chain that only offers models this turn already tried, `not-routed` a turn
 * the host is not tracking, and `refused` a model that cannot take this turn.
 */
export type NativeHarnessLeadFallbackOutcome =
  | {
      readonly status: "switched";
      readonly target: NativeHarnessLeadTarget;
      readonly endpoint: NativeHarnessTransportSession;
    }
  | {
      readonly status: "none";
      readonly reason:
        | "slot-empty"
        | "no-eligible-candidate"
        | "circuit-open"
        | "no-other-model"
        | "not-routed"
        | "refused";
    };

/**
 * The lead's way off a model that stays down. It is asked once the endpoint's
 * own retries have run out and nothing of the failed request streamed, so
 * continuing on another model cannot repeat anything the user saw. Which model
 * comes next is the router's answer; the loop only carries the turn over.
 */
export interface NativeHarnessLeadFallback {
  readonly next: (input: {
    readonly failed: NativeHarnessLeadTarget;
    /** Models this turn already ran on, the failed one last. */
    readonly attempted: ReadonlyArray<NativeHarnessLeadTarget>;
    readonly failure: ProviderFailure;
    readonly turn: ProviderTurnInput;
  }) => Promise<NativeHarnessLeadFallbackOutcome>;
}

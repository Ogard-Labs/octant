import type {
  NativeHarnessTranscriptToolCall,
  ProviderFailure,
  ProviderInstanceId,
  ProviderModelId,
  ProviderRuntimeEvent,
  ProviderToolDefinition,
  ProviderToolImage,
  ProviderTurnInput,
} from "@octant/contracts";
import type { ObservedRateLimitBucket } from "../providers/rateLimitHeaders";

/**
 * One message of the conversation the loop sends. The shape is shared by both
 * wire protocols: an assistant message may carry the calls it made, and a
 * message carrying only results answers the calls before it. Images a tool
 * returned ride along live; the journaled copy only counts them.
 */
export interface NativeHarnessMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolCalls?: ReadonlyArray<NativeHarnessTranscriptToolCall> | undefined;
  readonly toolResults?:
    | ReadonlyArray<{
        readonly toolCallId: string;
        readonly resultJson: string;
        readonly isError: boolean;
        readonly images?: ReadonlyArray<ProviderToolImage> | undefined;
      }>
    | undefined;
}

/**
 * What one request cost, as the endpoint reported it. `inputTokens` is all
 * input, cached or not, so context math does not depend on whether an endpoint
 * caches; the cache figures are how much of it was read from or written to the
 * prompt cache. `reasoningTokens` is the part of `outputTokens` spent thinking.
 * A figure the endpoint did not report is absent, never zero.
 */
export interface NativeHarnessUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningTokens?: number;
}

/** A figure only appears in the total once some request has reported it. */
export function addNativeHarnessUsage(
  total: NativeHarnessUsage,
  step: NativeHarnessUsage,
): NativeHarnessUsage {
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const cacheRead = sum(total.cacheReadInputTokens, step.cacheReadInputTokens);
  const cacheWrite = sum(total.cacheWriteInputTokens, step.cacheWriteInputTokens);
  const reasoning = sum(total.reasoningTokens, step.reasoningTokens);
  return {
    inputTokens: total.inputTokens + step.inputTokens,
    outputTokens: total.outputTokens + step.outputTokens,
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

export type NativeHarnessStreamEvent =
  | { readonly kind: "text-delta"; readonly text: string }
  | { readonly kind: "reasoning-delta"; readonly text: string }
  | ({ readonly kind: "usage" } & NativeHarnessUsage)
  /** The request failed in a way that usually passes and goes out again after `delayMs`. */
  | {
      readonly kind: "retrying";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly reason: Extract<ProviderRuntimeEvent, { kind: "retrying" }>["reason"];
    };

/** Everything one model request is made of. */
export interface NativeHarnessRequest {
  readonly modelId: ProviderModelId;
  /** Stable instructions, sent where the protocol keeps a system prompt so its cache survives. */
  readonly system: string | undefined;
  /** Ends with a user message or with the results of the previous step's calls. */
  readonly history: ReadonlyArray<NativeHarnessMessage>;
  readonly tools: ReadonlyArray<ProviderToolDefinition>;
}

export interface NativeHarnessResponse {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<NativeHarnessTranscriptToolCall>;
  readonly usage?: NativeHarnessUsage;
  readonly rateLimitBuckets?: ReadonlyArray<ObservedRateLimitBucket>;
}

/**
 * A direct endpoint reduced to what the loop needs from it: send one request
 * and stream its output. The endpoint owns its wire protocol, credentials,
 * size limits, and what it learns about the model; it owns no conversation,
 * tools, or recovery — those belong to the loop (decision 0007).
 */
export interface NativeHarnessTransportSession {
  /** Whether a request fits the endpoint's bounds as it would be sent. */
  readonly fits: (request: NativeHarnessRequest) => boolean;
  readonly send: (
    request: NativeHarnessRequest,
    stream: {
      readonly signal: AbortSignal;
      readonly onEvent: (event: NativeHarnessStreamEvent) => void;
    },
  ) => Promise<NativeHarnessResponse>;
  readonly release: () => void;
}

export interface NativeHarnessTransport {
  /** Resolves the endpoint and its credential for one session. */
  readonly open: (modelId: ProviderModelId) => Promise<NativeHarnessTransportSession>;
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

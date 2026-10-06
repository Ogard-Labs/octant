import type {
  NativeHarnessTranscriptToolCall,
  ProviderModelId,
  ProviderToolDefinition,
  ProviderToolImage,
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

export type NativeHarnessStreamEvent =
  | { readonly kind: "text-delta"; readonly text: string }
  | { readonly kind: "reasoning-delta"; readonly text: string }
  | ({ readonly kind: "usage" } & NativeHarnessUsage);

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

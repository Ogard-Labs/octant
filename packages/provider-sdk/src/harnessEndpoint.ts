import type {
  NativeHarnessTranscriptToolCall,
  ProviderAttachmentInput,
  ProviderFailure,
  ProviderModelId,
  ProviderOutputStopReason,
  ProviderRuntimeEvent,
  ProviderSessionId,
  ProviderToolDefinition,
  ProviderToolImage,
  ProviderTurnInput,
  UtcTimestamp,
} from "@octant/contracts";
import type { ProviderDriver } from "./driver";

/**
 * The harness endpoint port: how a direct model endpoint joins Octant's native
 * harness without reaching into the host.
 *
 * A direct endpoint (an HTTP model API with no agent runtime of its own)
 * supplies a transport that sends one model request and streams its output,
 * and a verdict on which turns its models accept. The host owns everything
 * else: the conversation and its journal, tool execution, retries, the
 * registry another instance's lead falls back through, and session counts.
 * These are types only; the host composes them into a `ProviderDriver`.
 */

/**
 * One message of the conversation the host sends. An assistant message may
 * carry the calls it made, and a message carrying only results answers the
 * calls before it. Images a tool returned ride along live; the journaled copy
 * only counts them.
 */
export interface HarnessEndpointMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  /**
   * Files the person sent with this user message. Like tool images they ride
   * along live and are never journaled, and only for the turn they arrived
   * with: a later turn's requests carry the text alone, as they would after a
   * resume. Only an endpoint whose model takes native attachments is admitted
   * a turn that has them.
   */
  readonly attachments?: ReadonlyArray<ProviderAttachmentInput> | undefined;
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
export interface HarnessEndpointUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningTokens?: number;
  /** What the endpoint charged, in US dollars; absent when any request in the sum did not say. */
  readonly costUsd?: number;
}

/** A rate-limit window an accepted response reported about the endpoint. */
export interface HarnessEndpointRateLimitBucket {
  readonly bucket: "requests" | "tokens";
  readonly limit: number;
  readonly remaining: number;
  readonly resetsAt?: UtcTimestamp;
}

export type HarnessEndpointStreamEvent =
  | { readonly kind: "text-delta"; readonly text: string }
  | { readonly kind: "reasoning-delta"; readonly text: string }
  | ({ readonly kind: "usage" } & HarnessEndpointUsage)
  /**
   * The request failed in a way that usually passes and goes out again after
   * `delayMs`. The host announces its own retries with this; an endpoint
   * behind the port sends one attempt and does not emit it.
   */
  | {
      readonly kind: "retrying";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly reason: Extract<ProviderRuntimeEvent, { kind: "retrying" }>["reason"];
    };

/** Everything one model request is made of. */
export interface HarnessEndpointRequest {
  /**
   * The harness session's stable identity. A provider that caches by request
   * routes on it, so every step of one conversation reaches the same cache
   * while a different session never shares one.
   */
  readonly sessionId: ProviderSessionId;
  readonly modelId: ProviderModelId;
  /** Stable instructions, sent where the protocol keeps a system prompt so its cache survives. */
  readonly system: string | undefined;
  /** Ends with a user message or with the results of the previous step's calls. */
  readonly history: ReadonlyArray<HarnessEndpointMessage>;
  readonly tools: ReadonlyArray<ProviderToolDefinition>;
}

export interface HarnessEndpointResponse {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<NativeHarnessTranscriptToolCall>;
  readonly usage?: HarnessEndpointUsage;
  readonly rateLimitBuckets?: ReadonlyArray<HarnessEndpointRateLimitBucket>;
  /**
   * Why this reply stopped, when the endpoint said. Absent for a normal
   * finish and for a step that continued into tool calls.
   */
  readonly outputStopReason?: ProviderOutputStopReason;
}

/**
 * A direct endpoint reduced to what the loop needs from it for one session:
 * send one request and stream its output. The endpoint owns its wire protocol,
 * credentials, size limits, and what it learns about the model; it owns no
 * conversation, tools, or recovery.
 *
 * `send` rejects with a `ProviderFailure`. Behind the port it is one attempt:
 * the host sends it again after a failure that usually passes (a rate limit,
 * unavailability, a stream cut short, an empty completion) and after an abort
 * the endpoint must reject with category `interrupted`.
 */
export interface HarnessEndpointSession {
  /** Whether a request fits the endpoint's bounds as it would be sent. */
  readonly fits: (request: HarnessEndpointRequest) => boolean;
  readonly send: (
    request: HarnessEndpointRequest,
    stream: {
      readonly signal: AbortSignal;
      readonly onEvent: (event: HarnessEndpointStreamEvent) => void;
    },
  ) => Promise<HarnessEndpointResponse>;
  readonly release: () => void;
}

export interface HarnessEndpointTransport {
  /** Resolves the endpoint and its credential for one session. */
  readonly open: (modelId: ProviderModelId) => Promise<HarnessEndpointSession>;
}

/** A direct endpoint as the host's harness reaches it. */
export interface ProviderHarnessEndpoint extends HarnessEndpointTransport {
  /**
   * The endpoint's verdict on a turn's input for one of its models: a failure
   * refuses the turn before any request is sent or anything is recorded.
   */
  readonly admitTurn: (
    input: ProviderTurnInput,
    modelId: ProviderModelId,
  ) => ProviderFailure | undefined;
}

/**
 * A driver whose sessions the host runs through its native harness. It keeps
 * its own probe, verification, and authentication and supplies the endpoint;
 * it has no `acquire` of its own because the host builds every connection, and
 * its conversations are always host-owned.
 */
export interface HarnessEndpointDriver extends Omit<
  ProviderDriver,
  "acquire" | "conversationOwnership"
> {
  readonly harnessEndpoint: ProviderHarnessEndpoint;
}

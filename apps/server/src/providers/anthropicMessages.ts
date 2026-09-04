import { decodeProviderFailure, type ProviderFailure } from "@octant/contracts";
import { Effect } from "effect";
import {
  type AnthropicCompatibleEndpoint,
  requestAnthropicGeneration,
} from "./anthropicCompatibleEndpoint";
import { decodeSse } from "./openAiCompatibleSse";
import { readAnthropicRateLimitBuckets, type ObservedRateLimitBucket } from "./rateLimitHeaders";

export interface AnthropicHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export type AnthropicTurnEvent =
  | { readonly kind: "text-delta"; readonly sequence: number; readonly text: string }
  | { readonly kind: "reasoning-delta"; readonly sequence: number; readonly text: string }
  | {
      readonly kind: "usage";
      readonly sequence: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
    };

export interface AnthropicUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AnthropicTurnResult {
  readonly protocol: "messages";
  readonly accepted: boolean;
  readonly outputStarted: boolean;
  readonly terminal: "completed";
  readonly streaming: "supported";
  readonly text: string;
  readonly reasoning: string;
  readonly usage?: AnthropicUsage;
  readonly events: readonly AnthropicTurnEvent[];
  readonly verifiedManualModelId?: string;
  /** Quota buckets from the response headers. Absent when the endpoint sent none. */
  readonly rateLimitBuckets?: ReadonlyArray<ObservedRateLimitBucket>;
}

export interface AnthropicMessagesTurnInput {
  readonly endpoint: AnthropicCompatibleEndpoint;
  readonly modelId: string;
  readonly history: readonly AnthropicHistoryMessage[];
  readonly prompt: string;
  readonly sequenceStart?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AnthropicTurnEvent) => void;
  readonly maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 8192;

interface StreamState {
  accepted: boolean;
  outputStarted: boolean;
  terminal: boolean;
  messageId: string | undefined;
  nextSequence: number;
  text: string;
  reasoning: string;
  usage?: AnthropicUsage;
  readonly events: AnthropicTurnEvent[];
  readonly contentBlocks: Map<number, TrackedContentBlock>;
}

interface TrackedContentBlock {
  readonly index: number;
  readonly type: "text" | "thinking" | "tool_use" | "unknown";
  status: "in_progress" | "completed";
}

export function sendAnthropicMessagesTurn(
  input: AnthropicMessagesTurnInput,
): Effect.Effect<AnthropicTurnResult, ProviderFailure> {
  return Effect.tryPromise({ try: () => runMessagesTurn(input), catch: sanitizeFailure });
}

async function runMessagesTurn(input: AnthropicMessagesTurnInput): Promise<AnthropicTurnResult> {
  const response = await requestAnthropicGeneration(input.endpoint, {
    path: "messages",
    body: {
      model: input.modelId,
      messages: [
        ...input.history.map(({ role, text }) => ({ role, content: text })),
        { role: "user" as const, content: input.prompt },
      ],
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.body === null) {
    throw protocol("The provider returned an empty response stream.");
  }

  const state: StreamState = {
    accepted: false,
    outputStarted: false,
    terminal: false,
    messageId: undefined,
    nextSequence: input.sequenceStart ?? 1,
    text: "",
    reasoning: "",
    events: [],
    contentBlocks: new Map(),
  };
  assertSequenceStart(state.nextSequence);

  for await (const frame of decodeSse(response.body, {
    maxFrameBytes: input.endpoint.limits.responseBodyBytes,
    maxBufferedBytes: input.endpoint.limits.responseBodyBytes,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })) {
    if (state.terminal) {
      throw protocol("The provider stream continued after its terminal event.");
    }
    normalizeEvent(parseJson(frame.data), state, input.onEvent);
  }
  if (!state.terminal) {
    throw protocol("The provider stream ended without a terminal event.");
  }
  for (const block of state.contentBlocks.values()) {
    if (block.status !== "completed") {
      throw protocol("The provider stream ended with unresolved content blocks.");
    }
  }
  return result(input, state, response.headers);
}

function normalizeEvent(
  event: Record<string, unknown> & { readonly type: string },
  state: StreamState,
  onEvent: AnthropicMessagesTurnInput["onEvent"],
): void {
  switch (event.type) {
    case "message_start":
      state.accepted = true;
      validateMessageStart(event, state);
      return;
    case "content_block_start":
      state.accepted = true;
      validateContentBlockStart(event, state);
      return;
    case "content_block_delta":
      state.accepted = true;
      normalizeContentBlockDelta(event, state, onEvent);
      return;
    case "content_block_stop":
      state.accepted = true;
      validateContentBlockStop(event, state);
      return;
    case "message_delta":
      state.accepted = true;
      normalizeMessageDelta(event, state, onEvent);
      return;
    case "message_stop":
      state.accepted = true;
      state.terminal = true;
      return;
    case "ping":
      state.accepted = true;
      return;
    case "error": {
      state.accepted = true;
      const error = event.error;
      if (isRecord(error) && typeof error.type === "string") {
        const mapped = classifyAnthropicStreamError(error.type);
        if (mapped !== undefined) throw mapped;
      }
      throw failure("provider-failed", "The provider failed to complete the response.");
    }
    default:
      throw protocol("The provider stream contained an unsupported event.");
  }
}

function validateMessageStart(event: Record<string, unknown>, state: StreamState): void {
  const message = event.message;
  if (!isRecord(message) || typeof message.id !== "string" || message.id.length === 0) {
    throw protocol("The provider stream contained an invalid message start.");
  }
  if (state.messageId !== undefined && state.messageId !== message.id) {
    throw protocol("The provider stream changed message identity.");
  }
  state.messageId = message.id;
  const usage = message.usage;
  if (
    !isRecord(usage) ||
    !isNonNegativeInt(usage.input_tokens) ||
    !isNonNegativeInt(usage.output_tokens)
  ) {
    throw protocol("The provider stream contained invalid initial usage data.");
  }
  if (state.usage === undefined) {
    state.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  }
}

function validateContentBlockStart(event: Record<string, unknown>, state: StreamState): void {
  if (!isNonNegativeInt(event.index)) {
    throw protocol("The provider stream contained an invalid content block index.");
  }
  const index = event.index as number;
  if (state.contentBlocks.has(index)) {
    throw protocol("The provider stream duplicated a content block index.");
  }
  const block = event.content_block;
  if (!isRecord(block) || typeof block.type !== "string") {
    throw protocol("The provider stream contained an invalid content block.");
  }
  const type = block.type;
  if (
    type !== "text" &&
    type !== "thinking" &&
    type !== "tool_use" &&
    type !== "redacted_thinking" &&
    type !== "fallback"
  ) {
    throw protocol("The provider stream contained an unsupported content block type.");
  }
  if (type === "tool_use") {
    throw failure("unsupported", "The provider attempted an unsupported tool call.");
  }
  const trackedType: TrackedContentBlock["type"] =
    type === "text" ? "text" : type === "thinking" ? "thinking" : "unknown";
  state.contentBlocks.set(index, { index, type: trackedType, status: "in_progress" });
}

function normalizeContentBlockDelta(
  event: Record<string, unknown>,
  state: StreamState,
  onEvent: AnthropicMessagesTurnInput["onEvent"],
): void {
  if (!isNonNegativeInt(event.index)) {
    throw protocol("The provider stream contained an invalid content block index.");
  }
  const index = event.index as number;
  const tracked = state.contentBlocks.get(index);
  if (tracked === undefined || tracked.status !== "in_progress") {
    throw protocol("The provider stream referenced an unknown content block.");
  }
  const delta = event.delta;
  if (!isRecord(delta) || typeof delta.type !== "string") {
    throw protocol("The provider stream contained an invalid content block delta.");
  }
  if (delta.type === "text_delta") {
    if (typeof delta.text !== "string") {
      throw protocol("The provider stream contained an invalid text delta.");
    }
    if (delta.text.length === 0) return;
    state.outputStarted = true;
    state.text += delta.text;
    emit(
      { kind: "text-delta", sequence: allocateSequence(state), text: delta.text },
      state,
      onEvent,
    );
    return;
  }
  if (delta.type === "thinking_delta" || delta.type === "signature_delta") {
    if (delta.type === "signature_delta") {
      if (typeof delta.signature !== "string") {
        throw protocol("The provider stream contained an invalid reasoning signature delta.");
      }
      return;
    }
    if (typeof delta.thinking !== "string") {
      throw protocol("The provider stream contained an invalid reasoning delta.");
    }
    if (delta.thinking.length === 0) return;
    state.outputStarted = true;
    state.reasoning += delta.thinking;
    emit(
      { kind: "reasoning-delta", sequence: allocateSequence(state), text: delta.thinking },
      state,
      onEvent,
    );
    return;
  }
  if (delta.type === "input_json_delta") {
    throw failure("unsupported", "The provider attempted an unsupported tool call.");
  }
  throw protocol("The provider stream contained an unsupported content block delta.");
}

function validateContentBlockStop(event: Record<string, unknown>, state: StreamState): void {
  if (!isNonNegativeInt(event.index)) {
    throw protocol("The provider stream contained an invalid content block index.");
  }
  const index = event.index as number;
  const tracked = state.contentBlocks.get(index);
  if (tracked === undefined || tracked.status !== "in_progress") {
    throw protocol("The provider stream referenced an unknown content block.");
  }
  tracked.status = "completed";
}

function normalizeMessageDelta(
  event: Record<string, unknown>,
  state: StreamState,
  onEvent: AnthropicMessagesTurnInput["onEvent"],
): void {
  const delta = event.delta;
  if (!isRecord(delta)) {
    throw protocol("The provider stream contained an invalid message delta.");
  }
  if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
    if (delta.stop_reason === "tool_use") {
      throw failure("unsupported", "The provider attempted an unsupported tool call.");
    }
    if (
      delta.stop_reason !== "end_turn" &&
      delta.stop_reason !== "stop_sequence" &&
      delta.stop_reason !== "max_tokens" &&
      delta.stop_reason !== "refusal" &&
      delta.stop_reason !== "model_context_window_exceeded" &&
      delta.stop_reason !== "pause_turn"
    ) {
      throw protocol("The provider stream contained an unsupported stop reason.");
    }
  }
  const usage = event.usage;
  if (usage !== undefined && usage !== null) {
    if (
      !isRecord(usage) ||
      !isNonNegativeInt(usage.output_tokens) ||
      (usage.input_tokens !== undefined &&
        usage.input_tokens !== null &&
        !isNonNegativeInt(usage.input_tokens))
    ) {
      throw protocol("The provider stream contained invalid usage data.");
    }
    const inputTokens =
      usage.input_tokens !== undefined && usage.input_tokens !== null
        ? (usage.input_tokens as number)
        : (state.usage?.inputTokens ?? 0);
    state.usage = { inputTokens, outputTokens: usage.output_tokens };
    emit({ kind: "usage", sequence: allocateSequence(state), ...state.usage }, state, onEvent);
  }
}

function result(
  input: AnthropicMessagesTurnInput,
  state: StreamState,
  headers: Headers,
): AnthropicTurnResult {
  const rateLimitBuckets = readAnthropicRateLimitBuckets(headers);
  return {
    protocol: "messages",
    accepted: state.accepted,
    outputStarted: state.outputStarted,
    terminal: "completed",
    streaming: "supported",
    text: state.text,
    reasoning: state.reasoning,
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    events: state.events,
    ...(input.endpoint.configuration.manualModelIds.includes(input.modelId as never)
      ? { verifiedManualModelId: input.modelId }
      : {}),
    ...(rateLimitBuckets.length === 0 ? {} : { rateLimitBuckets }),
  };
}

function emit(
  event: AnthropicTurnEvent,
  state: StreamState,
  onEvent: AnthropicMessagesTurnInput["onEvent"],
): void {
  state.events.push(event);
  onEvent?.(event);
}

function allocateSequence(state: StreamState): number {
  if (!Number.isSafeInteger(state.nextSequence) || state.nextSequence < 0) {
    throw protocol("The Octant event sequence overflowed.");
  }
  const sequence = state.nextSequence;
  state.nextSequence += 1;
  return sequence;
}

function assertSequenceStart(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure("invalid-configuration", "The Octant event sequence start was invalid.");
  }
}

function parseJson(data: string): Record<string, unknown> & { readonly type: string } {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw protocol("The provider stream contained invalid JSON.");
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw protocol("The provider stream contained an invalid event.");
  }
  return value as Record<string, unknown> & { readonly type: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sanitizeFailure(error: unknown): ProviderFailure {
  try {
    const decoded = decodeProviderFailure(error);
    return {
      category: decoded.category,
      message: decoded.message,
      ...(decoded.retryAfterMs === undefined ? {} : { retryAfterMs: decoded.retryAfterMs }),
    };
  } catch {
    return failure("provider-failed", "The provider response could not be normalized.");
  }
}

function protocol(message: string): ProviderFailure {
  return failure("protocol", message);
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function classifyAnthropicStreamError(type: string): ProviderFailure | undefined {
  switch (type) {
    case "overloaded_error":
      return failure("unavailable", "The provider is overloaded.");
    case "rate_limit_error":
      return failure("rate-limited", "The provider rate limit was reached.");
    case "api_error":
      return failure("provider-failed", "The provider reported an internal error.");
    default:
      return undefined;
  }
}

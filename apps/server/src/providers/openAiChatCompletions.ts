import {
  decodeProviderFailure,
  type ProviderFailure,
  type ProviderToolAnswer,
  type ProviderToolDefinition,
} from "@octant/contracts";
import { Effect } from "effect";
import { type OpenAiCompatibleEndpoint, requestGeneration } from "./openAiCompatibleEndpoint";
import { decodeSse } from "./openAiCompatibleSse";
import {
  encodeChatCompletionsTools,
  encodeChatCompletionsToolResults,
  normalizeToolName,
} from "./openAiToolEncoding";
import type {
  ProtocolHistoryMessage,
  ProtocolToolCall,
  ProtocolTurnEvent,
  ProtocolUsage,
} from "./openAiResponses";
import { readOpenAiRateLimitBuckets, type ObservedRateLimitBucket } from "./rateLimitHeaders";

export interface ChatCompletionsTurnInput {
  readonly endpoint: OpenAiCompatibleEndpoint;
  readonly modelId: string;
  readonly history: readonly ProtocolHistoryMessage[];
  readonly prompt: string;
  readonly tools?: readonly ProviderToolDefinition[];
  readonly toolAnswers?: readonly ProviderToolAnswer[];
  readonly toolChoice?: "auto" | "required";
  readonly sequenceStart?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ProtocolTurnEvent) => void;
}

export interface ChatCompletionsTurnResult {
  readonly protocol: "chat-completions";
  readonly accepted: boolean;
  readonly outputStarted: boolean;
  readonly terminal: "completed" | "tool-calls";
  readonly streaming: "supported" | "unsupported";
  readonly text: string;
  readonly reasoning: "";
  readonly usage?: ProtocolUsage;
  readonly events: readonly ProtocolTurnEvent[];
  readonly toolCalls: readonly ProtocolToolCall[];
  readonly verifiedManualModelId?: string;
  /** Quota buckets from the response headers. Absent when the endpoint sent none. */
  readonly rateLimitBuckets?: ReadonlyArray<ObservedRateLimitBucket>;
}

interface TrackedChatToolCall {
  readonly index: number;
  id: string | null;
  name: string | null;
  arguments: string;
}

interface StreamState {
  accepted: boolean;
  outputStarted: boolean;
  terminal: boolean;
  done: boolean;
  text: string;
  usage?: ProtocolUsage;
  responseId?: string;
  nextSequence: number;
  readonly events: ProtocolTurnEvent[];
  readonly toolCalls: TrackedChatToolCall[];
  completedToolCalls: ProtocolToolCall[];
}

const CHUNK_KEYS = [
  "id",
  "object",
  "created",
  "model",
  "system_fingerprint",
  "service_tier",
  "choices",
  "usage",
];
const CHOICE_KEYS = ["index", "delta", "finish_reason", "logprobs"];
const DELTA_KEYS = ["role", "content", "refusal", "tool_calls", "function_call"];
const RESPONSE_KEYS = [
  "id",
  "object",
  "created",
  "model",
  "system_fingerprint",
  "service_tier",
  "choices",
  "usage",
];
const MESSAGE_KEYS = ["role", "content", "refusal", "tool_calls", "function_call"];

export function sendChatCompletionsTurn(
  input: ChatCompletionsTurnInput,
): Effect.Effect<ChatCompletionsTurnResult, ProviderFailure> {
  return Effect.tryPromise({ try: () => runChatTurn(input), catch: sanitizeFailure });
}

async function runChatTurn(input: ChatCompletionsTurnInput): Promise<ChatCompletionsTurnResult> {
  let streamUnsupported = false;
  try {
    const response = await requestGeneration(input.endpoint, {
      path: "chat/completions",
      body: requestBody(input, true),
      classifyRejectedResponse: async (response) => {
        if (await isStrictStreamUnsupported(response)) {
          streamUnsupported = true;
          return failure("unsupported", "The provider does not support streaming responses.");
        }
        return undefined;
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return await normalizeStream(response, input);
  } catch (error) {
    if (!streamUnsupported) throw error;
  }

  const response = await requestGeneration(input.endpoint, {
    path: "chat/completions",
    body: requestBody(input, false),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return normalizeNonStreaming(response, input);
}

function requestBody(input: ChatCompletionsTurnInput, streaming: boolean): Record<string, unknown> {
  const tools = input.tools === undefined ? undefined : encodeChatCompletionsTools(input.tools);
  const toolAnswers =
    input.toolAnswers === undefined
      ? undefined
      : encodeChatCompletionsToolResults(input.toolAnswers);
  // When continuing a tool loop (toolAnswers present), the assistant
  // tool_calls message is already in history; tool result messages must
  // immediately follow it with no intervening user message. Omit the
  // user prompt when it is empty so the pairing stays valid.
  const includeUserPrompt = !(input.prompt.length === 0 && toolAnswers !== undefined);
  return {
    model: input.modelId,
    messages: [
      ...input.history.flatMap((entry): Record<string, unknown>[] => {
        if (entry.toolResults !== undefined) {
          return entry.toolResults.map((result) => ({
            role: "tool",
            tool_call_id: result.toolCallId,
            content: result.resultJson,
          }));
        }
        return [
          entry.toolCalls === undefined
            ? { role: entry.role, content: entry.text }
            : {
                role: entry.role,
                content: entry.text.length === 0 ? null : entry.text,
                tool_calls: entry.toolCalls.map((call) => ({
                  id: call.toolCallId,
                  type: "function",
                  function: { name: call.toolName, arguments: call.argumentsJson },
                })),
              },
        ];
      }),
      ...(includeUserPrompt ? [{ role: "user", content: input.prompt }] : []),
      ...(toolAnswers === undefined ? [] : toolAnswers),
    ],
    stream: streaming,
    ...(streaming ? { stream_options: { include_usage: true } } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(input.toolChoice === undefined ? {} : { tool_choice: input.toolChoice }),
  };
}

async function normalizeStream(
  response: Response,
  input: ChatCompletionsTurnInput,
): Promise<ChatCompletionsTurnResult> {
  if (response.body === null) throw protocol("The provider returned an empty response stream.");
  const state: StreamState = {
    accepted: false,
    outputStarted: false,
    terminal: false,
    done: false,
    text: "",
    nextSequence: input.sequenceStart ?? 1,
    events: [],
    toolCalls: [],
    completedToolCalls: [],
  };
  assertSequenceStart(state.nextSequence);

  for await (const frame of decodeSse(response.body, {
    maxFrameBytes: input.endpoint.limits.responseBodyBytes,
    maxBufferedBytes: input.endpoint.limits.responseBodyBytes,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })) {
    if (state.done) throw protocol("The provider stream continued after its terminal marker.");
    if (frame.event !== undefined && frame.event !== "message") {
      throw protocol("The provider stream contained an unsupported event type.");
    }
    if (frame.data === "[DONE]") {
      if (!state.terminal) throw protocol("The provider stream ended without a finish reason.");
      state.done = true;
      continue;
    }
    normalizeChunk(parseJson(frame.data), state, input.onEvent);
  }
  if (!state.done || !state.terminal) {
    throw protocol("The provider stream ended without a terminal completion.");
  }
  return result(input, state, "supported", response.headers);
}

function normalizeChunk(
  value: unknown,
  state: StreamState,
  onEvent: ChatCompletionsTurnInput["onEvent"],
): void {
  if (!hasAllowedKeys(value, CHUNK_KEYS) || value.object !== "chat.completion.chunk") {
    throw protocol("The provider stream contained an invalid Chat Completions event.");
  }
  if (!isNonEmptyString(value.id) || !Array.isArray(value.choices)) {
    throw protocol("The provider stream contained an invalid Chat Completions event.");
  }
  if (state.responseId === undefined) state.responseId = value.id;
  else if (state.responseId !== value.id) {
    throw protocol("The provider stream changed completion identity.");
  }
  state.accepted = true;
  if (value.choices.length === 0) {
    if (!state.terminal || value.usage === undefined || value.usage === null) {
      throw protocol("The provider stream contained invalid usage data.");
    }
    if (state.usage !== undefined) throw protocol("The provider stream duplicated usage data.");
    state.usage = readUsage(value.usage);
    emit({ kind: "usage", sequence: allocateSequence(state), ...state.usage }, state, onEvent);
    return;
  }
  if (
    value.choices.length !== 1 ||
    state.terminal ||
    (value.usage !== undefined && value.usage !== null)
  ) {
    throw protocol("The provider stream contained an invalid choice.");
  }
  const choice = value.choices[0];
  if (
    !hasAllowedKeys(choice, CHOICE_KEYS) ||
    choice.index !== 0 ||
    !hasAllowedKeys(choice.delta, DELTA_KEYS) ||
    !(choice.finish_reason === null || typeof choice.finish_reason === "string")
  ) {
    throw protocol("The provider stream contained an invalid choice.");
  }
  if (choice.logprobs !== undefined && choice.logprobs !== null) {
    throw protocol("The provider stream contained unsupported log probability data.");
  }
  normalizeDelta(choice.delta, state, onEvent);
  if (choice.finish_reason !== null) normalizeFinish(choice.finish_reason, state, onEvent);
}

function normalizeDelta(
  delta: Record<string, unknown>,
  state: StreamState,
  onEvent: ChatCompletionsTurnInput["onEvent"],
): void {
  if (delta.role !== undefined && delta.role !== "assistant") {
    throw protocol("The provider stream contained an invalid assistant role.");
  }
  if (delta.function_call !== undefined) {
    state.outputStarted = true;
    throw failure("unsupported", "The provider attempted an unsupported tool call.");
  }
  if (delta.tool_calls !== undefined) {
    state.outputStarted = true;
    normalizeToolCallDeltas(delta.tool_calls, state);
    return;
  }
  if (delta.refusal !== undefined && delta.refusal !== null) {
    if (typeof delta.refusal !== "string")
      throw protocol("The provider stream contained an invalid refusal.");
    state.outputStarted = true;
    throw failure("provider-failed", "The provider refused the request.");
  }
  if (delta.content === undefined || delta.content === null) return;
  if (typeof delta.content !== "string")
    throw protocol("The provider stream contained an invalid text delta.");
  if (delta.content.length === 0) return;
  state.outputStarted = true;
  state.text += delta.content;
  emit(
    { kind: "text-delta", sequence: allocateSequence(state), text: delta.content },
    state,
    onEvent,
  );
}

function normalizeToolCallDeltas(value: unknown, state: StreamState): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw protocol("The provider stream contained an invalid tool call delta.");
  }
  for (const entry of value) {
    if (!isRecord(entry) || !isIndex(entry.index)) {
      throw protocol("The provider stream contained an invalid tool call delta.");
    }
    if (entry.type !== undefined && entry.type !== "function") {
      throw protocol("The provider stream contained an unsupported tool call type.");
    }
    if (!isRecord(entry.function)) {
      throw protocol("The provider stream contained an invalid tool call delta.");
    }
    const fn = entry.function;
    let tracked = state.toolCalls.find((call) => call.index === entry.index);
    if (tracked === undefined) {
      tracked = { index: entry.index, id: null, name: null, arguments: "" };
      state.toolCalls.push(tracked);
    }
    if (entry.id !== undefined && entry.id !== null) {
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        throw protocol("The provider stream contained an invalid tool call id.");
      }
      if (tracked.id !== null && tracked.id !== entry.id) {
        throw protocol("The provider stream changed a tool call id.");
      }
      tracked.id = entry.id;
    }
    if (fn.name !== undefined && fn.name !== null) {
      if (typeof fn.name !== "string" || fn.name.length === 0) {
        throw protocol("The provider stream contained an invalid tool call name.");
      }
      const normalized = tryNormalizeToolName(fn.name);
      if (normalized === undefined) {
        throw protocol("The provider stream contained an invalid tool call name.");
      }
      if (tracked.name !== null && tracked.name !== normalized) {
        throw protocol("The provider stream changed a tool call name.");
      }
      tracked.name = normalized;
    }
    if (fn.arguments !== undefined && fn.arguments !== null) {
      if (typeof fn.arguments !== "string") {
        throw protocol("The provider stream contained an invalid tool call arguments delta.");
      }
      if (tracked.arguments.length + fn.arguments.length > MAX_TOOL_CALL_ARGUMENT_BYTES) {
        throw protocol("The provider function call arguments exceeded the size limit.");
      }
      tracked.arguments += fn.arguments;
    }
  }
}

function tryNormalizeToolName(name: string): string | undefined {
  try {
    return normalizeToolName(name);
  } catch {
    return undefined;
  }
}

function normalizeFinish(
  reason: string,
  state: StreamState,
  onEvent: ChatCompletionsTurnInput["onEvent"],
): void {
  if (reason === "stop") {
    state.terminal = true;
    return;
  }
  if (reason === "tool_calls") {
    state.outputStarted = true;
    finalizeToolCalls(state, onEvent);
    state.terminal = true;
    return;
  }
  state.outputStarted ||= reason === "function_call";
  if (reason === "function_call") {
    throw failure("unsupported", "The provider attempted an unsupported tool call.");
  }
  if (reason === "length") {
    throw failure("provider-failed", "The provider returned an incomplete response.");
  }
  if (reason === "content_filter") {
    throw failure("provider-failed", "The provider refused the request.");
  }
  throw protocol("The provider stream contained an unsupported finish reason.");
}

function finalizeToolCalls(state: StreamState, onEvent: ChatCompletionsTurnInput["onEvent"]): void {
  if (state.toolCalls.length === 0) {
    throw protocol("The provider stream ended with a tool_calls finish reason but no tool calls.");
  }
  const ordered = [...state.toolCalls].sort((left, right) => left.index - right.index);
  for (const tracked of ordered) {
    if (tracked.id === null) {
      throw protocol("The provider stream ended with an unresolved tool call id.");
    }
    if (tracked.name === null) {
      throw protocol("The provider stream ended with an unresolved tool call name.");
    }
    assertBoundedToolCallArguments(tracked.arguments);
    const toolCall: ProtocolToolCall = {
      toolCallId: tracked.id,
      toolName: tracked.name,
      argumentsJson: tracked.arguments,
    };
    state.completedToolCalls.push(toolCall);
    emit({ kind: "tool-call", sequence: allocateSequence(state), ...toolCall }, state, onEvent);
  }
}

async function normalizeNonStreaming(
  response: Response,
  input: ChatCompletionsTurnInput,
): Promise<ChatCompletionsTurnResult> {
  let value: unknown;
  try {
    value = JSON.parse(await response.text()) as unknown;
  } catch (error) {
    if (isProviderFailure(error)) throw error;
    throw protocol("The provider returned an invalid Chat Completions response.");
  }
  if (
    !hasAllowedKeys(value, RESPONSE_KEYS) ||
    value.object !== "chat.completion" ||
    !isNonEmptyString(value.id) ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  ) {
    throw protocol("The provider returned an invalid Chat Completions response.");
  }
  const choice = value.choices[0];
  if (
    !hasAllowedKeys(choice, ["index", "message", "finish_reason", "logprobs"]) ||
    choice.index !== 0 ||
    !hasAllowedKeys(choice.message, MESSAGE_KEYS) ||
    choice.message.role !== "assistant" ||
    typeof choice.finish_reason !== "string"
  ) {
    throw protocol("The provider returned an invalid Chat Completions response.");
  }
  if (choice.logprobs !== undefined && choice.logprobs !== null) {
    throw protocol("The provider returned unsupported log probability data.");
  }
  const message = choice.message;
  if (message.function_call !== undefined) {
    throw failure("unsupported", "The provider attempted an unsupported tool call.");
  }
  if (message.refusal !== undefined && message.refusal !== null) {
    if (typeof message.refusal !== "string")
      throw protocol("The provider returned an invalid refusal.");
    throw failure("provider-failed", "The provider refused the request.");
  }
  const toolCalls =
    message.tool_calls === undefined ? [] : parseNonStreamingToolCalls(message.tool_calls);
  const hasToolCalls = toolCalls.length > 0;
  if (hasToolCalls && choice.finish_reason !== "tool_calls") {
    throw protocol("The provider returned tool calls without a tool_calls finish reason.");
  }
  if (!hasToolCalls && choice.finish_reason === "tool_calls") {
    throw protocol("The provider returned a tool_calls finish reason without tool calls.");
  }
  if (!hasToolCalls && choice.finish_reason !== "stop") {
    normalizeFinish(
      choice.finish_reason,
      {
        accepted: true,
        outputStarted: message.content !== null,
        terminal: false,
        done: false,
        text: "",
        nextSequence: 1,
        events: [],
        toolCalls: [],
        completedToolCalls: [],
      },
      input.onEvent,
    );
  }
  if (!hasToolCalls && typeof message.content !== "string") {
    throw protocol("The provider returned an invalid assistant message.");
  }
  const content = hasToolCalls ? "" : (message.content as string);
  const usage =
    value.usage === undefined || value.usage === null ? undefined : readUsage(value.usage);
  const state: StreamState = {
    accepted: true,
    outputStarted: hasToolCalls || content.length > 0,
    terminal: true,
    done: true,
    text: content,
    nextSequence: input.sequenceStart ?? 1,
    events: [],
    toolCalls: [],
    completedToolCalls: [],
    ...(usage === undefined ? {} : { usage }),
  };
  assertSequenceStart(state.nextSequence);
  if (hasToolCalls) {
    for (const toolCall of toolCalls) {
      state.completedToolCalls.push(toolCall);
      state.events.push({ kind: "tool-call", sequence: allocateSequence(state), ...toolCall });
    }
  } else {
    state.events.push({
      kind: "text-delta",
      sequence: allocateSequence(state),
      text: content,
    });
  }
  if (usage !== undefined) {
    state.events.push({ kind: "usage", sequence: allocateSequence(state), ...usage });
  }
  for (const event of state.events) input.onEvent?.(event);
  return result(input, state, "unsupported", response.headers);
}

function parseNonStreamingToolCalls(value: unknown): ProtocolToolCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw protocol("The provider returned an invalid tool call list.");
  }
  const calls: ProtocolToolCall[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.id) ||
      entry.type !== "function" ||
      !isRecord(entry.function)
    ) {
      throw protocol("The provider returned an invalid tool call.");
    }
    const fn = entry.function;
    if (!isNonEmptyString(fn.name) || typeof fn.arguments !== "string") {
      throw protocol("The provider returned an invalid tool call.");
    }
    const toolName = tryNormalizeToolName(fn.name);
    if (toolName === undefined) {
      throw protocol("The provider returned an invalid tool call name.");
    }
    assertBoundedToolCallArguments(fn.arguments);
    calls.push({ toolCallId: entry.id, toolName, argumentsJson: fn.arguments });
  }
  return calls;
}

function result(
  input: ChatCompletionsTurnInput,
  state: StreamState,
  streaming: "supported" | "unsupported",
  headers: Headers,
): ChatCompletionsTurnResult {
  const terminal: ChatCompletionsTurnResult["terminal"] =
    state.completedToolCalls.length > 0 ? "tool-calls" : "completed";
  const rateLimitBuckets = readOpenAiRateLimitBuckets(headers, Date.now());
  return {
    protocol: "chat-completions",
    accepted: state.accepted,
    outputStarted: state.outputStarted,
    terminal,
    streaming,
    text: state.text,
    reasoning: "",
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    events: state.events,
    toolCalls: state.completedToolCalls,
    ...(input.endpoint.configuration.manualModelIds.includes(input.modelId as never)
      ? { verifiedManualModelId: input.modelId }
      : {}),
    ...(rateLimitBuckets.length === 0 ? {} : { rateLimitBuckets }),
  };
}

async function isStrictStreamUnsupported(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 422) return false;
  let value: unknown;
  try {
    value = JSON.parse(await response.text()) as unknown;
  } catch (error) {
    if (isProviderFailure(error)) throw error;
    return false;
  }
  return (
    hasExactKeys(value, ["error"]) &&
    hasExactKeys(value.error, ["message", "type", "param", "code"]) &&
    isNonEmptyString(value.error.message) &&
    value.error.type === "invalid_request_error" &&
    value.error.param === "stream" &&
    value.error.code === "unsupported_parameter"
  );
}

function readUsage(value: unknown): ProtocolUsage {
  if (!hasExactKeys(value, ["prompt_tokens", "completion_tokens", "total_tokens"])) {
    throw protocol("The provider returned invalid usage data.");
  }
  if (
    !isTokenCount(value.prompt_tokens) ||
    !isTokenCount(value.completion_tokens) ||
    !isTokenCount(value.total_tokens) ||
    value.total_tokens !== value.prompt_tokens + value.completion_tokens
  ) {
    throw protocol("The provider returned invalid usage data.");
  }
  return { inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens };
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw protocol("The provider stream contained invalid JSON.");
  }
}

function emit(
  event: ProtocolTurnEvent,
  state: StreamState,
  onEvent: ChatCompletionsTurnInput["onEvent"],
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

const MAX_TOOL_CALL_ARGUMENT_BYTES = 65_536;
const MAX_TOOL_CALL_ARGUMENT_DEPTH = 16;
const MAX_TOOL_CALL_ARGUMENT_ENTRIES = 256;
const MAX_TOOL_CALL_ARGUMENT_KEY_LENGTH = 128;
const MAX_TOOL_CALL_ARGUMENT_STRING_LENGTH = 4_096;

function assertBoundedToolCallArguments(argumentsJson: string): void {
  if (argumentsJson.length === 0) {
    throw protocol("The provider function call arguments were empty.");
  }
  if (argumentsJson.length > MAX_TOOL_CALL_ARGUMENT_BYTES) {
    throw protocol("The provider function call arguments exceeded the size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw protocol("The provider function call arguments were not valid JSON.");
  }
  if (!isBoundedToolCallArguments(parsed)) {
    throw protocol("The provider function call arguments exceeded the bounded JSON limits.");
  }
}

function isBoundedToolCallArguments(
  value: unknown,
  depth = 0,
  active: Set<object> = new Set(),
): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    return Array.from(value).length <= MAX_TOOL_CALL_ARGUMENT_STRING_LENGTH;
  }
  if (
    typeof value !== "object" ||
    depth > MAX_TOOL_CALL_ARGUMENT_DEPTH ||
    active.has(value as object)
  ) {
    return false;
  }
  active.add(value as object);
  try {
    if (Array.isArray(value)) {
      return (
        value.length <= MAX_TOOL_CALL_ARGUMENT_ENTRIES &&
        value.every((entry) => isBoundedToolCallArguments(entry, depth + 1, active))
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > MAX_TOOL_CALL_ARGUMENT_ENTRIES ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          key.trim().length === 0 ||
          Array.from(key).length > MAX_TOOL_CALL_ARGUMENT_KEY_LENGTH,
      )
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      return (
        descriptor !== undefined &&
        "value" in descriptor &&
        isBoundedToolCallArguments(descriptor.value, depth + 1, active)
      );
    });
  } finally {
    active.delete(value as object);
  }
}

function hasAllowedKeys(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

function isProviderFailure(error: unknown): error is ProviderFailure {
  return typeof error === "object" && error !== null && "category" in error && "message" in error;
}

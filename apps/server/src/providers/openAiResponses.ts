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
  encodeResponsesTools,
  encodeResponsesToolResults,
  normalizeToolName,
} from "./openAiToolEncoding";
import { readOpenAiRateLimitBuckets, type ObservedRateLimitBucket } from "./rateLimitHeaders";

export interface ProtocolToolResult {
  readonly toolCallId: string;
  readonly resultJson: string;
  readonly isError: boolean;
}

export interface ProtocolHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolCalls?: readonly ProtocolToolCall[];
  readonly toolResults?: readonly ProtocolToolResult[];
}

export interface ProtocolToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}

export type ProtocolTurnEvent =
  | { readonly kind: "text-delta"; readonly sequence: number; readonly text: string }
  | { readonly kind: "reasoning-delta"; readonly sequence: number; readonly text: string }
  | {
      readonly kind: "usage";
      readonly sequence: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | {
      readonly kind: "tool-call";
      readonly sequence: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly argumentsJson: string;
    };

export interface ProtocolTurnResult {
  readonly protocol: "responses";
  readonly accepted: boolean;
  readonly outputStarted: boolean;
  readonly terminal: "completed" | "tool-calls";
  readonly text: string;
  readonly reasoning: string;
  readonly usage?: ProtocolUsage;
  readonly events: readonly ProtocolTurnEvent[];
  readonly toolCalls: readonly ProtocolToolCall[];
  readonly verifiedManualModelId?: string;
  /** Quota buckets from the response headers. Absent when the endpoint sent none. */
  readonly rateLimitBuckets?: ReadonlyArray<ObservedRateLimitBucket>;
}

export interface ProtocolUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ResponsesTurnInput {
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
  readonly onAttemptFailure?: (metadata: ProtocolTurnFailureMetadata) => void;
}

export interface ProtocolTurnFailureMetadata {
  readonly failure: ProviderFailure;
  readonly accepted: boolean;
  readonly outputStarted: boolean;
  readonly httpStatus?: number;
}

interface MutableAttemptMetadata {
  accepted: boolean;
  outputStarted: boolean;
  httpStatus?: number;
}

interface NormalizationState {
  accepted: boolean;
  outputStarted: boolean;
  lastProviderSequence: number;
  nextSequence: number;
  text: string;
  reasoning: string;
  usage?: ProtocolUsage;
  completed: boolean;
  readonly events: ProtocolTurnEvent[];
  readonly textParts: Map<string, string>;
  readonly reasoningParts: Map<string, string>;
  readonly items: Map<string, TrackedOutputItem>;
  readonly functionCalls: Map<string, TrackedFunctionCall>;
  readonly toolCalls: ProtocolToolCall[];
  responseId?: string;
}

interface TrackedOutputItem {
  readonly id: string;
  readonly type: "message" | "reasoning" | "function-call";
  readonly outputIndex: number;
  status: "in_progress" | "completed";
}

interface TrackedFunctionCall {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly callId: string;
  readonly toolName: string;
  arguments: string;
  status: "in_progress" | "completed";
}

export function sendResponsesTurn(
  input: ResponsesTurnInput,
): Effect.Effect<ProtocolTurnResult, ProviderFailure> {
  return Effect.suspend(() => {
    const attempt: MutableAttemptMetadata = { accepted: false, outputStarted: false };
    return Effect.tryPromise({
      try: () => runResponsesTurn(input, attempt),
      catch: (error) => {
        const failure = sanitizeFailure(error);
        notifyAttemptFailure(input.onAttemptFailure, attempt, failure);
        return failure;
      },
    });
  });
}

async function runResponsesTurn(
  input: ResponsesTurnInput,
  attempt: MutableAttemptMetadata,
): Promise<ProtocolTurnResult> {
  const tools = input.tools === undefined ? undefined : encodeResponsesTools(input.tools);
  const toolAnswers =
    input.toolAnswers === undefined ? undefined : encodeResponsesToolResults(input.toolAnswers);
  // When continuing a tool loop (toolAnswers present), the prior
  // function_call items are already in history; function_call_output items
  // must immediately follow them with no intervening user item. Omit the
  // user prompt when it is empty so the call/output pairing stays valid.
  const includeUserPrompt = !(input.prompt.length === 0 && toolAnswers !== undefined);
  const response = await requestGeneration(input.endpoint, {
    path: "responses",
    body: {
      model: input.modelId,
      input: [
        ...input.history.flatMap((entry) => {
          // Entries that contain only tool results (role: "assistant",
          // empty text) must serialize directly to function_call_output
          // items. Emitting an empty assistant item before the outputs
          // would place a gap between the prior function_call and its
          // matching output, which Responses providers reject.
          if (entry.toolResults !== undefined && entry.toolCalls === undefined) {
            return entry.toolResults.map((result) => ({
              type: "function_call_output" as const,
              call_id: result.toolCallId,
              output: result.resultJson,
            }));
          }
          return [
            { role: entry.role, content: entry.text },
            ...(entry.toolCalls === undefined
              ? []
              : entry.toolCalls.map((call) => ({
                  type: "function_call" as const,
                  call_id: call.toolCallId,
                  name: call.toolName,
                  arguments: call.argumentsJson,
                }))),
            ...(entry.toolResults === undefined
              ? []
              : entry.toolResults.map((result) => ({
                  type: "function_call_output" as const,
                  call_id: result.toolCallId,
                  output: result.resultJson,
                }))),
          ];
        }),
        ...(includeUserPrompt ? [{ role: "user" as const, content: input.prompt }] : []),
        ...(toolAnswers === undefined ? [] : toolAnswers),
      ],
      stream: true,
      store: false,
      ...(tools === undefined ? {} : { tools }),
      ...(input.toolChoice === undefined ? {} : { tool_choice: input.toolChoice }),
    },
    classifyRejectedResponse: classifyStoreRejection,
    onRejected: ({ httpStatus }) => {
      attempt.httpStatus = httpStatus;
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.body === null) {
    throw protocol("The provider returned an empty response stream.");
  }

  const state: NormalizationState = {
    accepted: false,
    outputStarted: false,
    lastProviderSequence: -1,
    nextSequence: input.sequenceStart ?? 1,
    text: "",
    reasoning: "",
    completed: false,
    events: [],
    textParts: new Map(),
    reasoningParts: new Map(),
    items: new Map(),
    functionCalls: new Map(),
    toolCalls: [],
  };
  assertSequenceStart(state.nextSequence);

  try {
    for await (const frame of decodeSse(response.body, {
      maxFrameBytes: input.endpoint.limits.responseBodyBytes,
      maxBufferedBytes: input.endpoint.limits.responseBodyBytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })) {
      if (frame.data === "[DONE]") {
        if (!state.completed) {
          throw protocol("The provider stream ended without a terminal response.");
        }
        continue;
      }
      if (state.completed) {
        throw protocol("The provider stream continued after its terminal response.");
      }
      const event = parseEvent(frame.data);
      validateProviderSequence(event.sequence_number, state);
      normalizeEvent(event, state, input.onEvent);
    }

    if (!state.completed) {
      throw protocol("The provider stream ended without a terminal response.");
    }
  } catch (error) {
    attempt.accepted = state.accepted;
    attempt.outputStarted = state.outputStarted;
    throw error;
  }
  const terminal: ProtocolTurnResult["terminal"] =
    state.toolCalls.length > 0 ? "tool-calls" : "completed";
  const rateLimitBuckets = readOpenAiRateLimitBuckets(response.headers, Date.now());
  return {
    protocol: "responses",
    accepted: state.accepted,
    outputStarted: state.outputStarted,
    terminal,
    text: state.text,
    reasoning: state.reasoning,
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    events: state.events,
    toolCalls: state.toolCalls,
    ...(input.endpoint.configuration.manualModelIds.includes(input.modelId as never)
      ? { verifiedManualModelId: input.modelId }
      : {}),
    ...(rateLimitBuckets.length === 0 ? {} : { rateLimitBuckets }),
  };
}

function normalizeEvent(
  event: Record<string, unknown> & { readonly type: string; readonly sequence_number: number },
  state: NormalizationState,
  onEvent: ResponsesTurnInput["onEvent"],
): void {
  switch (event.type) {
    case "response.created":
    case "response.queued":
    case "response.in_progress":
      state.accepted = true;
      validateResponseLifecycle(event, state);
      return;
    case "response.output_item.added":
    case "response.output_item.done":
      state.accepted = true;
      validateOutputItem(event, state, onEvent);
      return;
    case "response.content_part.added":
    case "response.content_part.done":
      state.accepted = true;
      validateContentPart(event, state);
      return;
    case "response.output_text.delta":
      state.accepted = true;
      appendDelta("text-delta", event, state, onEvent);
      return;
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta":
      state.accepted = true;
      appendDelta("reasoning-delta", event, state, onEvent);
      return;
    case "response.output_text.done":
      state.accepted = true;
      validateDoneText(event, state, state.textParts, "output");
      return;
    case "response.reasoning_text.done":
    case "response.reasoning_summary_text.done":
      state.accepted = true;
      validateDoneText(event, state, state.reasoningParts, "reasoning");
      return;
    case "response.reasoning_summary_part.added":
    case "response.reasoning_summary_part.done":
      state.accepted = true;
      validateReasoningSummaryPart(event, state);
      return;
    case "response.function_call_arguments.delta":
      state.accepted = true;
      state.outputStarted = true;
      appendFunctionCallArgumentsDelta(event, state);
      return;
    case "response.function_call_arguments.done":
      state.accepted = true;
      state.outputStarted = true;
      validateFunctionCallArgumentsDone(event, state);
      return;
    case "response.completed": {
      state.accepted = true;
      validateResponseState(event.response, "completed", state);
      validateTerminalItems(event.response, state);
      const usage = readUsage(event.response);
      if (usage !== undefined) {
        state.usage = usage;
        emit({ kind: "usage", sequence: allocateSequence(state), ...usage }, state, onEvent);
      }
      state.completed = true;
      return;
    }
    case "response.refusal.delta":
    case "response.refusal.done":
      state.accepted = true;
      state.outputStarted = true;
      throw failure("provider-failed", "The provider refused the request.");
    case "response.failed":
      state.accepted = true;
      validateResponseState(event.response, "failed", state);
      throw failure("provider-failed", "The provider failed to complete the response.");
    case "response.incomplete":
      state.accepted = true;
      validateResponseState(event.response, "incomplete", state);
      throw failure("provider-failed", "The provider returned an incomplete response.");
    case "error":
      state.accepted = true;
      throw failure("provider-failed", "The provider failed to complete the response.");
    default:
      if (isToolEvent(event)) {
        state.accepted = true;
        state.outputStarted = true;
        throw failure("unsupported", "The provider attempted an unsupported tool call.");
      }
      throw protocol("The provider stream contained an unsupported event.");
  }
}

function appendDelta(
  kind: "text-delta" | "reasoning-delta",
  source: Record<string, unknown> & { readonly type: string },
  state: NormalizationState,
  onEvent: ResponsesTurnInput["onEvent"],
): void {
  const value = source.delta;
  if (typeof value !== "string") {
    throw protocol("The provider stream contained an invalid output delta.");
  }
  if (kind === "text-delta" && !Array.isArray(source.logprobs)) {
    throw protocol("The provider stream contained an invalid output delta.");
  }
  const key = contentKey(source);
  trackStreamingItem(state, source, kind === "text-delta" ? "message" : "reasoning");
  if (value.length === 0) return;
  const parts = kind === "text-delta" ? state.textParts : state.reasoningParts;
  parts.set(key, (parts.get(key) ?? "") + value);
  state.outputStarted = true;
  if (kind === "text-delta") state.text += value;
  else state.reasoning += value;
  emit({ kind, sequence: allocateSequence(state), text: value }, state, onEvent);
}

function emit(
  event: ProtocolTurnEvent,
  state: NormalizationState,
  onEvent: ResponsesTurnInput["onEvent"],
): void {
  state.events.push(event);
  onEvent?.(event);
}

function parseEvent(
  data: string,
): Record<string, unknown> & { readonly type: string; readonly sequence_number: number } {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw protocol("The provider stream contained invalid JSON.");
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw protocol("The provider stream contained an invalid event.");
  }
  return value as Record<string, unknown> & {
    readonly type: string;
    readonly sequence_number: number;
  };
}

function validateProviderSequence(sequence: unknown, state: NormalizationState): void {
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
    throw protocol("The provider stream sequence was invalid.");
  }
  if ((sequence as number) <= state.lastProviderSequence) {
    throw protocol("The provider stream sequence was invalid.");
  }
  state.lastProviderSequence = sequence as number;
}

function validateResponseLifecycle(
  event: Record<string, unknown> & { readonly type: string },
  state: NormalizationState,
): void {
  const expectedStatus = event.type === "response.queued" ? "queued" : "in_progress";
  validateResponseState(event.response, expectedStatus, state);
}

function validateResponseState(
  value: unknown,
  expectedStatus: "queued" | "in_progress" | "completed" | "failed" | "incomplete",
  state: NormalizationState,
): void {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    value.object !== "response" ||
    value.status !== expectedStatus ||
    !("usage" in value) ||
    (value.usage !== null && expectedStatus !== "completed")
  ) {
    throw invalidLifecycle();
  }
  if (state.responseId !== undefined && state.responseId !== value.id) {
    throw invalidLifecycle();
  }
  if (
    expectedStatus === "failed" &&
    (!isRecord(value.error) ||
      !isNonEmptyString(value.error.code) ||
      !isNonEmptyString(value.error.message))
  ) {
    throw invalidLifecycle();
  }
  if (
    expectedStatus === "incomplete" &&
    (!isRecord(value.incomplete_details) || !isNonEmptyString(value.incomplete_details.reason))
  ) {
    throw invalidLifecycle();
  }
  if (
    expectedStatus === "completed" &&
    (("error" in value && value.error !== null) ||
      ("incomplete_details" in value && value.incomplete_details !== null))
  ) {
    throw invalidLifecycle();
  }
  state.responseId = value.id;
}

function validateOutputItem(
  event: Record<string, unknown> & { readonly type: string },
  state: NormalizationState,
  onEvent: ResponsesTurnInput["onEvent"],
): void {
  if (!isIndex(event.output_index) || !isRecord(event.item)) {
    throw invalidLifecycle();
  }
  const item = event.item;
  if (!isNonEmptyString(item.id)) throw invalidLifecycle();
  if (typeof item.type !== "string") throw invalidLifecycle();
  if (item.type === "function_call") {
    state.accepted = true;
    validateFunctionCallItem(event, item, state, onEvent);
    return;
  }
  if (isToolItemType(item.type)) {
    throw failure("unsupported", "The provider attempted an unsupported tool call.");
  }
  const isAdded = event.type === "response.output_item.added";
  if (
    (isAdded && item.status !== "in_progress") ||
    (!isAdded && item.status !== "completed" && item.status !== "incomplete")
  ) {
    throw invalidLifecycle();
  }
  if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) throw invalidLifecycle();
    reconcileItemLifecycle(state, item.id, "message", event.output_index, item.status, isAdded);
    const coveredKeys = validateMessageContent(
      item.id,
      item.content,
      event.output_index,
      state,
      !isAdded,
    );
    if (!isAdded) {
      validateItemCoverage(item.id, coveredKeys, state.textParts, "output");
    }
    return;
  }
  if (
    !Array.isArray(item.summary) ||
    (item.content !== undefined && !Array.isArray(item.content))
  ) {
    throw invalidLifecycle();
  }
  reconcileItemLifecycle(state, item.id, "reasoning", event.output_index, item.status, isAdded);
  const coveredKeys = validateReasoningItem(
    item.id,
    item.summary,
    item.content,
    event.output_index,
    state,
    !isAdded,
  );
  if (!isAdded) {
    validateItemCoverage(item.id, coveredKeys, state.reasoningParts, "reasoning");
  }
}

function validateFunctionCallItem(
  event: Record<string, unknown> & { readonly type: string },
  item: Record<string, unknown>,
  state: NormalizationState,
  onEvent: ResponsesTurnInput["onEvent"],
): void {
  const isAdded = event.type === "response.output_item.added";
  const outputIndex = event.output_index as number;
  if (!isNonEmptyString(item.call_id)) throw invalidLifecycle();
  if (!isNonEmptyString(item.name)) throw invalidLifecycle();
  if (!isNonEmptyString(item.id)) throw invalidLifecycle();
  if (typeof item.arguments !== "string") throw invalidLifecycle();
  const toolName = normalizeToolNameOrFail(item.name);
  const callId = item.call_id;
  const itemId = item.id;
  if (isAdded) {
    if (item.status !== "in_progress") throw invalidLifecycle();
    if (state.functionCalls.has(itemId)) throw invalidLifecycle();
    if (item.arguments !== "") throw invalidLifecycle();
    state.functionCalls.set(itemId, {
      itemId,
      outputIndex,
      callId,
      toolName,
      arguments: "",
      status: "in_progress",
    });
    reconcileItemLifecycle(state, itemId, "function-call", outputIndex, "in_progress", true);
    return;
  }
  if (item.status !== "completed") throw invalidLifecycle();
  const tracked = state.functionCalls.get(itemId);
  if (
    tracked === undefined ||
    tracked.outputIndex !== outputIndex ||
    tracked.callId !== callId ||
    tracked.toolName !== toolName ||
    tracked.status !== "in_progress"
  ) {
    throw invalidLifecycle();
  }
  if (item.arguments !== tracked.arguments && item.arguments !== "") {
    throw protocol("The provider function call arguments did not match the streamed deltas.");
  }
  const argumentsJson = item.arguments.length > 0 ? item.arguments : tracked.arguments;
  assertBoundedToolCallArguments(argumentsJson);
  tracked.status = "completed";
  reconcileItemLifecycle(state, itemId, "function-call", outputIndex, "completed", false);
  const toolCall: ProtocolToolCall = { toolCallId: callId, toolName, argumentsJson };
  state.toolCalls.push(toolCall);
  emit(
    {
      kind: "tool-call",
      sequence: allocateSequence(state),
      toolCallId: callId,
      toolName,
      argumentsJson,
    },
    state,
    onEvent,
  );
}

function normalizeToolNameOrFail(name: unknown): string {
  if (!isNonEmptyString(name)) throw invalidLifecycle();
  try {
    return normalizeToolName(name);
  } catch {
    throw invalidLifecycle();
  }
}

function appendFunctionCallArgumentsDelta(
  event: Record<string, unknown> & { readonly type: string },
  state: NormalizationState,
): void {
  if (!isNonEmptyString(event.item_id) || !isIndex(event.output_index)) throw invalidLifecycle();
  if (typeof event.delta !== "string") throw invalidLifecycle();
  const tracked = state.functionCalls.get(event.item_id);
  if (
    tracked === undefined ||
    tracked.outputIndex !== event.output_index ||
    tracked.status !== "in_progress"
  ) {
    throw invalidLifecycle();
  }
  if (event.delta.length === 0) return;
  if (tracked.arguments.length + event.delta.length > MAX_TOOL_CALL_ARGUMENT_BYTES) {
    throw protocol("The provider function call arguments exceeded the size limit.");
  }
  tracked.arguments += event.delta;
}

function validateFunctionCallArgumentsDone(
  event: Record<string, unknown> & { readonly type: string },
  state: NormalizationState,
): void {
  if (!isNonEmptyString(event.item_id) || !isIndex(event.output_index)) throw invalidLifecycle();
  if (typeof event.arguments !== "string") throw invalidLifecycle();
  const tracked = state.functionCalls.get(event.item_id);
  if (
    tracked === undefined ||
    tracked.outputIndex !== event.output_index ||
    tracked.status !== "in_progress"
  ) {
    throw invalidLifecycle();
  }
  if (event.arguments !== tracked.arguments && tracked.arguments.length > 0) {
    throw protocol("The provider function call arguments did not match the streamed deltas.");
  }
  tracked.arguments = event.arguments;
}

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

const MAX_TOOL_CALL_ARGUMENT_BYTES = 65_536;
const MAX_TOOL_CALL_ARGUMENT_DEPTH = 16;
const MAX_TOOL_CALL_ARGUMENT_ENTRIES = 256;
const MAX_TOOL_CALL_ARGUMENT_KEY_LENGTH = 128;
const MAX_TOOL_CALL_ARGUMENT_STRING_LENGTH = 4_096;

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

function validateMessageContent(
  itemId: string,
  contentItems: unknown[],
  outputIndex: number,
  state: NormalizationState,
  validateCompletedText: boolean,
): ReadonlySet<string> {
  const coveredKeys = new Set<string>();
  contentItems.forEach((content, contentIndex) => {
    if (!isRecord(content) || typeof content.type !== "string") throw invalidLifecycle();
    if (content.type === "refusal") {
      if (typeof content.refusal !== "string") throw invalidLifecycle();
      throw failure("provider-failed", "The provider refused the request.");
    }
    if (
      content.type !== "output_text" ||
      typeof content.text !== "string" ||
      !Array.isArray(content.annotations)
    ) {
      throw invalidLifecycle();
    }
    const key = partKey(itemId, outputIndex, contentIndex, "content");
    coveredKeys.add(key);
    if (validateCompletedText) {
      validatePartText(key, content.text, state.textParts, "output");
    }
  });
  return coveredKeys;
}

function validateReasoningItem(
  itemId: string,
  summaryItems: unknown[],
  contentItems: unknown,
  outputIndex: number,
  state: NormalizationState,
  validateCompletedText: boolean,
): ReadonlySet<string> {
  const coveredKeys = new Set<string>();
  summaryItems.forEach((summary, summaryIndex) => {
    if (!isRecord(summary) || summary.type !== "summary_text" || typeof summary.text !== "string") {
      throw invalidLifecycle();
    }
    const key = partKey(itemId, outputIndex, summaryIndex, "summary");
    coveredKeys.add(key);
    if (validateCompletedText) {
      validatePartText(key, summary.text, state.reasoningParts, "reasoning");
    }
  });
  if (Array.isArray(contentItems)) {
    contentItems.forEach((content, contentIndex) => {
      if (
        !isRecord(content) ||
        content.type !== "reasoning_text" ||
        typeof content.text !== "string"
      ) {
        throw invalidLifecycle();
      }
      const key = partKey(itemId, outputIndex, contentIndex, "content");
      coveredKeys.add(key);
      if (validateCompletedText) {
        validatePartText(key, content.text, state.reasoningParts, "reasoning");
      }
    });
  }
  return coveredKeys;
}

function validateItemCoverage(
  itemId: string,
  coveredKeys: ReadonlySet<string>,
  parts: ReadonlyMap<string, string>,
  kind: "output" | "reasoning",
): void {
  const contentPrefix = `content:${itemId}:`;
  const summaryPrefix = `summary:${itemId}:`;
  for (const key of parts.keys()) {
    if (
      (key.startsWith(contentPrefix) || (kind === "reasoning" && key.startsWith(summaryPrefix))) &&
      !coveredKeys.has(key)
    ) {
      throw protocol(
        kind === "output"
          ? "The provider stream output item omitted streamed content."
          : "The provider stream reasoning item omitted streamed content.",
      );
    }
  }
}

function reconcileItemLifecycle(
  state: NormalizationState,
  itemId: string,
  type: TrackedOutputItem["type"],
  outputIndex: number,
  status: unknown,
  isAdded: boolean,
): void {
  const tracked = state.items.get(itemId);
  if (isAdded) {
    if (status !== "in_progress" || tracked !== undefined) throw invalidLifecycle();
    state.items.set(itemId, { id: itemId, type, outputIndex, status: "in_progress" });
    return;
  }
  if (
    status !== "completed" ||
    tracked === undefined ||
    tracked.type !== type ||
    tracked.outputIndex !== outputIndex ||
    tracked.status !== "in_progress"
  ) {
    throw invalidLifecycle();
  }
  tracked.status = "completed";
}

function trackStreamingItem(
  state: NormalizationState,
  event: Record<string, unknown>,
  type: TrackedOutputItem["type"],
): void {
  if (!isNonEmptyString(event.item_id) || !isIndex(event.output_index)) {
    throw invalidLifecycle();
  }
  const tracked = state.items.get(event.item_id);
  if (tracked === undefined) {
    state.items.set(event.item_id, {
      id: event.item_id,
      type,
      outputIndex: event.output_index,
      status: "in_progress",
    });
    return;
  }
  if (
    tracked.type !== type ||
    tracked.outputIndex !== event.output_index ||
    tracked.status !== "in_progress"
  ) {
    throw invalidLifecycle();
  }
}

function validateTerminalItems(response: unknown, state: NormalizationState): void {
  if (!isRecord(response)) throw invalidLifecycle();
  if (response.output !== undefined) {
    if (!Array.isArray(response.output)) throw invalidLifecycle();
    validateTerminalOutput(response.output, state);
  }
  for (const item of state.items.values()) {
    if (item.status !== "completed") {
      throw protocol("The provider stream ended with unresolved output items.");
    }
  }
}

function validateTerminalOutput(output: unknown[], state: NormalizationState): void {
  const seen = new Set<string>();
  output.forEach((value, outputIndex) => {
    if (!isRecord(value) || !isNonEmptyString(value.id) || typeof value.type !== "string") {
      throw invalidLifecycle();
    }
    if (isKnownToolItemType(value.type)) {
      throw failure("unsupported", "The provider attempted an unsupported tool call.");
    }
    if (value.type === "function_call") {
      validateTerminalFunctionCall(value, outputIndex, state, seen);
      return;
    }
    if (value.type !== "message" && value.type !== "reasoning") throw invalidLifecycle();
    if (value.status !== "completed") throw invalidLifecycle();
    if (value.type === "message") validateTerminalMessageRefusal(value);

    const tracked = state.items.get(value.id);
    if (
      tracked === undefined ||
      tracked.type !== value.type ||
      tracked.outputIndex !== outputIndex ||
      tracked.status !== "completed" ||
      seen.has(value.id)
    ) {
      throw invalidLifecycle();
    }
    seen.add(value.id);

    if (value.type === "message") {
      if (value.role !== "assistant" || !Array.isArray(value.content)) throw invalidLifecycle();
      const coveredKeys = validateMessageContent(value.id, value.content, outputIndex, state, true);
      validateItemCoverage(value.id, coveredKeys, state.textParts, "output");
      return;
    }
    if (
      !Array.isArray(value.summary) ||
      (value.content !== undefined && !Array.isArray(value.content))
    ) {
      throw invalidLifecycle();
    }
    const coveredKeys = validateReasoningItem(
      value.id,
      value.summary,
      value.content,
      outputIndex,
      state,
      true,
    );
    validateItemCoverage(value.id, coveredKeys, state.reasoningParts, "reasoning");
  });
  if (seen.size !== state.items.size) throw invalidLifecycle();
}

function validateTerminalFunctionCall(
  value: Record<string, unknown>,
  outputIndex: number,
  state: NormalizationState,
  seen: Set<string>,
): void {
  if (value.status !== "completed") throw invalidLifecycle();
  if (!isNonEmptyString(value.call_id) || !isNonEmptyString(value.name)) throw invalidLifecycle();
  if (typeof value.arguments !== "string") throw invalidLifecycle();
  if (!isNonEmptyString(value.id)) throw invalidLifecycle();
  if (seen.has(value.id)) throw invalidLifecycle();
  const tracked = state.functionCalls.get(value.id);
  if (
    tracked === undefined ||
    tracked.outputIndex !== outputIndex ||
    tracked.callId !== value.call_id ||
    tracked.toolName !== value.name ||
    tracked.status !== "completed"
  ) {
    throw invalidLifecycle();
  }
  if (value.arguments !== tracked.arguments) {
    throw protocol("The provider function call arguments did not match the streamed deltas.");
  }
  seen.add(value.id);
}

function validateTerminalMessageRefusal(value: Record<string, unknown>): void {
  if (!Array.isArray(value.content)) throw invalidLifecycle();
  for (const content of value.content) {
    if (!isRecord(content) || typeof content.type !== "string") throw invalidLifecycle();
    if (content.type === "refusal") {
      if (typeof content.refusal !== "string") throw invalidLifecycle();
      throw failure("provider-failed", "The provider refused the request.");
    }
  }
}

function validateContentPart(
  event: Record<string, unknown> & { readonly type: string },
  state: NormalizationState,
): void {
  if (
    !isNonEmptyString(event.item_id) ||
    !isIndex(event.output_index) ||
    !isIndex(event.content_index) ||
    !isRecord(event.part) ||
    typeof event.part.type !== "string"
  ) {
    throw invalidLifecycle();
  }
  const part = event.part;
  if (part.type === "refusal") {
    if (typeof part.refusal !== "string") throw invalidLifecycle();
    throw failure("provider-failed", "The provider refused the request.");
  }
  if (part.type === "output_text") {
    if (typeof part.text !== "string" || !Array.isArray(part.annotations)) throw invalidLifecycle();
    trackStreamingItem(state, event, "message");
    if (event.type === "response.content_part.done") {
      validateAccumulatedText(event, part.text, state.textParts, "output");
    }
    return;
  }
  if (part.type === "reasoning_text") {
    if (typeof part.text !== "string") throw invalidLifecycle();
    trackStreamingItem(state, event, "reasoning");
    if (event.type === "response.content_part.done") {
      validateAccumulatedText(event, part.text, state.reasoningParts, "reasoning");
    }
    return;
  }
  throw invalidLifecycle();
}

function validateReasoningSummaryPart(
  event: Record<string, unknown> & { readonly type: string },
  state: NormalizationState,
): void {
  if (
    !isNonEmptyString(event.item_id) ||
    !isIndex(event.output_index) ||
    !isIndex(event.summary_index) ||
    !isRecord(event.part) ||
    event.part.type !== "summary_text" ||
    typeof event.part.text !== "string"
  ) {
    throw invalidLifecycle();
  }
  trackStreamingItem(state, event, "reasoning");
  if (event.type === "response.reasoning_summary_part.done") {
    validateAccumulatedText(event, event.part.text, state.reasoningParts, "reasoning");
  }
}

function validateDoneText(
  event: Record<string, unknown>,
  state: NormalizationState,
  parts: ReadonlyMap<string, string>,
  kind: "output" | "reasoning",
): void {
  if (typeof event.text !== "string" || (kind === "output" && !Array.isArray(event.logprobs))) {
    throw invalidLifecycle();
  }
  trackStreamingItem(state, event, kind === "output" ? "message" : "reasoning");
  validateAccumulatedText(event, event.text, parts, kind);
}

function validateAccumulatedText(
  event: Record<string, unknown>,
  completedText: string,
  parts: ReadonlyMap<string, string>,
  kind: "output" | "reasoning",
): void {
  const key = contentKey(event);
  validatePartText(key, completedText, parts, kind);
}

function contentKey(event: Record<string, unknown>): string {
  if (!isNonEmptyString(event.item_id) || !isIndex(event.output_index)) {
    throw invalidLifecycle();
  }
  const channel =
    typeof event.type === "string" && event.type.includes("reasoning_summary")
      ? "summary"
      : "content";
  if (
    (channel === "summary" && event.content_index !== undefined) ||
    (channel === "content" && event.summary_index !== undefined)
  ) {
    throw invalidLifecycle();
  }
  const index = channel === "content" ? event.content_index : event.summary_index;
  if (!isIndex(index)) throw invalidLifecycle();
  return partKey(event.item_id, event.output_index, index, channel);
}

function partKey(
  itemId: string,
  outputIndex: number,
  partIndex: number,
  channel: "content" | "summary",
): string {
  return `${channel}:${itemId}:${outputIndex}:${partIndex}`;
}

function validatePartText(
  key: string,
  completedText: string,
  parts: ReadonlyMap<string, string>,
  kind: "output" | "reasoning",
): void {
  if ((parts.get(key) ?? "") !== completedText) {
    throw protocol(
      kind === "output"
        ? "The provider stream output did not match its completed text."
        : "The provider stream reasoning did not match its completed text.",
    );
  }
}

function readUsage(value: unknown): ProtocolUsage | undefined {
  if (!isRecord(value) || value.usage === null || value.usage === undefined) return undefined;
  const usage = value.usage;
  if (
    !isRecord(usage) ||
    !isTokenCount(usage.input_tokens) ||
    !isTokenCount(usage.output_tokens) ||
    !isTokenCount(usage.total_tokens) ||
    !Number.isSafeInteger(usage.input_tokens + usage.output_tokens) ||
    usage.total_tokens !== usage.input_tokens + usage.output_tokens
  ) {
    throw protocol("The provider stream contained invalid usage.");
  }
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function isToolEvent(event: { readonly type: string }): boolean {
  return (
    event.type.startsWith("response.file_search_call") ||
    event.type.startsWith("response.web_search_call") ||
    event.type.startsWith("response.image_generation_call") ||
    event.type.startsWith("response.code_interpreter_call") ||
    event.type.startsWith("response.computer_tool_call") ||
    event.type.startsWith("response.mcp_call") ||
    event.type.startsWith("response.local_shell_call") ||
    event.type.startsWith("response.shell_call")
  );
}

function isToolItemType(type: string): boolean {
  return type !== "message" && type !== "reasoning" && type !== "function_call";
}

function isKnownToolItemType(type: string): boolean {
  return [
    "file_search_call",
    "web_search_call",
    "image_generation_call",
    "code_interpreter_call",
    "computer_call",
    "computer_tool_call",
    "mcp_call",
    "local_shell_call",
    "shell_call",
  ].includes(type);
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSequenceStart(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure("invalid-configuration", "The Octant event sequence start was invalid.");
  }
}

function allocateSequence(state: NormalizationState): number {
  if (!Number.isSafeInteger(state.nextSequence) || state.nextSequence < 0) {
    throw protocol("The Octant event sequence overflowed.");
  }
  const sequence = state.nextSequence;
  state.nextSequence += 1;
  return sequence;
}

function invalidLifecycle(): ProviderFailure {
  return protocol("The provider stream contained invalid lifecycle data.");
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

function notifyAttemptFailure(
  observer: ResponsesTurnInput["onAttemptFailure"],
  attempt: MutableAttemptMetadata,
  failure: ProviderFailure,
): void {
  try {
    observer?.({
      failure,
      accepted: attempt.accepted,
      outputStarted: attempt.outputStarted,
      ...(attempt.httpStatus === undefined ? {} : { httpStatus: attempt.httpStatus }),
    });
  } catch {
    // Attempt observation cannot replace the sanitized provider failure.
  }
}

function protocol(message: string): ProviderFailure {
  return failure("protocol", message);
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

async function classifyStoreRejection(response: Response): Promise<ProviderFailure | undefined> {
  if (response.status !== 400 && response.status !== 422) return undefined;
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw sanitizeFailure(error);
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (
    !hasExactKeys(value, ["error"]) ||
    !hasExactKeys(value.error, ["message", "type", "param", "code"])
  ) {
    return undefined;
  }
  const error = value.error;
  if (
    !isNonEmptyString(error.message) ||
    error.type !== "invalid_request_error" ||
    error.param !== "store" ||
    !["unsupported_parameter", "invalid_parameter", "unsupported_value"].includes(
      error.code as string,
    )
  ) {
    return undefined;
  }
  return failure("unsupported", "The provider does not support requests with storage disabled.");
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

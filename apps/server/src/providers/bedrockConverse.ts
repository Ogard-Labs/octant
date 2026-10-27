import { createHash } from "node:crypto";
import type {
  NativeHarnessTranscriptToolCall,
  ProviderFailure,
  ProviderOutputStopReason,
  ProviderToolDefinition,
  ProviderToolImage,
} from "@octant/contracts";
import type {
  HarnessEndpointMessage,
  HarnessEndpointStreamEvent,
  HarnessEndpointUsage,
} from "@octant/provider-sdk/harness-endpoint";
import type { CloudIamRequest } from "@octant/provider-sdk/cloud-iam";
import { contextOverflowFromBody } from "./contextOverflowRefusal";

/**
 * Amazon Bedrock's Converse API as one request attempt: the body Bedrock
 * reads, the signed request that carries it, and the binary event stream
 * that answers. The transport owns no credential: every request is described
 * to the caller's authorization by its fields, and the caller signs and sends
 * it, so the bytes that were signed are the bytes that are sent.
 */

export interface BedrockConverseLimits {
  readonly connectionTimeoutMs: number;
  readonly requestBodyBytes: number;
  readonly responseBodyBytes: number;
  readonly streamIdleTimeoutMs: number;
}

export const DEFAULT_BEDROCK_CONVERSE_LIMITS: BedrockConverseLimits = {
  connectionTimeoutMs: 10_000,
  // Bedrock accepts larger bodies than a keyed endpoint usually does; tool
  // images ride along base64-encoded.
  requestBodyBytes: 4 * 1_048_576,
  responseBodyBytes: 1_048_576,
  streamIdleTimeoutMs: 120_000,
};

/**
 * Sends one request the caller signs. It may send twice, renewing the
 * credentials between; it answers with the response to read or rejects with a
 * provider failure in the caller's own words.
 */
export type BedrockRequestAuthorization = (
  request: CloudIamRequest,
  send: (headers: Readonly<Record<string, string>>) => Promise<Response>,
) => Promise<Response>;

export type BedrockFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface BedrockConverseEndpoint {
  /** The Bedrock runtime host of the instance's region. */
  readonly host: string;
  readonly fetch: BedrockFetch;
  readonly authorize: BedrockRequestAuthorization;
  readonly limits: BedrockConverseLimits;
}

export interface BedrockConverseInput {
  readonly modelId: string;
  readonly system: string | undefined;
  readonly history: ReadonlyArray<HarnessEndpointMessage>;
  readonly tools: ReadonlyArray<ProviderToolDefinition>;
  /** "required" makes the model answer with a tool call; a capability probe needs that. */
  readonly toolChoice?: "auto" | "required";
  readonly maxTokens?: number;
}

export interface BedrockConverseResult {
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: ReadonlyArray<NativeHarnessTranscriptToolCall>;
  readonly usage?: HarnessEndpointUsage;
  readonly outputStopReason?: ProviderOutputStopReason;
}

/** The request path for a model: its id is one percent-encoded path segment. */
export function bedrockConversePath(modelId: string): string {
  return `/model/${percentEncode(modelId)}/converse-stream`;
}

/**
 * The body Converse reads, shared by the sender and the size check so the
 * bytes that are measured are the bytes that are sent. Converse refuses tool
 * blocks without a tool list, so a history that called tools is sent as text
 * when this request offers none.
 */
export function buildBedrockConverseBody(input: BedrockConverseInput): Record<string, unknown> {
  const offersTools = input.tools.length > 0;
  const messages: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> =
    [];
  for (const message of input.history) {
    const content = offersTools ? toolBlocksOf(message) : textBlocksOf(message);
    if (content.length === 0) continue;
    const last = messages.at(-1);
    // Converse wants the roles to alternate; two messages of one role in a
    // row (a tool result and the person's next words) become one.
    if (last !== undefined && last.role === message.role) {
      last.content.push(...content);
    } else {
      messages.push({ role: message.role, content });
    }
  }
  return {
    messages,
    ...(input.system === undefined || input.system.trim().length === 0
      ? {}
      : { system: [{ text: input.system }] }),
    ...(offersTools
      ? {
          toolConfig: {
            tools: input.tools.map((tool) => ({
              toolSpec: {
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                inputSchema: { json: tool.inputSchema },
              },
            })),
            ...(input.toolChoice === "required" ? { toolChoice: { any: {} } } : {}),
          },
        }
      : {}),
    ...(input.maxTokens === undefined ? {} : { inferenceConfig: { maxTokens: input.maxTokens } }),
  };
}

function toolBlocksOf(message: HarnessEndpointMessage): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const result of message.toolResults ?? []) {
    blocks.push({
      toolResult: {
        toolUseId: result.toolCallId,
        content: [{ text: result.resultJson }, ...imageBlocks(result.images)],
        status: result.isError ? "error" : "success",
      },
    });
  }
  if (message.text.trim().length > 0) blocks.push({ text: message.text });
  for (const call of message.toolCalls ?? []) {
    blocks.push({
      toolUse: {
        toolUseId: call.toolCallId,
        name: call.toolName,
        input: parseArguments(call.argumentsJson),
      },
    });
  }
  return blocks;
}

function textBlocksOf(message: HarnessEndpointMessage): Array<Record<string, unknown>> {
  const parts: string[] = [];
  for (const result of message.toolResults ?? []) {
    parts.push(`[Result of tool call ${result.toolCallId}]\n${result.resultJson}`);
  }
  if (message.text.trim().length > 0) parts.push(message.text);
  for (const call of message.toolCalls ?? []) {
    parts.push(`[Called tool ${call.toolName} (${call.toolCallId}) with ${call.argumentsJson}]`);
  }
  return parts.length === 0 ? [] : [{ text: parts.join("\n\n") }];
}

function imageBlocks(
  images: ReadonlyArray<ProviderToolImage> | undefined,
): Array<Record<string, unknown>> {
  return (images ?? []).map((image) => ({
    image: {
      format: image.mimeType === "image/png" ? "png" : "jpeg",
      source: { bytes: image.data },
    },
  }));
}

/**
 * Send one Converse request and read its event stream. Rejects with a
 * provider failure: an abort is `interrupted`; a throttled, overloaded, or
 * cut-short stream is one the host retries; a request that outgrew the
 * model's window says so.
 */
export async function sendBedrockConverse(input: {
  readonly endpoint: BedrockConverseEndpoint;
  readonly request: BedrockConverseInput;
  readonly signal: AbortSignal;
  readonly onEvent: (event: HarnessEndpointStreamEvent) => void;
}): Promise<BedrockConverseResult> {
  const { endpoint, signal } = input;
  if (signal.aborted) throw interrupted();
  const body = JSON.stringify(buildBedrockConverseBody(input.request));
  if (Buffer.byteLength(body, "utf8") > endpoint.limits.requestBodyBytes) {
    throw failure("invalid-configuration", "The request is larger than this endpoint accepts.");
  }
  const path = bedrockConversePath(input.request.modelId);
  const signable: CloudIamRequest = {
    method: "POST",
    host: endpoint.host,
    path,
    query: [],
    headers: { "content-type": "application/json", accept: "application/vnd.amazon.eventstream" },
    payloadHash: createHash("sha256").update(body, "utf8").digest("hex"),
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const connection = setTimeout(abort, endpoint.limits.connectionTimeoutMs);
  let response: Response;
  try {
    response = await endpoint.authorize(signable, async (signature) => {
      try {
        return await endpoint.fetch(`https://${endpoint.host}${path}`, {
          method: "POST",
          headers: { ...signable.headers, ...signature },
          body,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        if (signal.aborted) throw interrupted();
        throw failure("unavailable", "The provider endpoint could not be reached.");
      }
    });
  } catch (error) {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) throw interrupted();
    throw error;
  } finally {
    clearTimeout(connection);
  }
  try {
    if (response.status !== 200) throw await refusal(response);
    if (response.body === null) {
      throw failure("protocol", "The provider returned an empty response stream.");
    }
    return await readConverseStream(response.body, {
      limits: endpoint.limits,
      signal,
      onEvent: input.onEvent,
    });
  } catch (error) {
    if (signal.aborted) throw interrupted();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * The failure a non-200 answer stands for. Only the service's error type is
 * read from its header, and the body only to recognise a filled context
 * window; no text of Bedrock's reaches a failure.
 */
async function refusal(response: Response): Promise<ProviderFailure> {
  const type = errorType(response.headers.get("x-amzn-errortype"));
  const text = await boundedText(response, 16_384);
  if (response.status === 400 && type === "ValidationException") {
    const overflow = contextOverflowFromBody(text);
    if (overflow !== undefined) return overflow;
    return failure("provider-failed", "Amazon Bedrock refused the request as invalid.");
  }
  if (response.status === 404 || type === "ResourceNotFoundException") {
    return failure(
      "invalid-configuration",
      "Amazon Bedrock does not serve that model, or it is not enabled for this account and region.",
    );
  }
  if (response.status === 429 || type === "ThrottlingException") {
    return failure("rate-limited", "The provider rate limit was reached.");
  }
  if (
    response.status === 408 ||
    response.status >= 500 ||
    type === "ModelTimeoutException" ||
    type === "ServiceUnavailableException" ||
    type === "ModelNotReadyException"
  ) {
    return failure("unavailable", `The provider request failed with HTTP ${response.status}.`);
  }
  return failure("provider-failed", `The provider request failed with HTTP ${response.status}.`);
}

/** The error type a service named in its header, without its namespace suffix. */
export function errorType(header: string | null): string | undefined {
  const name = header?.split(":", 1)[0]?.trim();
  return name !== undefined && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(name) ? name : undefined;
}

interface StreamState {
  text: string;
  reasoning: string;
  terminal: boolean;
  stopReason: string | undefined;
  usage: HarnessEndpointUsage | undefined;
  readonly toolBlocks: Map<number, { toolCallId: string; toolName: string; input: string }>;
  readonly toolCalls: NativeHarnessTranscriptToolCall[];
}

async function readConverseStream(
  body: ReadableStream<Uint8Array>,
  options: {
    readonly limits: BedrockConverseLimits;
    readonly signal: AbortSignal;
    readonly onEvent: (event: HarnessEndpointStreamEvent) => void;
  },
): Promise<BedrockConverseResult> {
  const state: StreamState = {
    text: "",
    reasoning: "",
    terminal: false,
    stopReason: undefined,
    usage: undefined,
    toolBlocks: new Map(),
    toolCalls: [],
  };
  let metadataSeen = false;
  for await (const message of decodeEventStream(body, options)) {
    const messageType = message.headers.get(":message-type");
    if (messageType === "exception" || messageType === "error") {
      throw streamException(message.headers.get(":exception-type"), message.payload);
    }
    if (messageType !== "event") {
      throw failure("protocol", "The provider stream contained an invalid event.");
    }
    const event = parsePayload(message.payload);
    switch (message.headers.get(":event-type")) {
      case "messageStart":
        break;
      case "contentBlockStart":
        startBlock(event, state);
        break;
      case "contentBlockDelta":
        applyDelta(event, state, options.onEvent);
        break;
      case "contentBlockStop":
        stopBlock(event, state);
        break;
      case "messageStop":
        state.terminal = true;
        state.stopReason = typeof event.stopReason === "string" ? event.stopReason : undefined;
        break;
      case "metadata":
        metadataSeen = true;
        state.usage = readUsage(event.usage);
        if (state.usage !== undefined) options.onEvent({ kind: "usage", ...state.usage });
        break;
      default:
        // A newer event type is ignored rather than failing a good reply.
        break;
    }
  }
  if (!state.terminal) {
    throw failure("protocol", "The provider stream ended without a terminal event.");
  }
  if (state.toolBlocks.size > 0) {
    throw failure("protocol", "The provider stream ended with unresolved content blocks.");
  }
  const outputStopReason = stopReasonOf(state.stopReason);
  return {
    text: state.text,
    reasoning: state.reasoning,
    toolCalls: state.toolCalls,
    ...(metadataSeen && state.usage !== undefined ? { usage: state.usage } : {}),
    ...(outputStopReason === undefined ? {} : { outputStopReason }),
  };
}

function startBlock(event: Record<string, unknown>, state: StreamState): void {
  const index = event.contentBlockIndex;
  const start = event.start;
  const toolUse = isRecord(start) ? start.toolUse : undefined;
  if (!isIndex(index)) throw failure("protocol", "The provider stream contained an invalid block.");
  if (!isRecord(toolUse)) return;
  const { toolUseId, name } = toolUse;
  if (
    typeof toolUseId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(toolUseId) ||
    typeof name !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(name)
  ) {
    throw failure("protocol", "The provider stream contained an invalid tool use.");
  }
  state.toolBlocks.set(index, { toolCallId: toolUseId, toolName: name, input: "" });
}

function applyDelta(
  event: Record<string, unknown>,
  state: StreamState,
  onEvent: (event: HarnessEndpointStreamEvent) => void,
): void {
  const index = event.contentBlockIndex;
  const delta = event.delta;
  if (!isIndex(index) || !isRecord(delta)) {
    throw failure("protocol", "The provider stream contained an invalid delta.");
  }
  if (typeof delta.text === "string") {
    if (delta.text.length === 0) return;
    state.text += delta.text;
    onEvent({ kind: "text-delta", text: delta.text });
    return;
  }
  if (isRecord(delta.toolUse)) {
    const block = state.toolBlocks.get(index);
    if (block === undefined || typeof delta.toolUse.input !== "string") {
      throw failure("protocol", "The provider stream referenced an unknown tool use.");
    }
    block.input += delta.toolUse.input;
    return;
  }
  if (isRecord(delta.reasoningContent)) {
    const text = delta.reasoningContent.text;
    if (typeof text === "string" && text.length > 0) {
      state.reasoning += text;
      onEvent({ kind: "reasoning-delta", text });
    }
  }
}

function stopBlock(event: Record<string, unknown>, state: StreamState): void {
  const index = event.contentBlockIndex;
  if (!isIndex(index)) throw failure("protocol", "The provider stream contained an invalid block.");
  const block = state.toolBlocks.get(index);
  if (block === undefined) return;
  state.toolBlocks.delete(index);
  const argumentsJson = block.input.trim().length === 0 ? "{}" : block.input;
  try {
    JSON.parse(argumentsJson);
  } catch {
    throw failure("protocol", "The provider stream contained invalid tool arguments.");
  }
  state.toolCalls.push({
    toolCallId: block.toolCallId,
    toolName: block.toolName,
    argumentsJson,
  });
}

/**
 * Converse reports input it read from or wrote to the prompt cache apart from
 * the rest; the host's `inputTokens` is all input, so they are added.
 */
function readUsage(value: unknown): HarnessEndpointUsage | undefined {
  if (!isRecord(value)) return undefined;
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens } = value;
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined;
  const cacheRead = isCount(cacheReadInputTokens) ? cacheReadInputTokens : undefined;
  const cacheWrite = isCount(cacheWriteInputTokens) ? cacheWriteInputTokens : undefined;
  return {
    inputTokens: inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0),
    outputTokens,
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
  };
}

function stopReasonOf(value: string | undefined): ProviderOutputStopReason | undefined {
  if (value === "max_tokens") return "max-tokens";
  if (value === "guardrail_intervened" || value === "content_filtered") return "content-filter";
  return undefined;
}

/** An exception the stream reported in place of an event, by its type alone. */
function streamException(type: string | undefined, payload: Uint8Array): ProviderFailure {
  switch (type) {
    case "throttlingException":
      return failure("rate-limited", "The provider rate limit was reached.");
    case "serviceUnavailableException":
    case "internalServerException":
    case "modelStreamErrorException":
    case "modelTimeoutException":
      return failure("unavailable", "The provider failed to complete the response.");
    case "validationException":
      return (
        contextOverflowFromBody(new TextDecoder().decode(payload)) ??
        failure("provider-failed", "Amazon Bedrock refused the request as invalid.")
      );
    default:
      return failure("provider-failed", "The provider failed to complete the response.");
  }
}

interface EventStreamMessage {
  readonly headers: ReadonlyMap<string, string>;
  readonly payload: Uint8Array;
}

/**
 * The cloud's binary event stream: each message is a length-prefixed prelude
 * with its own checksum, typed headers, a payload, and a checksum over the
 * whole message. A message whose checksums do not hold, or that is larger
 * than the response limit, ends the stream as a protocol failure.
 */
export async function* decodeEventStream(
  body: ReadableStream<Uint8Array>,
  options: { readonly limits: BedrockConverseLimits; readonly signal: AbortSignal },
): AsyncGenerator<EventStreamMessage> {
  const reader = body.getReader();
  let buffered = new Uint8Array(0);
  try {
    for (;;) {
      while (buffered.byteLength >= 12) {
        const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
        const total = view.getUint32(0);
        const headersLength = view.getUint32(4);
        if (crc32(buffered.subarray(0, 8)) !== view.getUint32(8)) {
          throw failure("protocol", "The provider stream contained a damaged message.");
        }
        if (total < 16 || total > options.limits.responseBodyBytes || headersLength > total - 16) {
          throw failure("protocol", "The provider stream contained an oversized message.");
        }
        if (buffered.byteLength < total) break;
        const message = buffered.subarray(0, total);
        if (crc32(message.subarray(0, total - 4)) !== view.getUint32(total - 4)) {
          throw failure("protocol", "The provider stream contained a damaged message.");
        }
        yield {
          headers: readHeaders(message.subarray(12, 12 + headersLength)),
          payload: message.subarray(12 + headersLength, total - 4),
        };
        buffered = buffered.slice(total);
      }
      const read = await readWithin(reader, options.limits.streamIdleTimeoutMs, options.signal);
      if (read.done) break;
      const next = new Uint8Array(buffered.byteLength + read.value.byteLength);
      next.set(buffered);
      next.set(read.value, buffered.byteLength);
      buffered = next;
    }
    if (buffered.byteLength > 0) {
      throw failure("protocol", "The provider stream ended without a terminal event.");
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  signal: AbortSignal,
): Promise<
  ReadableStreamReadResult<Uint8Array> | { readonly done: true; readonly value?: undefined }
> {
  if (signal.aborted) throw interrupted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(failure("unavailable", "The provider stream stopped responding.")),
          idleMs,
        );
        onAbort = () => reject(interrupted());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch (error) {
    if (isProviderFailure(error)) throw error;
    throw failure("unavailable", "The provider stream ended unexpectedly.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function readHeaders(bytes: Uint8Array): ReadonlyMap<string, string> {
  const headers = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const decoder = new TextDecoder();
  const need = (count: number) => {
    if (offset + count > bytes.byteLength) {
      throw failure("protocol", "The provider stream contained a damaged message.");
    }
  };
  while (offset < bytes.byteLength) {
    need(1);
    const nameLength = view.getUint8(offset);
    offset += 1;
    need(nameLength + 1);
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = view.getUint8(offset);
    offset += 1;
    // Only string values are read; every other type is skipped by its size.
    const fixed: Readonly<Record<number, number>> = {
      0: 0,
      1: 0,
      2: 1,
      3: 2,
      4: 4,
      5: 8,
      8: 8,
      9: 16,
    };
    if (type === 6 || type === 7) {
      need(2);
      const length = view.getUint16(offset);
      offset += 2;
      need(length);
      if (type === 7) headers.set(name, decoder.decode(bytes.subarray(offset, offset + length)));
      offset += length;
      continue;
    }
    const size = fixed[type];
    if (size === undefined) {
      throw failure("protocol", "The provider stream contained a damaged message.");
    }
    need(size);
    offset += size;
  }
  return headers;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE), which the event stream checksums its preludes and messages with. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePayload(payload: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw failure("protocol", "The provider stream contained invalid JSON.");
  }
  if (!isRecord(value))
    throw failure("protocol", "The provider stream contained an invalid event.");
  return value;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      const read = await reader.read();
      if (read.done) break;
      chunks.push(read.value);
      length += read.value.byteLength;
    }
  } catch {
    return "";
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, limit);
}

/** RFC 3986 encoding of one path segment: everything but the unreserved characters. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function parseArguments(argumentsJson: string): unknown {
  try {
    const parsed: unknown = argumentsJson.trim().length === 0 ? {} : JSON.parse(argumentsJson);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderFailure(error: unknown): error is ProviderFailure {
  return isRecord(error) && typeof error.category === "string" && typeof error.message === "string";
}

function interrupted(): ProviderFailure {
  return failure("interrupted", "The provider request was cancelled.");
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

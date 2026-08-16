import {
  decodeProviderFailure,
  decodeProviderModelId,
  type ProviderCapabilities,
  type ProviderFailure,
  type ProviderInputModality,
  type ProviderModel,
  type ProviderReadiness,
} from "@octant/contracts";
import { unsupportedChatCapabilities } from "@octant/provider-sdk/chat-conformance";

export type OllamaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OllamaHttpLimits {
  readonly requestTimeoutMs: number;
  readonly requestBodyBytes: number;
  readonly responseBodyBytes: number;
  readonly frameBytes: number;
  readonly maximumModels: number;
  readonly maximumFrames: number;
  readonly maximumHistoryMessages: number;
}

export interface OllamaEndpoint {
  readonly baseUrl: string;
  readonly fetch: OllamaFetch;
  readonly limits: OllamaHttpLimits;
  readonly url: (path: "version" | "tags" | "show" | "chat") => string;
}

export interface OllamaProbeResult {
  readonly readiness: ProviderReadiness;
  readonly version: string;
  readonly models: readonly ProviderModel[];
  readonly capabilities: ProviderCapabilities;
}

export interface OllamaHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export type OllamaTurnEvent =
  | { readonly kind: "text-delta"; readonly text: string }
  | { readonly kind: "reasoning-delta"; readonly text: string }
  | { readonly kind: "tool-request"; readonly toolCallId: string; readonly toolName: string }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number };

export interface OllamaChatInput {
  readonly modelId: string;
  readonly history: readonly OllamaHistoryMessage[];
  readonly prompt: string;
  readonly attachments?: readonly {
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }[];
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: OllamaTurnEvent) => void;
}

export interface OllamaChatResult {
  readonly text: string;
  readonly reasoning: string;
  readonly toolRequests: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
  }[];
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly doneReason: string;
}

const DEFAULT_LIMITS: OllamaHttpLimits = {
  requestTimeoutMs: 120_000,
  requestBodyBytes: 1_048_576,
  responseBodyBytes: 16_777_216,
  frameBytes: 1_048_576,
  maximumModels: 256,
  maximumFrames: 16_384,
  maximumHistoryMessages: 256,
};

const unsupportedCapabilities = {
  approvals: "unsupported",
  userQuestions: "unsupported",
  fileChanges: "unsupported",
  diffs: "unsupported",
  taskProgress: "unsupported",
  nativeChildAgents: "unsupported",
} as const;

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function sanitizeFailure(error: unknown): ProviderFailure {
  try {
    return decodeProviderFailure(error);
  } catch {
    if (error instanceof DOMException && error.name === "AbortError") {
      return failure("interrupted", "The Ollama request was interrupted.");
    }
    return failure("unavailable", "The Ollama service could not be reached.");
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function boundedString(value: unknown, maximum = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.includes("\n") || normalized.includes("\r")) {
    return undefined;
  }
  return Array.from(normalized).length <= maximum ? normalized : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const integer = nonNegativeInteger(value);
  return integer !== undefined && integer > 0 ? integer : undefined;
}

export function makeOllamaEndpoint(options: {
  readonly baseUrl: string;
  readonly fetch?: OllamaFetch;
  readonly limits?: Partial<OllamaHttpLimits>;
}): OllamaEndpoint {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
  for (const limit of Object.values(limits)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw failure("invalid-configuration", "Ollama HTTP limits must be positive integers.");
    }
  }
  return Object.freeze({
    baseUrl,
    fetch: options.fetch ?? globalThis.fetch,
    limits,
    url: (path: "version" | "tags" | "show" | "chat") => `${baseUrl}/api/${path}`,
  });
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim();
  if (normalized.includes("?") || normalized.includes("#")) {
    throw failure(
      "invalid-configuration",
      "Ollama base URL cannot include query or fragment delimiters.",
    );
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw failure("invalid-configuration", "Ollama base URL is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase()) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw failure(
      "invalid-configuration",
      "Ollama base URL must be an HTTP origin on literal loopback with no path, credentials, query, or fragment.",
    );
  }
  return url.origin;
}

export async function probeOllama(endpoint: OllamaEndpoint): Promise<OllamaProbeResult> {
  const versionValue = await requestJson(endpoint, "version", "GET");
  const version = boundedString(record(versionValue)?.version, 64);
  if (version === undefined || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw failure("protocol", "Ollama returned an invalid version response.");
  }

  const tagsValue = record(await requestJson(endpoint, "tags", "GET"));
  const candidates = tagsValue?.models;
  if (!Array.isArray(candidates) || candidates.length > endpoint.limits.maximumModels) {
    throw failure("protocol", "Ollama returned an invalid model list.");
  }

  const names: string[] = [];
  for (const candidate of candidates) {
    const model = record(candidate);
    const name = boundedString(model?.model ?? model?.name);
    if (name === undefined || names.includes(name)) {
      throw failure("protocol", "Ollama returned an invalid model identity.");
    }
    names.push(name);
  }

  const observations = [] as Array<{
    model: ProviderModel;
    tools: boolean;
    vision: boolean;
  }>;
  for (const name of names) {
    const detail = record(await requestJson(endpoint, "show", "POST", { model: name }));
    const capabilityValues = detail?.capabilities;
    if (
      !Array.isArray(capabilityValues) ||
      capabilityValues.some((value) => typeof value !== "string")
    ) {
      throw failure("protocol", "Ollama returned invalid model capabilities.");
    }
    const capabilities = new Set(capabilityValues);
    if (!capabilities.has("completion")) continue;
    const contextLimit = findContextLimit(detail?.model_info);
    const inputModalities: ProviderInputModality[] = capabilities.has("vision")
      ? ["text", "image"]
      : ["text"];
    observations.push({
      model: {
        id: decodeProviderModelId(name),
        displayName: name,
        source: "discovered",
        verification: "verified",
        ...(contextLimit === undefined ? {} : { contextLimit }),
        reasoning: capabilities.has("thinking") ? "supported" : "unsupported",
        inputModalities,
        // Ollama reports an explicit capability list per model, so both the
        // presence and the absence of vision are observed facts.
        imageInput: capabilities.has("vision") ? "supported" : "unsupported",
        options: [],
      },
      tools: capabilities.has("tools"),
      vision: capabilities.has("vision"),
    });
  }

  const models = observations.map(({ model }) => model);
  const available = models.length > 0;
  const reasoning = observations.some(({ model }) => model.reasoning === "supported");
  const tools = observations.some((observation) => observation.tools);
  const vision = observations.some((observation) => observation.vision);
  return {
    readiness: available ? "ready" : "degraded",
    version,
    models,
    capabilities: {
      streaming: "unavailable",
      resume: "supported",
      interruption: "supported",
      ...unsupportedCapabilities,
      ...unsupportedChatCapabilities,
      nativeAttachments: vision ? "supported" : "unsupported",
      reasoning: available ? (reasoning ? "unavailable" : "unsupported") : "unavailable",
      usage: "unavailable",
      toolActivity: available ? (tools ? "unavailable" : "unsupported") : "unavailable",
    },
  };
}

function findContextLimit(value: unknown): number | undefined {
  const info = record(value);
  if (info === undefined) return undefined;
  const limits = Object.entries(info)
    .filter(([key]) => key.endsWith(".context_length"))
    .flatMap(([, candidate]) => {
      const limit = positiveInteger(candidate);
      return limit === undefined ? [] : [limit];
    });
  return limits.length === 1 ? limits[0] : undefined;
}

export async function sendOllamaChat(
  endpoint: OllamaEndpoint,
  input: OllamaChatInput,
): Promise<OllamaChatResult> {
  if (
    input.history.length > endpoint.limits.maximumHistoryMessages ||
    boundedString(input.modelId) === undefined ||
    input.prompt.length === 0
  ) {
    throw failure("invalid-configuration", "The Ollama turn request is invalid or too large.");
  }
  const images =
    input.attachments === undefined
      ? []
      : input.attachments
          .filter((attachment) => attachment.mediaType.startsWith("image/"))
          .map((attachment) => Buffer.from(attachment.bytes).toString("base64"));
  const response = await request(
    endpoint,
    "chat",
    "POST",
    {
      model: input.modelId,
      messages: [
        ...input.history.map(({ role, text }) => ({ role, content: text })),
        {
          role: "user",
          content: input.prompt,
          ...(images.length === 0 ? {} : { images }),
        },
      ],
      stream: true,
    },
    input.signal,
  );
  if (response.body === null) throw failure("protocol", "Ollama returned an empty stream.");

  const state = {
    text: "",
    reasoning: "",
    done: false,
    frames: 0,
    tools: [] as Array<{ toolCallId: string; toolName: string }>,
    usage: undefined as OllamaChatResult["usage"],
    doneReason: "stop",
  };
  for await (const line of decodeNdjson(response.body, endpoint.limits, input.signal)) {
    if (state.done) throw failure("protocol", "Ollama streamed data after completion.");
    state.frames += 1;
    if (state.frames > endpoint.limits.maximumFrames) {
      throw failure("protocol", "Ollama returned too many stream frames.");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw failure("protocol", "Ollama returned malformed NDJSON.");
    }
    normalizeFrame(value, input, state);
  }
  if (!state.done) throw failure("protocol", "Ollama ended without a completion frame.");
  return {
    text: state.text,
    reasoning: state.reasoning,
    toolRequests: state.tools,
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    doneReason: state.doneReason,
  };
}

function normalizeFrame(
  value: unknown,
  input: OllamaChatInput,
  state: {
    text: string;
    reasoning: string;
    done: boolean;
    tools: Array<{ toolCallId: string; toolName: string }>;
    usage: OllamaChatResult["usage"];
    doneReason: string;
  },
): void {
  const frame = record(value);
  const message = record(frame?.message);
  if (frame === undefined || message === undefined || message.role !== "assistant") {
    throw failure("protocol", "Ollama returned an invalid chat frame.");
  }
  if (frame.model !== undefined && frame.model !== input.modelId) {
    throw failure("protocol", "Ollama changed model identity during the turn.");
  }
  if (typeof frame.done !== "boolean") {
    throw failure("protocol", "Ollama returned an invalid completion state.");
  }
  const content = message.content ?? "";
  const thinking = message.thinking ?? "";
  if (typeof content !== "string" || typeof thinking !== "string") {
    throw failure("protocol", "Ollama returned invalid assistant output.");
  }
  if (thinking.length > 0) {
    state.reasoning += thinking;
    input.onEvent?.({ kind: "reasoning-delta", text: thinking });
  }
  if (content.length > 0) {
    state.text += content;
    input.onEvent?.({ kind: "text-delta", text: content });
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) {
      throw failure("protocol", "Ollama returned invalid tool requests.");
    }
    for (const candidate of message.tool_calls) {
      const toolName = boundedString(record(record(candidate)?.function)?.name, 256);
      if (toolName === undefined)
        throw failure("protocol", "Ollama returned an invalid tool request.");
      const toolCallId = `ollama-tool-${state.tools.length + 1}`;
      const request = { toolCallId, toolName };
      state.tools.push(request);
      input.onEvent?.({ kind: "tool-request", ...request });
    }
  }
  if (!frame.done) return;
  const inputTokens = nonNegativeInteger(frame.prompt_eval_count);
  const outputTokens = nonNegativeInteger(frame.eval_count);
  if ((inputTokens === undefined) !== (outputTokens === undefined)) {
    throw failure("protocol", "Ollama returned invalid token usage.");
  }
  if (inputTokens !== undefined && outputTokens !== undefined) {
    state.usage = { inputTokens, outputTokens };
    input.onEvent?.({ kind: "usage", inputTokens, outputTokens });
  }
  if (frame.done_reason !== undefined) {
    const doneReason = boundedString(frame.done_reason, 128);
    if (doneReason === undefined)
      throw failure("protocol", "Ollama returned an invalid completion reason.");
    state.doneReason = doneReason;
  }
  state.done = true;
}

async function requestJson(
  endpoint: OllamaEndpoint,
  path: "version" | "tags" | "show",
  method: "GET" | "POST",
  body?: unknown,
): Promise<unknown> {
  const response = await request(endpoint, path, method, body);
  const bytes = await readBoundedBody(
    response,
    endpoint.limits.responseBodyBytes,
    endpoint.limits.requestTimeoutMs,
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure("protocol", "Ollama returned invalid JSON.");
  }
}

async function request(
  endpoint: OllamaEndpoint,
  path: "version" | "tags" | "show" | "chat",
  method: "GET" | "POST",
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) throw failure("interrupted", "The Ollama request was interrupted.");
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded !== undefined && Buffer.byteLength(encoded) > endpoint.limits.requestBodyBytes) {
    throw failure("invalid-configuration", "The Ollama request exceeded the size limit.");
  }
  const controller = new AbortController();
  let rejectAbort!: (reason: ProviderFailure) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort();
    rejectAbort(failure("interrupted", "The Ollama request was interrupted."));
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const fetchRequest = Promise.resolve().then(() =>
      endpoint.fetch(endpoint.url(path), {
        method,
        redirect: "manual",
        cache: "no-store",
        headers: {
          accept: "application/json",
          ...(encoded === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(encoded === undefined ? {} : { body: encoded }),
        signal: controller.signal,
      }),
    );
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(failure("unavailable", "The Ollama request timed out."));
      }, endpoint.limits.requestTimeoutMs);
    });
    const response = await Promise.race([fetchRequest, deadline, aborted]);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw failure("invalid-configuration", "The Ollama endpoint returned a redirect.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw failure(
        response.status === 404 ? "incompatible" : "provider-failed",
        `The Ollama request failed with HTTP ${response.status}.`,
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > endpoint.limits.responseBodyBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw failure("protocol", "The Ollama response exceeded the size limit.");
    }
    return response;
  } catch (error) {
    if (signal?.aborted) throw failure("interrupted", "The Ollama request was interrupted.");
    throw sanitizeFailure(error);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, undefined, deadline);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        throw failure("protocol", "The Ollama response exceeded the size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw sanitizeFailure(error);
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function* decodeNdjson(
  stream: ReadableStream<Uint8Array>,
  limits: OllamaHttpLimits,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  const deadline = Date.now() + limits.requestTimeoutMs;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal, deadline);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limits.responseBodyBytes) {
        throw failure("protocol", "The Ollama stream exceeded the response size limit.");
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (Buffer.byteLength(line) > limits.frameBytes) {
          throw failure("protocol", "An Ollama stream frame exceeded the size limit.");
        }
        if (line.length > 0) yield line;
      }
      if (Buffer.byteLength(buffer) > limits.frameBytes) {
        throw failure("protocol", "An Ollama stream frame exceeded the size limit.");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0)
      throw failure("protocol", "Ollama ended with an incomplete NDJSON frame.");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw sanitizeFailure(error);
  } finally {
    reader.releaseLock();
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (signal?.aborted) throw failure("interrupted", "The Ollama request was interrupted.");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw failure("unavailable", "The Ollama response timed out.");

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(failure("interrupted", "The Ollama request was interrupted."));
    signal?.addEventListener("abort", abort, { once: true });
  });
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(failure("unavailable", "The Ollama response timed out.")),
      remaining,
    );
  });
  try {
    return await Promise.race([reader.read(), interrupted, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
  }
}

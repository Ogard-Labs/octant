import {
  decodeProviderFailure,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderFailure,
  type ProviderModel,
  type ProviderReadiness,
} from "@octant/contracts";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { textOnlyInputModalities } from "@octant/provider-sdk/chat-conformance";

const MAX_RETRY_AFTER_MS = 3_600_000;
const DEFAULT_LIMITS: CompatibleHttpLimits = {
  connectionTimeoutMs: 10_000,
  requestBodyBytes: 1_048_576,
  responseBodyBytes: 1_048_576,
  streamIdleTimeoutMs: 30_000,
};

export interface CompatibleHttpLimits {
  readonly connectionTimeoutMs: number;
  readonly requestBodyBytes: number;
  readonly responseBodyBytes: number;
  readonly streamIdleTimeoutMs: number;
}

export type OpenAiCompatibleAuthStrategy = "bearer" | "api-key" | "none";

export interface OpenAiCompatibleEndpointOptions {
  readonly instanceId: string;
  readonly configuration: OpenAiCompatibleProviderConfiguration;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: CompatibleFetch;
  readonly limits?: Partial<CompatibleHttpLimits>;
  /**
   * Credential header strategy. Defaults to the OpenAI-compatible
   * configuration's authentication mode. Azure AI Foundry reuses this wire
   * adapter with `api-key` so it sends the documented `api-key` header instead
   * of `Authorization: Bearer` without forking the shared endpoint.
   */
  readonly authStrategy?: OpenAiCompatibleAuthStrategy;
}

export interface OpenAiCompatibleEndpoint {
  readonly instanceId: string;
  readonly configuration: OpenAiCompatibleProviderConfiguration;
  readonly authStrategy: OpenAiCompatibleAuthStrategy;
  readonly fetch: CompatibleFetch;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly limits: CompatibleHttpLimits;
  readonly url: (path: CompatibleEndpointPath) => string;
}

/**
 * The paths one OpenAI-compatible base URL serves. Speech and image
 * generation both ride the same instance as chat: `/audio/*` and
 * `/images/*` resolve against the same base URL with the same credential and
 * endpoint policy, so neither capability ever needs a second URL a person
 * could point somewhere else (`docs/decisions/0084`, `docs/decisions/0085`).
 */
export type CompatibleEndpointPath =
  | "models"
  | "responses"
  | "chat/completions"
  | "audio/transcriptions"
  | "audio/speech"
  | "images/generations"
  | "images/edits";

export type CompatibleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CompatibleProbeResult {
  readonly readiness: ProviderReadiness;
  readonly models: readonly ProviderModel[];
  readonly failure?: ProviderFailure;
}

export interface CompatibleGenerationRequest {
  readonly path: "responses" | "chat/completions";
  readonly body: unknown;
  readonly signal?: AbortSignal;
  readonly classifyRejectedResponse?: (response: Response) => Promise<ProviderFailure | undefined>;
  readonly onRejected?: (metadata: CompatibleGenerationRejection) => void;
}

export interface CompatibleGenerationRejection {
  readonly httpStatus: number;
  readonly failure: ProviderFailure;
}

export function makeOpenAiCompatibleEndpoint(
  options: OpenAiCompatibleEndpointOptions,
): OpenAiCompatibleEndpoint {
  const baseUrl = options.configuration.baseUrl.replace(/\/+$/, "");
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
  assertPositiveLimit(limits.connectionTimeoutMs);
  assertPositiveLimit(limits.requestBodyBytes);
  assertPositiveLimit(limits.responseBodyBytes);
  assertPositiveLimit(limits.streamIdleTimeoutMs);
  const authStrategy: OpenAiCompatibleAuthStrategy =
    options.authStrategy ?? options.configuration.authentication;
  return Object.freeze({
    instanceId: options.instanceId,
    configuration: options.configuration,
    authStrategy,
    fetch: options.fetch ?? globalThis.fetch,
    ...(options.credentialResolver === undefined
      ? {}
      : { credentialResolver: options.credentialResolver }),
    limits,
    url: (path: CompatibleEndpointPath) => `${baseUrl}/${path}`,
  });
}

export async function probeModels(
  endpoint: OpenAiCompatibleEndpoint,
  signal?: AbortSignal,
): Promise<CompatibleProbeResult> {
  const response = await performRequest(endpoint, endpoint.url("models"), {
    method: "GET",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const failure = classifyCompatibleHttpFailure(response);
    await cancelResponseBody(response);
    if (failure.category === "unsupported") {
      const models = manualModels(endpoint.configuration.manualModelIds);
      return {
        readiness: models.length === 0 ? "unavailable" : "degraded",
        models,
        failure,
      };
    }
    throw failure;
  }

  const value = await readJson(response);
  if (!isStrictModelList(value)) {
    throw fail("protocol", "The provider returned an invalid models response.");
  }
  const discoveredIds = new Set(value.data.map(({ id }) => id));
  const models: ProviderModel[] = [...discoveredIds].map(discoveredModel);
  for (const id of endpoint.configuration.manualModelIds) {
    if (!discoveredIds.has(id)) models.push(manualModel(id));
  }
  return { readiness: "ready", models };
}

export async function requestGeneration(
  endpoint: OpenAiCompatibleEndpoint,
  request: CompatibleGenerationRequest,
): Promise<Response> {
  const body = JSON.stringify(request.body);
  if (body === undefined) {
    throw fail("invalid-configuration", "The provider request could not be encoded.");
  }
  if (Buffer.byteLength(body, "utf8") > endpoint.limits.requestBodyBytes) {
    throw fail("invalid-configuration", "The provider request exceeded the configured size limit.");
  }
  const response = await performRequest(endpoint, endpoint.url(request.path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (!response.ok) {
    let failure = classifyCompatibleHttpFailure(response);
    if (request.classifyRejectedResponse !== undefined) {
      try {
        failure = (await request.classifyRejectedResponse(response)) ?? failure;
      } catch (error) {
        if (isProviderFailure(error)) failure = error;
      }
    }
    failure = sanitizeCompatibleFailure(failure);
    try {
      request.onRejected?.({ httpStatus: response.status, failure });
    } catch {
      // Rejection observation cannot replace the sanitized provider failure.
    }
    await cancelResponseBody(response);
    throw failure;
  }
  return response;
}

export function classifyCompatibleHttpFailure(
  response: Response,
  now = Date.now(),
): ProviderFailure {
  switch (response.status) {
    case 401:
      return fail("unauthenticated", "The provider rejected the configured credential.");
    case 403:
      return fail("unauthorized", "The provider denied this request.");
    case 404:
    case 405:
    case 501:
      return fail("unsupported", "The provider does not support this endpoint.");
    case 408:
    case 504:
      return fail("unavailable", "The provider request timed out.");
    case 429: {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now);
      return {
        category: "rate-limited",
        message: "The provider rate limit was reached.",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    default:
      return fail("provider-failed", `The provider request failed with HTTP ${response.status}.`);
  }
}

/**
 * One authenticated, deadline-bounded request against the endpoint for a
 * caller that builds its own body — multipart audio, or JSON whose response
 * is bytes rather than a stream of events. Rejections are returned, not
 * thrown, because what a non-2xx means differs per route.
 */
export function performCompatibleRequest(
  endpoint: OpenAiCompatibleEndpoint,
  path: CompatibleEndpointPath,
  init: RequestInit,
): Promise<Response> {
  return performRequest(endpoint, endpoint.url(path), init);
}

export function markCompatibleModelVerified(
  models: readonly ProviderModel[],
  modelId: string,
): readonly ProviderModel[] {
  return models.map(
    (model): ProviderModel =>
      model.id === modelId && model.source === "manual" && model.verification === "unverified"
        ? { ...model, verification: "verified" }
        : model,
  );
}

async function performRequest(
  endpoint: OpenAiCompatibleEndpoint,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const callerSignal = init.signal;
  if (isAborted(callerSignal)) throw interrupted();
  const deadline = makeRequestDeadline(callerSignal, endpoint.limits.connectionTimeoutMs);

  try {
    const headers = new Headers(init.headers);
    if (endpoint.authStrategy !== "none") {
      let credential: string;
      try {
        const resolution = Promise.resolve().then(
          async () => (await endpoint.credentialResolver?.resolve(endpoint.instanceId)) ?? "",
        );
        credential = await Promise.race([resolution, deadline.failure]);
      } catch (error) {
        if (isProviderFailure(error)) throw error;
        throw fail("unauthenticated", "The provider credential is missing or unavailable.");
      }
      if (credential.length === 0) {
        throw fail("unauthenticated", "The provider credential is missing or unavailable.");
      }
      if (endpoint.authStrategy === "api-key") {
        // Azure AI Foundry documents the `api-key` header for its OpenAI v1
        // endpoint. Reusing the shared adapter with this strategy keeps a
        // single wire path for both bearer and Foundry api-key credentials.
        headers.set("api-key", credential);
      } else {
        headers.set("authorization", `Bearer ${credential}`);
      }
    }
    let response: Response;
    try {
      const fetchRequest = Promise.resolve().then(async () =>
        endpoint.fetch(url, {
          ...init,
          headers: Object.fromEntries(headers),
          redirect: "manual",
          signal: deadline.signal,
        }),
      );
      const outcome = await Promise.race([
        fetchRequest.then(
          (value) => ({ kind: "response", value }) as const,
          (error: unknown) => ({ kind: "fetch-failure", error }) as const,
        ),
        deadline.failure.catch(
          (failure: ProviderFailure) => ({ kind: "deadline-failure", failure }) as const,
        ),
      ]);
      if (outcome.kind === "deadline-failure") {
        safelyCancelLateResponse(fetchRequest);
        throw outcome.failure;
      }
      if (outcome.kind === "fetch-failure") throw outcome.error;
      response = outcome.value;
    } catch (error) {
      if (isProviderFailure(error)) throw error;
      if (isAborted(callerSignal)) throw interrupted();
      throw fail("unavailable", "The provider endpoint could not be reached.");
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw fail("invalid-configuration", "The configured endpoint returned a redirect.");
    }
    return boundResponse(response, endpoint.limits, callerSignal);
  } finally {
    deadline.close();
  }
}

function boundResponse(
  response: Response,
  limits: CompatibleHttpLimits,
  signal: AbortSignal | null | undefined,
): Response {
  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > limits.responseBodyBytes) {
    safelyCancel(response.body);
    throw fail("protocol", "The provider response exceeded the configured size limit.");
  }
  if (response.body === null) return response;

  const reader = response.body.getReader();
  let bytesRead = 0;
  let terminated = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => signal?.removeEventListener("abort", abort);
  const abort = () => {
    if (terminated) return;
    terminated = true;
    void reader.cancel().catch(() => undefined);
    streamController?.error(interrupted());
    cleanup();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      signal?.addEventListener("abort", abort, { once: true });
      if (isAborted(signal)) abort();
    },
    async pull(controller) {
      if (terminated) return;
      try {
        const result = await readWithIdleTimeout(reader, limits.streamIdleTimeoutMs);
        if (terminated) return;
        if (result.done) {
          terminated = true;
          cleanup();
          controller.close();
          return;
        }
        bytesRead += result.value.byteLength;
        if (bytesRead > limits.responseBodyBytes) {
          terminated = true;
          cleanup();
          await reader.cancel();
          controller.error(
            fail("protocol", "The provider response exceeded the configured size limit."),
          );
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        if (terminated) return;
        terminated = true;
        cleanup();
        await reader.cancel().catch(() => undefined);
        controller.error(
          isProviderFailure(error)
            ? error
            : fail("unavailable", "The provider response stream timed out."),
        );
      }
    },
    cancel(reason) {
      terminated = true;
      cleanup();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(fail("unavailable", "The provider response stream timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch (error) {
    if (isProviderFailure(error)) throw error;
    throw fail("protocol", "The provider returned an invalid models response.");
  }
}

function isStrictModelList(
  value: unknown,
): value is { readonly data: Array<{ readonly id: string }> } {
  // Accept the standard OpenAI model-list shape `{ object: "list", data: [...] }`
  // (and Azure AI Foundry's equivalent) without rejecting extra top-level or
  // per-entry metadata fields. Only the required `data` array and string `id`
  // fields are validated so real provider responses parse alongside the
  // minimal fixture shape used in tests.
  if (typeof value !== "object" || value === null) return false;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return false;
  return data.every(
    (model) =>
      typeof model === "object" &&
      model !== null &&
      typeof (model as { id?: unknown }).id === "string" &&
      (model as { id: string }).id.length > 0 &&
      (model as { id: string }).id === (model as { id: string }).id.trim(),
  );
}

function manualModels(ids: readonly string[]): ProviderModel[] {
  return ids.map(manualModel);
}

function manualModel(id: string): ProviderModel {
  return {
    id: id as ProviderModel["id"],
    displayName: id,
    source: "manual",
    verification: "unverified",
    reasoning: "unavailable",
    inputModalities: textOnlyInputModalities,
    options: [],
  };
}

function discoveredModel(id: string): ProviderModel {
  return {
    id: id as ProviderModel["id"],
    displayName: id,
    source: "discovered",
    verification: "verified",
    reasoning: "unavailable",
    inputModalities: textOnlyInputModalities,
    options: [],
  };
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  const delay = retryAt - now;
  return delay <= 0 ? undefined : Math.min(delay, MAX_RETRY_AFTER_MS);
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

interface RequestDeadline {
  readonly signal: AbortSignal;
  readonly failure: Promise<never>;
  readonly close: () => void;
}

function makeRequestDeadline(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): RequestDeadline {
  const controller = new AbortController();
  let closed = false;
  let rejectFailure: (failure: ProviderFailure) => void = () => undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const abort = (reason: ProviderFailure) => {
    if (closed) return;
    closed = true;
    rejectFailure(reason);
    controller.abort();
  };
  const abortFromCaller = () => abort(interrupted());
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => abort(fail("unavailable", "The provider request timed out.")),
    timeoutMs,
  );
  if (isAborted(callerSignal)) abortFromCaller();

  return {
    signal: controller.signal,
    failure,
    close: () => {
      closed = true;
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation cleanup must not replace the sanitized provider failure.
  }
}

function safelyCancelLateResponse(fetchRequest: Promise<Response>): void {
  void fetchRequest
    .then(
      (response) => cancelResponseBody(response),
      () => undefined,
    )
    .catch(() => undefined);
}

function safelyCancel(body: ReadableStream<Uint8Array> | null): void {
  if (body !== null) void body.cancel().catch(() => undefined);
}

function assertPositiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Compatible HTTP limits must be positive integers.");
  }
}

function interrupted(): ProviderFailure {
  return fail("interrupted", "The provider request was cancelled.");
}

function fail(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

export function isProviderFailure(error: unknown): error is ProviderFailure {
  return typeof error === "object" && error !== null && "category" in error && "message" in error;
}

export function sanitizeCompatibleFailure(error: unknown): ProviderFailure {
  try {
    const decoded = decodeProviderFailure(error);
    return {
      category: decoded.category,
      message: decoded.message,
      ...(decoded.retryAfterMs === undefined ? {} : { retryAfterMs: decoded.retryAfterMs }),
    };
  } catch {
    return fail("provider-failed", "The provider request failed.");
  }
}

function isAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted ?? false;
}

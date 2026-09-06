import { decodeProviderFailure, type ProviderFailure } from "@octant/contracts";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";

const MAX_RETRY_AFTER_MS = 3_600_000;

export const OPENAI_IMAGE_API_BASE_URL = "https://api.openai.com/v1";
export const GEMINI_IMAGE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const BFL_IMAGE_API_BASE_URL = "https://api.bfl.ai";

/**
 * How a provider's credential becomes a request header. A plain union of
 * string literals stopped scaling once BFL's raw `x-key` header (no scheme
 * prefix) joined `Authorization: Bearer` and `x-goog-api-key`: this
 * descriptor lets `performImageHttpRequest` build any of them generically
 * instead of growing another hardcoded literal and if-branch per vendor.
 */
export type ImageHttpAuth =
  | { readonly header: "authorization"; readonly scheme: "Bearer" }
  | { readonly header: "x-goog-api-key" }
  | { readonly header: "x-key" };

export type ImageHttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ImageHttpLimits {
  readonly connectionTimeoutMs: number;
  readonly requestBodyBytes: number;
  readonly responseBodyBytes: number;
}

export interface ImageHttpRequest {
  readonly url: string;
  readonly method: "POST" | "GET";
  readonly auth: ImageHttpAuth;
  readonly instanceId: string;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly form?: FormData;
  readonly signal?: AbortSignal;
  readonly fetch: ImageHttpFetch;
  readonly limits: ImageHttpLimits;
}

export async function performImageHttpRequest(request: ImageHttpRequest): Promise<Response> {
  if (isAborted(request.signal)) throw interrupted();
  const deadline = makeRequestDeadline(request.signal, request.limits.connectionTimeoutMs);
  try {
    const headers = new Headers(request.headers);
    let credential: string;
    try {
      const resolution = Promise.resolve().then(() =>
        request.credentialResolver.resolve(request.instanceId),
      );
      credential = await Promise.race([resolution, deadline.failure]);
    } catch (error) {
      if (isProviderFailure(error)) throw error;
      throw fail("unauthenticated", "The provider credential is missing or unavailable.");
    }
    if (credential.length === 0) {
      throw fail("unauthenticated", "The provider credential is missing or unavailable.");
    }
    if ("scheme" in request.auth) {
      headers.set(request.auth.header, `${request.auth.scheme} ${credential}`);
    } else {
      headers.set(request.auth.header, credential);
    }

    if (request.body !== undefined) {
      if (Buffer.byteLength(request.body, "utf8") > request.limits.requestBodyBytes) {
        throw fail(
          "invalid-configuration",
          "The provider request exceeded the configured size limit.",
        );
      }
      headers.set("content-type", "application/json");
    }
    if (
      request.form !== undefined &&
      formPayloadBytes(request.form) > request.limits.requestBodyBytes
    ) {
      throw fail(
        "invalid-configuration",
        "The provider request exceeded the configured size limit.",
      );
    }

    let response: Response;
    try {
      const fetchRequest = Promise.resolve().then(async () =>
        request.fetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(headers),
          redirect: "manual",
          signal: deadline.signal,
          ...(request.body === undefined ? {} : { body: request.body }),
          ...(request.form === undefined ? {} : { body: request.form }),
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
      if (isAborted(request.signal)) throw interrupted();
      throw fail("unavailable", "The provider endpoint could not be reached.");
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw fail("invalid-configuration", "The configured endpoint returned a redirect.");
    }
    return boundResponse(response, request.limits, request.signal);
  } finally {
    deadline.close();
  }
}

/**
 * The one bounded exception to "reject URL forms" (`docs/decisions/0086`): a
 * single GET to a URL a provider's own just-completed authenticated call
 * returned (BFL's `result.sample`, and Ideogram's equivalent next). No
 * redirects, the same size and time bounds as any other image fetch, and the
 * URL itself never outlives this call — callers must not log or store it.
 */
export async function fetchApprovedImageUrl(input: {
  readonly url: string;
  readonly fetch: ImageHttpFetch;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly bytes: Uint8Array } | { readonly failure: ProviderFailure }> {
  if (isAborted(input.signal)) return { failure: interrupted() };
  const deadline = makeRequestDeadline(input.signal, input.timeoutMs);
  try {
    let response: Response;
    try {
      const fetchRequest = Promise.resolve().then(async () =>
        input.fetch(input.url, {
          method: "GET",
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
      if (isAborted(input.signal)) throw interrupted();
      throw fail("unavailable", "The provider image could not be reached.");
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw fail("protocol", "The provider's approved image URL returned a redirect.");
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw fail(
        "provider-failed",
        `The provider image fetch failed with HTTP ${response.status}.`,
      );
    }
    const bounded = boundResponse(
      response,
      {
        connectionTimeoutMs: input.timeoutMs,
        requestBodyBytes: 0,
        responseBodyBytes: input.maxBytes,
      },
      input.signal,
    );
    const bytes = new Uint8Array(await bounded.arrayBuffer());
    return { bytes };
  } catch (error) {
    return {
      failure: isProviderFailure(error)
        ? error
        : fail("provider-failed", "The provider image fetch failed."),
    };
  } finally {
    deadline.close();
  }
}

export function classifyImageHttpFailure(response: Response, now = Date.now()): ProviderFailure {
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

export function sanitizeImageFailure(error: unknown): ProviderFailure {
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

export function isProviderFailure(error: unknown): error is ProviderFailure {
  return typeof error === "object" && error !== null && "category" in error && "message" in error;
}

export function fail(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

export function interrupted(): ProviderFailure {
  return fail("interrupted", "The provider request was cancelled.");
}

export async function readImageJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch (error) {
    if (isProviderFailure(error)) throw error;
    throw fail("protocol", "The provider returned an invalid image response.");
  }
}

function boundResponse(
  response: Response,
  limits: ImageHttpLimits,
  signal: AbortSignal | undefined,
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
        const result = await reader.read();
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

interface RequestDeadline {
  readonly signal: AbortSignal;
  readonly failure: Promise<never>;
  readonly close: () => void;
}

function makeRequestDeadline(
  callerSignal: AbortSignal | undefined,
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

async function cancelResponseBody(response: Response): Promise<void> {
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

export function parseRetryAfter(value: string | null, now: number): number | undefined {
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

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function formPayloadBytes(form: FormData): number {
  let total = 0;
  for (const value of form.values()) {
    const entry: unknown = value;
    if (typeof entry === "string") {
      total += Buffer.byteLength(entry, "utf8");
    } else if (isFormBlob(entry)) {
      total += entry.size;
    }
  }
  return total;
}

function isFormBlob(value: unknown): value is Blob {
  if (typeof value !== "object" || value === null || !("size" in value)) return false;
  return typeof value.size === "number";
}

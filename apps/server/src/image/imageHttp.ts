import {
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_VARIANTS,
  type ProviderFailure,
} from "@octant/contracts";
import {
  imageFailure,
  imageInterrupted,
  isImageEndpointAllowed,
  isProviderFailure,
  type ApprovedImageFetch,
  type ImageGenerationEndpoint,
  type ImageGenerationPorts,
  type ImageHttpAuth,
} from "@octant/provider-sdk/image-generation";
import type {
  ProviderCredentialLease,
  ProviderCredentialResolver,
} from "../providers/credentialBrokerClient";
import { acquireProviderCredential, reportKeyRejection } from "../providers/providerApiKeyPool";
import { sniffGeneratedImageMediaType } from "./generatedImageStore";

export type ImageHttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ImageHttpLimits {
  readonly connectionTimeoutMs: number;
  readonly requestBodyBytes: number;
  readonly responseBodyBytes: number;
}

interface AuthenticatedImageHttpRequest {
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

export async function performImageHttpRequest(
  request: AuthenticatedImageHttpRequest,
): Promise<Response> {
  if (isAborted(request.signal)) throw imageInterrupted();
  const deadline = makeRequestDeadline(request.signal, request.limits.connectionTimeoutMs);
  const attempt: { lease?: ProviderCredentialLease | undefined } = {};
  try {
    const headers = new Headers(request.headers);
    let credential: string;
    try {
      const resolution = Promise.resolve().then(async () => {
        const acquired = await acquireProviderCredential(
          request.credentialResolver,
          request.instanceId,
        );
        attempt.lease = acquired.lease;
        return acquired.credential;
      });
      credential = await Promise.race([resolution, deadline.failure]);
    } catch (error) {
      if (isProviderFailure(error)) throw error;
      throw imageFailure("unauthenticated", "The provider credential is missing or unavailable.");
    }
    if (credential.length === 0) {
      throw imageFailure("unauthenticated", "The provider credential is missing or unavailable.");
    }
    if ("scheme" in request.auth) {
      headers.set(request.auth.header, `${request.auth.scheme} ${credential}`);
    } else {
      headers.set(request.auth.header, credential);
    }

    if (request.body !== undefined) {
      if (Buffer.byteLength(request.body, "utf8") > request.limits.requestBodyBytes) {
        throw imageFailure(
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
      throw imageFailure(
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
      if (isAborted(request.signal)) throw imageInterrupted();
      throw imageFailure("unavailable", "The provider endpoint could not be reached.");
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw imageFailure("invalid-configuration", "The configured endpoint returned a redirect.");
    }
    await reportKeyRejection(attempt.lease, response);
    return boundResponse(response, request.limits, request.signal);
  } finally {
    deadline.close();
  }
}

/**
 * The host's bounds for one image call when an adapter names none: room for
 * every variant at the stored-image ceiling plus a JSON envelope. Providers
 * that answer inline send base64, which expands bytes by 4/3, so the
 * response bound allows that expansion or a valid maximal answer would be
 * cut off before the adapter decodes it.
 */
export const IMAGE_HTTP_DEFAULT_LIMITS: ImageHttpLimits = {
  connectionTimeoutMs: 120_000,
  requestBodyBytes: MAX_GENERATED_IMAGE_BYTES * 2,
  responseBodyBytes: 4 * Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * MAX_IMAGE_VARIANTS + 262_144,
};

/**
 * The ports one image profile's adapter receives through the provider-sdk
 * image seam. The credential resolver, key pool, fetch, and limits stay
 * here; the adapter only names the header its provider reads.
 */
export function makeImageGenerationPorts(options: {
  readonly instanceId: string;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly endpoint: ImageGenerationEndpoint;
  readonly fetch?: ImageHttpFetch;
  readonly limits?: Partial<ImageHttpLimits>;
}): ImageGenerationPorts {
  const fetch = options.fetch ?? globalThis.fetch;
  const limits: ImageHttpLimits = { ...IMAGE_HTTP_DEFAULT_LIMITS, ...options.limits };
  return {
    request: async (request) => {
      // Checked before any credential is read: a driver chooses the URL, so
      // the host decides where the profile's key may go.
      if (!isImageEndpointAllowed(request.url, options.endpoint)) {
        throw imageFailure(
          "unauthorized",
          "The image provider asked to send its credential outside its own endpoint.",
        );
      }
      return performImageHttpRequest({
        ...request,
        instanceId: options.instanceId,
        credentialResolver: options.credentialResolver,
        fetch,
        limits,
      });
    },
    fetchApprovedImageUrl: (input) =>
      fetchApprovedImageUrl({
        url: input.url,
        fetch,
        maxBytes: MAX_GENERATED_IMAGE_BYTES,
        timeoutMs: limits.connectionTimeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    sniffMediaType: sniffGeneratedImageMediaType,
  };
}

/**
 * The one bounded exception to "reject URL forms": a
 * single GET to a URL a provider's own just-completed authenticated call
 * returned (BFL's `result.sample`, and Ideogram's `data[].url`). No
 * redirects, the same size and time bounds as any other image fetch, and the
 * URL itself never outlives this call — callers must not log or store it.
 */
export async function fetchApprovedImageUrl(input: {
  readonly url: string;
  readonly fetch: ImageHttpFetch;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ApprovedImageFetch> {
  if (isAborted(input.signal)) return { failure: imageInterrupted() };
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
      if (isAborted(input.signal)) throw imageInterrupted();
      throw imageFailure("unavailable", "The provider image could not be reached.");
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw imageFailure("protocol", "The provider's approved image URL returned a redirect.");
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw imageFailure(
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
        : imageFailure("provider-failed", "The provider image fetch failed."),
    };
  } finally {
    deadline.close();
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
    throw imageFailure("protocol", "The provider response exceeded the configured size limit.");
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
    streamController?.error(imageInterrupted());
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
            imageFailure("protocol", "The provider response exceeded the configured size limit."),
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
            : imageFailure("unavailable", "The provider response stream timed out."),
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
  const abortFromCaller = () => abort(imageInterrupted());
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => abort(imageFailure("unavailable", "The provider request timed out.")),
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

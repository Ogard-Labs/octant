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
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isPublicNetworkAddress } from "@octant/domain/network-address-policy";
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
  // Video drivers also cancel (PUT, POST) and delete (DELETE) provider jobs.
  readonly method: "POST" | "GET" | "PUT" | "DELETE";
  readonly auth: ImageHttpAuth;
  readonly instanceId: string;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly form?: FormData;
  readonly signal?: AbortSignal;
  readonly preserveResponseOnAbort?: (response: Response) => boolean;
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
    if (!response.ok && attempt.lease !== undefined) {
      const expired = await Promise.race([
        reportKeyRejection(attempt.lease, response, deadline.signal).then(() => undefined),
        deadline.failure.catch((failure: ProviderFailure) => failure),
      ]);
      if (expired !== undefined) {
        // The deadline releases the pool's clone. Release the original too.
        safelyCancel(response.body);
        if (
          expired.category === "interrupted" &&
          request.preserveResponseOnAbort?.(response) !== true
        ) {
          throw expired;
        }
        // The provider already answered. Preserve its refusal and retry
        // metadata when only the optional error text timed out.
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    }
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
  /**
   * The transport for the one unauthenticated approved-image GET. The job
   * service always passes the pinned transport here; absent, a supplied
   * `fetch` is used (a test's own), else the pinned transport, which allows a
   * private address only on the profile's own configured base URL origin.
   */
  readonly approvedFetch?: ImageHttpFetch;
  readonly limits?: Partial<ImageHttpLimits>;
}): ImageGenerationPorts {
  const fetch = options.fetch ?? globalThis.fetch;
  const allowedOrigin = configuredOrigin(options.endpoint.baseUrl);
  const approvedFetch =
    options.approvedFetch ??
    options.fetch ??
    makePinnedImageFetch(allowedOrigin === undefined ? {} : { allowedOrigin });
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
        fetch: approvedFetch,
        maxBytes: MAX_GENERATED_IMAGE_BYTES,
        timeoutMs: limits.connectionTimeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    sniffMediaType: sniffGeneratedImageMediaType,
  };
}

function configuredOrigin(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}

async function resolveAllAddresses(hostname: string): Promise<ReadonlyArray<string>> {
  return (await lookup(hostname, { all: true })).map((entry) => entry.address);
}

/**
 * The transport for an approved image download: it connects only to an
 * address it has just checked. A name resolved once for a check and again by
 * the fetch could answer a public address and then a private one (DNS
 * rebinding); here the one resolution that is checked is the one the socket
 * connects to, through `node:http`'s `lookup`, and the original name still
 * reaches the server as `Host` and, over HTTPS, as the TLS server name the
 * certificate is verified against. Every address must be publicly routable,
 * except on `allowedOrigin`, the profile's own configured base URL, which the
 * person chose and may be on this computer. It follows no redirect: a
 * redirect is answered as the response it is, which the caller refuses, so
 * every hop is this one.
 */
export function makePinnedImageFetch(
  options: {
    readonly allowedOrigin?: string;
    readonly resolveAll?: (hostname: string) => Promise<ReadonlyArray<string>>;
  } = {},
): ImageHttpFetch {
  const resolveAll = options.resolveAll ?? resolveAllAddresses;
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const secure = url.protocol === "https:";
      if (!secure && url.protocol !== "http:") {
        reject(new Error("The approved image address is not HTTP or HTTPS."));
        return;
      }
      const mayBePrivate =
        options.allowedOrigin !== undefined && url.origin === options.allowedOrigin;
      const host = url.hostname.replace(/^\[|\]$/g, "");
      // `node:http` connects to a literal address without calling `lookup`.
      if (isIP(host) !== 0 && !mayBePrivate && !isPublicNetworkAddress(host)) {
        reject(new Error("The approved image address is on a private network."));
        return;
      }
      const pinnedLookup = (
        hostname: string,
        lookupOptions: { readonly all?: boolean } | undefined,
        callback: (
          error: Error | null,
          address?: string | ReadonlyArray<{ readonly address: string; readonly family: number }>,
          family?: number,
        ) => void,
      ) => {
        resolveAll(hostname).then(
          (addresses) => {
            if (addresses.length === 0) {
              callback(new Error("The approved image address does not resolve."));
              return;
            }
            if (!mayBePrivate && !addresses.every((address) => isPublicNetworkAddress(address))) {
              callback(new Error("The approved image address resolves to a private network."));
              return;
            }
            const entries = addresses.map((address) => ({ address, family: isIP(address) }));
            if (lookupOptions?.all === true) callback(null, entries);
            else callback(null, entries[0]?.address, entries[0]?.family);
          },
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      };
      const request = (secure ? httpsRequest : httpRequest)(
        {
          host,
          port: url.port.length > 0 ? Number(url.port) : secure ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { host: url.host },
          // A fresh connection each time: a pooled socket opened for an
          // earlier answer would skip this lookup and its check.
          agent: false,
          lookup: pinnedLookup as never,
          ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
          ...(secure ? { servername: host } : {}),
        },
        (incoming) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (typeof value === "string") headers.set(name, value);
            else if (Array.isArray(value)) headers.set(name, value.join(", "));
          }
          const status = incoming.statusCode ?? 502;
          const nullBody = status === 204 || status === 205 || status === 304;
          if (nullBody) incoming.resume();
          const chunks = nullBody ? undefined : incoming[Symbol.asyncIterator]();
          const body =
            chunks === undefined
              ? null
              : new ReadableStream<Uint8Array>({
                  async pull(controller) {
                    const next: IteratorResult<unknown> = await chunks.next();
                    if (next.done === true) {
                      controller.close();
                      return;
                    }
                    controller.enqueue(
                      next.value instanceof Uint8Array
                        ? next.value
                        : new TextEncoder().encode(String(next.value)),
                    );
                  },
                  cancel() {
                    incoming.destroy();
                  },
                });
          try {
            resolve(new Response(body, { status, headers }));
          } catch (error) {
            incoming.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
      request.on("error", reject);
      request.end();
    });
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

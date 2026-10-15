import {
  decodeProviderFailure,
  type GeminiImageAspectRatio,
  type GeminiImageResolution,
  type ImageArtifactMediaType,
  type OpenAiImageQuality,
  type OpenAiImageSize,
  type ProviderDriverKind,
  type ProviderFailure,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";

const MAX_RETRY_AFTER_MS = 3_600_000;

export interface ImageAdapterReference {
  readonly bytes: Uint8Array;
  readonly mediaType: ImageArtifactMediaType;
}

export interface ImageAdapterUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly size?: string;
  readonly outputQuality?: string;
}

export interface ImageAdapterImage {
  readonly bytes: Uint8Array;
  readonly mediaType: ImageArtifactMediaType;
}

export type ImageAdapterResult =
  | {
      readonly status: "completed";
      readonly images: ReadonlyArray<ImageAdapterImage>;
      readonly usage?: ImageAdapterUsage;
    }
  | { readonly status: "refused"; readonly safetyRefusal: string }
  | { readonly status: "failed"; readonly providerFailure: ProviderFailure };

export interface ImageAdapterRequest {
  readonly instanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly prompt: string;
  readonly references?: ReadonlyArray<ImageAdapterReference>;
  readonly quality?: OpenAiImageQuality;
  readonly size?: OpenAiImageSize;
  readonly aspectRatio?: GeminiImageAspectRatio;
  readonly resolution?: GeminiImageResolution;
  readonly variantCount?: number;
  readonly signal?: AbortSignal;
}

/**
 * One image profile's generator. `generate` never rejects: every refusal and
 * failure is a result the image job records, so a broken adapter cannot leave
 * a job running.
 */
export interface ImageGenerationAdapter {
  generate(request: ImageAdapterRequest): Promise<ImageAdapterResult>;
}

/**
 * How the profile's credential becomes a request header. The adapter names
 * the header; the host reads the credential and sets it, so the adapter never
 * holds the secret or the credential store.
 */
export interface ImageHttpAuth {
  readonly header: string;
  readonly scheme?: "Bearer";
}

export interface ImageHttpRequest {
  readonly url: string;
  readonly method: "POST" | "GET";
  readonly auth: ImageHttpAuth;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly form?: FormData;
  readonly signal?: AbortSignal;
}

export type ApprovedImageFetch =
  | { readonly bytes: Uint8Array }
  | { readonly failure: ProviderFailure };

/**
 * The capabilities an image adapter receives instead of host internals. Each
 * one is scoped to the profile the host built it for.
 */
export interface ImageGenerationPorts {
  /**
   * One authenticated call to the provider. The host leases a key from the
   * profile's key pool, sets it as `auth` names, enforces the request and
   * response size and time limits, refuses redirects, and records a refused
   * key so the next attempt uses another. Rejects with a `ProviderFailure`
   * when the call cannot be made; an HTTP error status resolves normally.
   */
  readonly request: (request: ImageHttpRequest) => Promise<Response>;
  /**
   * The one bounded exception to "reject URL forms": a single unauthenticated
   * GET of a URL the provider's own just-completed authenticated call
   * returned. No redirects, the host's image size and time bounds, and the
   * URL must not be logged or stored.
   */
  readonly fetchApprovedImageUrl: (input: {
    readonly url: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApprovedImageFetch>;
  /** The media type the host accepts these bytes as, or `undefined` when it refuses them. */
  readonly sniffMediaType: (bytes: Uint8Array) => ImageArtifactMediaType | undefined;
}

export interface ImageGenerationDriverContext {
  readonly instance: ProviderInstance;
  readonly ports: ImageGenerationPorts;
}

/**
 * A bundled or third-party image provider as the image job service sees it:
 * the driver kind it serves and how to build an adapter for one profile from
 * the profile's configuration and the ports the host grants it.
 */
export interface ImageGenerationDriver {
  readonly driverKind: ProviderDriverKind;
  readonly create: (context: ImageGenerationDriverContext) => ImageGenerationAdapter;
}

export function imageFailure(
  category: ProviderFailure["category"],
  message: string,
): ProviderFailure {
  return { category, message };
}

export function imageInterrupted(): ProviderFailure {
  return imageFailure("interrupted", "The provider request was cancelled.");
}

export function isProviderFailure(error: unknown): error is ProviderFailure {
  return typeof error === "object" && error !== null && "category" in error && "message" in error;
}

/**
 * The failure an image job may record: a decodable category and message, and
 * nothing else the provider or adapter attached.
 */
export function sanitizeImageFailure(error: unknown): ProviderFailure {
  try {
    const decoded = decodeProviderFailure(error);
    return {
      category: decoded.category,
      message: decoded.message,
      ...(decoded.retryAfterMs === undefined ? {} : { retryAfterMs: decoded.retryAfterMs }),
    };
  } catch {
    return imageFailure("provider-failed", "The provider request failed.");
  }
}

export function classifyImageHttpFailure(response: Response, now = Date.now()): ProviderFailure {
  switch (response.status) {
    case 401:
      return imageFailure("unauthenticated", "The provider rejected the configured credential.");
    case 403:
      return imageFailure("unauthorized", "The provider denied this request.");
    case 404:
    case 405:
    case 501:
      return imageFailure("unsupported", "The provider does not support this endpoint.");
    case 408:
    case 504:
      return imageFailure("unavailable", "The provider request timed out.");
    case 429: {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now);
      return {
        category: "rate-limited",
        message: "The provider rate limit was reached.",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    default:
      return imageFailure(
        "provider-failed",
        `The provider request failed with HTTP ${response.status}.`,
      );
  }
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

export async function readImageJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch (error) {
    if (isProviderFailure(error)) throw error;
    throw imageFailure("protocol", "The provider returned an invalid image response.");
  }
}

import type { ProviderFailure, ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type {
  VideoClipOptions,
  VideoDriverKind,
  VideoModelCapabilities,
} from "@octant/contracts/video-generation";
import { checkVideoClipOptions } from "./videoGenerationPolicy";
import {
  imageFailure,
  isImageEndpointAllowed,
  isProviderFailure,
  parseRetryAfter,
  type ImageAdapterReference,
  type ImageHttpAuth,
} from "./imageGeneration";

/**
 * The video seam: what a video provider plugin implements and the
 * capabilities the host grants it. Drivers import only `@octant/contracts`
 * and this module, so a bundled driver and one from an outside package are
 * the same kind of value.
 */

export interface VideoAdapterRequest {
  readonly modelId: ProviderModelId;
  readonly prompt: string;
  readonly options: VideoClipOptions;
  readonly firstFrame?: ImageAdapterReference;
  readonly lastFrame?: ImageAdapterReference;
  readonly references: ReadonlyArray<ImageAdapterReference>;
  readonly signal: AbortSignal;
}

export interface VideoAdapterUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly billedSeconds?: number;
}

export interface VideoAdapterClip {
  readonly bytes: Uint8Array;
  readonly mediaType: "video/mp4";
}

export type VideoAdapterStart =
  | { readonly status: "started"; readonly remoteId: string }
  | { readonly status: "refused"; readonly safetyRefusal: string }
  | { readonly status: "failed"; readonly providerFailure: ProviderFailure };

export type VideoAdapterPoll =
  | { readonly status: "running" }
  | {
      readonly status: "completed";
      readonly video: VideoAdapterClip;
      readonly usage?: VideoAdapterUsage;
    }
  | { readonly status: "refused"; readonly safetyRefusal: string }
  | { readonly status: "failed"; readonly providerFailure: ProviderFailure }
  | { readonly status: "cancelled"; readonly usage?: VideoAdapterUsage };

export type VideoAdapterForget =
  | { readonly status: "removed" }
  | { readonly status: "failed"; readonly providerFailure: ProviderFailure };

/**
 * One video profile's generator. No method rejects: every refusal and
 * failure is a result the job records, so a broken adapter cannot leave a
 * job running.
 */
export interface VideoGenerationAdapter {
  /** The models this profile offers, each with what it declares about itself. */
  readonly models: () => Promise<ReadonlyArray<VideoModelCapabilities>>;
  readonly start: (request: VideoAdapterRequest) => Promise<VideoAdapterStart>;
  readonly poll: (remoteId: string, signal: AbortSignal) => Promise<VideoAdapterPoll>;
  /**
   * Asks the provider to stop, then reports the job's state with any usage it
   * states. Called only when the model declares it can cancel. A result still
   * `running` means the stop is not yet confirmed: the job service keeps
   * polling until a terminal state or the job time runs out.
   */
  readonly cancel: (remoteId: string) => Promise<VideoAdapterPoll>;
  /**
   * Removes the provider's stored copy. Called after every terminal state when
   * the model declares `removal: delete`; the job service retries a failure.
   */
  readonly forget: (remoteId: string) => Promise<VideoAdapterForget>;
}

export type VideoHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface VideoHttpRequest {
  readonly url: string;
  readonly method: VideoHttpMethod;
  readonly auth: ImageHttpAuth;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export type ApprovedVideoFetch =
  | { readonly bytes: Uint8Array }
  | { readonly failure: ProviderFailure };

/**
 * The capabilities a video adapter receives instead of host internals. Each
 * one is scoped to the profile the host built it for.
 */
export interface VideoGenerationPorts {
  /**
   * One authenticated call to the provider. The host refuses a URL outside
   * the driver's declared hosts before it reads any credential, leases a key
   * from the profile's key pool and sets it as `auth` names, enforces size and
   * time limits, and refuses redirects. Rejects with a `ProviderFailure` when
   * the call cannot be made; an HTTP error status resolves normally.
   */
  readonly request: (request: VideoHttpRequest) => Promise<Response>;
  /**
   * One unauthenticated GET of a download URL the provider's own
   * just-completed authenticated call returned. No redirects, the host's clip
   * size and time bounds, and the URL is never logged or stored.
   */
  readonly fetchApprovedVideoUrl: (input: {
    readonly url: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApprovedVideoFetch>;
  /** `"video/mp4"` when the host accepts these bytes as a clip, else `undefined`. */
  readonly sniffMediaType: (bytes: Uint8Array) => "video/mp4" | undefined;
}

/** The profile a driver builds an adapter for, as much as a driver needs of it. */
export interface VideoGenerationProfile {
  readonly instanceId: ProviderInstanceId;
  /** The model ids the person enabled on this profile. */
  readonly modelIds: ReadonlyArray<ProviderModelId>;
}

export interface VideoGenerationDriverContext {
  readonly profile: VideoGenerationProfile;
  readonly ports: VideoGenerationPorts;
}

/**
 * A bundled or third-party video provider as the job service sees it: the
 * kind it serves, the hosts its API answers on, and how to build an adapter
 * for one profile from the ports the host grants it.
 */
export interface VideoGenerationDriver {
  readonly driverKind: VideoDriverKind;
  /**
   * The hosts the provider's own API answers on, fixed in the driver.
   * `*.example.com` also matches every subdomain. The host sends the
   * profile's credential only to these, over HTTPS.
   */
  readonly providerHosts: ReadonlyArray<string>;
  readonly create: (context: VideoGenerationDriverContext) => VideoGenerationAdapter;
}

/** Whether an authenticated call may go to `url`: HTTPS to one of the driver's declared hosts. */
export function isVideoEndpointAllowed(url: string, providerHosts: ReadonlyArray<string>): boolean {
  return isImageEndpointAllowed(url, { providerHosts });
}

export function videoFailure(
  category: ProviderFailure["category"],
  message: string,
): ProviderFailure {
  return imageFailure(category, message);
}

export function videoInterrupted(): ProviderFailure {
  return videoFailure("interrupted", "The provider request was cancelled.");
}

/**
 * The refusal a driver returns before calling out when a request is outside
 * what its model declares, or `undefined` when it may proceed. Every driver
 * runs it, so a host bug cannot spend money on an option the model refuses.
 */
export function refuseOutsideDeclaration(
  capabilities: ReadonlyArray<VideoModelCapabilities>,
  request: VideoAdapterRequest,
): ProviderFailure | undefined {
  if (request.signal.aborted) return videoInterrupted();
  if (request.prompt.trim().length === 0) {
    return videoFailure("invalid-configuration", "The prompt is empty.");
  }
  const model = capabilities.find(
    (candidate) => String(candidate.modelId) === String(request.modelId),
  );
  if (model === undefined) {
    return videoFailure("invalid-configuration", "This profile does not offer that video model.");
  }
  const check = checkVideoClipOptions(model, request.options, {
    firstFrame: request.firstFrame !== undefined,
    lastFrame: request.lastFrame !== undefined,
    referenceCount: request.references.length,
  });
  return check.status === "refused"
    ? videoFailure("invalid-configuration", check.reason)
    : undefined;
}

export function classifyVideoHttpFailure(response: Response, now = Date.now()): ProviderFailure {
  switch (response.status) {
    case 401:
      return videoFailure("unauthenticated", "The provider rejected the configured credential.");
    case 402:
      return videoFailure(
        "unauthorized",
        "The provider account has no credit or billing for video. Check it with the provider.",
      );
    case 403:
      return videoFailure("unauthorized", "The provider denied this request.");
    case 404:
      return videoFailure(
        "unsupported",
        "The provider does not offer this video model or job. Check the model in Settings.",
      );
    case 400:
    case 422:
      return videoFailure(
        "provider-failed",
        `The provider rejected an option of this request (HTTP ${response.status}).`,
      );
    case 408:
    case 504:
      return videoFailure("unavailable", "The provider request timed out.");
    case 500:
    case 502:
    case 503:
    case 529:
      return videoFailure(
        "unavailable",
        `The provider is unavailable (HTTP ${response.status}). Try again shortly.`,
      );
    case 429: {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now);
      return {
        category: "rate-limited",
        message: "The provider rate limit was reached.",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    default:
      return videoFailure(
        "provider-failed",
        `The provider request failed with HTTP ${response.status}.`,
      );
  }
}

export async function readVideoJson(response: Response): Promise<unknown> {
  // A body that never finished reading is a transport break, not bad JSON:
  // typed as unavailable so the host retries it, while an invalid but fully
  // received body stays a protocol failure.
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isProviderFailure(error)) throw error;
    throw videoFailure("unavailable", "The provider response could not be read.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw videoFailure("protocol", "The provider returned an invalid video response.");
  }
}

/** Reads a nested field of untrusted JSON without casting. */
export function jsonField(value: unknown, ...path: ReadonlyArray<string>): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Whether a rejection is already a provider failure a job can record. */
export { isProviderFailure } from "./imageGeneration";

/** The failure a video job may record: a decodable category and message, and nothing else. */
export { sanitizeImageFailure as sanitizeVideoFailure } from "./imageGeneration";

/**
 * The pure option, default and pricing rules every driver and the host run,
 * kept in the seam itself so a third-party driver needs no other package.
 */
export * from "./videoGenerationPolicy";

import {
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_VARIANTS,
  type ProviderFailure,
  type ProviderInstanceId,
} from "@octant/contracts";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import { sniffGeneratedImageMediaType } from "./generatedImageStore";
import type {
  ImageAdapterRequest,
  ImageAdapterResult,
  ImageGenerationAdapter,
} from "./imageAdapter";
import {
  BFL_IMAGE_API_BASE_URL,
  fail,
  fetchApprovedImageUrl,
  interrupted,
  isProviderFailure,
  parseRetryAfter,
  performImageHttpRequest,
  readImageJson,
  sanitizeImageFailure,
  type ImageHttpFetch,
  type ImageHttpLimits,
} from "./imageHttp";
import { isRecord } from "./openAiImageResponseCodec";

const DEFAULT_LIMITS: ImageHttpLimits = {
  connectionTimeoutMs: 120_000,
  requestBodyBytes: MAX_GENERATED_IMAGE_BYTES * 2,
  responseBodyBytes: MAX_GENERATED_IMAGE_BYTES * MAX_IMAGE_VARIANTS + 262_144,
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 120;

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const BFL_AUTH = { header: "x-key" } as const;

export interface BflImageAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly fetch?: ImageHttpFetch;
  readonly limits?: Partial<ImageHttpLimits>;
  /** Overridable only so tests do not wait out the real 1s cadence. */
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
}

/**
 * Black Forest Labs FLUX adapter (`docs/decisions/0086`). Submit is a POST to
 * a model-named path, not a body field; the result arrives only after polling
 * a `polling_url` the submit call returned. The one image byte payload is
 * never inline — it is a signed URL the adapter fetches exactly once, through
 * the bounded `fetchApprovedImageUrl` exception, and then discards.
 */
export function makeBflImageAdapter(options: BflImageAdapterOptions): ImageGenerationAdapter {
  const fetch = options.fetch ?? globalThis.fetch;
  const limits: ImageHttpLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  return {
    generate: async (request) => {
      try {
        return await generateBflImage({
          adapterInstanceId: options.instanceId,
          credentialResolver: options.credentialResolver,
          fetch,
          limits,
          pollIntervalMs,
          maxPollAttempts,
          request,
        });
      } catch (error) {
        if (isProviderFailure(error)) {
          if (error.category === "interrupted") return { status: "failed", providerFailure: error };
          return { status: "failed", providerFailure: sanitizeImageFailure(error) };
        }
        return { status: "failed", providerFailure: sanitizeImageFailure(error) };
      }
    },
  };
}

async function generateBflImage(input: {
  readonly adapterInstanceId: ProviderInstanceId;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly fetch: ImageHttpFetch;
  readonly limits: ImageHttpLimits;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;
  readonly request: ImageAdapterRequest;
}): Promise<ImageAdapterResult> {
  const signal = input.request.signal;
  if (signal?.aborted) {
    return { status: "failed", providerFailure: interrupted() };
  }
  if (input.request.prompt.trim().length === 0) {
    return {
      status: "failed",
      providerFailure: fail("invalid-configuration", "The image prompt must not be empty."),
    };
  }
  if (input.request.prompt.length > MAX_IMAGE_PROMPT_CHARACTERS) {
    return {
      status: "failed",
      providerFailure: fail("invalid-configuration", "The image prompt exceeded the length limit."),
    };
  }
  const modelId = String(input.request.modelId);
  if (!MODEL_ID_PATTERN.test(modelId)) {
    return {
      status: "failed",
      providerFailure: fail("invalid-configuration", "The selected model id is not valid."),
    };
  }
  const variantCount = input.request.variantCount ?? 1;
  if (
    !Number.isSafeInteger(variantCount) ||
    variantCount < 1 ||
    variantCount > MAX_IMAGE_VARIANTS
  ) {
    return {
      status: "failed",
      providerFailure: fail(
        "invalid-configuration",
        "The requested variant count is not supported.",
      ),
    };
  }
  if (variantCount > 1) {
    return {
      status: "failed",
      providerFailure: fail(
        "invalid-configuration",
        "This provider generates one image per request.",
      ),
    };
  }
  if ((input.request.references ?? []).length > 0) {
    return {
      status: "failed",
      providerFailure: fail(
        "invalid-configuration",
        "This provider does not support reference images.",
      ),
    };
  }

  const submitResponse = await performImageHttpRequest({
    url: `${BFL_IMAGE_API_BASE_URL}/v1/${encodeURIComponent(modelId)}`,
    method: "POST",
    auth: BFL_AUTH,
    instanceId: String(input.adapterInstanceId),
    credentialResolver: input.credentialResolver,
    body: JSON.stringify({ prompt: input.request.prompt }),
    fetch: input.fetch,
    limits: input.limits,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!submitResponse.ok) {
    return {
      status: "failed",
      providerFailure: sanitizeImageFailure(classifyBflHttpFailure(submitResponse)),
    };
  }
  const submitted = decodeBflSubmitResponse(await readImageJson(submitResponse));
  if (submitted === undefined) {
    return {
      status: "failed",
      providerFailure: fail("protocol", "The provider returned an invalid submit response."),
    };
  }

  let sampleUrl: string | undefined;
  for (let attempt = 0; attempt < input.maxPollAttempts; attempt += 1) {
    if (attempt > 0) await delay(input.pollIntervalMs, signal);
    if (signal?.aborted) throw interrupted();

    const pollResponse = await performImageHttpRequest({
      url: submitted.pollingUrl,
      method: "GET",
      auth: BFL_AUTH,
      instanceId: String(input.adapterInstanceId),
      credentialResolver: input.credentialResolver,
      fetch: input.fetch,
      limits: input.limits,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!pollResponse.ok) {
      return {
        status: "failed",
        providerFailure: sanitizeImageFailure(classifyBflHttpFailure(pollResponse)),
      };
    }
    const decoded = decodeBflPollResponse(await readImageJson(pollResponse));
    if (decoded.kind === "pending") continue;
    if (decoded.kind === "ready") {
      sampleUrl = decoded.sampleUrl;
      break;
    }
    if (decoded.kind === "refused") {
      return { status: "refused", safetyRefusal: decoded.message };
    }
    if (decoded.kind === "failed") {
      return {
        status: "failed",
        providerFailure: fail("provider-failed", "The provider reported a generation failure."),
      };
    }
    return {
      status: "failed",
      providerFailure: fail("protocol", "The provider returned an invalid poll response."),
    };
  }
  if (sampleUrl === undefined) {
    return {
      status: "failed",
      providerFailure: fail("unavailable", "The provider request timed out."),
    };
  }

  const fetched = await fetchApprovedImageUrl({
    url: sampleUrl,
    fetch: input.fetch,
    maxBytes: MAX_GENERATED_IMAGE_BYTES,
    timeoutMs: input.limits.connectionTimeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });
  if ("failure" in fetched) {
    return { status: "failed", providerFailure: sanitizeImageFailure(fetched.failure) };
  }
  const mediaType = sniffGeneratedImageMediaType(fetched.bytes);
  if (mediaType === undefined) {
    return {
      status: "failed",
      providerFailure: fail("protocol", "The provider returned malformed image bytes."),
    };
  }
  return { status: "completed", images: [{ bytes: fetched.bytes, mediaType }] };
}

function classifyBflHttpFailure(response: Response, now = Date.now()): ProviderFailure {
  switch (response.status) {
    case 400:
      return fail("invalid-configuration", "The provider rejected this request.");
    case 402:
      return fail("unauthorized", "The provider account has insufficient credits.");
    case 403:
      return fail("unauthorized", "The provider denied this request.");
    case 422:
      return fail("invalid-configuration", "The provider rejected this request.");
    case 429: {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now);
      return {
        category: "rate-limited",
        message: "The provider rate limit was reached.",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    case 500:
      return fail("provider-failed", "The provider request failed.");
    case 503:
      return fail("unavailable", "The provider is temporarily unavailable.");
    default:
      return fail("provider-failed", `The provider request failed with HTTP ${response.status}.`);
  }
}

function decodeBflSubmitResponse(value: unknown): { readonly pollingUrl: string } | undefined {
  if (!isRecord(value)) return undefined;
  const pollingUrl = value.polling_url;
  if (typeof pollingUrl !== "string" || pollingUrl.length === 0) return undefined;
  return { pollingUrl };
}

type BflPollDecoded =
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly sampleUrl: string }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "failed" }
  | { readonly kind: "invalid" };

function decodeBflPollResponse(value: unknown): BflPollDecoded {
  if (!isRecord(value)) return { kind: "invalid" };
  const status = value.status;
  if (typeof status !== "string") return { kind: "invalid" };
  switch (status) {
    case "Pending":
    case "Reasoning":
    case "Generating":
      return { kind: "pending" };
    case "Ready": {
      const result = isRecord(value.result) ? value.result : undefined;
      const sampleUrl = result?.sample;
      if (typeof sampleUrl !== "string" || sampleUrl.length === 0) return { kind: "invalid" };
      return { kind: "ready", sampleUrl };
    }
    case "Request Moderated":
    case "Content Moderated":
      return { kind: "refused", message: bflModerationMessage(value, status) };
    case "Task not found":
    case "Error":
      return { kind: "failed" };
    default:
      return { kind: "invalid" };
  }
}

function bflModerationMessage(value: Record<string, unknown>, status: string): string {
  const details = isRecord(value.details) ? value.details : undefined;
  const reasons = details?.["Moderation Reasons"];
  if (Array.isArray(reasons) && reasons.length > 0) {
    const message = reasons
      .filter((reason): reason is string => typeof reason === "string")
      .join(", ");
    if (message.length > 0) return message;
  }
  return `The provider refused this request (${status}).`;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(interrupted());
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(interrupted());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

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
  IDEOGRAM_IMAGE_API_BASE_URL,
  fail,
  fetchApprovedImageUrl,
  interrupted,
  isProviderFailure,
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

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const IDEOGRAM_AUTH = { header: "Api-Key" } as const;

export interface IdeogramImageAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly fetch?: ImageHttpFetch;
  readonly limits?: Partial<ImageHttpLimits>;
}

/**
 * Ideogram adapter (`docs/decisions/0087`). Like BFL, the model version is a
 * URL path segment rather than a body field, but the request body is
 * `multipart/form-data` and the response is synchronous — no polling. Every
 * generated image is a URL, never inline bytes, fetched once per image
 * through the bounded `fetchApprovedImageUrl` exception. A whole-request
 * refusal arrives as HTTP 422; a per-image refusal arrives inside an
 * otherwise-200 response as `is_image_safe: false` and fails the whole
 * result rather than returning a partial set of images.
 */
export function makeIdeogramImageAdapter(
  options: IdeogramImageAdapterOptions,
): ImageGenerationAdapter {
  const fetch = options.fetch ?? globalThis.fetch;
  const limits: ImageHttpLimits = { ...DEFAULT_LIMITS, ...options.limits };
  return {
    generate: async (request) => {
      try {
        return await generateIdeogramImage({
          adapterInstanceId: options.instanceId,
          credentialResolver: options.credentialResolver,
          fetch,
          limits,
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

async function generateIdeogramImage(input: {
  readonly adapterInstanceId: ProviderInstanceId;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly fetch: ImageHttpFetch;
  readonly limits: ImageHttpLimits;
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
  if ((input.request.references ?? []).length > 0) {
    return {
      status: "failed",
      providerFailure: fail(
        "invalid-configuration",
        "This provider does not support reference images.",
      ),
    };
  }

  const form = new FormData();
  form.set("prompt", input.request.prompt);
  form.set("num_images", String(variantCount));

  const response = await performImageHttpRequest({
    url: `${IDEOGRAM_IMAGE_API_BASE_URL}/v1/${encodeURIComponent(modelId)}/generate`,
    method: "POST",
    auth: IDEOGRAM_AUTH,
    instanceId: String(input.adapterInstanceId),
    credentialResolver: input.credentialResolver,
    form,
    fetch: input.fetch,
    limits: input.limits,
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    if (response.status === 422) {
      return { status: "refused", safetyRefusal: await readIdeogramSafetyRefusal(response) };
    }
    return {
      status: "failed",
      providerFailure: sanitizeImageFailure(classifyIdeogramHttpFailure(response)),
    };
  }

  const decoded = decodeIdeogramResponse(await readImageJson(response));
  if (decoded === undefined) {
    return {
      status: "failed",
      providerFailure: fail("protocol", "The provider returned an invalid image response."),
    };
  }

  // Every item is checked before any bytes are fetched: one unsafe image
  // fails the whole result rather than returning fewer images than
  // requested (`docs/decisions/0087`).
  const approvedUrls: Array<string> = [];
  for (const item of decoded) {
    if (!item.safe) {
      return {
        status: "refused",
        safetyRefusal: "The provider refused this request (unsafe content detected).",
      };
    }
    approvedUrls.push(item.url);
  }

  const images = [];
  for (const url of approvedUrls) {
    const fetched = await fetchApprovedImageUrl({
      url,
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
    images.push({ bytes: fetched.bytes, mediaType });
  }
  return { status: "completed", images };
}

function classifyIdeogramHttpFailure(response: Response): ProviderFailure {
  switch (response.status) {
    case 400:
      return fail("invalid-configuration", "The provider rejected this request.");
    case 401:
      return fail("unauthenticated", "The provider rejected the configured credential.");
    case 429:
      // Ideogram documents no Retry-After header, unlike the other adapters.
      return fail("rate-limited", "The provider rate limit was reached.");
    default:
      return fail("provider-failed", `The provider request failed with HTTP ${response.status}.`);
  }
}

type IdeogramResponseItem =
  | { readonly safe: true; readonly url: string }
  | { readonly safe: false };

function decodeIdeogramResponse(value: unknown): ReadonlyArray<IdeogramResponseItem> | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.data) || value.data.length === 0) return undefined;
  const items: Array<IdeogramResponseItem> = [];
  for (const entry of value.data) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.is_image_safe !== "boolean") return undefined;
    if (!entry.is_image_safe) {
      items.push({ safe: false });
      continue;
    }
    if (typeof entry.url !== "string" || entry.url.length === 0) return undefined;
    items.push({ safe: true, url: entry.url });
  }
  return items;
}

async function readIdeogramSafetyRefusal(response: Response): Promise<string> {
  try {
    const payload = await readImageJson(response);
    if (isRecord(payload) && typeof payload.error === "string" && payload.error.length > 0) {
      return payload.error;
    }
  } catch {
    // Falls through to the generic refusal message below.
  }
  return "The provider refused this request.";
}

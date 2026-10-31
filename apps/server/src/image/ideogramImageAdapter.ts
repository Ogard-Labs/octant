import {
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_VARIANTS,
  type ProviderFailure,
} from "@octant/contracts";
import {
  imageFailure,
  imageInterrupted,
  isProviderFailure,
  readImageJson,
  sanitizeImageFailure,
  type ImageAdapterRequest,
  type ImageAdapterResult,
  type ImageGenerationAdapter,
  type ImageGenerationDriver,
  type ImageGenerationPorts,
} from "@octant/provider-sdk/image-generation";

export const IDEOGRAM_IMAGE_API_BASE_URL = "https://api.ideogram.ai/";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const IDEOGRAM_AUTH = { header: "Api-Key" } as const;

export interface IdeogramImageAdapterOptions {
  readonly ports: ImageGenerationPorts;
  /** The profile's configured endpoint; the provider's own when absent. */
  readonly baseUrl?: string;
}

/**
 * Ideogram adapter. Like BFL, the model version is a
 * URL path segment rather than a body field, but the request body is
 * `multipart/form-data` and the response is synchronous — no polling. Every
 * generated image is a URL, never inline bytes, fetched once per image
 * through the host's bounded approved-URL port. A whole-request
 * refusal arrives as HTTP 422; a per-image refusal arrives inside an
 * otherwise-200 response as `is_image_safe: false` and fails the whole
 * result rather than returning a partial set of images.
 */
export function makeIdeogramImageAdapter(
  options: IdeogramImageAdapterOptions,
): ImageGenerationAdapter {
  const baseUrl = withTrailingSlash(options.baseUrl ?? IDEOGRAM_IMAGE_API_BASE_URL);
  return {
    generate: async (request) => {
      try {
        return await generateIdeogramImage({ ports: options.ports, baseUrl, request });
      } catch (error) {
        if (isProviderFailure(error) && error.category === "interrupted") {
          return { status: "failed", providerFailure: error };
        }
        return { status: "failed", providerFailure: sanitizeImageFailure(error) };
      }
    },
  };
}

export const ideogramImageDriver: ImageGenerationDriver = {
  driverKind: "ideogram-image",
  providerHosts: ["api.ideogram.ai"],
  create: ({ instance, ports }) => {
    const baseUrl =
      instance.configuration.kind === "ideogram-image-http"
        ? instance.configuration.baseUrl
        : undefined;
    return makeIdeogramImageAdapter({ ports, ...(baseUrl === undefined ? {} : { baseUrl }) });
  },
};

async function generateIdeogramImage(input: {
  readonly ports: ImageGenerationPorts;
  readonly baseUrl: string;
  readonly request: ImageAdapterRequest;
}): Promise<ImageAdapterResult> {
  const signal = input.request.signal;
  if (signal?.aborted) {
    return { status: "failed", providerFailure: imageInterrupted() };
  }
  if (input.request.prompt.trim().length === 0) {
    return {
      status: "failed",
      providerFailure: imageFailure("invalid-configuration", "The image prompt must not be empty."),
    };
  }
  if (input.request.prompt.length > MAX_IMAGE_PROMPT_CHARACTERS) {
    return {
      status: "failed",
      providerFailure: imageFailure(
        "invalid-configuration",
        "The image prompt exceeded the length limit.",
      ),
    };
  }
  const modelId = String(input.request.modelId);
  if (!MODEL_ID_PATTERN.test(modelId)) {
    return {
      status: "failed",
      providerFailure: imageFailure("invalid-configuration", "The selected model id is not valid."),
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
      providerFailure: imageFailure(
        "invalid-configuration",
        "The requested variant count is not supported.",
      ),
    };
  }
  if ((input.request.references ?? []).length > 0) {
    return {
      status: "failed",
      providerFailure: imageFailure(
        "invalid-configuration",
        "This provider does not support reference images.",
      ),
    };
  }

  const form = new FormData();
  form.set("prompt", input.request.prompt);
  form.set("num_images", String(variantCount));

  const response = await input.ports.request({
    url: new URL(`v1/${encodeURIComponent(modelId)}/generate`, input.baseUrl).toString(),
    method: "POST",
    auth: IDEOGRAM_AUTH,
    form,
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
      providerFailure: imageFailure("protocol", "The provider returned an invalid image response."),
    };
  }

  // Every item is checked before any bytes are fetched: one unsafe image
  // fails the whole result rather than returning fewer images than
  // requested.
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
    // Fetched exactly as the provider's result named it: a configured base
    // URL never rewrites or widens it, and it never carries the credential.
    const fetched = await input.ports.fetchApprovedImageUrl({
      url,
      ...(signal === undefined ? {} : { signal }),
    });
    if ("failure" in fetched) {
      return { status: "failed", providerFailure: sanitizeImageFailure(fetched.failure) };
    }
    const mediaType = input.ports.sniffMediaType(fetched.bytes);
    if (mediaType === undefined) {
      return {
        status: "failed",
        providerFailure: imageFailure("protocol", "The provider returned malformed image bytes."),
      };
    }
    images.push({ bytes: fetched.bytes, mediaType });
  }
  return { status: "completed", images };
}

function classifyIdeogramHttpFailure(response: Response): ProviderFailure {
  switch (response.status) {
    case 400:
      return imageFailure("invalid-configuration", "The provider rejected this request.");
    case 401:
      return imageFailure("unauthenticated", "The provider rejected the configured credential.");
    case 429:
      // Ideogram documents no Retry-After header, unlike the other adapters.
      return imageFailure("rate-limited", "The provider rate limit was reached.");
    default:
      return imageFailure(
        "provider-failed",
        `The provider request failed with HTTP ${response.status}.`,
      );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A base URL's path is kept: `v1/...` resolves below it, never beside it. */
function withTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

import {
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_VARIANTS,
  type OpenAiImageQuality,
  type OpenAiImageSize,
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
  OPENAI_IMAGE_API_BASE_URL,
  classifyImageHttpFailure,
  fail,
  interrupted,
  isProviderFailure,
  performImageHttpRequest,
  readImageJson,
  sanitizeImageFailure,
  type ImageHttpFetch,
  type ImageHttpLimits,
} from "./imageHttp";
import {
  decodeBase64Image,
  decodeOpenAiImageResponse,
  safetyMessageFromUnknown,
} from "./openAiImageResponseCodec";

const DEFAULT_LIMITS: ImageHttpLimits = {
  connectionTimeoutMs: 120_000,
  requestBodyBytes: MAX_GENERATED_IMAGE_BYTES * 2,
  // Base64 expands decoded bytes by 4/3: bound the encoded JSON response by
  // that expansion, not by the decoded image ceiling, or a valid maximal
  // response gets rejected before decodeOpenAiImageResponse ever sees it.
  responseBodyBytes: 4 * Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * MAX_IMAGE_VARIANTS + 262_144,
};

export interface OpenAiImageAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly fetch?: ImageHttpFetch;
  readonly limits?: Partial<ImageHttpLimits>;
}

/**
 * OpenAI Image API adapter. The base URL is fixed; a user-supplied endpoint
 * cannot appear here, which closes SSRF. Results are base64 only — a URL form
 * is a protocol failure, never an artifact.
 */
export function makeOpenAiImageAdapter(options: OpenAiImageAdapterOptions): ImageGenerationAdapter {
  const fetch = options.fetch ?? globalThis.fetch;
  const limits: ImageHttpLimits = { ...DEFAULT_LIMITS, ...options.limits };
  return {
    generate: async (request) => {
      try {
        return await generateOpenAiImage({
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
        return {
          status: "failed",
          providerFailure: sanitizeImageFailure(error),
        };
      }
    },
  };
}

async function generateOpenAiImage(input: {
  readonly adapterInstanceId: ProviderInstanceId;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly fetch: ImageHttpFetch;
  readonly limits: ImageHttpLimits;
  readonly request: ImageAdapterRequest;
}): Promise<ImageAdapterResult> {
  if (input.request.signal?.aborted) {
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

  const references = input.request.references ?? [];
  const url =
    references.length === 0
      ? `${OPENAI_IMAGE_API_BASE_URL}/images/generations`
      : `${OPENAI_IMAGE_API_BASE_URL}/images/edits`;

  let response;
  if (references.length === 0) {
    const body: Record<string, unknown> = {
      model: input.request.modelId,
      prompt: input.request.prompt,
      n: variantCount,
    };
    assignOpenAiOptions(body, input.request.quality, input.request.size);
    response = await performImageHttpRequest({
      url,
      method: "POST",
      auth: { header: "authorization", scheme: "Bearer" },
      instanceId: String(input.adapterInstanceId),
      credentialResolver: input.credentialResolver,
      body: JSON.stringify(body),
      fetch: input.fetch,
      limits: input.limits,
      ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
    });
  } else {
    const form = new FormData();
    form.set("model", String(input.request.modelId));
    form.set("prompt", input.request.prompt);
    form.set("n", String(variantCount));
    if (input.request.quality !== undefined) form.set("quality", input.request.quality);
    if (input.request.size !== undefined) form.set("size", input.request.size);
    for (const [index, reference] of references.entries()) {
      form.append(
        "image[]",
        new Blob([Uint8Array.from(reference.bytes)], { type: reference.mediaType }),
        `reference-${index}${extensionFor(reference.mediaType)}`,
      );
    }
    response = await performImageHttpRequest({
      url,
      method: "POST",
      auth: { header: "authorization", scheme: "Bearer" },
      instanceId: String(input.adapterInstanceId),
      credentialResolver: input.credentialResolver,
      form,
      fetch: input.fetch,
      limits: input.limits,
      ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
    });
  }

  if (!response.ok) {
    const refusal = await readOpenAiSafetyRefusal(response);
    if (refusal !== undefined) return { status: "refused", safetyRefusal: refusal };
    return {
      status: "failed",
      providerFailure: sanitizeImageFailure(classifyImageHttpFailure(response)),
    };
  }

  const payload = await readImageJson(response);
  const decoded = decodeOpenAiImageResponse(payload);
  if (decoded.kind === "url-rejected") {
    return {
      status: "failed",
      providerFailure: fail(
        "protocol",
        "The provider returned an image URL instead of inline image bytes.",
      ),
    };
  }
  if (decoded.kind === "invalid") {
    return {
      status: "failed",
      providerFailure: fail("protocol", "The provider returned an invalid image response."),
    };
  }
  if (decoded.kind === "refused") {
    return { status: "refused", safetyRefusal: decoded.message };
  }

  const images = [];
  for (const item of decoded.images) {
    const bytes = decodeBase64Image(item);
    if (bytes === undefined) {
      return {
        status: "failed",
        providerFailure: fail("protocol", "The provider returned malformed image bytes."),
      };
    }
    if (bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
      return {
        status: "failed",
        providerFailure: fail(
          "protocol",
          "The provider response exceeded the configured size limit.",
        ),
      };
    }
    const mediaType = sniffGeneratedImageMediaType(bytes);
    if (mediaType === undefined) {
      return {
        status: "failed",
        providerFailure: fail("protocol", "The provider returned malformed image bytes."),
      };
    }
    images.push({ bytes, mediaType });
  }
  if (images.length === 0) {
    return {
      status: "failed",
      providerFailure: fail("protocol", "The provider returned an invalid image response."),
    };
  }
  return {
    status: "completed",
    images,
    ...(decoded.usage === undefined ? {} : { usage: decoded.usage }),
  };
}

function assignOpenAiOptions(
  body: Record<string, unknown>,
  quality: OpenAiImageQuality | undefined,
  size: OpenAiImageSize | undefined,
): void {
  if (quality !== undefined) body.quality = quality;
  if (size !== undefined) body.size = size;
}

function extensionFor(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".png";
  }
}

async function readOpenAiSafetyRefusal(response: Response): Promise<string | undefined> {
  try {
    const payload = await readImageJson(response);
    return safetyMessageFromUnknown(payload);
  } catch {
    return undefined;
  }
}

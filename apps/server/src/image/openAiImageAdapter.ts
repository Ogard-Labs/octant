import {
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_VARIANTS,
  MAX_GENERATED_IMAGE_BYTES,
  type OpenAiImageQuality,
  type OpenAiImageSize,
} from "@octant/contracts";
import {
  classifyImageHttpFailure,
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
export const OPENAI_IMAGE_API_BASE_URL = "https://api.openai.com/v1";

export interface OpenAiImageAdapterOptions {
  readonly ports: ImageGenerationPorts;
}

/**
 * OpenAI Image API adapter. The base URL is fixed; a user-supplied endpoint
 * cannot appear here, which closes SSRF. Results are base64 only — a URL form
 * is a protocol failure, never an artifact.
 */
export function makeOpenAiImageAdapter(options: OpenAiImageAdapterOptions): ImageGenerationAdapter {
  return {
    generate: async (request) => {
      try {
        return await generateOpenAiImage({ ports: options.ports, request });
      } catch (error) {
        if (isProviderFailure(error) && error.category === "interrupted") {
          return { status: "failed", providerFailure: error };
        }
        return { status: "failed", providerFailure: sanitizeImageFailure(error) };
      }
    },
  };
}

export const openAiImageDriver: ImageGenerationDriver = {
  driverKind: "openai-image",
  providerHosts: ["api.openai.com"],
  create: ({ ports }) => makeOpenAiImageAdapter({ ports }),
};

async function generateOpenAiImage(input: {
  readonly ports: ImageGenerationPorts;
  readonly request: ImageAdapterRequest;
}): Promise<ImageAdapterResult> {
  if (input.request.signal?.aborted) {
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
    response = await input.ports.request({
      url,
      method: "POST",
      auth: { header: "authorization", scheme: "Bearer" },
      body: JSON.stringify(body),
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
    response = await input.ports.request({
      url,
      method: "POST",
      auth: { header: "authorization", scheme: "Bearer" },
      form,
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
      providerFailure: imageFailure(
        "protocol",
        "The provider returned an image URL instead of inline image bytes.",
      ),
    };
  }
  if (decoded.kind === "invalid") {
    return {
      status: "failed",
      providerFailure: imageFailure("protocol", "The provider returned an invalid image response."),
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
        providerFailure: imageFailure("protocol", "The provider returned malformed image bytes."),
      };
    }
    if (bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
      return {
        status: "failed",
        providerFailure: imageFailure(
          "protocol",
          "The provider response exceeded the configured size limit.",
        ),
      };
    }
    const mediaType = input.ports.sniffMediaType(bytes);
    if (mediaType === undefined) {
      return {
        status: "failed",
        providerFailure: imageFailure("protocol", "The provider returned malformed image bytes."),
      };
    }
    images.push({ bytes, mediaType });
  }
  if (images.length === 0) {
    return {
      status: "failed",
      providerFailure: imageFailure("protocol", "The provider returned an invalid image response."),
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

// OpenAI-shaped image responses, shared with the OpenAI-compatible adapter.
export type OpenAiImageDecoded =
  | {
      readonly kind: "ok";
      readonly images: ReadonlyArray<string>;
      readonly usage?: { inputTokens?: number; outputTokens?: number; size?: string };
    }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "url-rejected" }
  | { readonly kind: "invalid" };

export function decodeOpenAiImageResponse(value: unknown): OpenAiImageDecoded {
  if (!isRecord(value)) return { kind: "invalid" };
  const safety = safetyMessageFromUnknown(value);
  if (safety !== undefined) return { kind: "refused", message: safety };
  if (!Array.isArray(value.data)) return { kind: "invalid" };
  const images: Array<string> = [];
  for (const item of value.data) {
    if (!isRecord(item)) return { kind: "invalid" };
    if (typeof item.url === "string") return { kind: "url-rejected" };
    if (typeof item.b64_json !== "string" || item.b64_json.length === 0) return { kind: "invalid" };
    images.push(item.b64_json);
  }
  const usage = decodeOpenAiUsage(value.usage);
  return {
    kind: "ok",
    images,
    ...(usage === undefined ? {} : { usage }),
  };
}

function decodeOpenAiUsage(
  value: unknown,
): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = asNonNegativeInt(value.input_tokens);
  const outputTokens = asNonNegativeInt(value.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

export function safetyMessageFromUnknown(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = isRecord(value.error) ? value.error : value;
  const code = typeof error.code === "string" ? error.code : "";
  const type = typeof error.type === "string" ? error.type : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (
    code === "moderation_blocked" ||
    code === "content_policy_violation" ||
    type === "image_generation_user_error" ||
    /safety|content policy|moderation/i.test(message)
  ) {
    return message.length > 0 ? message.slice(0, 2_000) : "The provider refused this request.";
  }
  return undefined;
}

export function decodeBase64Image(value: string): Uint8Array | undefined {
  try {
    const bytes = Uint8Array.from(Buffer.from(value, "base64"));
    if (bytes.byteLength === 0) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

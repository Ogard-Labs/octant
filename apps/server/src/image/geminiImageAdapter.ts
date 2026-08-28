import {
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_VARIANTS,
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
  GEMINI_IMAGE_API_BASE_URL,
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

const DEFAULT_LIMITS: ImageHttpLimits = {
  connectionTimeoutMs: 120_000,
  requestBodyBytes: MAX_GENERATED_IMAGE_BYTES * 2,
  responseBodyBytes: MAX_GENERATED_IMAGE_BYTES * MAX_IMAGE_VARIANTS + 262_144,
};

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface GeminiImageAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly fetch?: ImageHttpFetch;
  readonly limits?: Partial<ImageHttpLimits>;
}

/**
 * Gemini native image adapter. The base URL is fixed per kind. Inline data is
 * the only accepted payload; file URIs and HTTP URLs fail closed so they are
 * never journaled.
 */
export function makeGeminiImageAdapter(options: GeminiImageAdapterOptions): ImageGenerationAdapter {
  const fetch = options.fetch ?? globalThis.fetch;
  const limits: ImageHttpLimits = { ...DEFAULT_LIMITS, ...options.limits };
  return {
    generate: async (request) => {
      try {
        return await generateGeminiImage({
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

async function generateGeminiImage(input: {
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
  const modelId = String(input.request.modelId);
  if (!MODEL_ID_PATTERN.test(modelId)) {
    return {
      status: "failed",
      providerFailure: fail("invalid-configuration", "The selected model id is not valid."),
    };
  }

  const parts: Array<Record<string, unknown>> = [{ text: input.request.prompt }];
  for (const reference of input.request.references ?? []) {
    parts.push({
      inlineData: {
        mimeType: reference.mediaType,
        data: Buffer.from(reference.bytes).toString("base64"),
      },
    });
  }
  const imageConfig: Record<string, unknown> = {};
  if (input.request.aspectRatio !== undefined) imageConfig.aspectRatio = input.request.aspectRatio;
  if (input.request.resolution !== undefined) imageConfig.imageSize = input.request.resolution;
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
    ...(Object.keys(imageConfig).length === 0 ? {} : { imageConfig }),
  };
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig,
  };

  const response = await performImageHttpRequest({
    url: `${GEMINI_IMAGE_API_BASE_URL}/models/${encodeURIComponent(modelId)}:generateContent`,
    method: "POST",
    auth: "goog-api-key",
    instanceId: String(input.adapterInstanceId),
    credentialResolver: input.credentialResolver,
    body: JSON.stringify(body),
    fetch: input.fetch,
    limits: input.limits,
    ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
  });

  if (!response.ok) {
    const refusal = await readGeminiSafetyRefusal(response);
    if (refusal !== undefined) return { status: "refused", safetyRefusal: refusal };
    return {
      status: "failed",
      providerFailure: sanitizeImageFailure(classifyImageHttpFailure(response)),
    };
  }

  const payload = await readImageJson(response);
  const decoded = decodeGeminiImageResponse(payload);
  if (decoded.kind === "url-rejected") {
    return {
      status: "failed",
      providerFailure: fail(
        "protocol",
        "The provider returned an image URL instead of inline image bytes.",
      ),
    };
  }
  if (decoded.kind === "refused") {
    return { status: "refused", safetyRefusal: decoded.message };
  }
  if (decoded.kind === "invalid") {
    return {
      status: "failed",
      providerFailure: fail("protocol", "The provider returned an invalid image response."),
    };
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
  return { status: "completed", images };
}

type GeminiDecoded =
  | { readonly kind: "ok"; readonly images: ReadonlyArray<string> }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "url-rejected" }
  | { readonly kind: "invalid" };

function decodeGeminiImageResponse(value: unknown): GeminiDecoded {
  if (!isRecord(value)) return { kind: "invalid" };
  const promptFeedback = isRecord(value.promptFeedback) ? value.promptFeedback : undefined;
  const blockReason =
    promptFeedback !== undefined && typeof promptFeedback.blockReason === "string"
      ? promptFeedback.blockReason
      : undefined;
  if (blockReason !== undefined && blockReason !== "BLOCK_REASON_UNSPECIFIED") {
    const message =
      typeof promptFeedback?.blockReasonMessage === "string" &&
      promptFeedback.blockReasonMessage.length > 0
        ? promptFeedback.blockReasonMessage
        : `The provider refused this request (${blockReason}).`;
    return { kind: "refused", message: message.slice(0, 2_000) };
  }
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    return { kind: "invalid" };
  }
  const images: Array<string> = [];
  for (const candidate of value.candidates) {
    if (!isRecord(candidate)) return { kind: "invalid" };
    const finishReason = typeof candidate.finishReason === "string" ? candidate.finishReason : "";
    if (
      finishReason === "SAFETY" ||
      finishReason === "IMAGE_SAFETY" ||
      finishReason === "BLOCKLIST"
    ) {
      return {
        kind: "refused",
        message: `The provider refused this request (${finishReason}).`,
      };
    }
    const content = isRecord(candidate.content) ? candidate.content : undefined;
    if (content === undefined || !Array.isArray(content.parts)) return { kind: "invalid" };
    for (const part of content.parts) {
      if (!isRecord(part)) return { kind: "invalid" };
      if (
        part.fileData !== undefined ||
        part.fileUri !== undefined ||
        typeof part.fileUri === "string"
      ) {
        return { kind: "url-rejected" };
      }
      if (isRecord(part.inlineData)) {
        if (
          typeof part.inlineData.fileUri === "string" ||
          typeof part.inlineData.url === "string"
        ) {
          return { kind: "url-rejected" };
        }
        if (typeof part.inlineData.data !== "string" || part.inlineData.data.length === 0) {
          return { kind: "invalid" };
        }
        images.push(part.inlineData.data);
      }
    }
  }
  if (images.length === 0) return { kind: "invalid" };
  return { kind: "ok", images };
}

async function readGeminiSafetyRefusal(response: Response): Promise<string | undefined> {
  try {
    const payload = await readImageJson(response);
    const decoded = decodeGeminiImageResponse(payload);
    return decoded.kind === "refused" ? decoded.message : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64Image(value: string): Uint8Array | undefined {
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

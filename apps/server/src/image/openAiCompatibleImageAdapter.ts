import {
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_VARIANTS,
  type OpenAiCompatibleProviderInstance,
} from "@octant/contracts";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import {
  classifyCompatibleHttpFailure,
  isProviderFailure,
  makeOpenAiCompatibleEndpoint,
  performCompatibleRequest,
  sanitizeCompatibleFailure,
  type CompatibleEndpointPath,
  type CompatibleFetch,
  type CompatibleHttpLimits,
  type OpenAiCompatibleEndpoint,
} from "../providers/openAiCompatibleEndpoint";
import { sniffGeneratedImageMediaType } from "./generatedImageStore";
import type {
  ImageAdapterRequest,
  ImageAdapterResult,
  ImageGenerationAdapter,
} from "./imageAdapter";
import { fail, interrupted, readImageJson } from "./imageHttp";
import {
  decodeBase64Image,
  decodeOpenAiImageResponse,
  safetyMessageFromUnknown,
} from "./openAiImageResponseCodec";

const DEFAULT_LIMITS: CompatibleHttpLimits = {
  connectionTimeoutMs: 120_000,
  requestBodyBytes: MAX_GENERATED_IMAGE_BYTES * 2,
  // Base64 expands decoded bytes by 4/3: bound the encoded JSON response by
  // that expansion, not by the decoded image ceiling, or a valid maximal
  // response gets rejected before decodeOpenAiImageResponse ever sees it.
  responseBodyBytes: 4 * Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * MAX_IMAGE_VARIANTS + 262_144,
  streamIdleTimeoutMs: 30_000,
};

export interface OpenAiCompatibleImageAdapterOptions {
  readonly instance: OpenAiCompatibleProviderInstance;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly fetch?: CompatibleFetch;
  readonly limits?: Partial<CompatibleHttpLimits>;
}

/**
 * Image generation over an OpenAI-compatible HTTP instance
 * (`docs/decisions/0085`). The instance's own base URL, credential, and
 * endpoint policy are reused unchanged, exactly like the speech adapter
 * reuses them for `/audio/*`; this adapter only adds the two `images/*`
 * paths. Results are base64 only — a URL form is a protocol failure, never an
 * artifact, the same as the fixed OpenAI Image adapter.
 */
export function makeOpenAiCompatibleImageAdapter(
  options: OpenAiCompatibleImageAdapterOptions,
): ImageGenerationAdapter {
  const limits: CompatibleHttpLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const endpoint = makeOpenAiCompatibleEndpoint({
    instanceId: String(options.instance.id),
    configuration: options.instance.configuration,
    credentialResolver: options.credentialResolver,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    limits,
  });
  return {
    generate: async (request) => {
      try {
        return await generateCompatibleImage(endpoint, request);
      } catch (error) {
        if (isProviderFailure(error)) {
          if (error.category === "interrupted") return { status: "failed", providerFailure: error };
          return { status: "failed", providerFailure: sanitizeCompatibleFailure(error) };
        }
        return { status: "failed", providerFailure: sanitizeCompatibleFailure(error) };
      }
    },
  };
}

async function generateCompatibleImage(
  endpoint: OpenAiCompatibleEndpoint,
  request: ImageAdapterRequest,
): Promise<ImageAdapterResult> {
  if (request.signal?.aborted) {
    return { status: "failed", providerFailure: interrupted() };
  }
  if (request.prompt.trim().length === 0) {
    return {
      status: "failed",
      providerFailure: fail("invalid-configuration", "The image prompt must not be empty."),
    };
  }
  if (request.prompt.length > MAX_IMAGE_PROMPT_CHARACTERS) {
    return {
      status: "failed",
      providerFailure: fail("invalid-configuration", "The image prompt exceeded the length limit."),
    };
  }
  const variantCount = request.variantCount ?? 1;
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

  const references = request.references ?? [];
  const path: CompatibleEndpointPath =
    references.length === 0 ? "images/generations" : "images/edits";

  let response: Response;
  if (references.length === 0) {
    const body = { model: String(request.modelId), prompt: request.prompt, n: variantCount };
    response = await performCompatibleRequest(endpoint, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } else {
    const form = new FormData();
    form.set("model", String(request.modelId));
    form.set("prompt", request.prompt);
    form.set("n", String(variantCount));
    for (const [index, reference] of references.entries()) {
      form.append(
        "image[]",
        new Blob([Uint8Array.from(reference.bytes)], { type: reference.mediaType }),
        `reference-${index}${extensionFor(reference.mediaType)}`,
      );
    }
    // No content-type header on the form branch — fetch sets the multipart
    // boundary itself, the same as the speech adapter's transcribe call.
    response = await performCompatibleRequest(endpoint, path, {
      method: "POST",
      body: form,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  if (!response.ok) {
    const refusal = await readCompatibleSafetyRefusal(response);
    if (refusal !== undefined) return { status: "refused", safetyRefusal: refusal };
    return {
      status: "failed",
      providerFailure: sanitizeCompatibleFailure(classifyCompatibleHttpFailure(response)),
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

async function readCompatibleSafetyRefusal(response: Response): Promise<string | undefined> {
  try {
    const payload = await readImageJson(response);
    return safetyMessageFromUnknown(payload);
  } catch {
    return undefined;
  }
}

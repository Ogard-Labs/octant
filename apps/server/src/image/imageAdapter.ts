import type {
  GeminiImageAspectRatio,
  GeminiImageResolution,
  ImageArtifactMediaType,
  OpenAiImageQuality,
  OpenAiImageSize,
  ProviderFailure,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts";

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

export interface ImageGenerationAdapter {
  generate(request: ImageAdapterRequest): Promise<ImageAdapterResult>;
}

import {
  GEMINI_IMAGE_ASPECT_RATIOS,
  GEMINI_IMAGE_RESOLUTIONS,
  MAX_IMAGE_VARIANTS,
  OPENAI_IMAGE_QUALITIES,
  OPENAI_IMAGE_SIZES,
  type GeminiImageAspectRatio,
  type GeminiImageResolution,
  type ImageGenerationCustomSource,
  type ImageGenerationProfileView,
  type ImageJob,
  type OpenAiImageQuality,
  type OpenAiImageSize,
  type ProviderInstance,
  type ThreadExportAttachment,
} from "@octant/contracts";
import { isImageProfileDriverKind } from "./providerPolicy";
import { resolveImageCustomSource } from "./imageSourcePolicy";

export type ImageGenerationHonoredOptions =
  | {
      readonly kind: "openai-image-http";
      readonly qualities: ReadonlyArray<OpenAiImageQuality>;
      readonly sizes: ReadonlyArray<OpenAiImageSize>;
      readonly maxVariants: number;
      readonly supportsReferences: boolean;
    }
  | {
      readonly kind: "gemini-native-image-http";
      readonly aspectRatios: ReadonlyArray<GeminiImageAspectRatio>;
      readonly resolutions: ReadonlyArray<GeminiImageResolution>;
      readonly maxVariants: number;
      readonly supportsReferences: boolean;
    }
  | {
      readonly kind: "openai-compatible-http";
      readonly maxVariants: number;
      readonly supportsReferences: boolean;
    }
  | {
      readonly kind: "bfl-image-http";
      readonly maxVariants: number;
      readonly supportsReferences: boolean;
    };

/**
 * Enabled Settings-configured custom image sources, as profile views. Only a
 * `"ready"` resolution is offered here — an `"unavailable"` custom source is
 * Settings' job to surface with its reason, not the picker's
 * (`docs/decisions/0085`).
 */
export function listCustomImageProfiles(
  customSources: ReadonlyArray<ImageGenerationCustomSource>,
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<ImageGenerationProfileView> {
  const profiles: Array<ImageGenerationProfileView> = [];
  for (const source of customSources) {
    const resolution = resolveImageCustomSource(source, instances);
    if (resolution.status !== "ready") continue;
    profiles.push({
      instanceId: resolution.instance.id,
      displayName: resolution.label,
      driverKind: "openai-compatible-image",
      modelAllowlist: [resolution.modelId],
      defaultModel: resolution.modelId,
    });
  }
  return profiles;
}

/**
 * Image generation is bound to enabled Settings profiles. Disabled or
 * non-image instances never appear as something a composer or agent can name.
 */
export function listEligibleImageProfiles(
  instances: ReadonlyArray<ProviderInstance>,
  customSources: ReadonlyArray<ImageGenerationCustomSource> = [],
): ReadonlyArray<ImageGenerationProfileView> {
  const profiles: Array<ImageGenerationProfileView> = [];
  for (const instance of instances) {
    if (!instance.enabled) continue;
    if (!isImageProfileDriverKind(instance.driverKind)) continue;
    const configuration = instance.configuration;
    if (configuration.kind === "openai-image-http") {
      profiles.push({
        instanceId: instance.id,
        displayName: instance.displayName,
        driverKind: "openai-image",
        modelAllowlist: configuration.modelAllowlist,
        defaultModel: configuration.defaultModel,
        ...(configuration.quality === undefined ? {} : { quality: configuration.quality }),
        ...(configuration.size === undefined ? {} : { size: configuration.size }),
      });
      continue;
    }
    if (configuration.kind === "gemini-native-image-http") {
      profiles.push({
        instanceId: instance.id,
        displayName: instance.displayName,
        driverKind: "gemini-native-image",
        modelAllowlist: configuration.modelAllowlist,
        defaultModel: configuration.defaultModel,
        ...(configuration.aspectRatio === undefined
          ? {}
          : { aspectRatio: configuration.aspectRatio }),
        ...(configuration.resolution === undefined ? {} : { resolution: configuration.resolution }),
      });
      continue;
    }
    if (configuration.kind === "bfl-image-http") {
      profiles.push({
        instanceId: instance.id,
        displayName: instance.displayName,
        driverKind: "bfl-image",
        modelAllowlist: configuration.modelAllowlist,
        defaultModel: configuration.defaultModel,
      });
    }
  }
  return [...profiles, ...listCustomImageProfiles(customSources, instances)];
}

export function hasEligibleImageProfile(
  instances: ReadonlyArray<ProviderInstance>,
  customSources: ReadonlyArray<ImageGenerationCustomSource> = [],
): boolean {
  return listEligibleImageProfiles(instances, customSources).length > 0;
}

/**
 * Options a generation sheet may show for the selected profile kind. Gemini
 * never sees OpenAI quality/size, OpenAI never sees aspect ratio/resolution,
 * and a custom source sees neither — it has no Settings-configured quality or
 * size options of its own.
 */
export function honoredImageGenerationOptions(
  kind:
    | "openai-image-http"
    | "gemini-native-image-http"
    | "openai-compatible-http"
    | "bfl-image-http",
): ImageGenerationHonoredOptions {
  switch (kind) {
    case "openai-image-http":
      return {
        kind,
        qualities: OPENAI_IMAGE_QUALITIES,
        sizes: OPENAI_IMAGE_SIZES,
        maxVariants: MAX_IMAGE_VARIANTS,
        supportsReferences: true,
      };
    case "gemini-native-image-http":
      return {
        kind,
        aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
        resolutions: GEMINI_IMAGE_RESOLUTIONS,
        maxVariants: MAX_IMAGE_VARIANTS,
        supportsReferences: true,
      };
    case "openai-compatible-http":
      return { kind, maxVariants: MAX_IMAGE_VARIANTS, supportsReferences: true };
    case "bfl-image-http":
      // BFL generates exactly one image per submit call: this is a real
      // constraint the provider enforces, not a placeholder ceiling.
      return { kind, maxVariants: 1, supportsReferences: false };
  }
}

export function imageGenerationConfigurationKind(
  driverKind: ImageGenerationProfileView["driverKind"],
): "openai-image-http" | "gemini-native-image-http" | "openai-compatible-http" | "bfl-image-http" {
  switch (driverKind) {
    case "openai-image":
      return "openai-image-http";
    case "gemini-native-image":
      return "gemini-native-image-http";
    case "openai-compatible-image":
      return "openai-compatible-http";
    case "bfl-image":
      return "bfl-image-http";
  }
}

/**
 * Completed generated images as export attachments. Bytes stay omitted; the
 * cut carries identity, media type, size, and generation provenance.
 */
export function generatedImageExportAttachments(
  jobs: ReadonlyArray<ImageJob>,
): ReadonlyArray<ThreadExportAttachment> {
  const attachments: Array<ThreadExportAttachment> = [];
  for (const job of jobs) {
    if (job.status !== "completed") continue;
    for (const [index, artifact] of job.artifacts.entries()) {
      const parent = artifact.evidence.parentArtifactRef;
      attachments.push({
        displayName: `generated-${String(job.id)}-${index + 1}.${imageFileExtension(artifact.mime)}`,
        mediaType: artifact.mime,
        byteLength: artifact.size,
        status: "finalized",
        generation: {
          jobId: job.id,
          profileInstanceId: artifact.evidence.profileInstanceId,
          modelId: artifact.evidence.modelId,
          promptHash: artifact.evidence.promptHash,
          ...(parent === undefined ? {} : { parentAttachmentId: parent.attachmentId }),
        },
      });
    }
  }
  return attachments;
}

function imageFileExtension(mime: ImageJob["artifacts"][number]["mime"]): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "png";
}

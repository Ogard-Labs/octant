import {
  GEMINI_IMAGE_ASPECT_RATIOS,
  GEMINI_IMAGE_RESOLUTIONS,
  MAX_IMAGE_VARIANTS,
  OPENAI_IMAGE_QUALITIES,
  OPENAI_IMAGE_SIZES,
  type GeminiImageAspectRatio,
  type GeminiImageResolution,
  type ImageGenerationProfileView,
  type ImageJob,
  type OpenAiImageQuality,
  type OpenAiImageSize,
  type ProviderInstance,
  type ThreadExportAttachment,
} from "@octant/contracts";
import { isImageProfileDriverKind } from "./providerPolicy";

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
    };

/**
 * Image generation is bound to enabled Settings profiles. Disabled or
 * non-image instances never appear as something a composer or agent can name.
 */
export function listEligibleImageProfiles(
  instances: ReadonlyArray<ProviderInstance>,
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
    }
  }
  return profiles;
}

export function hasEligibleImageProfile(instances: ReadonlyArray<ProviderInstance>): boolean {
  return listEligibleImageProfiles(instances).length > 0;
}

/**
 * Options a generation sheet may show for the selected profile kind. Gemini
 * never sees OpenAI quality/size, and OpenAI never sees aspect ratio/resolution.
 */
export function honoredImageGenerationOptions(
  kind: "openai-image-http" | "gemini-native-image-http",
): ImageGenerationHonoredOptions {
  if (kind === "openai-image-http") {
    return {
      kind,
      qualities: OPENAI_IMAGE_QUALITIES,
      sizes: OPENAI_IMAGE_SIZES,
      maxVariants: MAX_IMAGE_VARIANTS,
      supportsReferences: true,
    };
  }
  return {
    kind,
    aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
    resolutions: GEMINI_IMAGE_RESOLUTIONS,
    maxVariants: MAX_IMAGE_VARIANTS,
    supportsReferences: true,
  };
}

export function imageGenerationConfigurationKind(
  driverKind: ImageGenerationProfileView["driverKind"],
): "openai-image-http" | "gemini-native-image-http" {
  return driverKind === "openai-image" ? "openai-image-http" : "gemini-native-image-http";
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
        displayName: `generated-${index + 1}.png`,
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

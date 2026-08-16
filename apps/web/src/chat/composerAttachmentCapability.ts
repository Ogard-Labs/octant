import { CHAT_ATTACHMENT_MEDIA_TYPES } from "@octant/contracts/chat";
import type { ProviderInputModality, ProviderObservedState } from "@octant/contracts/providers";
import type { ChatComposerAttachmentCapability } from "./ChatComposer";

/**
 * Largest attachment the host will accept. Mirrors the provider contract's own
 * attachment byte bound so a paste that the host would reject is refused in
 * the composer instead of being read, uploaded, and then discarded.
 */
export const MAX_COMPOSER_ATTACHMENT_BYTES = 26_214_400;

const IMAGE_MEDIA_TYPES = CHAT_ATTACHMENT_MEDIA_TYPES.filter((mediaType) =>
  mediaType.startsWith("image/"),
);

/** The image media types Chat's attachment allow-list already accepts. */
export const COMPOSER_IMAGE_MEDIA_TYPES: ReadonlyArray<string> = IMAGE_MEDIA_TYPES;

/**
 * Classify a media type into the provider input modality the selected model
 * must declare. Kept here rather than inline so Chat, Work, and Code all
 * ask the same question of the same server-authored capability record.
 */
export function attachmentModality(mediaType: string): ProviderInputModality {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Whether the selected provider and model honestly accept this file. Three
 * separate server-authored facts must all hold: the provider observation says
 * native attachments are supported, the media type is on Chat's allow-list,
 * and the selected model declares the matching input modality. The renderer
 * only reads these — it never assumes support from a file extension.
 */
export function supportsAttachmentFile(
  observation: ProviderObservedState | undefined,
  modelId: string,
  file: { readonly type: string },
): boolean {
  if (observation?.capabilities.nativeAttachments !== "supported") return false;
  if (!(CHAT_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(file.type)) return false;
  const model = observation.models.find((candidate) => candidate.id === modelId);
  return model?.inputModalities.includes(attachmentModality(file.type)) ?? false;
}

/**
 * Attachment capability for the composer's paperclip control.
 */
export function buildAttachmentCapability(
  observation: ProviderObservedState | undefined,
): ChatComposerAttachmentCapability {
  return observation?.capabilities.nativeAttachments === "supported"
    ? { kind: "supported" }
    : {
        kind: "unavailable",
        reason: "The selected provider and model cannot accept native attachments.",
      };
}

/**
 * Image-specific capability. Images are offered only when the provider
 * accepts native attachments *and* the selected model declares the `image`
 * input modality — a provider that takes documents but not images must fail
 * closed with a visible reason rather than silently dropping pasted bytes.
 * The reason names which of the two facts is missing so the unavailable state
 * is actionable (change model vs. change provider).
 */
export function buildImageAttachmentCapability(
  observation: ProviderObservedState | undefined,
  modelId: string,
): ChatComposerAttachmentCapability {
  if (observation?.capabilities.nativeAttachments !== "supported") {
    return {
      kind: "unavailable",
      reason: "The selected provider cannot accept attachments, so images cannot be sent.",
    };
  }
  const model = observation.models.find((candidate) => candidate.id === modelId);
  if (!(model?.inputModalities.includes("image") ?? false)) {
    return {
      kind: "unavailable",
      reason: "The selected model does not accept images. Choose an image-capable model.",
    };
  }
  return { kind: "supported" };
}

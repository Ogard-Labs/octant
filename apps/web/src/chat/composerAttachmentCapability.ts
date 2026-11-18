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
 * Whether bytes are text: valid UTF-8 with no NUL byte. The host decides
 * the same way at send; the composer asks first so a file Chat cannot give
 * the model is refused when it is chosen, not after the message is written.
 */
export function isTextContent(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The document types whose text the host reads out for a model that does not
 * take them natively: PDF, Word, PowerPoint and Excel. The host checks the
 * bytes themselves at send.
 */
const EXTRACTED_DOCUMENT_MEDIA_TYPES: ReadonlyArray<string> = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/**
 * Why Chat cannot give a file that is not an image to the selected model, or
 * undefined when it can: natively where the provider and model take its type,
 * otherwise as text when its bytes are text or it is a document whose text the
 * host reads out. Chat has no folder for the model to open any other file
 * from, so that file belongs in a Work or Code thread.
 */
export function chatFileRefusal(
  observation: ProviderObservedState | undefined,
  modelId: string,
  file: { readonly type: string },
  bytes: Uint8Array,
  displayName: string,
): string | undefined {
  if (
    supportsAttachmentFile(observation, modelId, file) ||
    EXTRACTED_DOCUMENT_MEDIA_TYPES.includes(file.type) ||
    isTextContent(bytes)
  )
    return undefined;
  return `${displayName} is not text, and the selected model does not read this kind of file. Attach it in a Work or Code thread, where the agent opens it from the thread's attachments folder.`;
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
      reason: "This model cannot read images. Pick one that can.",
    };
  }
  return { kind: "supported" };
}

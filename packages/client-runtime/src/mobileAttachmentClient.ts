import {
  CHAT_ATTACHMENT_MEDIA_TYPES,
  ChatAttachment,
  CODE_ATTACHMENT_MEDIA_TYPES,
  CodeAttachmentReference,
  MAX_CODE_ATTACHMENT_BYTES,
  MAX_WORK_ATTACHMENT_BYTES,
  WORK_ATTACHMENT_MEDIA_TYPES,
  WorkAttachmentReference,
  decodeHostAnswer,
  type ProviderInputModality,
} from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";
import type { MobileModelOption } from "./mobileProviderClient";

/**
 * The largest attachment the host's listener takes from a paired device, in
 * every mode. It holds the whole body to check the device's proof, so a phone
 * upload is bounded by the Work and Code limit even where Chat at the host
 * takes larger files.
 */
export const MOBILE_ATTACHMENT_MAX_BYTES = Math.min(
  MAX_WORK_ATTACHMENT_BYTES,
  MAX_CODE_ATTACHMENT_BYTES,
);

export type MobileAttachmentMode = "chat" | "work" | "code";
export type MobileAttachmentSource = "camera" | "library" | "file";

export interface MobileAttachmentOffer {
  /** Where the phone may take an attachment from: empty when nothing is offered. */
  readonly sources: ReadonlyArray<MobileAttachmentSource>;
  /** The media types the document picker may return. */
  readonly mediaTypes: ReadonlyArray<string>;
}

const MODE_MEDIA_TYPES: Readonly<Record<MobileAttachmentMode, ReadonlyArray<string>>> = {
  chat: CHAT_ATTACHMENT_MEDIA_TYPES,
  work: WORK_ATTACHMENT_MEDIA_TYPES,
  code: CODE_ATTACHMENT_MEDIA_TYPES,
};

function attachmentModality(mediaType: string): ProviderInputModality {
  return mediaType.startsWith("image/") ? "image" : "document";
}

/**
 * What a phone may attach to a thread: the media its mode's route takes that
 * the thread's model also takes as a native attachment. A model the host does
 * not list as ready, or whose provider takes no native attachments, is offered
 * nothing, so the phone never uploads a file the turn would refuse.
 */
export function mobileAttachmentOffer(
  mode: MobileAttachmentMode,
  model: MobileModelOption | undefined,
): MobileAttachmentOffer {
  const modalities = model?.attachmentModalities ?? [];
  const mediaTypes = MODE_MEDIA_TYPES[mode].filter((mediaType) =>
    modalities.includes(attachmentModality(mediaType)),
  );
  const images = mediaTypes.some((mediaType) => mediaType.startsWith("image/"));
  return {
    sources: [
      ...(images ? (["camera", "library"] as const) : []),
      ...(mediaTypes.length > 0 ? (["file"] as const) : []),
    ],
    mediaTypes,
  };
}

export interface MobileAttachmentUpload {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly attachmentId: string;
  readonly displayName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/**
 * Refuses, before anything is sent, an attachment the mode's route would
 * refuse: an empty or oversized file, or a media type the mode does not take.
 */
export function refuseUnsendableAttachment(
  mode: MobileAttachmentMode,
  upload: Pick<MobileAttachmentUpload, "mediaType" | "bytes">,
): void {
  if (!MODE_MEDIA_TYPES[mode].includes(upload.mediaType)) {
    throw new MobileInboxFailure("rejected", "This thread cannot take that kind of file.");
  }
  if (upload.bytes.byteLength === 0) {
    throw new MobileInboxFailure("rejected", "The file is empty.");
  }
  if (upload.bytes.byteLength > MOBILE_ATTACHMENT_MAX_BYTES) {
    throw new MobileInboxFailure("rejected", "The file is larger than 10 MB.");
  }
}

async function putThreadAttachment<T>(
  mode: "work" | "code",
  upload: MobileAttachmentUpload,
  decode: (value: unknown) => T,
): Promise<T> {
  refuseUnsendableAttachment(mode, upload);
  const response = await upload.transport.authenticatedFetch({
    method: "PUT",
    path: `/api/${mode}/attachments`,
    contentType: upload.mediaType,
    headers: {
      [`x-octant-${mode}-thread-id`]: upload.threadId,
      [`x-octant-${mode}-attachment-id`]: upload.attachmentId,
      [`x-octant-${mode}-display-name`]: encodeURIComponent(upload.displayName),
    },
    body: upload.bytes,
  });
  return answeredAttachment(response, decode);
}

async function answeredAttachment<T>(
  response: Response,
  decode: (value: unknown) => T,
): Promise<T> {
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 || response.status === 413 || response.status === 415
        ? "rejected"
        : "unavailable",
      response.status === 415
        ? "The host could not read the image, so it was not attached."
        : "Could not upload the attachment to the host.",
    );
  }
  try {
    return decode(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      "Attachment upload returned an invalid response from the host.",
    );
  }
}

/**
 * Upload a Chat attachment (image, PDF, or text) to its thread. Chat keeps the
 * attachment as thread content once the host accepts it.
 */
export async function uploadMobileChatAttachment(
  upload: MobileAttachmentUpload,
): Promise<ChatAttachment> {
  refuseUnsendableAttachment("chat", upload);
  const response = await upload.transport.authenticatedFetch({
    method: "POST",
    path: "/api/chat/attachments",
    body: upload.bytes,
    contentType: upload.mediaType,
    headers: {
      "x-octant-chat-thread-id": upload.threadId,
      "x-octant-chat-attachment-id": upload.attachmentId,
      "x-octant-chat-display-name": encodeURIComponent(upload.displayName),
    },
  });
  return answeredAttachment(response, decodeHostAnswer(ChatAttachment));
}

/** Stage an image for a Work thread's next turn, under that thread's authority. */
export function uploadMobileWorkAttachment(
  upload: MobileAttachmentUpload,
): Promise<WorkAttachmentReference> {
  return putThreadAttachment("work", upload, decodeHostAnswer(WorkAttachmentReference));
}

/** Stage an image for a Code thread's next turn, under that thread's authority. */
export function uploadMobileCodeAttachment(
  upload: MobileAttachmentUpload,
): Promise<CodeAttachmentReference> {
  return putThreadAttachment("code", upload, decodeHostAnswer(CodeAttachmentReference));
}

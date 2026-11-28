import {
  MobileInboxFailure,
  uploadMobileChatAttachment,
  uploadMobileCodeAttachment,
  uploadMobileWorkAttachment,
  type MobileAttachmentMode,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import {
  MAX_CHAT_TURN_ATTACHMENTS,
  MAX_CODE_TURN_ATTACHMENTS,
  MAX_WORK_TURN_ATTACHMENTS,
} from "@octant/contracts";
import { MOBILE_COPY } from "../../copy";
import { defaultAttachmentName } from "./imageBytes";
import type { PendingAttachment } from "./pendingAttachments";

export const TURN_ATTACHMENT_LIMITS: Readonly<Record<MobileAttachmentMode, number>> = {
  chat: MAX_CHAT_TURN_ATTACHMENTS,
  work: MAX_WORK_TURN_ATTACHMENTS,
  code: MAX_CODE_TURN_ATTACHMENTS,
};

export interface StagedThreadAttachmentUpload {
  readonly displayName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/**
 * Uploads one already-validated attachment (from a picker or the OS share
 * staging folder) through the thread's own attachment route.
 */
export async function uploadStagedThreadAttachment(
  mode: MobileAttachmentMode,
  transport: MobileRemoteTransport,
  threadId: string,
  item: StagedThreadAttachmentUpload,
): Promise<PendingAttachment> {
  const attachmentId = globalThis.crypto.randomUUID();
  const upload = {
    transport,
    threadId,
    attachmentId,
    displayName: item.displayName || defaultAttachmentName(item.mediaType, attachmentId),
    mediaType: item.mediaType,
    bytes: item.bytes,
  };
  if (mode === "chat") {
    const attachment = await uploadMobileChatAttachment(upload);
    return { id: String(attachment.id), displayName: attachment.displayName };
  }
  const reference =
    mode === "work"
      ? await uploadMobileWorkAttachment(upload)
      : await uploadMobileCodeAttachment(upload);
  return { id: String(reference.attachmentId), displayName: reference.displayName };
}

export type StagedBatchUploadResult =
  | { readonly status: "ok"; readonly uploaded: ReadonlyArray<PendingAttachment> }
  | { readonly status: "failed"; readonly message: string; readonly rejected: boolean };

/**
 * Uploads a batch of validated share attachments to a thread, respecting the
 * mode's turn attachment limit and surfacing host refusals cleanly.
 */
export async function uploadStagedThreadAttachments(input: {
  readonly mode: MobileAttachmentMode;
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly items: ReadonlyArray<StagedThreadAttachmentUpload>;
  readonly existingCount?: number;
}): Promise<StagedBatchUploadResult> {
  const limit = TURN_ATTACHMENT_LIMITS[input.mode];
  if (input.items.length + (input.existingCount ?? 0) > limit) {
    return { status: "failed", message: MOBILE_COPY.attachLimit(limit), rejected: true };
  }
  const uploaded: PendingAttachment[] = [];
  for (const item of input.items) {
    try {
      uploaded.push(
        await uploadStagedThreadAttachment(input.mode, input.transport, input.threadId, item),
      );
    } catch (cause) {
      if (cause instanceof MobileInboxFailure) {
        return {
          status: "failed",
          message: cause.message,
          rejected: cause.category === "rejected",
        };
      }
      return { status: "failed", message: MOBILE_COPY.attachFailed, rejected: false };
    }
  }
  return { status: "ok", uploaded };
}

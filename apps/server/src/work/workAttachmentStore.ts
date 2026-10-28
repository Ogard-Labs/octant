import {
  MAX_WORK_ATTACHMENT_BYTES,
  MAX_WORK_ATTACHMENT_DISPLAY_NAME_LENGTH,
  MAX_WORK_TURN_ATTACHMENTS,
  decodeWorkAttachmentId,
  decodeWorkThreadId,
  type WorkAttachmentId,
  type WorkAttachmentMediaType,
  type WorkAttachmentReference,
  type WorkThreadId,
} from "@octant/contracts";
import {
  TurnAttachmentStore,
  type TurnQueuedAttachments,
} from "../attachments/turnAttachmentStore";

export type WorkQueuedAttachments = TurnQueuedAttachments<WorkAttachmentReference>;

export { MAX_WORK_ATTACHMENT_BYTES, MAX_WORK_ATTACHMENT_DISPLAY_NAME_LENGTH };

export class WorkAttachmentTooLarge extends Error {
  readonly category = "invalid" as const;

  constructor(readonly byteLength: number) {
    super(
      `Attachment is too large (${byteLength} bytes). The maximum size is ${MAX_WORK_ATTACHMENT_BYTES} bytes.`,
    );
    this.name = "WorkAttachmentTooLarge";
  }
}

export class WorkAttachmentInvalid extends Error {
  readonly category = "invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkAttachmentInvalid";
  }
}

/**
 * The images a Work thread has staged for its next turn, and the bytes of the
 * ones its turns already sent: the one turn-attachment store, carrying this
 * mode's branded ids and limits.
 */
export class WorkAttachmentStore extends TurnAttachmentStore<
  WorkThreadId,
  WorkAttachmentId,
  WorkAttachmentMediaType,
  WorkAttachmentReference
> {
  constructor(dataDirectory: string) {
    super(dataDirectory, {
      scopesDirectory: "work-threads",
      maxBytes: MAX_WORK_ATTACHMENT_BYTES,
      maxTurnAttachments: MAX_WORK_TURN_ATTACHMENTS,
      decodeThreadId: (value) => decodeWorkThreadId(value),
      decodeAttachmentId: (value) => decodeWorkAttachmentId(value),
      tooLarge: (byteLength) => new WorkAttachmentTooLarge(byteLength),
      invalid: (message) => new WorkAttachmentInvalid(message),
      buildReference: (parts) => ({
        attachmentId: parts.attachmentId,
        displayName: parts.displayName,
        mediaType: parts.mediaType,
        byteLength: parts.byteLength,
        digest: parts.digest,
      }),
    });
  }
}

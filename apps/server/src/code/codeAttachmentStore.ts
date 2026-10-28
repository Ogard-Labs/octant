import {
  MAX_CODE_ATTACHMENT_BYTES,
  MAX_CODE_ATTACHMENT_DISPLAY_NAME_LENGTH,
  MAX_CODE_TURN_ATTACHMENTS,
  decodeCodeAttachmentId,
  decodeCodeThreadId,
  type CodeAttachmentId,
  type CodeAttachmentMediaType,
  type CodeAttachmentReference,
  type CodeThreadId,
} from "@octant/contracts";
import {
  TurnAttachmentStore,
  type TurnQueuedAttachments,
} from "../attachments/turnAttachmentStore";

export type CodeQueuedAttachments = TurnQueuedAttachments<CodeAttachmentReference>;

export { MAX_CODE_ATTACHMENT_BYTES, MAX_CODE_ATTACHMENT_DISPLAY_NAME_LENGTH };

export class CodeAttachmentTooLarge extends Error {
  readonly category = "invalid" as const;

  constructor(readonly byteLength: number) {
    super(
      `Attachment is too large (${byteLength} bytes). The maximum size is ${MAX_CODE_ATTACHMENT_BYTES} bytes.`,
    );
    this.name = "CodeAttachmentTooLarge";
  }
}

export class CodeAttachmentInvalid extends Error {
  readonly category = "invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "CodeAttachmentInvalid";
  }
}

/**
 * The images a Code thread has staged for its next turn, and the bytes of the
 * ones its turns already sent: the one turn-attachment store, carrying this
 * mode's branded ids and limits.
 */
export class CodeAttachmentStore extends TurnAttachmentStore<
  CodeThreadId,
  CodeAttachmentId,
  CodeAttachmentMediaType,
  CodeAttachmentReference
> {
  constructor(dataDirectory: string) {
    super(dataDirectory, {
      scopesDirectory: "code-threads",
      maxBytes: MAX_CODE_ATTACHMENT_BYTES,
      maxTurnAttachments: MAX_CODE_TURN_ATTACHMENTS,
      decodeThreadId: (value) => decodeCodeThreadId(value),
      decodeAttachmentId: (value) => decodeCodeAttachmentId(value),
      tooLarge: (byteLength) => new CodeAttachmentTooLarge(byteLength),
      invalid: (message) => new CodeAttachmentInvalid(message),
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

import type { ProviderAttachmentInput } from "@octant/contracts";
import { planProductFeedbackDelivery } from "@octant/domain";
import type { ProductFeedbackService } from "./productFeedbackService";

const MAX_CROP_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export interface ProductFeedbackTurnPortDeps {
  readonly service: Pick<ProductFeedbackService, "deliver" | "readCrop">;
}

/**
 * The seam between notes waiting on a thread and the turn about to run.
 *
 * Marking a note delivered and using it happen together: the service records
 * that each note went, and only the notes it recorded are quoted or attached.
 * A note the journal refused is therefore never sent, which is the honest
 * direction to fail — a note that arrives twice reads as the user asking twice.
 */
export function createProductFeedbackTurnPort(deps: ProductFeedbackTurnPortDeps) {
  return async (input: {
    readonly threadId: string;
    readonly operationId: string;
    readonly supportsImages: boolean;
  }): Promise<{
    readonly context?: string;
    readonly attachments: ReadonlyArray<ProviderAttachmentInput>;
  }> => {
    const carried = deps.service.deliver({
      threadId: String(input.threadId),
      operationId: String(input.operationId),
    });
    if (carried.length === 0) return { attachments: [] };

    const plan = planProductFeedbackDelivery({
      notes: carried.map((note) => ({
        noteId: String(note.id),
        comment: note.comment,
        element: note.element,
        ...(note.crop === undefined ? {} : { cropContentId: String(note.crop.contentId) }),
      })),
      supportsImages: input.supportsImages,
    });

    const attachments: ProviderAttachmentInput[] = [];
    for (const crop of plan.crops) {
      const note = carried.find((candidate) => String(candidate.id) === crop.noteId);
      if (note === undefined) continue;
      const dataUrl = deps.service.readCrop(note);
      const decoded = dataUrl === undefined ? undefined : decodeImageDataUrl(dataUrl);
      // A picture the store no longer holds costs this note its image only. The
      // words already say a picture was meant to travel, so the model is not
      // left believing it saw one.
      if (decoded === undefined) continue;
      attachments.push({
        attachmentId: crop.noteId,
        displayName: "Pointed-at element",
        mediaType: decoded.mediaType,
        bytes: decoded.bytes,
      });
    }

    return {
      ...(plan.context.length === 0 ? {} : { context: plan.context }),
      attachments,
    };
  };
}

function decodeImageDataUrl(
  dataUrl: string,
): { readonly mediaType: string; readonly bytes: Uint8Array } | undefined {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (match === null) return undefined;
  const mediaType = match[1];
  const encoded = match[2];
  if (mediaType === undefined || encoded === undefined) return undefined;
  try {
    const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
    return bytes.byteLength === 0 || bytes.byteLength > MAX_CROP_ATTACHMENT_BYTES
      ? undefined
      : { mediaType, bytes };
  } catch {
    return undefined;
  }
}

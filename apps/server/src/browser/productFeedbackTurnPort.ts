import type { ProviderAttachmentInput, ProductFeedbackNote, WindowId } from "@octant/contracts";
import { planProductFeedbackDelivery } from "@octant/domain";
import type { ProductFeedbackService } from "./productFeedbackService";

const MAX_CROP_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export interface ProductFeedbackTurnPortDeps {
  readonly service: Pick<ProductFeedbackService, "deliver" | "readCrop" | "pendingForTurn">;
  /** Existing host task/window binding, retained before provider preparation. */
  readonly resolveScope?: (
    windowId: WindowId,
    threadId: string,
  ) => { readonly current: () => boolean } | undefined;
}

/**
 * The seam between notes waiting on a thread and the turn about to run.
 *
 * Marking a note delivered and using it happen together: the service records
 * that each note went, and only the notes it recorded are quoted or attached.
 * A note the journal refused is therefore never sent, which is the honest
 * direction to fail — a note that arrives twice reads as the user asking twice.
 */
export interface ProductFeedbackTurnInput {
  readonly threadId: string;
  readonly operationId: string;
  readonly supportsImages: boolean;
}

export interface ProductFeedbackTurnDelivery {
  readonly context?: string;
  readonly attachments: ReadonlyArray<ProviderAttachmentInput>;
}

export interface PreparedProductFeedbackTurn extends ProductFeedbackTurnDelivery {
  /** Claims only this exact prepared version; never a later edited note. */
  readonly take: () => ProductFeedbackTurnDelivery;
}

export function createProductFeedbackTurnPort(deps: ProductFeedbackTurnPortDeps) {
  const format = (
    notes: ReadonlyArray<ProductFeedbackNote>,
    supportsImages: boolean,
  ): ProductFeedbackTurnDelivery => {
    const images = new Map<string, ProviderAttachmentInput>();
    for (const note of notes) {
      if (!supportsImages || note.crop === undefined) continue;
      let dataUrl: string | undefined;
      try {
        dataUrl = deps.service.readCrop(note);
      } catch {
        dataUrl = undefined;
      }
      const decoded = dataUrl === undefined ? undefined : decodeImageDataUrl(dataUrl);
      if (decoded !== undefined)
        images.set(String(note.id), {
          attachmentId: String(note.id),
          displayName: "Pointed-at element",
          mediaType: decoded.mediaType,
          bytes: decoded.bytes,
        });
    }
    const plan = planProductFeedbackDelivery({
      notes: notes.map((note) => ({
        noteId: String(note.id),
        comment: note.comment,
        element: note.element,
        capturedAt: note.capturedAt,
        ...(note.crop === undefined || !images.has(String(note.id))
          ? {}
          : { cropContentId: String(note.crop.contentId) }),
        ...(note.crop === undefined
          ? { cropOmission: "not-captured" as const }
          : !supportsImages
            ? { cropOmission: "unsupported-model" as const }
            : !images.has(String(note.id))
              ? { cropOmission: "unavailable" as const }
              : {}),
      })),
      supportsImages,
    });
    return {
      ...(plan.context.length === 0 ? {} : { context: plan.context }),
      attachments: [...images.values()],
    };
  };
  const take = (input: ProductFeedbackTurnInput): ProductFeedbackTurnDelivery =>
    format(
      deps.service.deliver({ threadId: input.threadId, operationId: input.operationId }),
      input.supportsImages,
    );
  return Object.assign(take, {
    prepare(
      input: ProductFeedbackTurnInput & {
        readonly windowId: WindowId;
        readonly current: () => boolean;
      },
    ): PreparedProductFeedbackTurn {
      const scope = deps.resolveScope?.(input.windowId, input.threadId);
      const current = () => input.current() && scope?.current() !== false;
      if ((deps.resolveScope !== undefined && scope === undefined) || !current())
        throw new Error("Feedback turn admission is no longer current.");
      const notes = deps.service.pendingForTurn(input.threadId);
      const selected = notes.map((note) => ({ noteId: String(note.id), version: note.version }));
      const delivery = format(notes, input.supportsImages);
      if (!current()) throw new Error("Feedback turn admission is no longer current.");
      let taken = false;
      return {
        ...delivery,
        take: () => {
          if (taken || !current()) throw new Error("Prepared feedback is no longer current.");
          taken = true;
          const carried = deps.service.deliver({
            threadId: input.threadId,
            operationId: input.operationId,
            selected,
          });
          if (carried.length !== selected.length)
            throw new Error("Selected feedback changed before delivery.");
          // Publication can synchronously retire the original task/window.
          // Preserve its durable claim, but expose no fresh evidence afterward.
          if (!current())
            throw new Error(
              "Product-note delivery changed after its durable claim. Refresh notes before retrying.",
            );
          return delivery;
        },
      };
    },
  });
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

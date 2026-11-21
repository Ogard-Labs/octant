import type { ProviderAttachmentInput, ProductFeedbackNote, WindowId } from "@octant/contracts";
import { planProductFeedbackDelivery } from "@octant/domain";
import type {
  ProductFeedbackClaimDecision,
  ProductFeedbackService,
} from "./productFeedbackService";

export type { ProductFeedbackClaimDecision };

export type ProductFeedbackTakeResult =
  | { readonly status: "taken"; readonly delivery: ProductFeedbackTurnDelivery }
  | { readonly status: "claim-refused" }
  | { readonly status: "feedback-changed" };

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
  readonly maxAttachments?: number;
}

export interface ProductFeedbackTurnDelivery {
  readonly context?: string;
  readonly attachments: ReadonlyArray<ProviderAttachmentInput>;
}

export interface PreparedProductFeedbackTurn extends ProductFeedbackTurnDelivery {
  /** Claims only this exact prepared version; never a later edited note. */
  readonly take: (maxAttachments?: number) => ProductFeedbackTurnDelivery;
  /**
   * Value-returning claim path that coordinates an in-transaction decision
   * without throwing expected refusals across the port boundary.
   */
  readonly takeWithClaim?: (
    maxAttachments: number | undefined,
    onClaimed?: () => ProductFeedbackClaimDecision,
  ) => ProductFeedbackTakeResult;
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
      deps.service.deliver({
        threadId: input.threadId,
        operationId: input.operationId,
        ...(input.maxAttachments === undefined ? {} : { maxImages: input.maxAttachments }),
      }),
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
      const takeWithClaim = (
        maxAttachments: number | undefined,
        onClaimed?: () => ProductFeedbackClaimDecision,
      ): ProductFeedbackTakeResult => {
        if (maxAttachments !== undefined && delivery.attachments.length > maxAttachments)
          return { status: "feedback-changed" };
        if (taken || !current()) return { status: "feedback-changed" };
        taken = true;
        let claimDecision: ProductFeedbackClaimDecision | undefined;
        let carried: ReadonlyArray<ProductFeedbackNote>;
        try {
          // Both feedback delivery and `onClaimed` join the journal's single
          // SQLite transaction so a refused claim rolls back the delivery and a
          // feedback version conflict skips `onClaimed`. Journal publication
          // runs only after that shared transaction commits.
          carried = deps.service.deliver({
            threadId: input.threadId,
            operationId: input.operationId,
            selected,
            ...(onClaimed === undefined
              ? {}
              : {
                  onClaimed: () => {
                    const decision = onClaimed();
                    claimDecision = decision;
                    return decision;
                  },
                }),
          });
        } catch {
          return { status: "feedback-changed" };
        }
        if (claimDecision?.status === "refused") return { status: "claim-refused" };
        if (carried.length !== selected.length) return { status: "feedback-changed" };
        // Publication can synchronously retire the original task/window after
        // the shared transaction commits. Preserve the durable commit, but
        // refuse the turn so no fresh evidence is exposed afterward.
        if (!current()) return { status: "feedback-changed" };
        return { status: "taken", delivery };
      };
      return {
        ...delivery,
        take: (maxAttachments) => {
          const result = takeWithClaim(maxAttachments);
          if (result.status !== "taken")
            throw new Error("Product-note delivery changed before delivery.");
          return result.delivery;
        },
        takeWithClaim,
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

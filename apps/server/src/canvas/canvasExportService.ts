import { createHash } from "node:crypto";
import type {
  CanvasBlock,
  CanvasDefinition,
  CanvasDesignBlock,
  CanvasId,
  CanvasVersionId,
} from "@octant/contracts/canvas";
import {
  CANVAS_EXPORT_APPROVAL_TTL_MS,
  CANVAS_EXPORT_MAX_PENDING_PER_CANVAS,
  CANVAS_EXPORT_PICTURES_MAX_BYTES,
  canvasExportBodyByteLength,
  decodeCanvasExportApprovalCard,
  decodeCanvasExportDecideResult,
  decodeCanvasExportDelivery,
  decodeCanvasExportOfferList,
  decodeCanvasExportPayloadDigest,
  decodeCanvasExportPrepareResult,
  decodeCanvasExportRecorded,
  decodeCanvasExportRenderedOutput,
  isCanvasExportImplementedFormat,
  isCanvasExportPictureFormat,
  CanvasExportApprovalId,
  CanvasExportRecordId,
  type CanvasExportApprovalCard,
  type CanvasExportDecideResult,
  type CanvasExportDelivery,
  type CanvasExportFrameTheme,
  type CanvasExportOfferList,
  type CanvasExportPictureFormat,
  type CanvasExportPrepareRequest,
  type CanvasExportPrepareResult,
  type CanvasExportRefusal,
  type CanvasExportRenderedOutput,
  type CanvasExportTargetId,
  type CanvasExportTextFormat,
  type CanvasExportLinkChoice,
  type CanvasExportVisibility,
  CANVAS_EXPORT_BODY_MAX_BYTES,
} from "@octant/contracts/canvas-export";
import type { CanvasPublicShareDocument } from "@octant/contracts/canvas-public-share";
import { buildCanvasPublicShareDocument, CanvasSharePolicyRejected } from "@octant/domain";
import type { CanvasExportDestination, CanvasExportTarget } from "@octant/plugin-api/canvas-export";
import {
  offerCanvasExportTargets,
  type CanvasExportActivationFacts,
} from "@octant/plugin-host/canvas-export-contributions";
import type { EventActor, UtcTimestamp } from "@octant/contracts";
import { canvasExportPictureFileNames } from "@octant/domain";
import { Schema } from "effect";
import { renderArtifactDocument, type ArtifactDocumentRender } from "./artifactDocumentRender";
import { renderCanvasDesignExportFrames, renderCanvasDesignPage } from "./canvasDesignPage";
import { CanvasExportEventStore } from "./canvasExportEventStore";
import type {
  CanvasExportPictureFrame,
  CanvasExportPictureRequest,
  CanvasExportRenderer,
} from "./canvasPreviewRenderer";

/**
 * Server-owned Canvas export.
 *
 * A destination plugin is reached only through the published export port, and
 * only after the person approves the rendered payload and that destination.
 * Preparing an approval does not call the plugin and does not journal an
 * export. Denying one does neither. The journal records the completed export
 * so a restart can replay it.
 */
export interface CanvasExportTargetBinding {
  readonly facts: CanvasExportActivationFacts;
  readonly target: CanvasExportTarget;
}

export interface CanvasExportDocument {
  readonly canvasId: CanvasId;
  readonly versionId: CanvasVersionId;
  readonly sequence: number;
  readonly title: string;
  readonly blocks: ReadonlyArray<CanvasBlock>;
  /**
   * The whole definition, which a picture of the document is drawn from with
   * the thread's own renderer. A loader that hands over the blocks alone can
   * still export text and a design's frames.
   */
  readonly definition?: CanvasDefinition;
}

export interface CanvasExportServiceOptions {
  readonly load: (
    canvasId: CanvasId,
    versionId?: CanvasVersionId,
  ) => CanvasExportDocument | undefined;
  /**
   * The destinations offered for one Canvas. Facts are per Canvas: whether a
   * destination is connected can depend on where that Canvas's Project exports.
   */
  readonly targets: (canvasId: CanvasId) => ReadonlyArray<CanvasExportTargetBinding>;
  readonly eventStore: CanvasExportEventStore;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  /**
   * The host's own browser, which draws a picture export. Absent on a host
   * that has none, where a picture export is refused as a value.
   */
  readonly renderer?: CanvasExportRenderer;
}

/**
 * A held approval, or a tombstone for one already released. The tombstone
 * keeps a closed-or-evicted dialog answerable exactly once — as an `expired`
 * refusal — while dropping the payload it used to pin.
 */
type PendingExport =
  | {
      readonly released?: undefined;
      readonly canvasId: CanvasId;
      readonly card: CanvasExportPrepareResult & { readonly kind: "approval" };
      readonly output: CanvasExportRenderedOutput;
      /**
       * The destination the card named, if it named one. Passed back to the
       * target on approval, which is what lets it replace an existing file.
       */
      readonly confirmedDestination?: CanvasExportDestination;
      /** Instant past which answering this approval is an `expired` refusal. */
      readonly expiresAtMs: number;
    }
  | {
      readonly released: true;
      readonly canvasId: CanvasId;
    };

const decodeApprovalId = Schema.decodeUnknownSync(CanvasExportApprovalId);
const decodeRecordId = Schema.decodeUnknownSync(CanvasExportRecordId);

function refused(code: CanvasExportRefusal["code"], message: string): CanvasExportRefusal {
  return { kind: "refused", code, message };
}

export class CanvasExportService {
  readonly #load: CanvasExportServiceOptions["load"];
  readonly #targets: CanvasExportServiceOptions["targets"];
  readonly #eventStore: CanvasExportEventStore;
  readonly #uuid: () => string;
  readonly #clock: () => UtcTimestamp;
  readonly #renderer: CanvasExportRenderer | undefined;
  readonly #pending = new Map<string, PendingExport>();

  constructor(options: CanvasExportServiceOptions) {
    this.#load = options.load;
    this.#targets = options.targets;
    this.#eventStore = options.eventStore;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#renderer = options.renderer;
  }

  offers(canvasId: CanvasId): CanvasExportOfferList | undefined {
    const document = this.#load(canvasId);
    if (document === undefined) return undefined;
    return decodeCanvasExportOfferList({
      schemaVersion: 1,
      kind: "canvas-export-offers",
      canvasId: document.canvasId,
      versionId: document.versionId,
      sequence: document.sequence,
      targets: offerCanvasExportTargets(
        this.#targets(canvasId).map((binding) => ({
          contribution: binding.target.contribution,
          facts: binding.facts,
        })),
      ),
    });
  }

  /**
   * Render the document and hold an approval card. The destination is not
   * called. A text form renders at once; a picture form is drawn in the host's
   * browser first, so the card names exactly the files it holds and a host
   * with no browser refuses here, before anything is held.
   */
  async prepare(
    request: CanvasExportPrepareRequest,
    permitted: boolean,
    /** Who asked, as the transport authenticated it. A link needs a local window. */
    requester: "local-window" | "remote-device" = "local-window",
  ): Promise<CanvasExportPrepareResult> {
    if (!permitted) {
      return decodeCanvasExportPrepareResult(
        refused("unauthorized", "Export is not authorized for this canvas."),
      );
    }
    const document = this.#load(request.canvasId, request.versionId);
    if (document === undefined) {
      return decodeCanvasExportPrepareResult(refused("unavailable", "Canvas is unavailable."));
    }
    if (
      String(document.versionId) !== String(request.versionId) ||
      document.sequence !== request.expectedSequence
    ) {
      return decodeCanvasExportPrepareResult(
        refused("malformed", "Export does not match the open canvas version."),
      );
    }
    if (!isCanvasExportImplementedFormat(request.format)) {
      return decodeCanvasExportPrepareResult(
        refused("unsupported-format", "This host cannot render that format."),
      );
    }
    const offer = this.#offerFor(request.targetId, document.canvasId);
    if (offer === undefined) {
      return decodeCanvasExportPrepareResult(
        refused("not-offered", "That destination is not offered."),
      );
    }
    if (offer.status === "not-connected") {
      return decodeCanvasExportPrepareResult(
        refused("not-connected", offer.message ?? "This destination is not connected."),
      );
    }
    if (offer.status !== "ready" || !offer.formats.includes(request.format)) {
      return decodeCanvasExportPrepareResult(
        refused("refused", offer.message ?? "That destination cannot accept this export."),
      );
    }

    const rendered = isCanvasExportPictureFormat(request.format)
      ? await this.#renderPictures(document, request.format, request.frameTheme)
      : renderText(document, request.format, request.frameTheme, this.#clock());
    if (rendered.kind === "refused") return decodeCanvasExportPrepareResult(rendered);
    const approvalId = decodeApprovalId(this.#uuid());
    let output: CanvasExportRenderedOutput;
    try {
      output = decodeCanvasExportRenderedOutput({
        schemaVersion: 1,
        kind: "canvas-export-output",
        format: rendered.format,
        title: document.title,
        ...(rendered.kind === "text" ? { body: rendered.body } : { files: rendered.files }),
        metadata: {
          canvasId: document.canvasId,
          versionId: document.versionId,
          sequence: document.sequence,
          byteLength: rendered.byteLength,
          contentDigest: rendered.payloadDigest,
        },
      });
    } catch {
      return decodeCanvasExportPrepareResult(
        refused("malformed", "The rendered document cannot be exported."),
      );
    }
    const binding = this.#soleTargetBinding(offer.targetId, document.canvasId);
    // A destination that can describe itself does so here, so the person
    // approves a place and its terms rather than a destination's promise.
    // Naming a file is also what makes the approval a confirmation to replace
    // an existing one; naming an account and an audience is what lets the
    // person see whose name it goes out under and who can see it.
    const destination = withoutChoice(binding?.target.describeDestination?.(output));
    // A link opens for anyone who holds it, so only the person at a local
    // window may publish one; a paired device can read links, not mint them.
    if (destination?.linkTerms !== undefined && requester !== "local-window") {
      return decodeCanvasExportPrepareResult(
        refused(
          "unauthorized",
          "A public link can be published only from a window on this computer.",
        ),
      );
    }
    const nowMs = Date.parse(this.#clock());
    const expiresAtMs = nowMs + CANVAS_EXPORT_APPROVAL_TTL_MS;
    const card = decodeCanvasExportApprovalCard({
      schemaVersion: 1,
      kind: "canvas-export-approval",
      approvalId,
      canvasId: document.canvasId,
      versionId: document.versionId,
      sequence: document.sequence,
      targetId: offer.targetId,
      destinationLabel: offer.label,
      format: rendered.format,
      title: document.title,
      ...(destination?.path === undefined
        ? {}
        : {
            destinationPath: destination.path,
            replacesExisting: destination.replacesExisting ?? false,
            ...(destination.alsoReplaces === undefined || destination.alsoReplaces.length === 0
              ? {}
              : { alsoReplaces: destination.alsoReplaces }),
          }),
      ...(destination?.account === undefined ? {} : { destinationAccount: destination.account }),
      ...(destination?.visibility === undefined
        ? {}
        : { destinationVisibility: destination.visibility }),
      ...(destination?.note === undefined ? {} : { destinationNote: destination.note }),
      ...rendered.card,
      ...(destination?.linkTerms === undefined
        ? {}
        : { destinationLinkTerms: destination.linkTerms }),
      payloadDigest: rendered.payloadDigest,
      byteLength: rendered.byteLength,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    const result = decodeCanvasExportPrepareResult({ kind: "approval", card });
    if (result.kind === "approval") {
      this.#holdPending(document.canvasId, {
        card: result,
        output,
        expiresAtMs,
        ...(destination === undefined ? {} : { confirmedDestination: destination }),
      });
    }
    return result;
  }

  /**
   * Release a held approval. A denial, an expired or missing approval, and a
   * destination that is no longer ready never call the plugin. The completed
   * export is journaled under `actor` — the authenticated transport principal
   * of the request that was approved — so a remote approval never replays as
   * a local one.
   */
  async decide(input: {
    readonly canvasId: CanvasId;
    readonly approvalId: CanvasExportApprovalId;
    readonly decision: "approved" | "denied";
    readonly permitted: boolean;
    readonly actor: EventActor;
    /**
     * The audience the person chose on the card. Absent keeps whatever the
     * destination described; a destination that offered no audience ignores it.
     */
    readonly visibility?: CanvasExportVisibility;
    /** The expiry and password the person chose, when the card offered link terms. */
    readonly link?: CanvasExportLinkChoice;
  }): Promise<CanvasExportDecideResult> {
    const key = String(input.approvalId);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      return decodeCanvasExportDecideResult(
        refused("approval-required", "Export requires approval."),
      );
    }
    // An evicted or swept approval keeps a payload-free tombstone so the closed
    // dialog is answered once as expired, then forgotten.
    if (pending.released === true) {
      this.#pending.delete(key);
      return decodeCanvasExportDecideResult(
        refused("expired", "This export approval has expired."),
      );
    }
    if (String(pending.card.card.canvasId) !== String(input.canvasId)) {
      return decodeCanvasExportDecideResult(
        refused("unauthorized", "Export is not authorized for this canvas."),
      );
    }
    if (!input.permitted || input.decision === "denied") {
      this.#pending.delete(key);
      if (!input.permitted) {
        return decodeCanvasExportDecideResult(
          refused("unauthorized", "Export is not authorized for this canvas."),
        );
      }
      return decodeCanvasExportDecideResult({
        kind: "denied",
        message: "Export was not approved.",
      });
    }
    if (pending.expiresAtMs <= Date.parse(this.#clock())) {
      this.#pending.delete(key);
      return decodeCanvasExportDecideResult(
        refused("expired", "This export approval has expired."),
      );
    }

    if (
      pending.confirmedDestination?.linkTerms !== undefined &&
      input.actor.kind === "remote-device"
    ) {
      this.#pending.delete(key);
      return decodeCanvasExportDecideResult(
        refused(
          "unauthorized",
          "A public link can be published only from a window on this computer.",
        ),
      );
    }
    const offer = this.#offerFor(pending.card.card.targetId, pending.card.card.canvasId);
    if (offer === undefined || offer.status !== "ready") {
      this.#pending.delete(key);
      return decodeCanvasExportDecideResult(
        refused("not-offered", "That destination is not offered."),
      );
    }
    // Delivery goes through the binding the offer was made from. Two bindings
    // sharing one id is ambiguous: the offer omits it, and a stale approval
    // for it is refused rather than resolved by binding order.
    const binding = this.#soleTargetBinding(pending.card.card.targetId, pending.card.card.canvasId);
    if (binding === undefined) {
      this.#pending.delete(key);
      return decodeCanvasExportDecideResult(
        refused("not-offered", "That destination is not offered."),
      );
    }

    this.#pending.delete(key);
    // The audience the person chose on the card travels back to the target as
    // part of the approved destination; the target described the default it
    // showed, and nothing here lets a choice reach a destination that never
    // offered one.
    const delivery = await this.#deliver(
      binding.target,
      pending.output,
      confirmedDestination(pending.confirmedDestination, input.visibility, input.link),
    );
    const record = decodeCanvasExportRecorded({
      schemaVersion: 1,
      kind: "canvas-export",
      exportId: decodeRecordId(this.#uuid()),
      canvasId: pending.output.metadata.canvasId,
      versionId: pending.output.metadata.versionId,
      sequence: pending.output.metadata.sequence,
      targetId: pending.card.card.targetId,
      destinationLabel: pending.card.card.destinationLabel,
      format: pending.output.format,
      payloadDigest: pending.output.metadata.contentDigest,
      approvalId: pending.card.card.approvalId,
      outcome: delivery,
    });
    // The destination has already been called, so a journal failure must not
    // read as a failed export: say it was delivered and could not be recorded.
    try {
      this.#eventStore.append({ record, occurredAt: this.#clock(), actor: input.actor });
    } catch {
      console.error("A Canvas export was delivered but could not be journaled.");
      return decodeCanvasExportDecideResult({
        kind: "unrecorded",
        outcome: delivery,
        message: "The export was delivered, but this host could not record it.",
      });
    }
    return decodeCanvasExportDecideResult({ kind: "exported", record });
  }

  /**
   * Hold a new approval within the per-canvas bound. An expired or evicted
   * entry releases its payload; nothing is held past its expiry in practice,
   * and eviction is reported as `expired` when an answer arrives.
   */
  #holdPending(
    canvasId: CanvasId,
    pending: Omit<Extract<PendingExport, { readonly released?: undefined }>, "canvasId">,
  ): void {
    const canvasKey = String(canvasId);
    this.#sweepExpired();
    const held = [...this.#pending.entries()].filter(
      (entry): entry is [string, Extract<PendingExport, { readonly released?: undefined }>] =>
        entry[1].released !== true && String(entry[1].canvasId) === canvasKey,
    );
    while (held.length >= CANVAS_EXPORT_MAX_PENDING_PER_CANVAS) {
      const oldest = held.shift();
      if (oldest !== undefined) {
        // Release the payload, but keep the id answerable once as expired.
        this.#pending.set(oldest[0], { released: true, canvasId });
      }
    }
    this.#pending.set(String(pending.card.card.approvalId), { ...pending, canvasId });
  }

  /** Drop payloads whose deadline passed; an unanswered dialog cannot pin one. */
  #sweepExpired(): void {
    const nowMs = Date.parse(this.#clock());
    for (const [key, entry] of this.#pending) {
      if (entry.released === true) continue;
      if (entry.expiresAtMs <= nowMs) {
        this.#pending.set(key, { released: true, canvasId: entry.canvasId });
      }
    }
  }

  #offerFor(targetId: CanvasExportTargetId, canvasId: CanvasId) {
    return offerCanvasExportTargets(
      this.#targets(canvasId).map((binding) => ({
        contribution: binding.target.contribution,
        facts: binding.facts,
      })),
    ).find((offer) => String(offer.targetId) === String(targetId));
  }

  #targetBindings(
    targetId: CanvasExportTargetId,
    canvasId: CanvasId,
  ): ReadonlyArray<CanvasExportTargetBinding> {
    return this.#targets(canvasId).filter(
      (binding) => String(binding.target.contribution.targetId) === String(targetId),
    );
  }

  /** The one binding that declares this id, or nothing when the id is ambiguous. */
  #soleTargetBinding(
    targetId: CanvasExportTargetId,
    canvasId: CanvasId,
  ): CanvasExportTargetBinding | undefined {
    const bindings = this.#targetBindings(targetId, canvasId);
    return bindings.length === 1 ? bindings[0] : undefined;
  }

  async #deliver(
    target: CanvasExportTarget,
    output: CanvasExportRenderedOutput,
    confirmed?: CanvasExportDestination,
  ): Promise<CanvasExportDelivery> {
    try {
      return decodeCanvasExportDelivery(await target.exportDocument(output, confirmed));
    } catch {
      return refused("refused", "The destination did not complete the export.");
    }
  }

  /**
   * Draw the pictures in the host's browser. A design's device-size frames are
   * drawn one to a picture, the way the HTML export writes them; a Canvas with
   * none is drawn as the thread draws it. A host with no browser, a build with
   * no renderer, and a drawing that failed are each a refusal the person reads.
   */
  async #renderPictures(
    document: CanvasExportDocument,
    format: CanvasExportPictureFormat,
    frameTheme: CanvasExportFrameTheme | undefined,
  ): Promise<Rendered | CanvasExportRefusal> {
    const renderer = this.#renderer;
    if (renderer === undefined || !(await renderer.available())) {
      return refused(
        "unavailable",
        "This host has no browser to draw pictures with. Export as HTML or Markdown instead.",
      );
    }
    const subject = pictureSubject(document, frameTheme);
    if (subject.kind === "refused") return subject;
    const drawn = await renderer.renderPictures({
      format,
      theme: frameTheme?.scheme ?? "light",
      subject,
    });
    if (drawn.kind !== "rendered") {
      return refused(
        "unavailable",
        drawn.reason === "no-browser"
          ? "This host has no browser to draw pictures with. Export as HTML or Markdown instead."
          : drawn.reason === "no-renderer"
            ? "This build carries no Canvas renderer to draw pictures with."
            : "The browser could not draw this Canvas.",
      );
    }
    const names = canvasExportPictureFileNames(document.title, format, drawn.files.length);
    const files = drawn.files.map((bytes, index) => ({
      name: names[index] ?? `${String(index + 1)}.${format}`,
      bytes,
    }));
    const byteLength = files.reduce((total, file) => total + file.bytes.length, 0);
    if (byteLength > CANVAS_EXPORT_PICTURES_MAX_BYTES) {
      return refused("too-large", "The rendered pictures are too large to export.");
    }
    // A PDF is one page per design frame, or one per deck slide followed by
    // the design frames the deck does not place.
    const pages =
      format !== "pdf"
        ? undefined
        : subject.kind === "frames"
          ? subject.frames.length
          : subject.kind === "slides"
            ? subject.slides.length + (subject.frames?.length ?? 0)
            : undefined;
    return {
      kind: "pictures",
      format,
      files,
      byteLength,
      payloadDigest: decodeCanvasExportPayloadDigest(digestOfFiles(files)),
      card: {
        files: files.map((file) => ({ name: file.name, byteLength: file.bytes.length })),
        ...(pages === undefined ? {} : { pages }),
        ...(subject.kind === "frames" ? { drawsDesignFrames: true as const } : {}),
        ...(subject.kind === "slides" &&
        subject.slides.some((slide) =>
          slide.definition.blocks.some((block) => block.kind === "design"),
        )
          ? { drawsDesignFrames: true as const }
          : {}),
      },
    };
  }
}

/**
 * What one prepare rendered: the output's own part, its weight and digest,
 * and what the card shows of it — the body of a text form, the files of a
 * picture form.
 */
type Rendered =
  | {
      readonly kind: "text";
      readonly format: CanvasExportTextFormat;
      readonly body: string;
      readonly byteLength: number;
      readonly payloadDigest: ReturnType<typeof decodeCanvasExportPayloadDigest>;
      readonly card: Pick<CanvasExportApprovalCard, "payload" | "writesDesignMarkup">;
    }
  | {
      readonly kind: "pictures";
      readonly format: CanvasExportPictureFormat;
      readonly files: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
      readonly byteLength: number;
      readonly payloadDigest: ReturnType<typeof decodeCanvasExportPayloadDigest>;
      readonly card: {
        readonly files: ReadonlyArray<{ readonly name: string; readonly byteLength: number }>;
        readonly pages?: number;
        readonly drawsDesignFrames?: true;
      };
    };

/**
 * A design's frames are written into the HTML form, and the card says so:
 * approving it is the person's acknowledgement that markup leaves as
 * written, which the share filter cannot check.
 */
function renderText(
  document: CanvasExportDocument,
  format: CanvasExportTextFormat,
  frameTheme: CanvasExportFrameTheme | undefined,
  publishedAt: UtcTimestamp,
): Rendered | CanvasExportRefusal {
  const rendered =
    format === "share-document"
      ? renderShareDocument(document, publishedAt)
      : renderArtifactDocument(document, format, {
          frames: "as-written",
          ...(frameTheme === undefined ? {} : { frameTheme }),
        });
  if (rendered.kind === "refused") return refused("refused", rendered.message);
  if (rendered.kind === "too-large") {
    return refused("too-large", "The rendered document is too large to export.");
  }
  return {
    kind: "text",
    format,
    body: rendered.body,
    byteLength: canvasExportBodyByteLength(rendered.body),
    payloadDigest: decodeCanvasExportPayloadDigest(digestOf(rendered.body)),
    card: {
      payload: rendered.body,
      ...(rendered.writesDesignMarkup ? { writesDesignMarkup: true as const } : {}),
    },
  };
}

/**
 * What a picture export draws: every device-size frame of every design, each
 * the standalone page the HTML export writes for it, or — when the Canvas
 * holds none — the document itself, with a running design's page built as
 * the preview builds it so a prototype runs in the picture.
 *
 * A themed design needs the theme the window draws it with; the window sends
 * it with every picture request, so refusing without one is the honest
 * answer to a request that did not come from the window.
 */
function pictureSubject(
  document: CanvasExportDocument,
  frameTheme: CanvasExportFrameTheme | undefined,
): CanvasExportPictureRequest["subject"] | CanvasExportRefusal {
  // A Canvas that holds a deck presents it: the deck's slides are the
  // subject, one sheet each, so a picture export is one deck page per slide.
  const deck = document.blocks.find(
    (block): block is Extract<CanvasBlock, { kind: "deck" }> => block.kind === "deck",
  );
  if (deck !== undefined && document.definition !== undefined) {
    const byId = new Map(
      document.blocks.map((block) => [String(block.blockId), block as CanvasBlock]),
    );
    const slides: Array<{ definition: CanvasDefinition }> = [];
    for (const slide of deck.slides) {
      const placed = byId.get(String(slide.blockId));
      if (placed === undefined) continue;
      let block = placed;
      if (placed.kind === "design" && slide.frameId !== undefined) {
        // A design slide shows the one frame the deck names, so the block the
        // slide's page draws carries that frame alone.
        block = {
          ...placed,
          frames: placed.frames.filter((frame) => String(frame.frameId) === String(slide.frameId)),
        };
      }
      if (placed.kind === "mockup" && slide.variantId !== undefined) {
        // A mockup slide shows the one variant the deck names; the block's
        // other variants stay on the screen, not on this slide.
        const variant = placed.variants?.find(
          (candidate) => String(candidate.variantId) === String(slide.variantId),
        );
        if (variant !== undefined) {
          block = { ...placed, variants: [variant] };
        }
      }
      slides.push({
        definition: {
          ...document.definition,
          title: placed.kind === "design" || placed.kind === "mockup" ? placed.title : deck.title,
          blocks: [block],
        },
      });
    }
    if (slides.length > 0) {
      // A design the deck does not place keeps its own sheets after the
      // deck's slides, so presenting one Canvas drops no screens it holds
      // beside it.
      const named = new Set(deck.slides.map((slide) => String(slide.blockId)));
      const loose: CanvasExportPictureFrame[] = [];
      for (const block of document.blocks) {
        if (
          block.kind !== "design" ||
          block.size === "document" ||
          named.has(String(block.blockId))
        ) {
          continue;
        }
        const pages = renderCanvasDesignExportFrames(block, frameTheme);
        if (pages === undefined) {
          return refused(
            "malformed",
            "A design in the workspace theme needs the theme the window draws it with.",
          );
        }
        for (const page of pages) {
          if (page.width === undefined) continue;
          loose.push({
            page: page.page,
            sandbox: page.sandbox,
            width: page.width,
            height: page.height,
          });
        }
      }
      return {
        kind: "slides",
        slides,
        ...(loose.length === 0 ? {} : { frames: loose }),
      };
    }
  }
  const frames: CanvasExportPictureFrame[] = [];
  for (const block of document.blocks) {
    if (block.kind !== "design" || block.size === "document") continue;
    const pages = renderCanvasDesignExportFrames(block, frameTheme);
    if (pages === undefined) {
      return refused(
        "malformed",
        "A design in the workspace theme needs the theme the window draws it with.",
      );
    }
    for (const page of pages) {
      if (page.width === undefined) continue;
      frames.push({
        page: page.page,
        sandbox: page.sandbox,
        width: page.width,
        height: page.height,
      });
    }
  }
  if (frames.length > 0) return { kind: "frames", frames };
  const definition = document.definition;
  if (definition === undefined) {
    return refused("unavailable", "This Canvas cannot be drawn as a picture on this host.");
  }
  return {
    kind: "document",
    definition,
    designPages: definition.blocks
      .filter(
        (block): block is CanvasDesignBlock => block.kind === "design" && block.runsScript === true,
      )
      .map((block) => ({
        blockId: String(block.blockId),
        html: renderCanvasDesignPage(block, String(block.frames[0]?.frameId ?? ""), []),
      })),
  };
}

/**
 * The share document a link destination draws itself, as the JSON it sends.
 * It is built by the same filter an authenticated snapshot passes, without
 * host, Project, thread, Canvas, or source identity; the card shows it whole.
 */
function renderShareDocument(
  document: CanvasExportDocument,
  publishedAt: UtcTimestamp,
): ArtifactDocumentRender | { readonly kind: "refused"; readonly message: string } {
  let shared: CanvasPublicShareDocument;
  try {
    shared = buildCanvasPublicShareDocument({
      definition: document,
      publishedAt,
      // The card this body is shown on says the markup leaves as written, and
      // approving it is the acknowledgement; nothing is sent before that.
      markupAcknowledged: true,
    });
  } catch (error) {
    if (error instanceof CanvasSharePolicyRejected) {
      return {
        kind: "refused",
        message: "This Canvas holds something a public link cannot carry.",
      };
    }
    throw error;
  }
  const body = JSON.stringify(shared, null, 2);
  if (canvasExportBodyByteLength(body) > CANVAS_EXPORT_BODY_MAX_BYTES) return { kind: "too-large" };
  return {
    kind: "rendered",
    title: shared.title,
    body,
    writesDesignMarkup: shared.blocks.some((block) => block.kind === "design"),
  };
}

/** A described destination never carries a choice; only the host adds one. */
function withoutChoice(
  destination: CanvasExportDestination | undefined,
): CanvasExportDestination | undefined {
  if (destination?.link === undefined) return destination;
  const { link: _link, ...described } = destination;
  return described;
}

function digestOf(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/** One digest over the set: each file's name and bytes, in writing order. */
function digestOfFiles(
  files: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name).update("\0").update(file.bytes).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * The approved destination, with the audience the person chose folded in.
 *
 * Without a choice the destination's own description stands. A choice only
 * ever reaches a destination that offered an audience on its card — one that
 * described none never hears a choice — and it only ever adds the audience
 * field, so a destination the person never confirmed still cannot replace an
 * existing file.
 */
function confirmedDestination(
  destination: CanvasExportDestination | undefined,
  visibility: CanvasExportVisibility | undefined,
  link: CanvasExportLinkChoice | undefined,
): CanvasExportDestination | undefined {
  if (destination === undefined) return undefined;
  const withVisibility =
    visibility === undefined || destination.visibility === undefined
      ? destination
      : { ...destination, visibility };
  // A link destination always hears an expiry: the person's choice, or the
  // default the card showed them. A destination that offered no terms hears
  // no choice, as with the audience.
  if (destination.linkTerms === undefined) return withVisibility;
  return {
    ...withVisibility,
    link: link ?? {
      expiry: { kind: "days", days: destination.linkTerms.defaultExpiryDays },
    },
  };
}

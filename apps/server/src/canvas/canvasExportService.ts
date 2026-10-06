import { createHash } from "node:crypto";
import type { CanvasBlock, CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import {
  CANVAS_EXPORT_APPROVAL_TTL_MS,
  CANVAS_EXPORT_MAX_PENDING_PER_CANVAS,
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
  CanvasExportApprovalId,
  CanvasExportRecordId,
  type CanvasExportDecideResult,
  type CanvasExportDelivery,
  type CanvasExportImplementedFormat,
  type CanvasExportOfferList,
  type CanvasExportPrepareRequest,
  type CanvasExportPrepareResult,
  type CanvasExportRecorded,
  type CanvasExportRefusal,
  type CanvasExportRenderedOutput,
  type CanvasExportTargetId,
} from "@octant/contracts/canvas-export";
import type { CanvasExportDestination, CanvasExportTarget } from "@octant/plugin-api/canvas-export";
import {
  offerCanvasExportTargets,
  type CanvasExportActivationFacts,
} from "@octant/plugin-host/canvas-export-contributions";
import type { EventActor, UtcTimestamp } from "@octant/contracts";
import { Schema } from "effect";
import { renderArtifactDocument } from "./artifactDocumentRender";
import { CanvasExportEventStore } from "./canvasExportEventStore";

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
  readonly #pending = new Map<string, PendingExport>();

  constructor(options: CanvasExportServiceOptions) {
    this.#load = options.load;
    this.#targets = options.targets;
    this.#eventStore = options.eventStore;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
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
   * Render the document and hold an approval card. The destination is not called.
   */
  prepare(request: CanvasExportPrepareRequest, permitted: boolean): CanvasExportPrepareResult {
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

    const rendered = renderArtifactDocument(document, request.format);
    if (rendered.kind === "too-large") {
      return decodeCanvasExportPrepareResult(
        refused("too-large", "The rendered document is too large to export."),
      );
    }
    const payloadDigest = decodeCanvasExportPayloadDigest(digestOf(rendered.body));
    const approvalId = decodeApprovalId(this.#uuid());
    const byteLength = canvasExportBodyByteLength(rendered.body);
    let output: CanvasExportRenderedOutput;
    try {
      output = decodeCanvasExportRenderedOutput({
        schemaVersion: 1,
        kind: "canvas-export-output",
        format: request.format,
        title: rendered.title,
        body: rendered.body,
        metadata: {
          canvasId: document.canvasId,
          versionId: document.versionId,
          sequence: document.sequence,
          byteLength,
          contentDigest: payloadDigest,
        },
      });
    } catch {
      return decodeCanvasExportPrepareResult(
        refused("malformed", "The rendered document cannot be exported."),
      );
    }
    const binding = this.#soleTargetBinding(offer.targetId, document.canvasId);
    // A destination that can name its file does so here, so the person
    // approves a place rather than a destination's promise. Naming it is also
    // what makes the approval a confirmation to replace an existing file.
    const destination = binding?.target.describeDestination?.(output);
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
      format: request.format,
      title: rendered.title,
      ...(destination === undefined
        ? {}
        : { destinationPath: destination.path, replacesExisting: destination.replacesExisting }),
      payload: rendered.body,
      payloadDigest,
      byteLength,
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
    const delivery = await this.#deliver(
      binding.target,
      pending.output,
      pending.confirmedDestination,
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
}

function digestOf(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

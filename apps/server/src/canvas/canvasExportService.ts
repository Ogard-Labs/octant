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
  type CanvasExportVisibility,
} from "@octant/contracts/canvas-export";
import { canvasExportPlannedName } from "@octant/domain";
import type {
  CanvasExportDestination,
  CanvasExportGrants,
  CanvasExportTarget,
} from "@octant/plugin-api/canvas-export";
import type { PagePublisherOffer } from "@octant/plugin-api/page-publishing";
import {
  offerCanvasExportTargets,
  type CanvasExportActivationFacts,
} from "@octant/plugin-host/canvas-export-contributions";
import type {
  EventActor,
  PagePublishOutcome,
  PagePublishRequest,
  ProviderInstanceId,
  UtcTimestamp,
} from "@octant/contracts";
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

/**
 * The host's page publishing, as the export service holds it. The service is
 * the only caller of `publish`: it calls it from the single-use grant it hands
 * a destination inside an approved export, with the render the person
 * approved, so the account side effect happens only behind the approval.
 */
export interface CanvasExportPagePublishing {
  readonly publishers: () => ReadonlyArray<PagePublisherOffer>;
  readonly publish: (
    instanceId: ProviderInstanceId,
    request: PagePublishRequest,
  ) => Promise<PagePublishOutcome>;
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
  /** Absent on a host that publishes no pages; every page grant then refuses. */
  readonly pagePublishing?: CanvasExportPagePublishing;
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
      /**
       * The one provider instance the card's account belongs to, when the
       * destination publishes a page. The export's page grant publishes here
       * and nowhere else.
       */
      readonly publisher?: ProviderInstanceId;
      /** Instant past which answering this approval is an `expired` refusal. */
      readonly expiresAtMs: number;
    }
  | {
      readonly released: true;
      readonly canvasId: CanvasId;
    };

type HeldExport = Extract<PendingExport, { readonly released?: undefined }>;

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
  readonly #pagePublishing: CanvasExportPagePublishing | undefined;
  readonly #pending = new Map<string, PendingExport>();

  constructor(options: CanvasExportServiceOptions) {
    this.#load = options.load;
    this.#targets = options.targets;
    this.#eventStore = options.eventStore;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#pagePublishing = options.pagePublishing;
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

    // A design's frames are written into the HTML form, and the card below
    // says so: approving it is the person's acknowledgement that markup
    // leaves as written, which the share filter cannot check.
    const rendered = renderArtifactDocument(document, request.format, {
      frames: "as-written",
      ...(request.frameTheme === undefined ? {} : { frameTheme: request.frameTheme }),
    });
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
    // A destination that can describe itself does so here, so the person
    // approves a place and its terms rather than a destination's promise.
    // Naming a file is also what makes the approval a confirmation to replace
    // an existing one; naming an account and an audience is what lets the
    // person see whose name it goes out under and who can see it.
    const destination = binding?.target.describeDestination?.(output);
    // A destination that publishes a page names the instance; the host names
    // the account. The card shows the account the host knows for that
    // instance, never the destination's own claim, and an instance the host
    // does not list as ready to publish is refused before any card exists,
    // because the grant issued on approval could only refuse it anyway.
    const publisher =
      destination?.publisher === undefined
        ? undefined
        : this.#readyPublisher(destination.publisher);
    if (destination?.publisher !== undefined && publisher === undefined) {
      return decodeCanvasExportPrepareResult(
        refused("refused", "That destination cannot publish a page on that account."),
      );
    }
    const account = publisher?.availability.account ?? destination?.account;
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
      ...(destination?.path === undefined
        ? {}
        : {
            destinationPath: destination.path,
            replacesExisting: destination.replacesExisting ?? false,
          }),
      ...(account === undefined ? {} : { destinationAccount: account }),
      ...(destination?.visibility === undefined
        ? {}
        : { destinationVisibility: destination.visibility }),
      ...(destination?.note === undefined ? {} : { destinationNote: destination.note }),
      ...(rendered.writesDesignMarkup ? { writesDesignMarkup: true } : {}),
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
        ...(publisher === undefined ? {} : { publisher: publisher.instanceId }),
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
    // The audience the person chose on the card travels back to the target as
    // part of the approved destination; the target described the default it
    // showed, and nothing here lets a choice reach a destination that never
    // offered one.
    const delivery = await this.#deliver(
      binding.target,
      pending,
      confirmedDestination(pending.confirmedDestination, input.visibility),
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
  #holdPending(canvasId: CanvasId, pending: Omit<HeldExport, "canvasId">): void {
    const canvasKey = String(canvasId);
    this.#sweepExpired();
    const held = [...this.#pending.entries()].filter(
      (entry): entry is [string, HeldExport] =>
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

  /** The listed publisher with this id, when it can publish right now. */
  #readyPublisher(
    instanceId: ProviderInstanceId,
  ): (PagePublisherOffer & { readonly availability: { readonly kind: "ready" } }) | undefined {
    const offer = this.#pagePublishing
      ?.publishers()
      .find((candidate) => String(candidate.instanceId) === String(instanceId));
    if (offer === undefined || offer.availability.kind !== "ready") return undefined;
    return { ...offer, availability: offer.availability };
  }

  /**
   * Call the destination with the approved render, the confirmed destination,
   * and a page grant that lives exactly as long as this call. The grant is
   * closed whether the destination returns, throws, or hands the grant to
   * something that outlives it: nothing publishes after delivery settles.
   */
  async #deliver(
    target: CanvasExportTarget,
    pending: HeldExport,
    confirmed?: CanvasExportDestination,
  ): Promise<CanvasExportDelivery> {
    const grant = issuePageGrant(pending, this.#pagePublishing);
    try {
      return decodeCanvasExportDelivery(
        await target.exportDocument(pending.output, confirmed, grant.grants),
      );
    } catch {
      return refused("refused", "The destination did not complete the export.");
    } finally {
      grant.settle();
    }
  }
}

/**
 * The single-use page grant for one approved export.
 *
 * It publishes the render the person approved (the held output's title and
 * body, under the name the folder destination would also use) to the one
 * instance the card's account belongs to, and does so at most once. A second
 * call, an instance the card did not name, a render that is not the HTML form,
 * a host without page publishing, and a call after the export settled are each
 * refused as a value; none reaches a provider. The destination contributes
 * only the instance id, so it has no way to change what is published.
 */
function issuePageGrant(
  pending: HeldExport,
  publishing: CanvasExportPagePublishing | undefined,
): { readonly grants: CanvasExportGrants; readonly settle: () => void } {
  let state: "open" | "used" | "settled" = "open";
  const refusal = (message: string): PagePublishOutcome => ({ kind: "refused", message });
  return {
    settle: () => {
      state = "settled";
    },
    grants: {
      publishPage: async (instanceId) => {
        if (state === "settled") {
          return refusal("This export has finished and can publish nothing more.");
        }
        if (state === "used") return refusal("This export has already published its page.");
        if (
          publishing === undefined ||
          pending.publisher === undefined ||
          String(instanceId) !== String(pending.publisher)
        ) {
          return refusal("The approval did not name that account for a page.");
        }
        if (pending.output.format !== "html") {
          return refusal("Only the HTML form of a document is published as a page.");
        }
        state = "used";
        return publishing.publish(instanceId, {
          fileName: canvasExportPlannedName(pending.output.title, "html"),
          title: pending.output.title,
          html: pending.output.body,
        });
      },
    },
  };
}

function digestOf(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
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
): CanvasExportDestination | undefined {
  if (visibility === undefined || destination?.visibility === undefined) return destination;
  return { ...destination, visibility };
}

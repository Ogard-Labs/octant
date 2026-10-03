import { createHash } from "node:crypto";
import type { CanvasBlock, CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import {
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
import type { CanvasExportTarget } from "@octant/plugin-api/canvas-export";
import {
  offerCanvasExportTargets,
  type CanvasExportActivationFacts,
} from "@octant/plugin-host/canvas-export-contributions";
import type { UtcTimestamp } from "@octant/contracts";
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
  readonly targets: () => ReadonlyArray<CanvasExportTargetBinding>;
  readonly eventStore: CanvasExportEventStore;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
}

interface PendingExport {
  readonly card: CanvasExportPrepareResult & { readonly kind: "approval" };
  readonly output: CanvasExportRenderedOutput;
}

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
        this.#targets().map((binding) => ({
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
    const offer = this.#offerFor(request.targetId);
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
          byteLength: rendered.body.length,
          contentDigest: payloadDigest,
        },
      });
    } catch {
      return decodeCanvasExportPrepareResult(
        refused("malformed", "The rendered document cannot be exported."),
      );
    }
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
      payload: rendered.body,
      payloadDigest,
      byteLength: rendered.body.length,
    });
    const result = decodeCanvasExportPrepareResult({ kind: "approval", card });
    if (result.kind === "approval") {
      this.#pending.set(String(card.approvalId), { card: result, output });
    }
    return result;
  }

  /**
   * Release a held approval. A denial, a missing approval, and a destination
   * that is no longer ready never call the plugin.
   */
  async decide(input: {
    readonly canvasId: CanvasId;
    readonly approvalId: CanvasExportApprovalId;
    readonly decision: "approved" | "denied";
    readonly permitted: boolean;
  }): Promise<CanvasExportDecideResult> {
    const pending = this.#pending.get(String(input.approvalId));
    if (pending === undefined) {
      return decodeCanvasExportDecideResult(
        refused("approval-required", "Export requires approval."),
      );
    }
    if (String(pending.card.card.canvasId) !== String(input.canvasId)) {
      return decodeCanvasExportDecideResult(
        refused("unauthorized", "Export is not authorized for this canvas."),
      );
    }
    if (!input.permitted || input.decision === "denied") {
      this.#pending.delete(String(input.approvalId));
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

    const offer = this.#offerFor(pending.card.card.targetId);
    if (offer === undefined || offer.status !== "ready") {
      this.#pending.delete(String(input.approvalId));
      return decodeCanvasExportDecideResult(
        refused("not-offered", "That destination is not offered."),
      );
    }
    const binding = this.#bindingFor(pending.card.card.targetId);
    if (binding === undefined) {
      this.#pending.delete(String(input.approvalId));
      return decodeCanvasExportDecideResult(
        refused("not-offered", "That destination is not offered."),
      );
    }

    this.#pending.delete(String(input.approvalId));
    const delivery = await this.#deliver(binding.target, pending.output);
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
    this.#eventStore.append({ record, occurredAt: this.#clock() });
    return decodeCanvasExportDecideResult({ kind: "exported", record });
  }

  #offerFor(targetId: CanvasExportTargetId) {
    return offerCanvasExportTargets(
      this.#targets().map((binding) => ({
        contribution: binding.target.contribution,
        facts: binding.facts,
      })),
    ).find((offer) => String(offer.targetId) === String(targetId));
  }

  #bindingFor(targetId: CanvasExportTargetId): CanvasExportTargetBinding | undefined {
    return this.#targets().find(
      (binding) => String(binding.target.contribution.targetId) === String(targetId),
    );
  }

  async #deliver(
    target: CanvasExportTarget,
    output: CanvasExportRenderedOutput,
  ): Promise<CanvasExportDelivery> {
    try {
      return decodeCanvasExportDelivery(await target.exportDocument(output));
    } catch {
      return refused("refused", "The destination did not complete the export.");
    }
  }
}

function digestOf(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

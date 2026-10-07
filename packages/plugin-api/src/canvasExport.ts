/**
 * Export destination seam. A plugin implements `CanvasExportTarget` and is
 * called by the host only after the person approves the rendered payload and
 * the destination. The schemas live in `@octant/contracts/canvas-export`.
 */
export type {
  CanvasExportApprovalCard,
  CanvasExportContribution,
  CanvasExportDecideRequest,
  CanvasExportDecideResult,
  CanvasExportDelivery,
  CanvasExportFilePath,
  CanvasExportFormat,
  CanvasExportImplementedFormat,
  CanvasExportOfferList,
  CanvasExportPrepareRequest,
  CanvasExportPrepareResult,
  CanvasExportReceipt,
  CanvasExportRecorded,
  CanvasExportRefusal,
  CanvasExportRefusalCode,
  CanvasExportRenderedOutput,
  CanvasExportTargetId,
  CanvasExportTargetOffer,
  CanvasExportTargetStatus,
  CanvasExportVisibility,
} from "@octant/contracts/canvas-export";

export {
  CANVAS_EXPORT_IMPLEMENTED_FORMATS,
  decodeCanvasExportContribution,
  decodeCanvasExportDelivery,
  decodeCanvasExportRenderedOutput,
  isCanvasExportImplementedFormat,
} from "@octant/contracts/canvas-export";

import type {
  CanvasExportContribution,
  CanvasExportDelivery,
  CanvasExportRenderedOutput,
  CanvasExportVisibility,
} from "@octant/contracts/canvas-export";

/**
 * What a destination plans to do with one document, described while the
 * approval card is built.
 *
 * A local destination names the file it writes, because a file the person goes
 * looking for has to be named before they approve anything, and naming it is
 * also what makes the approval a confirmation to replace what is there. A
 * remote destination names the account it acts as and the audience the result
 * will have, so the person approves those, not the destination's reputation.
 *
 * Every string here is shown verbatim on the card, so it is bounded and free
 * of paths and secrets by the card's own schema; an unsafe value fails the
 * card rather than reaching the person.
 */
export interface CanvasExportDestination {
  /** The absolute file a local destination writes, when it writes one. */
  readonly path?: string;
  /** Whether a file is already at `path` and will be replaced. */
  readonly replacesExisting?: boolean;
  /** The account this export will act as, when the destination acts as one. */
  readonly account?: string;
  /** Whether the result is visible to anyone, or only to `account`. */
  readonly visibility?: CanvasExportVisibility;
  /** The destination's own plain note about this export, shown on the card. */
  readonly note?: string;
}

/**
 * The port a destination plugin implements.
 *
 * The host owns rendering, approval, and the journal. A plugin does not choose
 * when it is called, and a call is not itself approval.
 */
export interface CanvasExportTarget {
  readonly contribution: CanvasExportContribution;
  /**
   * How this target would act on this document, called while the approval card
   * is built so the card can name the file, the account, and the audience — and
   * so the person approves those, not a destination's reputation.
   *
   * Optional, and synchronous on purpose: the offer list and the card cannot
   * wait on I/O. A destination with nothing to describe omits this and is
   * invoked without a confirmation; a target that names no file must not
   * replace an existing one.
   */
  readonly describeDestination?: (
    output: CanvasExportRenderedOutput,
  ) => CanvasExportDestination | undefined;
  /**
   * Perform the export. `confirmed` is the destination the approval card named
   * — including the audience the person chose — and the person approved; when
   * it is absent the target has no confirmation and, for a local destination,
   * writes alongside an existing file instead of over it.
   */
  readonly exportDocument: (
    output: CanvasExportRenderedOutput,
    confirmed?: CanvasExportDestination,
  ) => Promise<CanvasExportDelivery>;
}

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
} from "@octant/contracts/canvas-export";

/**
 * The exact file a destination plans to write for one document.
 *
 * A local destination writes a file the person then goes looking for, so the
 * host has to be able to name it before the person approves anything. Naming it
 * is also what makes the approval a confirmation: the host passes the approved
 * destination back to `exportDocument`, and a target replaces an existing file
 * only when that confirmation names the very file it is about to write.
 */
export interface CanvasExportDestination {
  /** The absolute path the person will find the file at. */
  readonly path: string;
  /** Whether a file is already there, so the approval card can say so. */
  readonly replacesExisting: boolean;
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
   * Where this target would put this document, called while the approval card
   * is built so the card can name the file — and so the person approves a
   * place, not a destination's reputation.
   *
   * Optional, and synchronous on purpose: a destination with nowhere local to
   * point (a link, a remote id) has no path to name and omits this. A target
   * that cannot describe its destination is invoked without a confirmation and
   * must not replace an existing file.
   */
  readonly describeDestination?: (
    output: CanvasExportRenderedOutput,
  ) => CanvasExportDestination | undefined;
  /**
   * Perform the export. `confirmed` is the destination the approval card named
   * and the person approved; when it is absent the target has no confirmation
   * and writes alongside an existing file instead of over it.
   */
  readonly exportDocument: (
    output: CanvasExportRenderedOutput,
    confirmed?: CanvasExportDestination,
  ) => Promise<CanvasExportDelivery>;
}

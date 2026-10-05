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
 * The port a destination plugin implements.
 *
 * The host owns rendering, approval, and the journal. A plugin does not choose
 * when it is called, and a call is not itself approval.
 */
export interface CanvasExportTarget {
  readonly contribution: CanvasExportContribution;
  readonly exportDocument: (output: CanvasExportRenderedOutput) => Promise<CanvasExportDelivery>;
}

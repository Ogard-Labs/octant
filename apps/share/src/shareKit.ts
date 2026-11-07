// The exact app modules the share service uses, imported straight from the
// workspace packages. The service reads the same share format and draws blocks
// with the same layout code as the app that publishes, because both import this
// one file. Add a name here when the service needs more of the app.
export { CANVAS_DESIGN_VIEWPORT } from "@octant/contracts/canvas";
export {
  CANVAS_SHARE_SCHEMA_VERSION,
  type CanvasStaticExportBlock,
} from "@octant/contracts/canvas-share";
export {
  CANVAS_PUBLIC_SHARE_MAX_DOCUMENT_BYTES,
  CANVAS_PUBLIC_SHARE_REPORT_DETAIL_MAX_CHARS,
  CANVAS_PUBLIC_SHARE_TOMBSTONE_DAYS,
  CANVAS_PUBLIC_SHARE_WIRE_VERSION,
  decodeCanvasPublicShareCreateRequest,
  decodeCanvasPublicShareCreated,
  decodeCanvasPublicShareDocument,
  decodeCanvasPublicShareReport,
  decodeCanvasPublicShareRevoked,
  decodeCanvasPublicShareServiceUrl,
  decodeCanvasPublicShareStatus,
  decodeCanvasPublicShareUpdateRequest,
  decodeCanvasPublicShareUpdated,
  type CanvasPublicShareDocument,
  type CanvasPublicShareRefusalCode,
  type CanvasPublicShareReportReason,
} from "@octant/contracts/canvas-public-share";
export { DESIGN_FRAME_KIT } from "@octant/domain/canvas-design-frame-kit";
export { layoutCanvasBarList } from "@octant/domain/canvas-bar-list-layout";
export {
  COMPARISON_MATRIX_GLYPH_LABEL,
  formatComparisonMatrixTotal,
  layoutCanvasComparisonMatrix,
  type CanvasMatrixCellLayout,
} from "@octant/domain/canvas-comparison-matrix";
export {
  canvasReadingOrder,
  type CanvasPlacedReadingItem,
} from "@octant/domain/canvas-dashboard-layout";
export { heatmapRowTotals } from "@octant/domain/canvas-heatmap-layout";
export {
  CANVAS_MOCKUP_DEVICE_NAME,
  canvasMockupCallouts,
  canvasMockupFrames,
  canvasMockupNodeReading,
  type CanvasMockupBranch,
} from "@octant/domain/canvas-mockup-outline";
export { formatCanvasNumber } from "@octant/domain/canvas-number-format";
export {
  treemapChildren,
  treemapRootId,
  treemapTotals,
} from "@octant/domain/canvas-treemap-layout";

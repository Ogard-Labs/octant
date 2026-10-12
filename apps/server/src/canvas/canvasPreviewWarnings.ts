import {
  CANVAS_DESIGN_ASSET_SCHEME,
  type CanvasBlock,
  type CanvasDefinition,
  type CanvasDesignAssetResolution,
  type CanvasDesignAssetUnavailableReason,
} from "@octant/contracts/canvas";
import {
  canvasDashboardCellWidth,
  canvasReadingOrder,
} from "@octant/domain/canvas-dashboard-layout";
import { contrastRatio } from "@octant/theme";
import type { CanvasPreviewDesignReading } from "./canvasPreviewFrames";

/**
 * What an agent should fix before it replies.
 *
 * A preview answers one question: does this document read well where the thread
 * will draw it? These are the ways it demonstrably can fail to — a label the
 * slot cannot hold, a legend that runs past the frame, a series with no reading
 * in it, and ink that does not clear its contrast target. Length is not one of
 * them: the thread shows a long inline document as a teaser the person expands. Each is a value, not a sentence: the tool
 * reports the kind and the measurement, and the agent decides what to change.
 *
 * Most warnings are computed from the document and the target width alone, so
 * they are reported whether or not a browser rendered the picture. That is what
 * makes a warnings-only build honest rather than empty: the layout reading does
 * not depend on the raster. A design frame is the exception, because it is
 * markup: its overflow, its text contrast, and a running design's script errors
 * are read from the drawn frames (`canvasPreviewDesignWarnings`), so they are
 * reported only when a browser drew the page.
 */
export type CanvasPreviewWarning =
  | {
      readonly kind: "clipped-label";
      readonly blockId: string;
      readonly label: string;
      readonly availablePx: number;
    }
  | {
      readonly kind: "legend-overflow";
      readonly blockId: string;
      readonly seriesCount: number;
      readonly fits: number;
    }
  | {
      readonly kind: "empty-series";
      readonly blockId: string;
      readonly seriesLabel?: string;
    }
  | {
      readonly kind: "contrast-below-target";
      readonly blockId: string;
      readonly foreground: string;
      readonly background: string;
      readonly ratio: number;
      readonly target: number;
    }
  | {
      /**
       * A declared image the host could not draw, so the frames that name it
       * show a placeholder. Names the frames and the id, never the bytes.
       * `frameIds` is every frame that names the asset; a reference in the
       * shared stylesheet reaches every frame.
       */
      readonly kind: "design-asset-unavailable";
      readonly blockId: string;
      readonly assetId: string;
      readonly reason: CanvasDesignAssetUnavailableReason;
      readonly frameIds: ReadonlyArray<string>;
    }
  | {
      /** A design frame whose content is wider than the page it is drawn in. */
      readonly kind: "design-frame-overflow";
      readonly blockId: string;
      readonly frameId: string;
      readonly overflowPx: number;
    }
  | {
      /** The text that reads worst in a design frame, below its target. */
      readonly kind: "design-contrast-below-target";
      readonly blockId: string;
      readonly frameId: string;
      readonly text: string;
      readonly foreground: string;
      readonly background: string;
      readonly ratio: number;
      readonly target: number;
    }
  | {
      /** An uncaught error a running design threw as it loaded, from its bridge. */
      readonly kind: "design-script-error";
      readonly blockId: string;
      readonly message: string;
    };

/**
 * What the browser measured in the drawn design frames, as warnings, in the
 * order the designs were drawn: each design's script errors, then its frames
 * that overflow, then its worst-reading text per frame.
 */
export function canvasPreviewDesignWarnings(
  designs: ReadonlyArray<CanvasPreviewDesignReading>,
): ReadonlyArray<CanvasPreviewWarning> {
  const warnings: CanvasPreviewWarning[] = [];
  for (const design of designs) {
    for (const message of design.scriptErrors) {
      warnings.push({ kind: "design-script-error", blockId: design.blockId, message });
    }
    for (const frame of design.overflow) {
      warnings.push({ kind: "design-frame-overflow", blockId: design.blockId, ...frame });
    }
    for (const frame of design.contrast) {
      warnings.push({ kind: "design-contrast-below-target", blockId: design.blockId, ...frame });
    }
  }
  return warnings;
}

/**
 * The colours a preview is drawn against, resolved from the chosen theme.
 *
 * Passed in rather than read from the document: a Canvas carries no theme, and
 * a preview is a look at how this document reads under one. Resolving the
 * palette at the boundary is what lets the contrast reading be a real
 * measurement instead of an assumption about the built-in theme.
 */
export interface CanvasPreviewPalette {
  /** The reading surface a block sits on. */
  readonly workspace: string;
  /** Primary ink: headings and values. */
  readonly ink: string;
  /** Secondary ink: axis labels and legend text. */
  readonly muted: string;
  /** The scarce accent, used for single-hue marks. */
  readonly accent: string;
  /** The categorical series hues in their fixed order. */
  readonly series: ReadonlyArray<string>;
}

export interface CanvasPreviewWarningInput {
  readonly definition: Pick<CanvasDefinition, "blocks">;
  /** The drawn width in CSS pixels; the same number the renderer is given. */
  readonly width: number;
  readonly palette: CanvasPreviewPalette;
  /**
   * Each design's images as the host resolved them for this preview, by block
   * id. A design missing here was not resolved, and its declared images read
   * as refused, which is what a reader would see.
   */
  readonly designAssets?: ReadonlyMap<string, ReadonlyArray<CanvasDesignAssetResolution>>;
}

/** A categorical mark must clear the 3:1 a graphical object needs (WCAG 1.4.11). */
const MARK_CONTRAST_TARGET = 3;
/** A series label is small text and must clear the normal-text target. */
const TEXT_CONTRAST_TARGET = 4.5;
/** One legend entry is a hue swatch and a short label; this is its band. */
const LEGEND_ENTRY_PX = 96;
/** Pie and donut legends toggle every slice up to the catalog's own bound. */
const PART_TO_WHOLE_LEGEND_LIMIT = 24;
/** The plot's padding and axis gutter, removed before a slot is measured. */
const PLOT_CHROME_PX = 48;
/** A character of the 11px axis label, in CSS pixels. */
const AXIS_CHARACTER_PX = 6.4;

/**
 * Everything this document would read badly as, at this width and theme.
 *
 * Ordered by block, so the report follows the document; a caller that shows
 * the first warning shows the one highest in the Canvas.
 */
export function canvasPreviewWarnings(
  input: CanvasPreviewWarningInput,
): ReadonlyArray<CanvasPreviewWarning> {
  const warnings: CanvasPreviewWarning[] = [];
  // A block placed in a dashboard is drawn at its cell's width, not the
  // document's, so it is measured there; otherwise a chart in a quarter of a
  // wide grid would clip labels that the full width would hold.
  const cellWidths = new Map<string, number>();
  // A dashboard inside a tab or column is measured the same way.
  const items = canvasReadingOrder(input.definition.blocks).flatMap((item) =>
    item.kind === "group" ? item.sections.flat() : [item],
  );
  for (const item of items) {
    if (item.kind !== "dashboard") continue;
    for (const cell of item.cells) {
      cellWidths.set(
        String(cell.block.blockId),
        canvasDashboardCellWidth({
          gridWidth: input.width,
          columns: item.columns,
          span: cell.span,
          kind: cell.block.kind,
        }),
      );
    }
  }
  for (const block of input.definition.blocks) {
    const width = cellWidths.get(String(block.blockId));
    warnings.push(...blockWarnings(block, width === undefined ? input : { ...input, width }));
  }
  return warnings;
}

function blockWarnings(
  block: CanvasBlock,
  input: CanvasPreviewWarningInput,
): ReadonlyArray<CanvasPreviewWarning> {
  switch (block.kind) {
    case "chart":
      return chartWarnings(block, input);
    case "bar-list":
      return barListWarnings(block, input);
    case "design":
      return designAssetWarnings(block, input);
    default:
      return [];
  }
}

function chartWarnings(
  block: Extract<CanvasBlock, { readonly kind: "chart" }>,
  input: CanvasPreviewWarningInput,
): ReadonlyArray<CanvasPreviewWarning> {
  const warnings: CanvasPreviewWarning[] = [];
  // A sankey draws flows rather than series, and its node labels sit beside
  // their columns rather than in category slots; its legend toggles at most the
  // catalog's bound, like a pie's. What it can still get wrong is contrast.
  if (block.chartType === "sankey") {
    return contrastWarnings(block.blockId, input.palette);
  }
  if (block.series.length === 0) {
    warnings.push({ kind: "empty-series", blockId: block.blockId });
    return warnings;
  }
  for (const series of block.series) {
    if (series.points.every((point) => point.y === 0)) {
      warnings.push({ kind: "empty-series", blockId: block.blockId, seriesLabel: series.label });
    }
  }
  const legendLimit = legendCapacity(block, input.width);
  if (block.series.length > legendLimit) {
    warnings.push({
      kind: "legend-overflow",
      blockId: block.blockId,
      seriesCount: block.series.length,
      fits: legendLimit,
    });
  }
  // A funnel's stages and a radar's axes are labelled beside their marks, not
  // in a slot per category, so the slot measure does not apply to them.
  if (block.chartType !== "funnel" && block.chartType !== "radar") {
    warnings.push(...clippedChartLabels(block, input.width));
  }
  warnings.push(...contrastWarnings(block.blockId, input.palette));
  return warnings;
}

/**
 * The legend entries that fit one row before wrapping counts as overflow.
 *
 * A pie or donut legend toggles up to the catalog's own bound; a categorical
 * legend lists every series, so its fit shrinks with the frame.
 */
function legendCapacity(
  block: Extract<CanvasBlock, { readonly kind: "chart" }>,
  width: number,
): number {
  if (block.chartType === "pie" || block.chartType === "donut") {
    return PART_TO_WHOLE_LEGEND_LIMIT;
  }
  // A funnel is one series and draws no legend.
  if (block.chartType === "funnel") return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor((width - PLOT_CHROME_PX) / LEGEND_ENTRY_PX));
}

/**
 * Category labels whose slot cannot hold them.
 *
 * The renderer truncates a label with an ellipsis rather than wrapping or
 * shrinking it, so a label past its slot is drawn as a fragment. Measuring it
 * here is the difference between the agent seeing that and the person seeing it.
 */
function clippedChartLabels(
  block: Extract<CanvasBlock, { readonly kind: "chart" }>,
  width: number,
): ReadonlyArray<CanvasPreviewWarning> {
  const first = block.series[0];
  if (first === undefined) return [];
  const slots = first.points.length;
  const availablePx = (width - PLOT_CHROME_PX) / slots;
  return first.points
    .filter((point) => typeof point.x === "string")
    .filter((point) => estimatedLabelPx(String(point.x)) > availablePx)
    .map((point) => ({
      kind: "clipped-label" as const,
      blockId: block.blockId,
      label: String(point.x),
      availablePx: Math.round(availablePx),
    }));
}

function designAssetWarnings(
  block: Extract<CanvasBlock, { readonly kind: "design" }>,
  input: CanvasPreviewWarningInput,
): ReadonlyArray<CanvasPreviewWarning> {
  const resolved = input.designAssets?.get(String(block.blockId));
  const warnings: CanvasPreviewWarning[] = [];
  for (const asset of block.assets ?? []) {
    const id = String(asset.assetId);
    const outcome = resolved?.find((entry) => String(entry.assetId) === id);
    if (outcome?.status === "resolved") continue;
    const reference = `${CANVAS_DESIGN_ASSET_SCHEME}${id}`;
    const named = (markup: string | undefined) =>
      markup !== undefined && namesAsset(markup, reference);
    warnings.push({
      kind: "design-asset-unavailable",
      blockId: String(block.blockId),
      assetId: id,
      reason: outcome?.reason ?? "refused",
      frameIds: block.frames
        .filter((frame) => named(block.styles) || named(frame.html))
        .map((frame) => String(frame.frameId)),
    });
  }
  return warnings;
}

/** Whether markup names this reference, not one whose id merely starts with it. */
function namesAsset(markup: string, reference: string): boolean {
  let at = markup.indexOf(reference);
  while (at !== -1) {
    if (!/[A-Za-z0-9._-]/.test(markup.charAt(at + reference.length))) return true;
    at = markup.indexOf(reference, at + reference.length);
  }
  return false;
}

function barListWarnings(
  block: Extract<CanvasBlock, { readonly kind: "bar-list" }>,
  input: CanvasPreviewWarningInput,
): ReadonlyArray<CanvasPreviewWarning> {
  const warnings: CanvasPreviewWarning[] = [];
  if (block.rows.every((row) => row.value === 0)) {
    warnings.push({ kind: "empty-series", blockId: block.blockId });
  }
  // A bar list reserves about half its width for the label column; a label past
  // that is drawn as a fragment, like a chart's category label.
  const labelPx = (input.width - PLOT_CHROME_PX) * 0.46;
  for (const row of block.rows) {
    if (estimatedLabelPx(row.label) > labelPx) {
      warnings.push({
        kind: "clipped-label",
        blockId: block.blockId,
        label: row.label,
        availablePx: Math.round(labelPx),
      });
    }
  }
  return warnings;
}

/**
 * Ink that does not clear its target on the surface it is drawn on.
 *
 * The marks carry the series hues and are judged as graphical objects; the
 * series labels are drawn in the muted ink and are judged as text. A built-in
 * theme clears both, so this fires for a theme whose palette does not — the
 * reading is a measurement, not a promise.
 */
function contrastWarnings(
  blockId: string,
  palette: CanvasPreviewPalette,
): ReadonlyArray<CanvasPreviewWarning> {
  const warnings: CanvasPreviewWarning[] = [];
  for (const hue of palette.series) {
    const ratio = contrastRatio(hue, palette.workspace);
    if (ratio < MARK_CONTRAST_TARGET) {
      warnings.push({
        kind: "contrast-below-target",
        blockId,
        foreground: hue,
        background: palette.workspace,
        ratio: Math.round(ratio * 100) / 100,
        target: MARK_CONTRAST_TARGET,
      });
      break;
    }
  }
  const labelRatio = contrastRatio(palette.muted, palette.workspace);
  if (labelRatio < TEXT_CONTRAST_TARGET) {
    warnings.push({
      kind: "contrast-below-target",
      blockId,
      foreground: palette.muted,
      background: palette.workspace,
      ratio: Math.round(labelRatio * 100) / 100,
      target: TEXT_CONTRAST_TARGET,
    });
  }
  return warnings;
}

function estimatedLabelPx(label: string): number {
  return label.length * AXIS_CHARACTER_PX;
}

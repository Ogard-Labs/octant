import type { CanvasBlock, CanvasDefinition, CanvasPresentation } from "@octant/contracts/canvas";
import { CANVAS_INLINE_MAX_BLOCKS } from "@octant/domain";
import { contrastRatio } from "@octant/theme";

/**
 * What an agent should fix before it replies.
 *
 * A preview answers one question: does this document read well where the thread
 * will draw it? These are the ways it demonstrably can fail to — a label the
 * slot cannot hold, a legend that runs past the frame, a series with no reading
 * in it, an inline document taller than the conversation allows, and ink that
 * does not clear its contrast target. Each is a value, not a sentence: the tool
 * reports the kind and the measurement, and the agent decides what to change.
 *
 * The warnings are computed from the document and the target width alone, so
 * they are reported whether or not a browser rendered the picture. That is what
 * makes a warnings-only build honest rather than empty: the layout reading does
 * not depend on the raster.
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
      readonly kind: "inline-height-cap-exceeded";
      readonly blockCount: number;
      readonly limit: number;
    }
  | {
      readonly kind: "contrast-below-target";
      readonly blockId: string;
      readonly foreground: string;
      readonly background: string;
      readonly ratio: number;
      readonly target: number;
    };

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
  readonly presentation: CanvasPresentation;
  /** The drawn width in CSS pixels; the same number the renderer is given. */
  readonly width: number;
  readonly palette: CanvasPreviewPalette;
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
  if (
    input.presentation === "inline" &&
    input.definition.blocks.length > CANVAS_INLINE_MAX_BLOCKS
  ) {
    warnings.push({
      kind: "inline-height-cap-exceeded",
      blockCount: input.definition.blocks.length,
      limit: CANVAS_INLINE_MAX_BLOCKS,
    });
  }
  for (const block of input.definition.blocks) {
    warnings.push(...blockWarnings(block, input));
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

import {
  CANVAS_DESIGN_VIEWPORT,
  type CanvasBlock,
  type CanvasDefinition,
} from "@octant/contracts/canvas";
import { MAX_ARTIFACT_PREVIEW_CHARACTERS } from "@octant/contracts/artifact-library";
import { CHART_BAR_RADIUS, CHART_LINE_WIDTH } from "@octant/theme";

/**
 * Drawing an artifact, once.
 *
 * The library's preview cards and the storage mirror's rendered sidecars are
 * the same picture at different sizes, so they are the same code. Anything that
 * knows how a block looks belongs here; nothing here reads state, touches the
 * filesystem, or decides authority.
 *
 * The output is a self-contained SVG fragment: no external references, no
 * script, no fonts beyond the generic families every platform has. That is what
 * lets a card draw it inline and a sidecar be opened outside Octant.
 */

export const ARTIFACT_THUMBNAIL_SIZE = { width: 320, height: 200 } as const;
/** A sidecar is read, not glanced at, so it gets room for more of the document. */
export const ARTIFACT_SIDECAR_SIZE = { width: 640, height: 900 } as const;
const PADDING = 12;
const ROW_GAP = 8;

/** Blocks a preview draws. The rest advance the layout without ink of their own. */
const DRAWN_KINDS = new Set<CanvasBlock["kind"]>([
  "heading",
  "rich-text",
  "callout",
  "summary",
  "table",
  "key-value",
  "chart",
  "timeline",
  "diagram",
  "sequence",
  "state",
  "mockup",
  "design",
  "code-excerpt",
  "pseudocode",
  "diff",
  "metric",
  "progress",
  "status",
  "image",
]);

export interface ArtifactThumbnailPalette {
  readonly background: string;
  readonly ink: string;
  readonly muted: string;
  readonly accent: string;
}

/**
 * A palette that reads on either theme.
 *
 * A preview is drawn once on the host and shown on whatever theme the viewer
 * has, so it cannot pick colours from one. These are chosen to sit legibly on
 * both a light and a dark card, which is why the background is drawn rather
 * than left transparent.
 */
export const DEFAULT_ARTIFACT_PALETTE: ArtifactThumbnailPalette = {
  background: "#f4f4f5",
  ink: "#3f3f46",
  muted: "#a1a1aa",
  accent: "#6b7280",
};

/**
 * Draw a preview of one artifact.
 *
 * The picture is a reading of the artifact's shape rather than a faithful
 * render: real text for the things a person recognises an artifact by — its
 * title, its headings — and the true geometry of the things whose shape is the
 * recognisable part, like a chart's bars or a diagram's nodes. It stops when it
 * runs out of room, which is what a thumbnail is.
 */
export interface ArtifactRenderOptions {
  readonly width: number;
  readonly height: number;
  readonly palette?: ArtifactThumbnailPalette;
  /**
   * The largest markup this caller can carry. A picture over it is dropped
   * rather than truncated — half an SVG is not a smaller picture. Omit for a
   * sidecar, which is written to a file and has no such ceiling.
   */
  readonly maximumCharacters?: number;
}

/** The gallery's card-sized preview, bounded by what the listing contract accepts. */
export function renderArtifactThumbnail(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
  palette: ArtifactThumbnailPalette = DEFAULT_ARTIFACT_PALETTE,
): string {
  return renderArtifactSvg(definition, {
    ...ARTIFACT_THUMBNAIL_SIZE,
    palette,
    maximumCharacters: MAX_ARTIFACT_PREVIEW_CHARACTERS,
  });
}

/** The page-sized render a mirrored sidecar carries. */
export function renderArtifactSidecarSvg(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
  palette: ArtifactThumbnailPalette = DEFAULT_ARTIFACT_PALETTE,
): string {
  return renderArtifactSvg(definition, { ...ARTIFACT_SIDECAR_SIZE, palette });
}

export function renderArtifactSvg(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
  options: ArtifactRenderOptions,
): string {
  const palette = options.palette ?? DEFAULT_ARTIFACT_PALETTE;
  const width = options.width;
  const height = options.height;
  const parts: string[] = [
    `<rect width="${String(width)}" height="${String(height)}" fill="${palette.background}"/>`,
    text(PADDING, PADDING + 11, clamp(definition.title, titleLength(width)), 13, palette.ink, 600),
  ];

  let y = PADDING + 26;
  for (const block of definition.blocks) {
    if (y > height - PADDING) break;
    if (!DRAWN_KINDS.has(block.kind)) continue;
    const drawn = drawBlock(block, y, palette, width);
    if (drawn === undefined) continue;
    parts.push(drawn.markup);
    y += drawn.height + ROW_GAP;
  }

  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}" role="img" font-family="system-ui, sans-serif">${parts.join("")}</svg>`;
  const ceiling = options.maximumCharacters;
  return ceiling === undefined || markup.length <= ceiling ? markup : "";
}

/** Roughly how many characters of title fit across a picture this wide. */
function titleLength(width: number): number {
  return Math.max(20, Math.floor((width - PADDING * 2) / 8));
}

interface DrawnBlock {
  readonly markup: string;
  readonly height: number;
}

function drawBlock(
  block: CanvasBlock,
  y: number,
  palette: ArtifactThumbnailPalette,
  canvasWidth: number,
): DrawnBlock | undefined {
  const width = canvasWidth - PADDING * 2;
  switch (block.kind) {
    case "heading":
      return {
        markup: text(PADDING, y + 9, clamp(block.text, 38), 11, palette.ink, 600),
        height: 12,
      };
    case "rich-text":
    case "summary":
      return { markup: lines(y, block.kind === "summary" ? 2 : 3, width, palette), height: 20 };
    case "callout":
      return {
        markup:
          `<rect x="${String(PADDING)}" y="${String(y)}" width="${String(width)}" height="20" rx="3" fill="none" stroke="${palette.muted}" stroke-width="1"/>` +
          text(PADDING + 6, y + 13, clamp(block.text, titleLength(canvasWidth)), 8, palette.ink),
        height: 20,
      };
    case "metric":
    case "status":
      return {
        markup:
          text(PADDING, y + 8, clamp(block.label, 20), 8, palette.muted) +
          text(PADDING, y + 20, clamp(String(block.value), 14), 13, palette.ink, 600),
        height: 22,
      };
    case "progress":
      return {
        markup:
          `<rect x="${String(PADDING)}" y="${String(y + 4)}" width="${String(width)}" height="6" rx="3" fill="${palette.muted}" opacity="0.4"/>` +
          `<rect x="${String(PADDING)}" y="${String(y + 4)}" width="${String(Math.round(width * clampUnit(block.value)))}" height="6" rx="3" fill="${palette.accent}"/>`,
        height: 12,
      };
    case "table":
    case "key-value":
      return { markup: grid(y, width, palette), height: 34 };
    case "chart":
      return { markup: bars(block, y, width, palette), height: 44 };
    case "timeline":
      return { markup: timeline(y, width, palette), height: 18 };
    case "diagram":
      return { markup: diagram(block, y, width, palette), height: 46 };
    case "sequence":
      return { markup: sequence(block, y, width, palette), height: 64 };
    case "state":
      return { markup: stateMachine(block, y, width, palette), height: 64 };
    case "mockup":
      return { markup: mockupFrame(block, y, width, palette), height: 52 };
    case "design":
      return { markup: designFrames(block, y, width, palette), height: 52 };
    case "code-excerpt":
    case "pseudocode":
    case "diff":
      return { markup: codeLines(y, width, palette), height: 30 };
    case "image":
      return {
        markup: `<rect x="${String(PADDING)}" y="${String(y)}" width="${String(width)}" height="34" rx="3" fill="${palette.muted}" opacity="0.35"/>`,
        height: 34,
      };
    default:
      return undefined;
  }
}

function lines(y: number, count: number, width: number, palette: ArtifactThumbnailPalette): string {
  return Array.from({ length: count }, (_unused, index) => {
    // The last line of a paragraph is short, which is what makes a stack of
    // bars read as prose rather than as a table.
    const lineWidth = index === count - 1 ? Math.round(width * 0.62) : width;
    return `<rect x="${String(PADDING)}" y="${String(y + index * 7)}" width="${String(lineWidth)}" height="3" rx="1.5" fill="${palette.muted}" opacity="0.55"/>`;
  }).join("");
}

function codeLines(y: number, width: number, palette: ArtifactThumbnailPalette): string {
  const widths = [0.72, 0.44, 0.86, 0.3];
  return (
    `<rect x="${String(PADDING)}" y="${String(y)}" width="${String(width)}" height="30" rx="3" fill="${palette.muted}" opacity="0.18"/>` +
    widths
      .map(
        (fraction, index) =>
          `<rect x="${String(PADDING + 6)}" y="${String(y + 5 + index * 6)}" width="${String(Math.round((width - 12) * fraction))}" height="2.5" rx="1.25" fill="${palette.accent}" opacity="0.7"/>`,
      )
      .join("")
  );
}

function grid(y: number, width: number, palette: ArtifactThumbnailPalette): string {
  const rows = 4;
  const columns = 3;
  const columnWidth = width / columns;
  const cells: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      cells.push(
        `<rect x="${String(Math.round(PADDING + column * columnWidth + 1))}" y="${String(y + row * 8)}" width="${String(Math.round(columnWidth - 3))}" height="5" rx="1" fill="${row === 0 ? palette.accent : palette.muted}" opacity="${row === 0 ? "0.75" : "0.4"}"/>`,
      );
    }
  }
  return cells.join("");
}

/** The picture area a chart block gets: `width` across, 44 down from `y`. */
const CHART_HEIGHT = 44;

function bars(
  block: Extract<CanvasBlock, { readonly kind: "chart" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
): string {
  // Each chart type draws its own shape, so a pie reads as a pie and a
  // bar-and-line chart keeps both of its marks. The real values, so a chart's
  // silhouette is its own rather than a stock one.
  switch (block.chartType) {
    case "pie":
    case "donut":
      return pie(block, y, width, palette, block.chartType === "donut");
    case "stacked-bar":
      return stackedColumns(block, y, width, palette);
    case "grouped-bar":
      return groupedColumns(block, y, width, palette, block.series.length);
    case "bar-line":
      return barAndLine(block, y, width, palette);
    default:
      return simpleBars(block, y, width, palette);
  }
}

function pie(
  block: Extract<CanvasBlock, { readonly kind: "chart" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
  ring: boolean,
): string {
  const slices = (block.series[0]?.points ?? []).slice(0, 12);
  if (slices.length === 0) return grid(y, width, palette);
  const values = slices.map((point) => Math.max(0, point.y));
  const total = values.reduce((sum, value) => sum + value, 0);
  const cx = Math.round(PADDING + width / 2);
  const cy = y + CHART_HEIGHT / 2;
  const radius = Math.min(19, Math.max(6, Math.round((width - 4) / 2)));
  if (total <= 0) {
    return `<circle cx="${String(cx)}" cy="${String(cy)}" r="${String(radius)}" fill="none" stroke="${palette.accent}" stroke-width="${String(CHART_LINE_WIDTH)}" opacity="0.75"/>`;
  }
  let angle = -Math.PI / 2;
  const wedges = values.map((value) => {
    const sweep = (value / total) * Math.PI * 2;
    const start = angle;
    angle += sweep;
    if (values.length === 1 || sweep >= Math.PI * 2 - 1e-9) {
      return `<circle cx="${String(cx)}" cy="${String(cy)}" r="${String(radius)}" fill="${palette.accent}" opacity="0.75"/>`;
    }
    const x1 = round(cx + radius * Math.cos(start));
    const y1 = round(cy + radius * Math.sin(start));
    const x2 = round(cx + radius * Math.cos(angle));
    const y2 = round(cy + radius * Math.sin(angle));
    const largeArc = sweep > Math.PI ? 1 : 0;
    return (
      `<path d="M ${String(cx)} ${String(cy)} L ${String(x1)} ${String(y1)} ` +
      `A ${String(radius)} ${String(radius)} 0 ${String(largeArc)} 1 ${String(x2)} ${String(y2)} Z" ` +
      `fill="${palette.accent}" opacity="${opacityFor(0.4 + 0.5 * (value / Math.max(...values)))}"/>`
    );
  });
  const hole = ring
    ? `<circle cx="${String(cx)}" cy="${String(cy)}" r="${String(Math.round(radius * 0.55))}" fill="${palette.background}"/>`
    : "";
  return wedges.join("") + hole;
}

function stackedColumns(
  block: Extract<CanvasBlock, { readonly kind: "chart" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
): string {
  const categories = (block.series[0]?.points ?? []).slice(0, 12);
  if (categories.length === 0) return grid(y, width, palette);
  const totals = categories.map((_point, index) =>
    block.series.reduce((sum, series) => sum + Math.abs(series.points[index]?.y ?? 0), 0),
  );
  const peak = Math.max(...totals, 1);
  const slot = width / categories.length;
  return categories
    .map((_point, categoryIndex) => {
      let top = y + CHART_HEIGHT;
      const segments: string[] = [];
      for (const [seriesIndex, series] of block.series.entries()) {
        const value = Math.abs(series.points[categoryIndex]?.y ?? 0);
        if (value === 0) continue;
        const height = Math.max(1.5, Math.round((value / peak) * (CHART_HEIGHT - 4)));
        top -= height;
        segments.push(
          column(
            PADDING + categoryIndex * slot,
            slot,
            top,
            height,
            palette,
            0.9 - seriesIndex * 0.18,
          ),
        );
      }
      return segments.join("");
    })
    .join("");
}

function groupedColumns(
  block: Extract<CanvasBlock, { readonly kind: "chart" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
  seriesCount: number,
): string {
  const categories = (block.series[0]?.points ?? []).slice(0, 12);
  if (categories.length === 0 || seriesCount === 0) return grid(y, width, palette);
  const peak = Math.max(
    ...block.series.flatMap((series) => series.points.map((point) => Math.abs(point.y))),
    1,
  );
  const slot = width / categories.length;
  const barWidth = Math.max(2, Math.floor((slot - 3) / seriesCount));
  return categories
    .map((_point, categoryIndex) =>
      block.series
        .map((series, seriesIndex) => {
          const value = Math.abs(series.points[categoryIndex]?.y ?? 0);
          const height = Math.max(2, Math.round((value / peak) * (CHART_HEIGHT - 4)));
          const x = PADDING + categoryIndex * slot + 1.5 + seriesIndex * barWidth;
          return column(
            x,
            barWidth,
            y + CHART_HEIGHT - height,
            height,
            palette,
            0.9 - seriesIndex * 0.18,
          );
        })
        .join(""),
    )
    .join("");
}

function barAndLine(
  block: Extract<CanvasBlock, { readonly kind: "chart" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
): string {
  const barSeries = block.series.filter((series) => series.mark === "bar");
  const lineSeries = block.series.filter((series) => series.mark === "line");
  const categories = (block.series[0]?.points ?? []).slice(0, 12);
  if (categories.length === 0) return grid(y, width, palette);
  const columns = groupedColumns(
    { ...block, series: barSeries },
    y,
    width,
    palette,
    Math.max(barSeries.length, 1),
  );
  const peak = Math.max(
    ...block.series.flatMap((series) => series.points.map((point) => Math.abs(point.y))),
    1,
  );
  const slot = width / categories.length;
  const lines = lineSeries
    .map((series, seriesIndex) => {
      const points = categories
        .map((_point, index) => {
          const value = Math.abs(series.points[index]?.y ?? 0);
          const x = round(PADDING + index * slot + slot / 2);
          const lineY = round(y + CHART_HEIGHT - (value / peak) * (CHART_HEIGHT - 4) - 2);
          return `${String(x)},${String(lineY)}`;
        })
        .join(" ");
      if (points.length === 0) return "";
      return `<polyline points="${points}" fill="none" stroke="${palette.ink}" stroke-width="${String(CHART_LINE_WIDTH)}" opacity="${opacityFor(0.9 - seriesIndex * 0.2)}"/>`;
    })
    .join("");
  return columns + lines;
}

function simpleBars(
  block: Extract<CanvasBlock, { readonly kind: "chart" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
): string {
  const values = block.series
    .flatMap((series) => series.points.map((point) => point.y))
    .slice(0, 12);
  if (values.length === 0) return grid(y, width, palette);
  const peak = Math.max(...values.map((value) => Math.abs(value)), 1);
  const slot = width / values.length;
  return values
    .map((value, index) => {
      const height = Math.max(2, Math.round((Math.abs(value) / peak) * (CHART_HEIGHT - 4)));
      return column(
        PADDING + index * slot + 1,
        slot - 3,
        y + CHART_HEIGHT - height,
        height,
        palette,
        0.75,
      );
    })
    .join("");
}

function column(
  x: number,
  width: number,
  top: number,
  height: number,
  palette: ArtifactThumbnailPalette,
  opacity: number,
): string {
  return `<rect x="${String(Math.round(x))}" y="${String(Math.round(top))}" width="${String(Math.max(2, Math.round(width)))}" height="${String(Math.round(height))}" rx="${String(CHART_BAR_RADIUS)}" fill="${palette.accent}" opacity="${opacityFor(opacity)}"/>`;
}

function round(value: number): number {
  return Math.round(value);
}

/** Keep a series' opacity readable, however many series share the picture. */
function opacityFor(value: number): string {
  return String(Math.min(0.9, Math.max(0.25, Math.round(value * 100) / 100)));
}

function timeline(y: number, width: number, palette: ArtifactThumbnailPalette): string {
  const marks = 5;
  return (
    `<rect x="${String(PADDING)}" y="${String(y + 7)}" width="${String(width)}" height="2" rx="1" fill="${palette.muted}" opacity="0.5"/>` +
    Array.from(
      { length: marks },
      (_unused, index) =>
        `<circle cx="${String(Math.round(PADDING + (index * width) / (marks - 1)))}" cy="${String(y + 8)}" r="3" fill="${palette.accent}" opacity="0.8"/>`,
    ).join("")
  );
}

function diagram(
  block: Extract<CanvasBlock, { readonly kind: "diagram" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
): string {
  const nodes = block.nodes.slice(0, 5);
  if (nodes.length === 0) return lines(y, 2, width, palette);
  const slot = width / Math.max(nodes.length, 2);
  const boxWidth = Math.max(24, Math.round(slot - 10));
  const positions = nodes.map((_unused, index) => ({
    x: Math.round(PADDING + index * slot),
    y: index % 2 === 0 ? y : y + 24,
  }));
  const edges = positions
    .slice(0, -1)
    .map((position, index) => {
      const next = positions[index + 1];
      if (next === undefined) return "";
      return `<line x1="${String(position.x + boxWidth)}" y1="${String(position.y + 9)}" x2="${String(next.x)}" y2="${String(next.y + 9)}" stroke="${palette.muted}" stroke-width="1"/>`;
    })
    .join("");
  const boxes = positions
    .map(
      (position) =>
        `<rect x="${String(position.x)}" y="${String(position.y)}" width="${String(boxWidth)}" height="18" rx="3" fill="none" stroke="${palette.accent}" stroke-width="1.2"/>`,
    )
    .join("");
  return edges + boxes;
}

function sequence(
  block: Extract<CanvasBlock, { readonly kind: "sequence" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
): string {
  const participants = block.participants.slice(0, 4);
  if (participants.length === 0) return lines(y, 2, width, palette);
  const slot = width / participants.length;
  const lifelines = participants
    .map((_participant, index) => {
      const x = Math.round(PADDING + slot * index + slot / 2);
      return `<line x1="${String(x)}" y1="${String(y)}" x2="${String(x)}" y2="${String(y + 52)}" stroke="${palette.muted}" stroke-width="1" stroke-dasharray="2 2"/>`;
    })
    .join("");
  const arrows = block.messages.slice(0, 3).map((message, index) => {
    const from = participants.findIndex(
      (participant) => String(participant.participantId) === String(message.from),
    );
    const to = participants.findIndex(
      (participant) => String(participant.participantId) === String(message.to),
    );
    const fromX = Math.round(PADDING + slot * Math.max(from, 0) + slot / 2);
    const toX = Math.round(PADDING + slot * Math.max(to, 0) + slot / 2);
    const lineY = y + 14 + index * 14;
    return (
      `<line x1="${String(fromX)}" y1="${String(lineY)}" x2="${String(toX)}" y2="${String(lineY)}" stroke="${palette.accent}" stroke-width="1.2"/>` +
      text(Math.min(fromX, toX) + 4, lineY - 2, clamp(message.label, 18), 7, palette.ink)
    );
  });
  const names = participants
    .map((participant, index) =>
      text(
        Math.round(PADDING + slot * index),
        y + 8,
        clamp(participant.label, 10),
        7,
        palette.ink,
        600,
      ),
    )
    .join("");
  return lifelines + arrows.join("") + names;
}

function stateMachine(
  block: Extract<CanvasBlock, { readonly kind: "state" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
): string {
  const states = block.states.filter((state) => state.parentId === undefined).slice(0, 4);
  if (states.length === 0) return lines(y, 2, width, palette);
  const slot = width / states.length;
  const boxWidth = Math.max(24, Math.round(slot - 10));
  const boxes = states
    .map((state, index) => {
      const x = Math.round(PADDING + index * slot);
      const mark =
        state.role === "initial" || state.role === "final"
          ? `<circle cx="${String(x + 8)}" cy="${String(y + 10)}" r="5" fill="${state.role === "initial" ? palette.accent : "none"}" stroke="${palette.accent}" stroke-width="1.2"/>`
          : `<rect x="${String(x)}" y="${String(y)}" width="${String(boxWidth)}" height="18" rx="3" fill="none" stroke="${palette.accent}" stroke-width="1.2"/>`;
      return mark + text(x, y + 32, clamp(state.label, 12), 7, palette.ink);
    })
    .join("");
  const arrows = block.transitions.slice(0, 3).map((transition, index) => {
    const from = states.findIndex((state) => String(state.stateId) === String(transition.source));
    const to = states.findIndex((state) => String(state.stateId) === String(transition.target));
    if (from < 0 || to < 0) return "";
    const fromX = Math.round(PADDING + from * slot + boxWidth);
    const toX = Math.round(PADDING + to * slot);
    return `<line x1="${String(fromX)}" y1="${String(y + 9)}" x2="${String(toX)}" y2="${String(y + 9 + index)}" stroke="${palette.muted}" stroke-width="1"/>`;
  });
  return arrows.join("") + boxes;
}

function mockupFrame(
  block: Extract<CanvasBlock, { readonly kind: "mockup" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
): string {
  const frameWidth =
    block.device === "phone"
      ? Math.min(width, 40)
      : block.device === "tablet"
        ? Math.min(width, 88)
        : width;
  const x = PADDING;
  const frame = `<rect x="${String(x)}" y="${String(y)}" width="${String(frameWidth)}" height="48" rx="4" fill="none" stroke="${palette.accent}" stroke-width="1.2"/>`;
  const rows = block.nodes.slice(0, 4).map((node, index) => {
    const rowWidth = Math.round((frameWidth - 8) * (node.component === "button" ? 0.42 : 0.78));
    return `<rect x="${String(x + 4)}" y="${String(y + 6 + index * 10)}" width="${String(rowWidth)}" height="6" rx="1.5" fill="${palette.muted}" opacity="0.5"/>`;
  });
  return frame + rows.join("");
}

/** A row of frame outlines in the design's own proportions, as many as fit. */
function designFrames(
  block: Extract<CanvasBlock, { readonly kind: "design" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
): string {
  const height = 48;
  const viewport = CANVAS_DESIGN_VIEWPORT[block.size];
  const frameWidth = Math.round((height * viewport.width) / viewport.height);
  const gap = 6;
  const fits = Math.max(1, Math.floor((width + gap) / (frameWidth + gap)));
  return block.frames
    .slice(0, fits)
    .map((_frame, index) => {
      const x = PADDING + index * (frameWidth + gap);
      return (
        `<rect x="${String(x)}" y="${String(y)}" width="${String(frameWidth)}" height="${String(height)}" rx="3" fill="none" stroke="${palette.accent}" stroke-width="1.2"/>` +
        `<rect x="${String(x + 4)}" y="${String(y + 6)}" width="${String(Math.round((frameWidth - 8) * 0.7))}" height="5" rx="1.5" fill="${palette.muted}" opacity="0.5"/>`
      );
    })
    .join("");
}

function text(
  x: number,
  y: number,
  value: string,
  size: number,
  fill: string,
  weight = 400,
): string {
  if (value.length === 0) return "";
  return `<text x="${String(x)}" y="${String(y)}" font-size="${String(size)}" font-weight="${String(weight)}" fill="${fill}">${escapeXml(value)}</text>`;
}

function clamp(value: string, maximum: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maximum ? collapsed : `${collapsed.slice(0, maximum - 1)}…`;
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Escape every character that could end an attribute or open a tag.
 *
 * Artifact text is written by providers and by people, so it is not trusted to
 * be markup-safe. Escaping here rather than at the call sites is what keeps a
 * title from becoming an element.
 */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

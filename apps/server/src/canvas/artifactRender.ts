import type { CanvasBlock, CanvasDefinition } from "@octant/contracts/canvas";
import { MAX_ARTIFACT_PREVIEW_CHARACTERS } from "@octant/contracts/artifact-library";

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

function bars(
  block: Extract<CanvasBlock, { readonly kind: "chart" }>,
  y: number,
  width: number,
  palette: ArtifactThumbnailPalette,
): string {
  // The real values, so a chart's silhouette is its own rather than a stock one.
  const values = block.series
    .flatMap((series) => series.points.map((point) => point.y))
    .slice(0, 12);
  if (values.length === 0) return grid(y, width, palette);
  const peak = Math.max(...values.map((value) => Math.abs(value)), 1);
  const slot = width / values.length;
  return values
    .map((value, index) => {
      const height = Math.max(2, Math.round((Math.abs(value) / peak) * 40));
      return `<rect x="${String(Math.round(PADDING + index * slot + 1))}" y="${String(y + 44 - height)}" width="${String(Math.max(2, Math.round(slot - 3)))}" height="${String(height)}" rx="1" fill="${palette.accent}" opacity="0.75"/>`;
    })
    .join("");
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

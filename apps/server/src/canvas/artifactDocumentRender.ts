import katex from "katex";
import {
  canvasTableRowCells,
  type CanvasBlock,
  type CanvasDefinition,
  type CanvasDesignAssetResolution,
  type CanvasMockupNode,
  type CanvasNumberFormat,
} from "@octant/contracts/canvas";
import {
  CANVAS_EXPORT_BODY_MAX_BYTES,
  CANVAS_HTML_FILE_IMAGES_MAX_BYTES,
  CANVAS_HTML_FILE_MAX_BYTES,
  canvasExportBodyByteLength,
  type CanvasExportImplementedFormat,
} from "@octant/contracts/canvas-export";
import { isCanvasShareSafeText } from "@octant/contracts/canvas-share";
import { formatCanvasNumber } from "@octant/domain/canvas-number-format";
import {
  layoutCanvasFlow,
  type CanvasFlowScreenSourceBlock,
} from "@octant/domain/canvas-flow-layout";
import { canvasFlowSite } from "@octant/domain/canvas-flow-site";
import {
  treemapChildren,
  treemapRootId,
  treemapTotals,
} from "@octant/domain/canvas-treemap-layout";
import { heatmapRowTotals } from "@octant/domain/canvas-heatmap-layout";
import { layoutCanvasBarList } from "@octant/domain/canvas-bar-list-layout";
import {
  COMPARISON_MATRIX_GLYPH_LABEL,
  formatComparisonMatrixTotal,
  layoutCanvasComparisonMatrix,
  type CanvasMatrixCellLayout,
} from "@octant/domain/canvas-comparison-matrix";
import { canvasMathRenderOptions } from "@octant/domain/canvas-math-policy";
import {
  canvasReadingOrder,
  type CanvasPlacedReadingItem,
} from "@octant/domain/canvas-dashboard-layout";
import {
  CANVAS_MOCKUP_DEVICE_NAME,
  canvasMockupCallouts,
  canvasMockupFrames,
  canvasMockupNodeReading,
  type CanvasMockupBranch,
} from "@octant/domain/canvas-mockup-outline";
import { layoutCanvasDiagram } from "@octant/domain/canvas-diagram-layout";
import { layoutCanvasPlanGantt } from "@octant/domain/canvas-plan-gantt-layout";
import { DEFAULT_LIGHT_TOKENS } from "@octant/theme";
import { DEFAULT_ARTIFACT_PALETTE, drawCanvasDiagramLayout, escapeXml } from "./artifactRender";
import type { DesignFrameThemeValues } from "@octant/domain";
import { CanvasExportImages, renderCanvasDesignExportFrames } from "./canvasDesignPage";
import {
  drawCanvasExportChart,
  EXPORT_INK,
  type CanvasExportDrawing,
  type CanvasExportLegendEntry,
} from "./canvasExportChart";
import {
  drawCanvasExportBarList,
  drawCanvasExportEr,
  drawCanvasExportHeatmap,
  drawCanvasExportMindmap,
  drawCanvasExportSequence,
  drawCanvasExportState,
  drawCanvasExportSwimlane,
  drawCanvasExportTreemap,
} from "./canvasExportDiagrams";

/**
 * The reading form of the same blocks a preview draws.
 *
 * The SVG in `artifactRender` is a glance. This is the document a destination
 * receives: Markdown or HTML, self-contained, with no script and no fetch.
 * Text the share filter would not let leave the host is redacted before either
 * form is built, so export does not invent a second send-out sanitizer.
 * PDF and PNG are not produced here.
 */

export type ArtifactDocumentRender =
  | {
      readonly kind: "rendered";
      readonly title: string;
      readonly body: string;
      /** Whether the body holds a design's frames, which are markup as written. */
      readonly writesDesignMarkup: boolean;
    }
  | { readonly kind: "too-large" };

/**
 * How a design leaves in the HTML form. Its titles always do. Its frames are
 * markup, which the share filter cannot read, so they are written only when
 * the person exporting has acknowledged that markup leaves as written.
 */
export interface ArtifactDocumentOptions {
  readonly frames?: "as-written";
  /**
   * The theme a design drawn in the workspace theme is exported in, handed
   * over by the person's window. Without it such a design reads as its titles.
   */
  readonly frameTheme?: DesignFrameThemeValues;
}

export function renderArtifactMarkdown(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
): ArtifactDocumentRender {
  return finish(renderDocument(definition, "markdown", {}), CANVAS_EXPORT_BODY_MAX_BYTES);
}

/**
 * The HTML a destination receives, under the approval card's limit. Pictures
 * make the file larger than the reading it carried before they were drawn, so
 * a Canvas that fit then must not be refused now: when the drawn file passes
 * the limit, each picture the reading under it already carries in full is
 * written as that reading alone, and styled blocks as their text.
 */
export function renderArtifactHtml(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
  options: ArtifactDocumentOptions = {},
): ArtifactDocumentRender {
  const drawn = finish(renderDocument(definition, "html", options), CANVAS_EXPORT_BODY_MAX_BYTES);
  if (drawn.kind === "rendered") return drawn;
  return finish(
    renderDocument(definition, "html", { ...options, pictures: "reading" }),
    CANVAS_EXPORT_BODY_MAX_BYTES,
  );
}

/**
 * The Canvas as one HTML file a person saves or copies from their own window:
 * the HTML form, with each design's declared images that resolved for that
 * reader written in as `data:` images up to the file's image budget, under
 * the file's own size cap rather than the approval card's.
 */
export type CanvasHtmlFileRender =
  | (Extract<ArtifactDocumentRender, { readonly kind: "rendered" }> & {
      /**
       * Declared images that resolved for the reader but were drawn as
       * placeholders because the file would pass its image budget.
       */
      readonly imagesLeftOut: number;
    })
  | { readonly kind: "too-large" };

export function renderCanvasHtmlFile(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
  options: ArtifactDocumentOptions & {
    /** The declared images of each design, by block id, resolved for the reader. */
    readonly designAssets: ReadonlyMap<string, ReadonlyArray<CanvasDesignAssetResolution>>;
  },
): CanvasHtmlFileRender {
  const images = new CanvasExportImages(
    options.designAssets,
    Math.ceil(CANVAS_HTML_FILE_IMAGES_MAX_BYTES / 3) * 4,
  );
  const document = renderDocument(definition, "html", { ...options, images });
  // The cap bounds the answer a window or paired device reads, where the file
  // is a JSON string: a newline, backslash, quote, or control character the
  // file holds as one byte takes two to six there, so the cap counts it so.
  if (canvasExportBodyByteLength(JSON.stringify(document.body)) > CANVAS_HTML_FILE_MAX_BYTES) {
    return { kind: "too-large" };
  }
  return { kind: "rendered", ...document, imagesLeftOut: images.leftOut };
}

export function renderArtifactDocument(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
  format: CanvasExportImplementedFormat,
  options: ArtifactDocumentOptions = {},
): ArtifactDocumentRender {
  return format === "html"
    ? renderArtifactHtml(definition, options)
    : renderArtifactMarkdown(definition);
}

/**
 * What the internal render takes: the public options, the file's image
 * budget, and whether pictures are written as their readings alone.
 */
type RenderOptions = ArtifactDocumentOptions & {
  readonly images?: CanvasExportImages;
  readonly pictures?: "reading";
};

type Piece =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly items: ReadonlyArray<string> }
  | { readonly kind: "ordered"; readonly items: ReadonlyArray<string> }
  | {
      readonly kind: "tree";
      readonly items: ReadonlyArray<{ readonly depth: number; readonly text: string }>;
    }
  | {
      readonly kind: "table";
      readonly headers: ReadonlyArray<string>;
      readonly rows: ReadonlyArray<ReadonlyArray<string>>;
    }
  | {
      /**
       * The reading of the picture drawn just above it. Markdown, which draws
       * no picture, writes it as ever; HTML folds it under a Data disclosure,
       * as the screen does, so the picture reads first and nothing is lost.
       */
      readonly kind: "data";
      readonly pieces: ReadonlyArray<Piece>;
    }
  | {
      /**
       * A block the HTML form draws in the Canvas's own anatomy (a callout's
       * tone edge, a metric tile, a progress bar, a status badge). `text` is
       * its reading, which the Markdown form writes as a paragraph.
       */
      readonly kind: "styled";
      readonly text: string;
      readonly html: string;
      /** Consecutive metric tiles share one row, as on screen. */
      readonly tile?: true;
    }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "rule" }
  | {
      readonly kind: "formula";
      /** The source, or undefined when the share filter withheld it. */
      readonly source: string | undefined;
      readonly caption: string;
    }
  | { readonly kind: "math-paragraph"; readonly runs: ReadonlyArray<MathRun> }
  | {
      /**
       * A picture the HTML form draws inline: generated SVG elements with every
       * text already filtered, no script, no id, and no reference out. The
       * Markdown form carries the reading beside it instead.
       */
      readonly kind: "drawing";
      readonly label: string;
      readonly width: number;
      readonly height: number;
      readonly markup: string;
      readonly legend?: ReadonlyArray<CanvasExportLegendEntry>;
      /**
       * The reading under it carries everything it shows, so a destination
       * export near its limit writes only that reading. The node-edge diagram,
       * drawn before any other picture, is always drawn.
       */
      readonly yieldsToReading?: true;
    }
  | {
      /**
       * A design's frame as the HTML form draws it: a page of the author's
       * markup in a sandboxed `srcdoc` frame that carries its own policy. The
       * Markdown form carries the frame's title instead.
       */
      readonly kind: "frame";
      readonly title: string;
      readonly sandbox: "" | "allow-scripts";
      readonly width: number | undefined;
      readonly height: number;
      readonly page: string;
    }
  | {
      /**
       * A flow as the HTML form draws it: one self-contained section set
       * whose screens move by `:target` and whose transitions are real
       * anchors. Generated by this host from typed, redacted data, so its
       * markup is trusted the way a drawing's is; a design screen inside it is
       * the design's sandboxed frame page. The Markdown form carries the
       * graph reading instead.
       */
      readonly kind: "site";
      readonly markup: string;
      /** The site embeds design frames, so the card must say markup leaves. */
      readonly writesDesignMarkup: boolean;
    };

/** A paragraph run; a withheld formula source reads as redacted prose. */
type MathRun =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "math"; readonly source: string };

interface DocumentBody {
  readonly title: string;
  readonly body: string;
  readonly writesDesignMarkup: boolean;
}

function finish(document: DocumentBody, maxBytes: number): ArtifactDocumentRender {
  return canvasExportBodyByteLength(document.body) <= maxBytes
    ? { kind: "rendered", ...document }
    : { kind: "too-large" };
}

function reading(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return isCanvasShareSafeText(trimmed) ? trimmed : "[redacted]";
}

/**
 * Prose beside a formula keeps its edge spaces: they are what separate the
 * words from the mathematics once the runs are joined.
 */
function prose(value: string): string {
  return isCanvasShareSafeText(value) ? value : "[redacted]";
}

/**
 * A formula's source as it may leave the host. The source is the reading in
 * both forms, so a source the share filter would not let out is withheld
 * whole rather than typeset around a hole.
 */
function mathSource(value: string): string | undefined {
  return isCanvasShareSafeText(value) ? value : undefined;
}

function mathPieces(block: Extract<CanvasBlock, { readonly kind: "math" }>): ReadonlyArray<Piece> {
  if (block.layout === "display") {
    return [
      {
        kind: "formula",
        source: mathSource(block.source),
        caption: block.caption === undefined ? "" : reading(block.caption),
      },
    ];
  }
  return [
    {
      kind: "math-paragraph",
      runs: block.runs.map((run): MathRun => {
        if (!("math" in run)) return { kind: "text", text: prose(run.text) };
        const source = mathSource(run.math);
        return source === undefined
          ? { kind: "text", text: "[redacted]" }
          : { kind: "math", source };
      }),
    },
  ];
}

function scalar(value: string | number | boolean | null, format?: CanvasNumberFormat): string {
  if (value === null) return "";
  if (typeof value === "string") return reading(value);
  // A number reads through the shared formatter so the document matches the
  // screen; a boolean has no number reading.
  if (typeof value === "number") return formatCanvasNumber(value, format);
  return String(value);
}

/**
 * A comparison matrix as the screen draws it: options across, criteria down,
 * a weighted score row from the shared layout, the cell notes numbered in the
 * same order, and the author's recommendation in words. Every option and
 * criterion the block declares is carried; an empty coordinate reads as not
 * assessed rather than as a zero or a no.
 */
function comparisonMatrixPieces(
  block: Extract<CanvasBlock, { readonly kind: "comparison-matrix" }>,
): ReadonlyArray<Piece> {
  const layout = layoutCanvasComparisonMatrix(block);
  const weighted = layout.rows.some((row) => row.weight !== undefined);
  const cellText = (cell: CanvasMatrixCellLayout | undefined): string => {
    const value = cell?.reading;
    let text: string;
    if (value === undefined) text = "Not assessed";
    else if (value.kind === "glyph") text = COMPARISON_MATRIX_GLYPH_LABEL[value.glyph];
    else if (value.kind === "text") text = reading(value.text);
    else text = formatCanvasNumber(value.score);
    return cell?.noteNumber === undefined ? text : `${text} [${String(cell.noteNumber)}]`;
  };
  const rows: Array<ReadonlyArray<string>> = layout.rows.map((row) => [
    row.prefer === "lower" ? `${reading(row.label)} (lower is better)` : reading(row.label),
    ...(weighted ? [formatCanvasNumber(row.weight ?? 1)] : []),
    ...row.cells.map(cellText),
  ]);
  if (layout.scoredCriteria.length > 0) {
    rows.push([
      "Weighted score",
      ...(weighted ? [""] : []),
      ...layout.options.map((option) => {
        if (option.total === undefined) return "";
        // The screen marks the highest score unless every option ties; the
        // export keeps that distinction rather than leaving the reader to scan.
        const leads =
          layout.leaders.includes(option.optionId) && layout.leaders.length < layout.options.length;
        const remarks = [
          ...(leads ? ["highest"] : []),
          ...(option.total.missing === 0 ? [] : [`${String(option.total.missing)} not scored`]),
        ];
        const total = formatComparisonMatrixTotal(option.total, layout.scoreRange);
        return remarks.length === 0 ? total : `${total} (${remarks.join(", ")})`;
      }),
    ]);
  }
  const labels = new Map<string, string>();
  for (const option of layout.options) labels.set(option.optionId, reading(option.label));
  for (const row of layout.rows) labels.set(row.criterionId, reading(row.label));
  const pieces: Piece[] = [
    {
      kind: "table",
      headers: [
        "Criterion",
        ...(weighted ? ["Weight"] : []),
        ...layout.options.map((option) =>
          option.recommended ? `${reading(option.label)} (recommended)` : reading(option.label),
        ),
      ],
      rows,
    },
  ];
  if (layout.notes.length > 0) {
    pieces.push({
      kind: "ordered",
      items: layout.notes.map(
        (note) =>
          `${labels.get(note.criterionId) ?? ""} · ${labels.get(note.optionId) ?? ""}: ${reading(note.text)}`,
      ),
    });
  }
  const recommended = layout.options.find((option) => option.recommended);
  if (recommended !== undefined) {
    const why = block.recommendation === undefined ? "" : reading(block.recommendation);
    pieces.push(
      ...paragraph(
        [`Recommended: ${reading(recommended.label)}.`, why]
          .filter((part) => part !== "")
          .join(" "),
      ),
    );
  }
  return pieces;
}

function renderDocument(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
  format: CanvasExportImplementedFormat,
  options: RenderOptions,
): DocumentBody {
  const pieces: Piece[] = [];
  // A design's frames are drawn only in the HTML form and only as written by
  // acknowledgement; a design the export cannot draw reads as its titles.
  const read = (block: CanvasBlock): ReadonlyArray<Piece> =>
    block.kind === "design" && format === "html" && options.frames === "as-written"
      ? (designFramePieces(block, options.frameTheme, options.images) ?? piecesFor(block))
      : piecesFor(block);
  // A dashboard reads where it sits: its title, then each placed block in
  // cell order, which is the order the screen's grid reads at one column. A
  // tab reads under its label and a column in track order, and a dashboard in
  // a pane or column reads there exactly as it does at the top level. A flow
  // reads as its graph: each screen, then each transition with its hotspot. A
  // placed block never reads again where it sits in the block list.
  const placedPieces = (item: CanvasPlacedReadingItem<CanvasBlock>): ReadonlyArray<Piece> =>
    item.kind === "block"
      ? read(item.block)
      : item.kind === "flow"
        ? format === "html" && options.pictures !== "reading"
          ? flowSitePieces(item.flow, definition.blocks, options)
          : flowPieces(item.flow, definition.blocks)
        : [
            { kind: "heading", level: 2, text: reading(item.dashboard.title) },
            ...item.cells.flatMap((cell) => read(cell.block)),
          ];
  for (const item of canvasReadingOrder(definition.blocks)) {
    if (item.kind !== "group") {
      pieces.push(...placedPieces(item));
      continue;
    }
    const group = item.group;
    item.sections.forEach((section, index) => {
      const label = group.kind === "tabs" ? group.panes[index]?.label : undefined;
      if (label !== undefined) pieces.push({ kind: "heading", level: 3, text: reading(label) });
      for (const child of section) pieces.push(...placedPieces(child));
    });
  }
  const title = reading(definition.title) || "Canvas";
  const written = options.pictures === "reading" ? asReading(pieces) : pieces;
  const body = format === "html" ? htmlDocument(title, written) : markdownDocument(title, written);
  return {
    title,
    body,
    writesDesignMarkup: pieces.some(
      (piece) => piece.kind === "frame" || (piece.kind === "site" && piece.writesDesignMarkup),
    ),
  };
}

/**
 * Text a generated page draws, with what the share filter would not let leave
 * the host replaced, as every other export path does through `reading`. The
 * site and mockup generators escape markup but do not judge content, so a
 * secret-shaped label or a host path is redacted before they see it. Edge
 * spaces are kept: a label is drawn whole, not joined to other runs.
 */
function shareSafe(value: string): string {
  return isCanvasShareSafeText(value) ? value : "[redacted]";
}

function readableFlow(
  flow: Extract<CanvasBlock, { readonly kind: "flow" }>,
): Extract<CanvasBlock, { readonly kind: "flow" }> {
  return {
    ...flow,
    title: shareSafe(flow.title),
    edges: flow.edges.map((edge) =>
      edge.label === undefined ? edge : { ...edge, label: shareSafe(edge.label) },
    ),
  };
}

function readableMockupNode(node: CanvasMockupNode): CanvasMockupNode {
  return {
    ...node,
    label: shareSafe(node.label),
    ...(node.value === undefined ? {} : { value: shareSafe(node.value) }),
    ...(node.columns === undefined ? {} : { columns: node.columns.map(shareSafe) }),
    ...(node.rows === undefined ? {} : { rows: node.rows.map((cells) => cells.map(shareSafe)) }),
  };
}

function readableMockup(
  block: Extract<CanvasBlock, { readonly kind: "mockup" }>,
): Extract<CanvasBlock, { readonly kind: "mockup" }> {
  return {
    ...block,
    title: shareSafe(block.title),
    ...(block.variants === undefined
      ? {}
      : {
          variants: block.variants.map((variant) => ({
            ...variant,
            label: shareSafe(variant.label),
          })),
        }),
    nodes: block.nodes.map(readableMockupNode),
    ...(block.definitions === undefined
      ? {}
      : {
          definitions: block.definitions.map((definition) => ({
            ...definition,
            label: shareSafe(definition.label),
            nodes: definition.nodes.map(readableMockupNode),
          })),
        }),
    ...(block.annotations === undefined
      ? {}
      : {
          annotations: block.annotations.map((annotation) => ({
            ...annotation,
            note: shareSafe(annotation.note),
          })),
        }),
  };
}

/** A design's titles as a flow site's headings draw them; its frames' markup is the frame page's. */
function readableDesignTitles(
  block: Extract<CanvasBlock, { readonly kind: "design" }>,
): Extract<CanvasBlock, { readonly kind: "design" }> {
  return {
    ...block,
    title: shareSafe(block.title),
    frames: block.frames.map((frame) => ({ ...frame, title: shareSafe(frame.title) })),
  };
}

/**
 * A flow as the HTML form draws it: the site's section set, with each design
 * screen holding the sandboxed frame page the export already writes for a
 * design's frames. The site itself is generated from typed data; only the
 * design screens' pages are the author's markup, so the card says so exactly
 * when a flow places a design.
 */
function flowSitePieces(
  flow: Extract<CanvasBlock, { readonly kind: "flow" }>,
  blocks: ReadonlyArray<CanvasBlock>,
  options: RenderOptions,
): ReadonlyArray<Piece> {
  const sources = blocks.filter((block) => block.kind === "mockup" || block.kind === "design");
  let writesDesignMarkup = false;
  const designScreenHtml = new Map<string, string>();
  for (const screen of flow.screens) {
    const design = sources.find(
      (block): block is Extract<CanvasBlock, { readonly kind: "design" }> =>
        block.kind === "design" && String(block.blockId) === String(screen.blockId),
    );
    if (design === undefined || screen.frameId === undefined) continue;
    // The export renders one page per authored frame, in the authored order,
    // so the screen's frame is the page at its own index.
    const index = design.frames.findIndex(
      (authored) => String(authored.frameId) === String(screen.frameId),
    );
    if (index < 0) continue;
    const frames = renderCanvasDesignExportFrames(design, options.frameTheme, options.images);
    const chosen = frames?.[index];
    if (chosen === undefined) continue;
    writesDesignMarkup = true;
    const attributes = `sandbox="${chosen.sandbox}" referrerpolicy="no-referrer" title="${escapeXml(reading(chosen.title))}"`;
    const srcdoc = `srcdoc="${escapeXml(chosen.page)}"`;
    const style =
      chosen.width === undefined
        ? `width:100%;max-width:100%;height:${String(chosen.height)}px;border:0`
        : `width:100%;max-width:100%;height:${String(chosen.height)}px;border:0;object-fit:contain`;
    designScreenHtml.set(
      String(screen.screenId),
      `<iframe ${attributes} style="${style}" ${srcdoc}></iframe>`,
    );
  }
  return [
    {
      kind: "site",
      markup: canvasFlowSite({
        flow: readableFlow(flow),
        scope: String(flow.blockId),
        blocks: sources.map((block) =>
          block.kind === "mockup" ? readableMockup(block) : readableDesignTitles(block),
        ),
        ...(designScreenHtml.size === 0 ? {} : { designScreenHtml }),
      }),
      writesDesignMarkup,
    },
  ];
}

/**
 * A flow as the graph a reader walks: its screens, then each transition with
 * the control that starts it. The reading comes from the same pure layout the
 * board draws, so an export and the screen name the same screens.
 */
function flowPieces(
  flow: Extract<CanvasBlock, { readonly kind: "flow" }>,
  blocks: ReadonlyArray<CanvasBlock>,
): ReadonlyArray<Piece> {
  const sources = blocks.filter(
    (block) => block.kind === "mockup" || block.kind === "design",
  ) as ReadonlyArray<CanvasFlowScreenSourceBlock>;
  const layout = layoutCanvasFlow(flow, sources);
  const transitions = layout.edges.map((edge) => {
    const joined = `${reading(edge.from.label)} → ${reading(edge.to.label)}`;
    const label = edge.label === undefined ? "" : `: ${reading(edge.label)}`;
    const hotspot = edge.hotspot === undefined ? "" : ` (via ${reading(edge.hotspot.label)})`;
    return `${joined}${label}${hotspot}`;
  });
  return [
    { kind: "heading", level: 2, text: reading(flow.title) },
    { kind: "list", items: layout.screens.map((screen) => reading(screen.label)) },
    ...(transitions.length === 0 ? [] : [{ kind: "list" as const, items: transitions }]),
  ];
}

/** A design as its title and its drawn frames, when the export can draw it. */ function designFramePieces(
  block: Extract<CanvasBlock, { readonly kind: "design" }>,
  theme: DesignFrameThemeValues | undefined,
  images: CanvasExportImages | undefined,
): ReadonlyArray<Piece> | undefined {
  const frames = renderCanvasDesignExportFrames(block, theme, images);
  if (frames === undefined) return undefined;
  // The file says so when an image that resolved was left out for size, so
  // a placeholder in it is not mistaken for a missing image.
  const leftOut = images?.leftOutOf(block) ?? 0;
  return [
    { kind: "heading", level: 2, text: reading(block.title) },
    ...(leftOut === 0
      ? []
      : paragraph(
          `${String(leftOut)} ${leftOut === 1 ? "image was" : "images were"} left out of this file to keep it under ${String(CANVAS_HTML_FILE_IMAGES_MAX_BYTES / (1024 * 1024))} MB of images; ${leftOut === 1 ? "its place shows" : "their places show"} a placeholder.`,
        )),
    ...frames.map((frame) => ({ kind: "frame" as const, ...frame, title: reading(frame.title) })),
  ];
}

function piecesFor(block: CanvasBlock): ReadonlyArray<Piece> {
  switch (block.kind) {
    case "heading":
      return [{ kind: "heading", level: Math.min(6, block.level + 1), text: reading(block.text) }];
    case "rich-text":
      return paragraph(reading(block.text));
    case "callout": {
      const title = block.title === undefined ? "" : reading(block.title);
      const text = [title, reading(block.text)].filter((part) => part.length > 0).join(" — ");
      return styled(
        text,
        `<aside class="callout callout--${block.tone}">${title === "" ? "" : `<strong>${escapeXml(title)}</strong>`}<p>${escapeXml(reading(block.text))}</p></aside>`,
      );
    }
    case "link":
      return paragraph(linkText(reading(block.label), block.href));
    case "divider":
      return [{ kind: "rule" }];
    case "citation":
      return paragraph(
        [reading(block.label), block.quote === undefined ? "" : reading(block.quote)]
          .filter((part) => part.length > 0)
          .join(": "),
      );
    case "metric": {
      const value = `${reading(block.label)}: ${scalar(block.value, block.format)}${block.unit === undefined ? "" : ` ${reading(block.unit)}`}`;
      const text = block.caption === undefined ? value : `${value} — ${reading(block.caption)}`;
      return text.length === 0
        ? []
        : [{ kind: "styled", text, html: metricTile(block), tile: true }];
    }
    case "progress": {
      const percent = `${String(Math.round(block.value * 100))}%`;
      const detail = block.detail === undefined ? "" : reading(block.detail);
      return styled(
        `${reading(block.label)}: ${percent}${detail === "" ? "" : ` — ${detail}`}`,
        `<div class="progress"><span>${escapeXml(reading(block.label))} <span class="muted">${percent}</span></span><progress max="1" value="${String(block.value)}">${percent}</progress>${detail === "" ? "" : `<span class="muted">${escapeXml(detail)}</span>`}</div>`,
      );
    }
    case "status":
      return styled(
        `${reading(block.label)}: ${reading(block.value)}`,
        `<p class="status status--${block.tone}"><span>${escapeXml(reading(block.label))}</span> <strong>${escapeXml(reading(block.value))}</strong></p>`,
      );
    case "key-value":
      return [
        {
          kind: "table",
          headers: ["Field", "Value"],
          rows: block.entries.map((entry) => [reading(entry.key), scalar(entry.value)]),
        },
      ];
    case "table":
      return [
        {
          kind: "table",
          headers: block.columns.map((column) => reading(column.label)),
          rows: block.rows.map((row) => {
            const cells = canvasTableRowCells(row);
            return block.columns.map((column, index) =>
              scalar(cells[index] ?? null, column.format),
            );
          }),
        },
      ];
    case "chart": {
      // The picture the screen draws, then every reading under it, so a value
      // a mark cannot label is still in the file.
      const items =
        block.chartType === "sankey"
          ? (block.links ?? []).map(
              (link) =>
                `${reading(link.source)} → ${reading(link.target)} = ${scalar(link.value, block.format)}`,
            )
          : block.series.flatMap((series) =>
              series.points.map((point) =>
                [
                  `${reading(series.label)}: ${scalar(point.x, block.format)} = ${scalar(point.y, block.format)}`,
                  point.note === undefined ? "" : ` — ${reading(point.note)}`,
                  point.emphasis === true ? " (highlighted)" : "",
                ].join(""),
              ),
            );
      const heading: ReadonlyArray<Piece> = [
        ...(block.title === undefined
          ? []
          : [{ kind: "heading" as const, level: 4, text: reading(block.title) }]),
        ...(block.subtitle === undefined
          ? []
          : [{ kind: "paragraph" as const, text: reading(block.subtitle) }]),
      ];
      return [
        ...heading,
        ...pictured(drawCanvasExportChart(block, reading), [{ kind: "list", items }]),
      ];
    }
    case "timeline":
      return [
        {
          kind: "list",
          items: block.items.map((item) =>
            [reading(item.title), item.detail === undefined ? "" : reading(item.detail)]
              .filter((part) => part.length > 0)
              .join(" — "),
          ),
        },
      ];
    case "diagram": {
      // The picture is the board's own layout, so the HTML places the same
      // nodes the thread does; the list is the reading both forms carry, with
      // a shaped node named by its role.
      const layout = layoutCanvasDiagram(block);
      const names = new Map(block.nodes.map((node) => [String(node.nodeId), reading(node.label)]));
      const drawing: CanvasExportDrawing | undefined =
        block.nodes.length === 0
          ? undefined
          : {
              label: "Diagram",
              width: layout.width,
              height: layout.height,
              markup: drawCanvasDiagramLayout(layout, DEFAULT_ARTIFACT_PALETTE, {
                x: 0,
                y: 0,
                scale: 1,
                label: reading,
              }),
            };
      return pictured(
        drawing,
        [
          {
            kind: "list",
            items: [
              ...layout.nodes.map((node) => {
                const named =
                  node.shape === "plain"
                    ? reading(node.label)
                    : `${reading(node.label)} (${node.shape})`;
                return node.detail === undefined ? named : `${named} — ${reading(node.detail)}`;
              }),
              ...block.edges.map((edge) => {
                const from = names.get(String(edge.source)) ?? "node";
                const to = names.get(String(edge.target)) ?? "node";
                const label = edge.label === undefined ? "" : reading(edge.label);
                const arrow = edge.style === "dashed" ? "⇢" : "→";
                return label.length === 0
                  ? `${from} ${arrow} ${to}`
                  : `${from} ${arrow} ${to}: ${label}`;
              }),
            ],
          },
        ],
        "always",
      );
    }
    case "sequence": {
      const names = new Map(
        block.participants.map((participant) => [
          String(participant.participantId),
          reading(participant.label),
        ]),
      );
      return pictured(drawCanvasExportSequence(block, reading), [
        {
          kind: "list",
          items: [
            ...block.messages.map((message) => {
              const from = names.get(String(message.from)) ?? "participant";
              const to = names.get(String(message.to)) ?? "participant";
              return `${from} → ${to}: ${reading(message.label)}`;
            }),
            ...(block.notes ?? []).map((note) => reading(note.text)),
          ],
        },
      ]);
    }
    case "state": {
      const names = new Map(
        block.states.map((state) => [String(state.stateId), reading(state.label)]),
      );
      return pictured(drawCanvasExportState(block, reading), [
        {
          kind: "list",
          items: [
            ...block.states.map((state) => reading(state.label)),
            ...block.transitions.map((transition) => {
              const from = names.get(String(transition.source)) ?? "state";
              const to = names.get(String(transition.target)) ?? "state";
              return `${from} → ${to}: ${reading(transition.label)}`;
            }),
          ],
        },
      ]);
    }
    case "code-excerpt":
    case "pseudocode":
      return [{ kind: "code", text: reading(block.code) }];
    case "diff":
      return [
        {
          kind: "code",
          text: block.hunks
            .map((hunk) =>
              [
                reading(hunk.header),
                ...hunk.lines.map((line) => {
                  const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
                  return `${prefix} ${reading(line.text)}`;
                }),
              ].join("\n"),
            )
            .join("\n"),
        },
      ];
    case "summary":
      return [
        { kind: "heading", level: 2, text: reading(block.title) },
        {
          kind: "list",
          items: block.items.map((item) =>
            item.value === undefined
              ? reading(item.label)
              : `${reading(item.label)}: ${scalar(item.value)}`,
          ),
        },
      ];
    case "source-reference":
    case "artifact-reference":
    case "file-reference":
    case "preview-reference":
    case "browser-reference":
    case "evidence-reference":
      return paragraph(
        [reading(block.label), block.detail === undefined ? "" : reading(block.detail)]
          .filter((part) => part.length > 0)
          .join(" — "),
      );
    case "image":
      return paragraph(
        [reading(block.alt), block.caption === undefined ? "" : reading(block.caption)]
          .filter((part) => part.length > 0)
          .join(" — "),
      );
    case "mockup":
      return mockupPieces(block);
    case "treemap": {
      // The hierarchy as a table: one row per node, indented by depth, so the
      // exported document carries the same readings the picture shows.
      const children = treemapChildren(block);
      const rootId = treemapRootId(block);
      const totals = block.measures.map((measure) =>
        treemapTotals(block, String(measure.measureId)),
      );
      const nodesById = new Map(block.nodes.map((node) => [String(node.nodeId), node]));
      const rows: Array<ReadonlyArray<string>> = [];
      const indent = (depth: number) => "\u00A0".repeat(depth * 2);
      const walk = (nodeId: string, depth: number) => {
        const node = nodesById.get(nodeId);
        if (node === undefined) return;
        rows.push([
          `${indent(depth)}${reading(node.label)}`,
          ...block.measures.map((measure, index) =>
            scalar(totals[index]?.get(nodeId) ?? 0, measure.format),
          ),
        ]);
        for (const child of children.get(nodeId) ?? []) walk(child, depth + 1);
      };
      walk(rootId, 0);
      return pictured(drawCanvasExportTreemap(block, reading), [
        {
          kind: "table",
          headers: ["Item", ...block.measures.map((measure) => reading(measure.label))],
          rows,
        },
      ]);
    }
    case "heatmap": {
      // The grid as a table: a row per declared row and a column per declared
      // column, so a coordinate the block does not list reads as an empty cell
      // rather than as a zero.
      if (block.layout === "matrix") {
        const totals = heatmapRowTotals(block);
        const byCoordinate = new Map(
          block.cells.map((cell) => [
            `${String(cell.rowId)}\u0000${String(cell.columnId)}`,
            cell.value,
          ]),
        );
        return pictured(drawCanvasExportHeatmap(block, reading), [
          {
            kind: "table",
            headers: ["Row", ...block.columns.map((column) => reading(column.label)), "Total"],
            rows: block.rows.map((row) => {
              const rowId = String(row.rowId);
              return [
                reading(row.label),
                ...block.columns.map((column) => {
                  const value = byCoordinate.get(`${rowId}\u0000${String(column.columnId)}`);
                  return value === undefined ? "" : scalar(value, block.format);
                }),
                scalar(totals.get(rowId) ?? 0, block.format),
              ];
            }),
          },
        ]);
      }
      return pictured(drawCanvasExportHeatmap(block, reading), [
        {
          kind: "table",
          headers: ["Date", reading(block.valueLabel ?? "Value"), "Note"],
          rows: block.days.map((day) => [
            day.date,
            scalar(day.value, block.format),
            day.note === undefined ? "" : reading(day.note),
          ]),
        },
      ]);
    }
    case "design":
      // The reading form names each screen or slide. Its markup is drawn only
      // inside Octant's sandboxed frame, so it never travels in an export.
      return [
        { kind: "heading", level: 2, text: reading(block.title) },
        { kind: "ordered", items: block.frames.map((frame) => reading(frame.title)) },
      ];
    case "bar-list": {
      // The ranking as a table in the order the screen and the preview draw
      // it, largest first through the shared layout, carrying every row the
      // block declares rather than only the top rows.
      const hasSecondary = block.rows.some((row) => row.secondaryValue !== undefined);
      const ranked = layoutCanvasBarList(block).rows;
      return pictured(drawCanvasExportBarList(block, reading), [
        {
          kind: "table",
          headers: [
            "Item",
            reading(block.valueLabel ?? "Value"),
            ...(hasSecondary ? [reading(block.secondaryLabel ?? "Second")] : []),
          ],
          rows: ranked.map((row) => [
            reading(row.label),
            scalar(row.value, block.format),
            ...(hasSecondary
              ? [
                  row.secondaryValue === undefined
                    ? ""
                    : scalar(row.secondaryValue, block.secondaryFormat ?? block.format),
                ]
              : []),
          ]),
        },
      ]);
    }
    case "comparison-matrix":
      return comparisonMatrixPieces(block);
    case "math":
      return mathPieces(block);
    case "plan": {
      const phases = new Map(
        block.phases.map((phase) => [String(phase.phaseId), reading(phase.title)]),
      );
      // Dates read from the same Gantt layout the view draws, so a bar's days
      // and the exported days agree, including a due day before its start.
      const days = new Map(
        layoutCanvasPlanGantt(block).bars.map((bar) => [
          bar.taskId,
          bar.startDay === bar.endDay ? bar.startDay : `${bar.startDay} → ${bar.endDay}`,
        ]),
      );
      return [
        { kind: "heading", level: 2, text: reading(block.title) },
        {
          kind: "list",
          items: block.tasks.map((task) => {
            const phase = phases.get(String(task.phaseId)) ?? "";
            const prefix = phase.length === 0 ? "" : `${phase}: `;
            const when = days.get(String(task.taskId));
            return `${prefix}${reading(task.title)} (${task.status})${when === undefined ? "" : `, ${when}`}`;
          }),
        },
      ];
    }
    case "er": {
      // The schema as one attribute table plus a relationship list: the same
      // reading the picture shows, so an exported model is not a second model.
      const keys = new Map(
        block.entities.map((entity) => [String(entity.entityId), reading(entity.label)]),
      );
      const rows: Array<ReadonlyArray<string>> = [];
      for (const entity of block.entities) {
        if (entity.attributes.length === 0) {
          rows.push([reading(entity.label), "", "", ""]);
          continue;
        }
        for (const attribute of entity.attributes) {
          rows.push([
            reading(entity.label),
            reading(attribute.name),
            reading(attribute.type),
            attribute.key === true ? "key" : "",
          ]);
        }
      }
      const relationshipItems = block.relationships.map((relationship) => {
        const from = keys.get(String(relationship.source)) ?? "entity";
        const to = keys.get(String(relationship.target)) ?? "entity";
        const label = relationship.label === undefined ? "" : ` (${reading(relationship.label)})`;
        return `${from} ${relationship.sourceCardinality} — ${relationship.targetCardinality} ${to}${label}`;
      });
      const pieces: Piece[] = [
        {
          kind: "table",
          headers: ["Entity", "Attribute", "Type", "Key"],
          rows,
        },
      ];
      if (relationshipItems.length > 0) {
        pieces.push({ kind: "list", items: relationshipItems });
      }
      return pictured(drawCanvasExportEr(block, reading), pieces);
    }
    case "swimlane": {
      // Numbered steps per lane, in lane order, then the connections.
      const pieces: Piece[] = [];
      const laneSteps = new Map<string, string[]>();
      for (const step of block.steps) {
        const bucket = laneSteps.get(String(step.laneId)) ?? [];
        bucket.push(reading(step.label));
        laneSteps.set(String(step.laneId), bucket);
      }
      for (const lane of block.lanes) {
        const steps = laneSteps.get(String(lane.laneId)) ?? [];
        pieces.push({ kind: "heading", level: 3, text: reading(lane.label) });
        pieces.push({
          kind: "ordered",
          items: steps.length === 0 ? ["(no steps)"] : steps,
        });
      }
      if (block.connections.length > 0) {
        const names = new Map(
          block.steps.map((step) => [String(step.stepId), reading(step.label)]),
        );
        pieces.push({
          kind: "list",
          items: block.connections.map((connection) => {
            const from = names.get(String(connection.source)) ?? "step";
            const to = names.get(String(connection.target)) ?? "step";
            const label = connection.label === undefined ? "" : `: ${reading(connection.label)}`;
            return `${from} → ${to}${label}`;
          }),
        });
      }
      return pictured(drawCanvasExportSwimlane(block, reading), pieces);
    }
    case "mindmap": {
      // A nested list, indented by depth, so the branch structure survives the
      // round trip even though the block stores parents rather than nesting.
      const childrenOf = new Map<string, string[]>();
      const nodesById = new Map(block.nodes.map((node) => [String(node.nodeId), node]));
      let rootId: string | undefined;
      for (const node of block.nodes) {
        const id = String(node.nodeId);
        if (node.parentId === undefined) {
          rootId ??= id;
          continue;
        }
        const siblings = childrenOf.get(String(node.parentId)) ?? [];
        siblings.push(id);
        childrenOf.set(String(node.parentId), siblings);
      }
      const items: Array<{ readonly depth: number; readonly text: string }> = [];
      const walk = (id: string, depth: number) => {
        const node = nodesById.get(id);
        if (node === undefined) return;
        const note = node.note === undefined ? "" : ` — ${reading(node.note)}`;
        items.push({ depth, text: `${reading(node.label)}${note}` });
        for (const child of childrenOf.get(id) ?? []) walk(child, depth + 1);
      };
      if (rootId !== undefined) walk(rootId, 0);
      return pictured(rootId === undefined ? undefined : drawCanvasExportMindmap(block, reading), [
        { kind: "tree", items },
      ]);
    }
    case "dashboard":
    case "tabs":
    case "columns":
      // Drawn by the reading order with what it places; one met alone has nothing to say.
      return [];
    case "flow":
      // Drawn by the reading order with the screens it places; one met alone
      // has nothing to say.
      return [];
    case "action":
      return paragraph(
        [reading(block.label), block.description === undefined ? "" : reading(block.description)]
          .filter((part) => part.length > 0)
          .join(" — "),
      );
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

/**
 * A mockup as the outline a reader would get from the screen: its device and
 * fidelity, then each frame's component tree as a nested list (under the
 * variant's name when there are several), then the numbered callouts.
 */
function mockupPieces(
  block: Extract<CanvasBlock, { readonly kind: "mockup" }>,
): ReadonlyArray<Piece> {
  const callouts = canvasMockupCallouts(block);
  const labels = new Map(block.nodes.map((node) => [String(node.nodeId), node.label]));
  const size =
    block.size === undefined
      ? ""
      : ` at ${String(block.size.width)} × ${String(block.size.height)}`;
  const pieces: Piece[] = [
    { kind: "heading", level: 2, text: reading(block.title) },
    {
      kind: "paragraph",
      text: `${CANVAS_MOCKUP_DEVICE_NAME[block.device]} mockup${size}, ${block.fidelity ?? "wireframe"}.`,
    },
  ];
  for (const frame of canvasMockupFrames(block)) {
    if (frame.label !== undefined) {
      pieces.push({ kind: "heading", level: 3, text: reading(frame.label) });
    }
    const items: Array<{ readonly depth: number; readonly text: string }> = [];
    const walk = (branch: CanvasMockupBranch, depth: number) => {
      items.push({
        depth,
        text: reading(
          canvasMockupNodeReading(branch.node, callouts.get(String(branch.node.nodeId))),
        ),
      });
      for (const child of branch.children) walk(child, depth + 1);
    };
    for (const root of frame.roots) walk(root, 0);
    if (items.length > 0) pieces.push({ kind: "tree", items });
  }
  if (block.annotations !== undefined && block.annotations.length > 0) {
    pieces.push({
      kind: "ordered",
      items: block.annotations.map(
        (annotation) =>
          `${reading(labels.get(String(annotation.nodeId)) ?? String(annotation.nodeId))} — ${reading(annotation.note)}`,
      ),
    });
  }
  return pieces;
}

function paragraph(text: string): ReadonlyArray<Piece> {
  return text.length === 0 ? [] : [{ kind: "paragraph", text }];
}

/**
 * A picture with its reading folded under it, or the reading alone when there
 * is no picture. A picture `"always"` drawn stays even when a destination
 * export writes the others as their readings.
 */
function pictured(
  drawing: CanvasExportDrawing | undefined,
  reading: ReadonlyArray<Piece>,
  drawn: "always" | "within-limit" = "within-limit",
): ReadonlyArray<Piece> {
  if (drawing === undefined) return reading;
  return [
    { kind: "drawing", ...drawing, ...(drawn === "within-limit" ? { yieldsToReading: true } : {}) },
    { kind: "data", pieces: reading },
  ];
}

/**
 * The document as a destination received it before pictures were drawn: each
 * picture that yields to its reading is left out and that reading written in
 * its place, unfolded, and a styled block is its text as a paragraph.
 */
function asReading(pieces: ReadonlyArray<Piece>): ReadonlyArray<Piece> {
  return pieces.flatMap((piece): ReadonlyArray<Piece> => {
    switch (piece.kind) {
      case "drawing":
        return piece.yieldsToReading === true ? [] : [piece];
      case "data":
        return asReading(piece.pieces);
      case "styled":
        return [{ kind: "paragraph", text: piece.text }];
      default:
        return [piece];
    }
  });
}

/** `html` is built here from filtered, escaped text; `text` is what Markdown writes. */
function styled(text: string, html: string): ReadonlyArray<Piece> {
  return text.length === 0 ? [] : [{ kind: "styled", text, html }];
}

/**
 * A metric as the screen's tile: label, value and unit, a signed delta whose
 * tone follows the block's own direction (the arrow and the sign stay the
 * channel without colour), the sparkline, and the caption.
 */
function metricTile(block: Extract<CanvasBlock, { readonly kind: "metric" }>): string {
  const unit =
    block.unit === undefined ? "" : ` <span class="unit">${escapeXml(reading(block.unit))}</span>`;
  const delta = block.delta;
  let deltaHtml = "";
  if (delta !== undefined) {
    const tone =
      delta === 0 || block.goodDirection === undefined || block.goodDirection === "neutral"
        ? "flat"
        : delta > 0 === (block.goodDirection === "up")
          ? "good"
          : "bad";
    const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "–";
    const sign = delta > 0 ? "+" : "";
    deltaHtml = `<span class="delta ${tone}">${arrow} ${escapeXml(`${sign}${formatCanvasNumber(delta, block.format)}`)}</span>`;
  }
  const caption =
    block.caption === undefined
      ? ""
      : `<span class="muted">${escapeXml(reading(block.caption))}</span>`;
  return `<div class="metric"><span class="muted">${escapeXml(reading(block.label))}</span><span class="value">${escapeXml(scalar(block.value, block.format))}${unit}</span>${deltaHtml}${sparkline(block.sparkline)}${caption}</div>`;
}

function sparkline(values: ReadonlyArray<number> | undefined): string {
  if (values === undefined || values.length === 0) return "";
  const width = 100;
  const height = 24;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const points = values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * (width - 4) + 2;
      const y = span === 0 ? height / 2 : height - 2 - ((value - low) / span) * (height - 4);
      return `${String(Math.round(x * 10) / 10)},${String(Math.round(y * 10) / 10)}`;
    })
    .join(" ");
  return `<svg class="sparkline" viewBox="0 0 ${String(width)} ${String(height)}" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${EXPORT_INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function linkText(label: string, href: string): string {
  if (label.length === 0) return "";
  if (!safeHttpUrl(href)) return label;
  return `[${label}](${href})`;
}

function safeHttpUrl(value: string): boolean {
  if (!isCanvasShareSafeText(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function markdownDocument(title: string, pieces: ReadonlyArray<Piece>): string {
  const lines = [`# ${inline(title)}`, ""];
  for (const piece of pieces) {
    // Markdown carries a drawing's reading, which follows it as its own piece.
    if (piece.kind === "drawing") continue;
    lines.push(markdownPiece(piece), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function markdownPiece(piece: Piece): string {
  switch (piece.kind) {
    case "heading":
      return `${"#".repeat(piece.level)} ${inline(piece.text)}`;
    case "paragraph":
      return inline(piece.text);
    case "list":
      return piece.items.map((item) => `- ${inline(item)}`).join("\n");
    case "ordered":
      return piece.items.map((item, index) => `${String(index + 1)}. ${inline(item)}`).join("\n");
    case "tree":
      return piece.items
        .map((item) => `${"  ".repeat(item.depth)}- ${inline(item.text)}`)
        .join("\n");
    case "table":
      return [
        `| ${piece.headers.map(cell).join(" | ")} |`,
        `| ${piece.headers.map(() => "---").join(" | ")} |`,
        ...piece.rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
      ].join("\n");
    case "code":
      return `\`\`\`\n${piece.text.replace(/```/g, "'''")}\n\`\`\``;
    case "rule":
      return "---";
    case "formula": {
      // A fenced `math` block is how GitHub and most Markdown readers typeset
      // display math, and a fence keeps the source out of HTML parsing.
      const formula =
        piece.source === undefined
          ? "[redacted]"
          : `${fence(piece.source, "`", 3)}math\n${piece.source}\n${fence(piece.source, "`", 3)}`;
      return piece.caption.length === 0 ? formula : `${formula}\n\n${inline(piece.caption)}`;
    }
    case "math-paragraph":
      // An inline formula is a code span between dollars, GitHub's inline
      // math, so `<` or `*` in the source stays mathematics.
      return piece.runs
        .map((run) => {
          if (run.kind === "text") return inline(run.text);
          const ticks = fence(run.source, "`", 1);
          const pad = run.source.startsWith("`") || run.source.endsWith("`") ? " " : "";
          return `$${ticks}${pad}${run.source}${pad}${ticks}$`;
        })
        .join("");
    case "drawing":
      return "";
    case "data":
      return piece.pieces.map(markdownPiece).join("\n\n");
    case "styled":
      return inline(piece.text);
    case "frame":
      // Markdown has no frame; the titles a design reads as are written by
      // the reading form, which the Markdown form always uses.
      return "";
    case "site":
      // A site is the HTML form's shape of a flow; the Markdown form renders
      // the graph reading, because `options.pictures` is the reading there.
      return "";
    default: {
      const unhandled: never = piece;
      return unhandled;
    }
  }
}

/** A run of `mark` longer than any run of it inside `text`, and at least `minimum` long. */
function fence(text: string, mark: string, minimum: number): string {
  let longest = 0;
  let current = 0;
  for (const character of text) {
    current = character === mark ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return mark.repeat(Math.max(minimum, longest + 1));
}

function inline(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cell(value: string): string {
  // Backslashes first: a cell ending in `\` would otherwise cancel the escape on
  // the next pipe and split the row.
  return inline(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

const color = (id: string, fallback: string): string => DEFAULT_LIGHT_TOKENS[id] ?? fallback;

/**
 * The Canvas's own anatomy on the light scheme, written into the file: a
 * reading column, tiles, callouts, tables, and pictures. Only generic and
 * system font families are named, so the file loads no font, and every
 * colour is a default theme value, so it needs no Octant page to read from.
 */
const DOCUMENT_STYLE = [
  ":root{color-scheme:light}",
  "*{box-sizing:border-box}",
  `body{margin:0;background:${color("workspace", "#ffffff")};color:${color("text-primary", "#141414")};font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}`,
  "main{max-width:880px;margin:0 auto;padding:32px 24px 48px}",
  "@media (max-width:600px){main{padding:20px 16px 32px}}",
  "h1{font-size:26px;line-height:1.2;letter-spacing:-0.01em;margin:0 0 20px;overflow-wrap:anywhere}",
  "h2{font-size:19px;margin:28px 0 8px;overflow-wrap:anywhere}",
  "h3{font-size:16px;margin:22px 0 6px;overflow-wrap:anywhere}",
  "h4,h5,h6{font-size:14px;margin:18px 0 6px}",
  "p,ul,ol{margin:4px 0 14px}",
  "figure{margin:0 0 18px}",
  `figcaption{font-size:12px;color:${color("text-muted", "#666666")};margin:0 0 6px}`,
  "svg{max-width:100%;height:auto}",
  ".scroll{overflow-x:auto;margin:0 0 16px}",
  "table{border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}",
  `th,td{border-bottom:1px solid ${color("border", "#e0e0de")};padding:6px 10px;text-align:left;vertical-align:top}`,
  `th{font-weight:600;color:${color("text-secondary", "#45454a")};background:${color("control", "#f0f0ef")}}`,
  `pre{white-space:pre-wrap;overflow-wrap:anywhere;background:${color("control", "#f0f0ef")};border:1px solid ${color("border", "#e0e0de")};border-radius:6px;padding:10px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}`,
  "a{color:inherit}",
  `details.data{margin:-10px 0 20px;font-size:13px;color:${color("text-secondary", "#45454a")}}`,
  `summary{cursor:pointer;color:${color("text-muted", "#666666")};font-size:12px}`,
  `.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:6px 0 0;padding:0;list-style:none;font-size:12px;color:${color("text-secondary", "#45454a")}}`,
  ".legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}",
  ".legend i.line{width:14px;height:0;border-radius:0;border-top:2px solid;vertical-align:3px}",
  `.callout{border:1px solid ${color("border", "#e0e0de")};border-left:2px solid ${color("accent-text", "#141414")};border-radius:8px;background:${color("floating", "#fdfdfc")};padding:10px 14px;margin:0 0 16px}`,
  `.callout--warning{border-left-color:${color("warning-text", "#141414")}}`,
  `.callout--danger{border-left-color:${color("danger-text", "#a8102f")}}`,
  `.callout--success{border-left-color:${color("success-text", "#0f6144")}}`,
  ".callout strong{display:block;margin-bottom:4px}.callout p{margin:0}",
  ".metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(max(9rem,25%),1fr));gap:8px;margin:0 0 16px}",
  ".metric{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:12px;border:1px solid rgba(20,20,20,0.07);border-radius:6px;background:rgba(20,20,20,0.04)}",
  ".metric .value{font-size:24px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}",
  ".metric .unit{font-size:14px;font-weight:500;letter-spacing:0}",
  ".delta{font-size:12px;font-variant-numeric:tabular-nums}",
  `.delta.good{color:${color("success-text", "#0f6144")}}.delta.bad{color:${color("danger-text", "#a8102f")}}`,
  ".sparkline{display:block;width:100%;max-width:160px;height:24px}",
  `.muted{color:${color("text-muted", "#666666")};font-size:12px}`,
  ".progress{display:flex;flex-direction:column;gap:4px;margin:0 0 16px}",
  `progress{width:100%;height:8px;accent-color:${color("accent", "#141414")}}`,
  `.status{display:inline-flex;gap:6px;padding:2px 10px;border-radius:999px;background:${color("control", "#f0f0ef")};font-size:13px}`,
  `.status--success{background:${color("success-surface", "#bfd8cc")};color:${color("success-text", "#0f6144")}}`,
  `.status--danger{color:${color("danger-text", "#a8102f")}}`,
  "iframe{background:#ffffff}",
].join("");

function htmlDocument(title: string, pieces: ReadonlyArray<Piece>): string {
  // Consecutive metric tiles share one responsive row, as on screen.
  const parts: string[] = [];
  let tiles: string[] = [];
  for (const piece of pieces) {
    if (piece.kind === "styled" && piece.tile === true) {
      tiles.push(piece.html);
      continue;
    }
    if (tiles.length > 0) parts.push(`<div class="metrics">${tiles.join("")}</div>`);
    tiles = [];
    parts.push(htmlPiece(piece));
  }
  if (tiles.length > 0) parts.push(`<div class="metrics">${tiles.join("")}</div>`);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${documentPolicy(pieces)}<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeXml(title)}</title><style>${DOCUMENT_STYLE}</style></head><body><main><h1>${escapeXml(title)}</h1>${parts.join("")}</main></body></html>\n`;
}

/**
 * The policy the document carries for itself, first in its head, so the file
 * loads nothing from anywhere wherever it is opened: its styles, pictures,
 * and images are all inside it.
 *
 * A frame's own page forbids its script every request, but not leaving: a
 * page that sets its own address loaded another page, which then reached the
 * network (seen in a browser with an exported file and a local listener).
 * `frame-src 'none'` on the document refuses that navigation, and a `srcdoc`
 * frame is not a navigation, so the frames still draw. A `srcdoc` page also
 * inherits this policy, so it admits inline script only when a frame here runs
 * any; the document itself holds no script.
 */
function documentPolicy(pieces: ReadonlyArray<Piece>): string {
  const script = pieces.some((piece) => piece.kind === "frame" && piece.sandbox === "allow-scripts")
    ? " script-src 'unsafe-inline';"
    : "";
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none';${script} style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
}

function htmlPiece(piece: Piece): string {
  switch (piece.kind) {
    case "heading":
      return `<h${String(piece.level)}>${htmlInline(piece.text)}</h${String(piece.level)}>`;
    case "paragraph":
      return `<p>${htmlInline(piece.text)}</p>`;
    case "list":
      return `<ul>${piece.items.map((item) => `<li>${htmlInline(item)}</li>`).join("")}</ul>`;
    case "ordered":
      return `<ol>${piece.items.map((item) => `<li>${htmlInline(item)}</li>`).join("")}</ol>`;
    case "tree":
      return htmlTree(piece.items);
    case "table":
      // A wide table scrolls inside its own box rather than widening the page.
      return `<div class="scroll"><table><thead><tr>${piece.headers.map((header) => `<th>${escapeXml(header)}</th>`).join("")}</tr></thead><tbody>${piece.rows
        .map((row) => `<tr>${row.map((value) => `<td>${escapeXml(value)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`;
    case "data":
      return `<details class="data"><summary>Data</summary>${piece.pieces.map(htmlPiece).join("")}</details>`;
    case "styled":
      return piece.tile === true ? `<div class="metrics">${piece.html}</div>` : piece.html;
    case "code":
      return `<pre>${escapeXml(piece.text)}</pre>`;
    case "rule":
      return "<hr>";
    case "formula": {
      const caption =
        piece.caption.length === 0 ? "" : `<figcaption>${escapeXml(piece.caption)}</figcaption>`;
      if (piece.source === undefined) return `<figure><p>[redacted]</p>${caption}</figure>`;
      return `<figure>${htmlMath(piece.source, true)}${caption}<details><summary>Source</summary><pre>${escapeXml(piece.source)}</pre></details></figure>`;
    }
    case "drawing": {
      const legend =
        piece.legend === undefined || piece.legend.length === 0
          ? ""
          : `<ul class="legend">${piece.legend
              .map(
                (entry) =>
                  `<li>${
                    entry.line === undefined
                      ? `<i style="background:${escapeXml(entry.color)}"></i>`
                      : `<i class="line" style="border-color:${escapeXml(entry.color)};border-top-style:${entry.line}"></i>`
                  }${escapeXml(entry.label)}</li>`,
              )
              .join("")}</ul>`;
      return `<figure><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(piece.label)}" viewBox="0 0 ${String(Math.ceil(piece.width))} ${String(Math.ceil(piece.height))}" style="max-width:100%;height:auto" width="${String(Math.ceil(piece.width))}" font-family="system-ui, sans-serif">${piece.markup}</svg>${legend}</figure>`;
    }
    case "math-paragraph":
      return `<p>${piece.runs
        .map((run) => (run.kind === "text" ? escapeXml(run.text) : htmlMath(run.source, false)))
        .join("")}</p>`;
    case "frame": {
      // The page is an attribute value, so its markup is escaped once more;
      // a frame is the only thing here that can hold the author's markup. It
      // loads with the document rather than lazily: a lazy frame below the
      // fold was blank in a printed or full-page capture of the file.
      const border = `1px solid ${DEFAULT_ARTIFACT_PALETTE.muted}`;
      const attributes = `sandbox="${piece.sandbox}" referrerpolicy="no-referrer" title="${escapeXml(piece.title)}"`;
      const srcdoc = `srcdoc="${escapeXml(piece.page)}"`;
      if (piece.width === undefined) {
        return `<figure><figcaption>${escapeXml(piece.title)}</figcaption><iframe ${attributes} style="width:100%;max-width:100%;height:${String(piece.height)}px;border:${border}" ${srcdoc}></iframe></figure>`;
      }
      // A slide or device screen is laid out against its declared viewport, so
      // the page keeps that size and the box scales it to the width on offer;
      // clipping the right edge would lose the footer and the composition.
      // `tan(atan2(...))` turns the box's width over the viewport width into
      // the unitless factor `scale` needs; where a browser lacks it the frame
      // draws at its own size inside the box.
      const width = `${String(piece.width)}px`;
      const height = `${String(piece.height)}px`;
      return `<figure><figcaption>${escapeXml(piece.title)}</figcaption><div style="width:min(100%,${width});aspect-ratio:${String(piece.width)}/${String(piece.height)};container-type:inline-size;overflow:hidden;border:${border}"><iframe ${attributes} style="display:block;width:${width};height:${height};border:0;transform-origin:0 0;transform:scale(tan(atan2(100cqw,${width})))" ${srcdoc}></iframe></div></figure>`;
    }
    case "site":
      // Generated from typed data by this host, so it is trusted the way a
      // drawing's SVG is, and carries its own scoped styles.
      return piece.markup;
    default: {
      const unhandled: never = piece;
      return unhandled;
    }
  }
}

/**
 * A formula as MathML alone, which a browser draws natively with no
 * stylesheet or font to carry, and which keeps the source as an annotation.
 * KaTeX builds it with trust off and escapes every character it emits; a
 * source it refuses is written as the source itself.
 */
function htmlMath(source: string, display: boolean): string {
  try {
    return katex.renderToString(source, canvasMathRenderOptions(display, "mathml"));
  } catch {
    return display ? `<pre>${escapeXml(source)}</pre>` : `<code>${escapeXml(source)}</code>`;
  }
}

/**
 * Render an indented list as real nested unordered lists, so an exported mind
 * map keeps the branch structure rather than reading as a flat list.
 */
function htmlTree(items: ReadonlyArray<{ readonly depth: number; readonly text: string }>): string {
  interface TreeNode {
    readonly text: string;
    readonly children: TreeNode[];
  }
  const roots: TreeNode[] = [];
  const stack: Array<{ readonly depth: number; readonly node: TreeNode }> = [];
  for (const item of items) {
    const node: TreeNode = { text: item.text, children: [] };
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? -1) >= item.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.node.children.push(node);
    stack.push({ depth: item.depth, node });
  }
  const render = (nodes: ReadonlyArray<TreeNode>): string =>
    `<ul>${nodes
      .map(
        (node) =>
          `<li>${htmlInline(node.text)}${node.children.length === 0 ? "" : render(node.children)}</li>`,
      )
      .join("")}</ul>`;
  return render(roots);
}

/** Markdown links stay links in HTML; everything else is escaped text. */
function htmlInline(value: string): string {
  const match = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(value);
  if (match === null) return escapeXml(value);
  const label = match[1];
  const href = match[2];
  if (label === undefined || href === undefined || !safeHttpUrl(href)) return escapeXml(value);
  return `<a href="${escapeXml(href)}">${escapeXml(label)}</a>`;
}

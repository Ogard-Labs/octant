import katex from "katex";
import type { CanvasBlock, CanvasDefinition, CanvasNumberFormat } from "@octant/contracts/canvas";
import {
  CANVAS_EXPORT_BODY_MAX_BYTES,
  canvasExportBodyByteLength,
  type CanvasExportImplementedFormat,
} from "@octant/contracts/canvas-export";
import { isCanvasShareSafeText } from "@octant/contracts/canvas-share";
import { formatCanvasNumber } from "@octant/domain/canvas-number-format";
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
  CANVAS_MOCKUP_DEVICE_NAME,
  canvasMockupCallouts,
  canvasMockupFrames,
  canvasMockupNodeReading,
  type CanvasMockupBranch,
} from "@octant/domain/canvas-mockup-outline";
import { DEFAULT_ARTIFACT_PALETTE, escapeXml } from "./artifactRender";

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
  | { readonly kind: "rendered"; readonly title: string; readonly body: string }
  | { readonly kind: "too-large" };

export function renderArtifactMarkdown(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
): ArtifactDocumentRender {
  return renderDocument(definition, "markdown");
}

export function renderArtifactHtml(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
): ArtifactDocumentRender {
  return renderDocument(definition, "html");
}

export function renderArtifactDocument(
  definition: Pick<CanvasDefinition, "title" | "blocks">,
  format: CanvasExportImplementedFormat,
): ArtifactDocumentRender {
  return format === "html" ? renderArtifactHtml(definition) : renderArtifactMarkdown(definition);
}

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
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "rule" }
  | {
      readonly kind: "formula";
      /** The source, or undefined when the share filter withheld it. */
      readonly source: string | undefined;
      readonly caption: string;
    }
  | { readonly kind: "math-paragraph"; readonly runs: ReadonlyArray<MathRun> };

/** A paragraph run; a withheld formula source reads as redacted prose. */
type MathRun =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "math"; readonly source: string };

function finish(title: string, body: string): ArtifactDocumentRender {
  return canvasExportBodyByteLength(body) <= CANVAS_EXPORT_BODY_MAX_BYTES
    ? { kind: "rendered", title, body }
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
): ArtifactDocumentRender {
  const pieces: Piece[] = [];
  for (const block of definition.blocks) {
    pieces.push(...piecesFor(block));
  }
  const title = reading(definition.title) || "Canvas";
  const body = format === "html" ? htmlDocument(title, pieces) : markdownDocument(title, pieces);
  return finish(title, body);
}

function piecesFor(block: CanvasBlock): ReadonlyArray<Piece> {
  switch (block.kind) {
    case "heading":
      return [{ kind: "heading", level: Math.min(6, block.level + 1), text: reading(block.text) }];
    case "rich-text":
      return paragraph(reading(block.text));
    case "callout":
      return paragraph(
        [block.title === undefined ? "" : reading(block.title), reading(block.text)]
          .filter((part) => part.length > 0)
          .join(" — "),
      );
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
      return paragraph(
        block.caption === undefined ? value : `${value} — ${reading(block.caption)}`,
      );
    }
    case "progress":
      return paragraph(
        `${reading(block.label)}: ${String(Math.round(block.value * 100))}%${block.detail === undefined ? "" : ` — ${reading(block.detail)}`}`,
      );
    case "status":
      return paragraph(`${reading(block.label)}: ${reading(block.value)}`);
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
          rows: block.rows.map((row) =>
            block.columns.map((column, index) => scalar(row[index] ?? null, column.format)),
          ),
        },
      ];
    case "chart":
      return [
        {
          kind: "list",
          items: block.series.flatMap((series) =>
            series.points.map(
              (point) =>
                `${reading(series.label)}: ${scalar(point.x, block.format)} = ${scalar(point.y, block.format)}`,
            ),
          ),
        },
      ];
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
      const names = new Map(block.nodes.map((node) => [String(node.nodeId), reading(node.label)]));
      return [
        {
          kind: "list",
          items: [
            ...block.nodes.map((node) => reading(node.label)),
            ...block.edges.map((edge) => {
              const from = names.get(String(edge.source)) ?? "node";
              const to = names.get(String(edge.target)) ?? "node";
              const label = edge.label === undefined ? "" : reading(edge.label);
              return label.length === 0 ? `${from} → ${to}` : `${from} → ${to}: ${label}`;
            }),
          ],
        },
      ];
    }
    case "sequence": {
      const names = new Map(
        block.participants.map((participant) => [
          String(participant.participantId),
          reading(participant.label),
        ]),
      );
      return [
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
      ];
    }
    case "state": {
      const names = new Map(
        block.states.map((state) => [String(state.stateId), reading(state.label)]),
      );
      return [
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
      ];
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
      return [
        {
          kind: "table",
          headers: ["Item", ...block.measures.map((measure) => reading(measure.label))],
          rows,
        },
      ];
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
        return [
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
        ];
      }
      return [
        {
          kind: "table",
          headers: ["Date", reading(block.valueLabel ?? "Value"), "Note"],
          rows: block.days.map((day) => [
            day.date,
            scalar(day.value, block.format),
            day.note === undefined ? "" : reading(day.note),
          ]),
        },
      ];
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
      return [
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
      ];
    }
    case "comparison-matrix":
      return comparisonMatrixPieces(block);
    case "math":
      return mathPieces(block);
    case "plan": {
      const phases = new Map(
        block.phases.map((phase) => [String(phase.phaseId), reading(phase.title)]),
      );
      return [
        { kind: "heading", level: 2, text: reading(block.title) },
        {
          kind: "list",
          items: block.tasks.map((task) => {
            const phase = phases.get(String(task.phaseId)) ?? "";
            const prefix = phase.length === 0 ? "" : `${phase}: `;
            return `${prefix}${reading(task.title)} (${task.status})`;
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
      return pieces;
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
      return pieces;
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
      return [{ kind: "tree", items }];
    }
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

function htmlDocument(title: string, pieces: ReadonlyArray<Piece>): string {
  const palette = DEFAULT_ARTIFACT_PALETTE;
  const style = [
    `body{font-family:system-ui,sans-serif;background:${palette.background};color:${palette.ink};margin:24px;line-height:1.45}`,
    "h1{font-size:20px}h2,h3,h4,h5,h6{font-size:16px}",
    `table{border-collapse:collapse}td,th{border:1px solid ${palette.muted};padding:4px 8px;text-align:left}`,
    "pre{white-space:pre-wrap}",
    "a{color:inherit}",
  ].join("");
  const body = pieces.map(htmlPiece).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>${style}</style></head><body><h1>${escapeXml(title)}</h1>${body}</body></html>\n`;
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
      return `<table><thead><tr>${piece.headers.map((header) => `<th>${escapeXml(header)}</th>`).join("")}</tr></thead><tbody>${piece.rows
        .map((row) => `<tr>${row.map((value) => `<td>${escapeXml(value)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
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
    case "math-paragraph":
      return `<p>${piece.runs
        .map((run) => (run.kind === "text" ? escapeXml(run.text) : htmlMath(run.source, false)))
        .join("")}</p>`;
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

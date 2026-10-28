import type { CanvasBlock } from "@octant/contracts/canvas";
import {
  layoutCanvasEr,
  layoutCanvasMindmap,
  layoutCanvasSequence,
  layoutCanvasState,
  layoutCanvasSwimlane,
  type CanvasDiagramPoint,
} from "@octant/domain";
import { formatCanvasNumber } from "@octant/domain/canvas-number-format";
import { barListValueDomain, layoutCanvasBarList } from "@octant/domain/canvas-bar-list-layout";
import {
  layoutCanvasHeatmapCalendar,
  layoutCanvasHeatmapMatrix,
} from "@octant/domain/canvas-heatmap-layout";
import {
  layoutCanvasTreemap,
  treemapLeafReading,
  treemapMeasureDomain,
} from "@octant/domain/canvas-treemap-layout";
import { chartScaleRoleId, chartScaleStep, DEFAULT_LIGHT_TOKENS } from "@octant/theme";
import {
  EXPORT_INK,
  EXPORT_MUTED,
  fit,
  round,
  seriesColor,
  svgText,
  type CanvasExportDrawing,
} from "./canvasExportChart";

/**
 * The structured diagrams and grids as the HTML export draws them, from the
 * same deterministic layouts the board draws, as plain SVG elements with no
 * script, id, or reference out. Every label passes `label`, which decides
 * what text may leave the host; the reading the export writes beside each
 * picture carries everything the picture shows.
 */

type Label = (value: string) => string;
type Block<K extends CanvasBlock["kind"]> = Extract<CanvasBlock, { readonly kind: K }>;

const SURFACE = DEFAULT_LIGHT_TOKENS["floating"] ?? "#fdfdfc";
const FILL = DEFAULT_LIGHT_TOKENS["control"] ?? "#f0f0ef";
const EDGE = DEFAULT_LIGHT_TOKENS["border-strong"] ?? "#bdbdbb";
const RULE = DEFAULT_LIGHT_TOKENS["border"] ?? "#e0e0de";
const FONT = 12;
/** Room around a laid-out diagram, so a label at its edge is not cut off. */
const INSET = 8;

function polyline(points: ReadonlyArray<CanvasDiagramPoint>, dashed = false): string {
  return `<polyline points="${points.map((point) => `${round(point.x)},${round(point.y)}`).join(" ")}" fill="none" stroke="${EXPORT_MUTED}" stroke-width="1.2"${dashed ? ' stroke-dasharray="5 3"' : ""}/>`;
}

/** A small filled triangle on the last segment, so no marker id is needed. */
function arrowhead(points: ReadonlyArray<CanvasDiagramPoint>): string {
  const end = points.at(-1);
  const before = points.at(-2);
  if (end === undefined || before === undefined) return "";
  const angle = Math.atan2(end.y - before.y, end.x - before.x);
  const size = 7;
  const corner = (turn: number) =>
    `${round(end.x - size * Math.cos(angle + turn))} ${round(end.y - size * Math.sin(angle + turn))}`;
  return `<path d="M${round(end.x)} ${round(end.y)} L${corner(-Math.PI / 7)} L${corner(Math.PI / 7)} Z" fill="${EXPORT_MUTED}"/>`;
}

function box(
  x: number,
  y: number,
  width: number,
  height: number,
  options: { readonly radius?: number; readonly fill?: string; readonly dashed?: boolean } = {},
): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="${String(options.radius ?? 6)}" fill="${options.fill ?? SURFACE}" stroke="${EDGE}" stroke-width="1"${options.dashed === true ? ' stroke-dasharray="4 3"' : ""}/>`;
}

function centred(x: number, y: number, value: string, width: number, fill = EXPORT_INK): string {
  return svgText(x, y + 4, fit(value, Math.floor((width - 12) / 7)), {
    anchor: "middle",
    fill,
    size: FONT,
  });
}

function drawing(
  label: string,
  width: number,
  height: number,
  parts: ReadonlyArray<string>,
): CanvasExportDrawing {
  return {
    label,
    width: Math.ceil(width + INSET * 2),
    height: Math.ceil(height + INSET * 2),
    markup: `<g transform="translate(${String(INSET)} ${String(INSET)})">${parts.join("")}</g>`,
  };
}

export function drawCanvasExportSequence(
  block: Block<"sequence">,
  label: Label,
): CanvasExportDrawing {
  const layout = layoutCanvasSequence(block);
  const parts: string[] = [];
  for (const participant of layout.participants) {
    parts.push(
      `<line x1="${round(participant.lifelineX)}" y1="${round(participant.lifelineY1)}" x2="${round(participant.lifelineX)}" y2="${round(participant.lifelineY2)}" stroke="${EDGE}" stroke-dasharray="4 4"/>`,
      box(participant.x, participant.y, participant.width, participant.height),
      centred(
        participant.x + participant.width / 2,
        participant.y + participant.height / 2,
        label(participant.label),
        participant.width,
      ),
    );
  }
  for (const activation of layout.activations) {
    parts.push(
      box(activation.x, activation.y, activation.width, activation.height, {
        radius: 1,
        fill: FILL,
      }),
    );
  }
  for (const message of layout.messages) {
    parts.push(polyline(message.points), arrowhead(message.points));
    parts.push(
      svgText(message.labelX, message.labelY, fit(label(message.label), 28), {
        anchor: "middle",
        size: FONT,
      }),
    );
  }
  for (const note of layout.notes) {
    parts.push(
      box(note.x, note.y, note.width, note.height, { radius: 2, fill: FILL }),
      centred(note.x + note.width / 2, note.y + note.height / 2, label(note.text), note.width),
    );
  }
  return drawing("Sequence diagram", layout.width, layout.height, parts);
}

export function drawCanvasExportState(block: Block<"state">, label: Label): CanvasExportDrawing {
  const layout = layoutCanvasState(block);
  const parts: string[] = [];
  // Regions first, so a nested state draws on top of the state that holds it.
  const ordered = [...layout.states].sort((a, b) => b.width * b.height - a.width * a.height);
  for (const state of ordered) {
    const cx = state.x + state.width / 2;
    const cy = state.y + state.height / 2;
    // A start is named above its marker and an end beneath it, as on the
    // board, so neither name sits on the transition leaving or entering it.
    const marker = svgText(
      cx,
      state.role === "initial" ? state.y - 5 : state.y + state.height + 12,
      fit(label(state.label), 18),
      { anchor: "middle", size: 11 },
    );
    if (state.role === "initial") {
      parts.push(
        `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(state.width / 2)}" fill="${EXPORT_INK}"/>`,
        marker,
      );
      continue;
    }
    if (state.role === "final") {
      parts.push(
        `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(state.width / 2)}" fill="none" stroke="${EXPORT_INK}" stroke-width="1.5"/>`,
        `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(state.width / 2 - 4)}" fill="${EXPORT_INK}"/>`,
        marker,
      );
      continue;
    }
    const region = layout.states.some(
      (other) =>
        other !== state &&
        other.x > state.x &&
        other.y > state.y &&
        other.x + other.width < state.x + state.width &&
        other.y + other.height < state.y + state.height,
    );
    parts.push(box(state.x, state.y, state.width, state.height, { radius: 10, dashed: region }));
    parts.push(
      region
        ? svgText(state.x + 10, state.y + 16, fit(label(state.label), 24), {
            fill: EXPORT_INK,
            size: FONT,
          })
        : centred(cx, cy, label(state.label), state.width),
    );
  }
  for (const transition of layout.transitions) {
    parts.push(polyline(transition.points), arrowhead(transition.points));
    parts.push(
      svgText(transition.labelX, transition.labelY, fit(label(transition.label), 24), {
        anchor: "middle",
        size: FONT,
      }),
    );
  }
  return drawing("State diagram", layout.width, layout.height, parts);
}

export function drawCanvasExportEr(block: Block<"er">, label: Label): CanvasExportDrawing {
  const layout = layoutCanvasEr(block);
  const parts: string[] = [];
  for (const relationship of layout.relationships) {
    parts.push(polyline(relationship.points));
    for (const [text, at] of [
      [relationship.sourceCardinality, relationship.sourceCardinalityAt],
      [relationship.targetCardinality, relationship.targetCardinalityAt],
    ] as const) {
      parts.push(svgText(at.x, at.y, text, { anchor: at.anchor, size: 11 }));
    }
    if (relationship.label !== undefined) {
      parts.push(
        svgText(relationship.labelX, relationship.labelY, fit(label(relationship.label), 24), {
          anchor: relationship.labelAnchor,
          size: 11,
        }),
      );
    }
  }
  for (const entity of layout.entities) {
    parts.push(
      box(entity.x, entity.y, entity.width, entity.height, { radius: 4 }),
      `<rect x="${round(entity.x)}" y="${round(entity.y)}" width="${round(entity.width)}" height="${round(entity.headerHeight)}" rx="4" fill="${FILL}" stroke="${EDGE}"/>`,
      svgText(entity.x + 8, entity.y + entity.headerHeight / 2 + 4, fit(label(entity.label), 28), {
        fill: EXPORT_INK,
        size: FONT,
        weight: 600,
      }),
    );
    for (const attribute of entity.attributes) {
      const text = `${label(attribute.name)}: ${label(attribute.type)}${attribute.key ? " (key)" : ""}`;
      parts.push(
        svgText(attribute.x + 8, attribute.y + attribute.height / 2 + 4, fit(text, 30), {
          fill: EXPORT_INK,
          size: 11,
        }),
      );
    }
  }
  return drawing("Entity relationship diagram", layout.width, layout.height, parts);
}

export function drawCanvasExportSwimlane(
  block: Block<"swimlane">,
  label: Label,
): CanvasExportDrawing {
  const layout = layoutCanvasSwimlane(block);
  const parts: string[] = [];
  for (const lane of layout.lanes) {
    parts.push(
      `<rect x="${round(lane.x)}" y="${round(lane.y)}" width="${round(lane.width)}" height="${round(lane.height)}" fill="none" stroke="${RULE}"/>`,
      svgText(lane.x + 10, lane.y + 20, fit(label(lane.label), 16), {
        fill: EXPORT_INK,
        size: FONT,
        weight: 600,
      }),
      svgText(lane.x + 10, lane.y + 34, fit(label(lane.kind), 18), { size: 10 }),
    );
  }
  for (const connection of layout.connections) {
    parts.push(polyline(connection.points), arrowhead(connection.points));
    if (connection.label !== undefined) {
      parts.push(
        svgText(connection.labelX, connection.labelY, fit(label(connection.label), 16), {
          anchor: "middle",
          size: 11,
        }),
      );
    }
  }
  for (const step of layout.steps) {
    const cx = step.x + step.width / 2;
    const cy = step.y + step.height / 2;
    parts.push(
      step.decision
        ? `<polygon points="${round(cx)},${round(step.y)} ${round(step.x + step.width)},${round(cy)} ${round(cx)},${round(step.y + step.height)} ${round(step.x)},${round(cy)}" fill="${SURFACE}" stroke="${EDGE}"/>`
        : box(step.x, step.y, step.width, step.height),
      centred(cx, cy, label(step.label), step.width),
    );
  }
  return drawing("Swimlane flow", layout.width, layout.height, parts);
}

export function drawCanvasExportMindmap(
  block: Block<"mindmap">,
  label: Label,
): CanvasExportDrawing {
  const layout = layoutCanvasMindmap(block);
  const parts: string[] = [];
  for (const edge of layout.edges) {
    const [from, ...rest] = edge.points;
    const to = rest.at(-1);
    if (from === undefined || to === undefined) continue;
    const middle = (from.x + to.x) / 2;
    parts.push(
      `<path d="M${round(from.x)} ${round(from.y)} C${round(middle)} ${round(from.y)} ${round(middle)} ${round(to.y)} ${round(to.x)} ${round(to.y)}" fill="none" stroke="${EDGE}" stroke-width="1.2"/>`,
    );
  }
  for (const node of layout.nodes) {
    parts.push(
      box(node.x, node.y, node.width, node.height, {
        radius: node.height / 2 > 17 ? 8 : node.height / 2,
        fill: node.root ? FILL : SURFACE,
      }),
    );
    if (node.note === undefined) {
      parts.push(
        centred(node.x + node.width / 2, node.y + node.height / 2, label(node.label), node.width),
      );
    } else {
      parts.push(
        centred(node.x + node.width / 2, node.y + 15, label(node.label), node.width),
        centred(node.x + node.width / 2, node.y + 31, label(node.note), node.width, EXPORT_MUTED),
      );
    }
  }
  return drawing("Mind map", layout.width, layout.height, parts);
}

const SCALE_STEPS = 5;

function scaleColor(
  kind: "sequential" | "diverging",
  value: number,
  domain: { readonly min: number; readonly max: number },
): string {
  const role = chartScaleRoleId(kind, chartScaleStep(value, domain, SCALE_STEPS));
  return DEFAULT_LIGHT_TOKENS[role] ?? EXPORT_MUTED;
}

export function drawCanvasExportTreemap(
  block: Block<"treemap">,
  label: Label,
): CanvasExportDrawing {
  const width = 560;
  const height = 320;
  const layout = layoutCanvasTreemap(block, {
    width,
    height,
    ...(block.startNodeId === undefined ? {} : { rootId: String(block.startNodeId) }),
  });
  const colorBy = String(block.colorBy);
  const domain = treemapMeasureDomain(block, colorBy);
  const scale = block.colorScale ?? "sequential";
  // A categorical treemap takes the hue of each node's top-level group.
  const topGroup = new Map<string, number>();
  let groupIndex = 0;
  for (const rect of layout.nodes) {
    if (rect.depth === 1) topGroup.set(rect.nodeId, groupIndex++);
  }
  const parents = new Map(layout.nodes.map((node) => [node.nodeId, node.parentId]));
  const groupOf = (rect: (typeof layout.nodes)[number]): number => {
    let current: string | undefined = rect.nodeId;
    while (current !== undefined) {
      const found = topGroup.get(current);
      if (found !== undefined) return found;
      current = parents.get(current);
    }
    return 0;
  };
  const parts: string[] = [];
  for (const rect of layout.nodes) {
    if (rect.width < 1 || rect.height < 1) continue;
    if (rect.isGroup) {
      if (rect.depth === 0) continue;
      parts.push(
        `<rect x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.width)}" height="${round(rect.height)}" fill="none" stroke="${EDGE}"/>`,
      );
      if (rect.showsHeader) {
        parts.push(
          svgText(rect.x + 4, rect.y + 12, fit(label(rect.label), Math.floor(rect.width / 7)), {
            fill: EXPORT_INK,
            size: 11,
          }),
        );
      }
      continue;
    }
    const value = treemapLeafReading(block, rect.nodeId, colorBy);
    const fill =
      scale === "categorical" ? seriesColor(groupOf(rect)) : scaleColor(scale, value, domain);
    parts.push(
      `<rect x="${round(rect.x + 0.5)}" y="${round(rect.y + 0.5)}" width="${round(Math.max(0, rect.width - 1))}" height="${round(Math.max(0, rect.height - 1))}" fill="${fill}"/>`,
    );
    if (rect.width > 40 && rect.height > 18) {
      parts.push(
        svgText(rect.x + 5, rect.y + 14, fit(label(rect.label), Math.floor((rect.width - 8) / 7)), {
          fill: "#ffffff",
          size: 11,
        }),
      );
    }
  }
  return { label: "Treemap", width, height, markup: parts.join("") };
}

export function drawCanvasExportHeatmap(
  block: Block<"heatmap">,
  label: Label,
): CanvasExportDrawing {
  const kind = block.scale ?? "sequential";
  const empty = (x: number, y: number, w: number, h: number) =>
    `<rect x="${round(x)}" y="${round(y)}" width="${round(Math.max(1, w - 2))}" height="${round(Math.max(1, h - 2))}" fill="none" stroke="${EDGE}" stroke-dasharray="2 2"/>`;
  const cell = (x: number, y: number, w: number, h: number, fill: string) =>
    `<rect x="${round(x)}" y="${round(y)}" width="${round(Math.max(1, w - 2))}" height="${round(Math.max(1, h - 2))}" rx="2" fill="${fill}"/>`;
  if (block.layout === "matrix") {
    const width = 560;
    const height = Math.min(480, 24 + block.rows.length * 28);
    const layout = layoutCanvasHeatmapMatrix(block, { width, height });
    const parts: string[] = [];
    for (const row of layout.rows) {
      parts.push(
        svgText(layout.grid.x - 6, row.y + row.height / 2 + 4, fit(label(row.label), 13), {
          anchor: "end",
          size: 11,
        }),
      );
    }
    for (const column of layout.columns) {
      parts.push(
        svgText(
          column.x + column.width / 2,
          layout.grid.y - 6,
          fit(label(column.label), Math.max(2, Math.floor(column.width / 7))),
          {
            anchor: "middle",
            size: 11,
          },
        ),
      );
    }
    for (const box of layout.cells) {
      parts.push(
        box.value === undefined
          ? empty(box.x, box.y, box.width, box.height)
          : cell(box.x, box.y, box.width, box.height, scaleColor(kind, box.value, layout.domain)),
      );
    }
    return { label: "Heatmap", width: layout.width, height: layout.height, markup: parts.join("") };
  }
  // A calendar starts its weeks on Monday so the picture does not depend on
  // the reader's locale, as in the artifact preview.
  const layout = layoutCanvasHeatmapCalendar(block, { weekStartsOn: 1 });
  const parts: string[] = [];
  for (const row of layout.weekdayRows) {
    parts.push(svgText(0, row.y + 10, row.label, { size: 10 }));
  }
  for (const month of layout.monthLabels) {
    parts.push(svgText(month.x, 10, month.label, { size: 10 }));
  }
  for (const day of layout.days) {
    parts.push(
      day.value === undefined
        ? empty(day.x, day.y, day.width + 2, day.height + 2)
        : cell(
            day.x,
            day.y,
            day.width + 2,
            day.height + 2,
            scaleColor(kind, day.value, layout.domain),
          ),
    );
  }
  return {
    label: `Calendar heatmap, ${formatCanvasNumber(layout.days.length)} days`,
    width: layout.width,
    height: layout.height,
    markup: parts.join(""),
  };
}

/**
 * A ranking as the screen draws it, largest first through the shared layout:
 * each row's label and reading over a bar whose length is its share of the
 * largest value. Every row is drawn, since a file has no Show all.
 */
export function drawCanvasExportBarList(
  block: Block<"bar-list">,
  label: Label,
): CanvasExportDrawing {
  const layout = layoutCanvasBarList(block);
  const width = 560;
  const row = 34;
  const domain = barListValueDomain(block);
  const parts: string[] = [];
  layout.rows.forEach((entry, index) => {
    const y = index * row;
    const value = formatCanvasNumber(entry.value, block.format);
    const reading =
      entry.secondaryValue === undefined
        ? value
        : `${value} · ${formatCanvasNumber(entry.secondaryValue, block.secondaryFormat ?? block.format)}`;
    const fill =
      block.scale === "sequential" ? scaleColor("sequential", entry.value, domain) : EXPORT_INK;
    parts.push(
      svgText(0, y + 13, fit(label(entry.label), 62), { fill: EXPORT_INK, size: FONT }),
      svgText(width, y + 13, reading, { anchor: "end", size: 11 }),
      `<rect x="0" y="${round(y + 19)}" width="${round(width)}" height="6" rx="3" fill="${FILL}"/>`,
      `<rect x="0" y="${round(y + 19)}" width="${round(Math.max(2, entry.fraction * width))}" height="6" rx="3" fill="${fill}"/>`,
    );
  });
  return {
    label: "Bar list",
    width,
    height: Math.max(row, layout.rows.length * row),
    markup: parts.join(""),
  };
}

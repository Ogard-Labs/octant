import { CANVAS_DESIGN_VIEWPORT } from "@octant/contracts/canvas";
import type { CanvasStaticExportBlock } from "@octant/contracts/canvas-share";
import { layoutCanvasBarList } from "@octant/domain/canvas-bar-list-layout";
import {
  COMPARISON_MATRIX_GLYPH_LABEL,
  formatComparisonMatrixTotal,
  layoutCanvasComparisonMatrix,
  type CanvasMatrixCellLayout,
} from "@octant/domain/canvas-comparison-matrix";
import {
  canvasReadingOrder,
  type CanvasPlacedReadingItem,
} from "@octant/domain/canvas-dashboard-layout";
import { heatmapRowTotals } from "@octant/domain/canvas-heatmap-layout";
import {
  CANVAS_MOCKUP_DEVICE_NAME,
  canvasMockupCallouts,
  canvasMockupFrames,
  canvasMockupNodeReading,
  type CanvasMockupBranch,
} from "@octant/domain/canvas-mockup-outline";
import { formatCanvasNumber } from "@octant/domain/canvas-number-format";
import {
  treemapChildren,
  treemapRootId,
  treemapTotals,
} from "@octant/domain/canvas-treemap-layout";
import type { FrameMode } from "./tokens.ts";

type Block = CanvasStaticExportBlock;
type Scalar = string | number | boolean | null;
type NumberFormat = Parameters<typeof formatCanvasNumber>[1];

export interface RenderContext {
  readonly shareId: string;
  /** The user-content address a design block's frame is drawn from. */
  readonly frameAddress: (blockId: string, mode: FrameMode) => string;
  /** The one prototype the viewer asked to run, if any. */
  readonly runBlockId: string | undefined;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const e = escapeHtml;

function scalar(value: Scalar, format?: NumberFormat): string {
  if (value === null) return "";
  if (typeof value === "number") return e(formatCanvasNumber(value, format));
  return e(String(value));
}

/** Plain text paragraphs: blank lines split them, single line breaks stay. Never Markdown. */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => `<p>${e(part).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function table(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  caption?: string,
): string {
  // Cells arrive already escaped; headers are escaped here.
  const head = headers.map((header) => `<th scope="col">${e(header)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
  return `<div class="table-scroll"><table>${
    caption === undefined ? "" : `<caption>${e(caption)}</caption>`
  }<thead><tr>${head}</tr></thead><tbody>${body.join("")}</tbody></table></div>`;
}

function list(items: ReadonlyArray<string>, ordered = false): string {
  if (items.length === 0) return "";
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`;
}

function tree(items: ReadonlyArray<{ readonly depth: number; readonly text: string }>): string {
  if (items.length === 0) return "";
  return `<ul class="tree">${items
    .map((item) => `<li class="depth-${String(Math.min(item.depth, 8))}">${e(item.text)}</li>`)
    .join("")}</ul>`;
}

function heading(level: number, text: string): string {
  const tag = `h${String(Math.min(6, Math.max(2, level)))}`;
  return `<${tag}>${e(text)}</${tag}>`;
}

function safeHref(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function labelled(label: string, detail: string | undefined): string {
  return `<p class="reference"><strong>${e(label)}</strong>${
    detail === undefined ? "" : ` ${e(detail)}`
  }</p>`;
}

function section(block: Block, body: string): string {
  return `<section class="block block-${e(block.kind)}" id="${e(String(block.blockId))}">${body}</section>`;
}

function comparisonMatrix(block: Extract<Block, { readonly kind: "comparison-matrix" }>): string {
  const layout = layoutCanvasComparisonMatrix(block);
  const weighted = layout.rows.some((row) => row.weight !== undefined);
  const cellText = (cell: CanvasMatrixCellLayout | undefined): string => {
    const value = cell?.reading;
    let text: string;
    if (value === undefined) text = "Not assessed";
    else if (value.kind === "glyph") text = COMPARISON_MATRIX_GLYPH_LABEL[value.glyph];
    else if (value.kind === "text") text = e(value.text);
    else text = e(formatCanvasNumber(value.score));
    return cell?.noteNumber === undefined ? text : `${text} [${String(cell.noteNumber)}]`;
  };
  const rows: Array<ReadonlyArray<string>> = layout.rows.map((row) => [
    row.prefer === "lower" ? `${e(row.label)} (lower is better)` : e(row.label),
    ...(weighted ? [e(formatCanvasNumber(row.weight ?? 1))] : []),
    ...row.cells.map(cellText),
  ]);
  if (layout.scoredCriteria.length > 0) {
    rows.push([
      "Weighted score",
      ...(weighted ? [""] : []),
      ...layout.options.map((option) =>
        option.total === undefined
          ? ""
          : e(formatComparisonMatrixTotal(option.total, layout.scoreRange)),
      ),
    ]);
  }
  const labels = new Map<string, string>();
  for (const option of layout.options) labels.set(option.optionId, option.label);
  for (const row of layout.rows) labels.set(row.criterionId, row.label);
  const recommended = layout.options.find((option) => option.recommended);
  return [
    table(
      [
        "Criterion",
        ...(weighted ? ["Weight"] : []),
        ...layout.options.map((option) =>
          option.recommended ? `${option.label} (recommended)` : option.label,
        ),
      ],
      rows,
    ),
    list(
      layout.notes.map(
        (note) =>
          `${e(labels.get(note.criterionId) ?? "")} · ${e(labels.get(note.optionId) ?? "")}: ${e(note.text)}`,
      ),
      true,
    ),
    recommended === undefined
      ? ""
      : `<p>Recommended: ${e(recommended.label)}.${
          block.recommendation === undefined ? "" : ` ${e(block.recommendation)}`
        }</p>`,
  ].join("");
}

function mockup(block: Extract<Block, { readonly kind: "mockup" }>): string {
  const callouts = canvasMockupCallouts(block);
  const labels = new Map(block.nodes.map((node) => [String(node.nodeId), node.label]));
  const size =
    block.size === undefined
      ? ""
      : ` at ${String(block.size.width)} × ${String(block.size.height)}`;
  const parts = [
    heading(2, block.title),
    `<p>${e(CANVAS_MOCKUP_DEVICE_NAME[block.device])} mockup${size}, ${e(block.fidelity ?? "wireframe")}.</p>`,
  ];
  for (const frame of canvasMockupFrames(block)) {
    if (frame.label !== undefined) parts.push(heading(3, frame.label));
    const items: Array<{ readonly depth: number; readonly text: string }> = [];
    const walk = (branch: CanvasMockupBranch, depth: number): void => {
      items.push({
        depth,
        text: canvasMockupNodeReading(branch.node, callouts.get(String(branch.node.nodeId))),
      });
      for (const child of branch.children) walk(child, depth + 1);
    };
    for (const root of frame.roots) walk(root, 0);
    parts.push(tree(items));
  }
  if (block.annotations !== undefined) {
    parts.push(
      list(
        block.annotations.map(
          (annotation) =>
            `${e(labels.get(String(annotation.nodeId)) ?? String(annotation.nodeId))} — ${e(annotation.note)}`,
        ),
        true,
      ),
    );
  }
  return parts.join("");
}

function design(block: Extract<Block, { readonly kind: "design" }>, ctx: RenderContext): string {
  const id = String(block.blockId);
  const viewport = block.size === "document" ? undefined : CANVAS_DESIGN_VIEWPORT[block.size];
  const dimensions = `${viewport === undefined ? "" : ` width="${String(viewport.width)}"`} height="${String(
    viewport?.height ?? 900,
  )}"`;
  const frame = (mode: FrameMode, sandbox: string): string =>
    `<iframe class="design-frame" title="${e(block.title)}" src="${e(
      ctx.frameAddress(id, mode),
    )}" sandbox="${sandbox}" referrerpolicy="no-referrer" loading="lazy"${dimensions}></iframe>`;
  const titles = list(
    block.frames.map((entry) => e(entry.title)),
    true,
  );
  if (block.runsScript !== true) return `${heading(2, block.title)}${frame("static", "")}`;
  if (ctx.runBlockId === id) {
    return `${heading(2, block.title)}<p class="note">This prototype runs script inside a sandboxed frame.</p>${frame(
      "running",
      "allow-scripts",
    )}`;
  }
  return `${heading(2, block.title)}${titles}<p><a class="run-link" href="/s/${e(
    ctx.shareId,
  )}?run=${encodeURIComponent(id)}#${e(id)}">Run prototype</a></p><p class="note">Prototypes run script. Run it only if you trust the person who shared this link.</p>`;
}

function blockBody(block: Block, ctx: RenderContext): string {
  switch (block.kind) {
    case "heading":
      return heading(block.level + 1, block.text);
    case "rich-text":
      return paragraphs(block.text);
    case "callout":
      return `<aside class="callout tone-${e(block.tone)}">${
        block.title === undefined ? "" : `<p class="callout-title">${e(block.title)}</p>`
      }${paragraphs(block.text)}</aside>`;
    case "link": {
      const href = safeHref(block.href);
      return href === undefined
        ? `<p>${e(block.label)}</p>`
        : `<p><a href="${e(href)}" rel="noopener noreferrer nofollow ugc">${e(block.label)}</a></p>`;
    }
    case "divider":
      return "<hr>";
    case "citation":
      return `<blockquote>${block.quote === undefined ? "" : paragraphs(block.quote)}<footer>${e(
        block.label,
      )}</footer></blockquote>`;
    case "metric": {
      const delta =
        block.delta === undefined
          ? ""
          : ` <span class="delta">${block.delta > 0 ? "+" : ""}${e(formatCanvasNumber(block.delta))}</span>`;
      return `<dl class="metric"><dt>${e(block.label)}</dt><dd><span class="metric-value">${scalar(
        block.value,
        block.format,
      )}${block.unit === undefined ? "" : ` ${e(block.unit)}`}</span>${delta}</dd></dl>${
        block.caption === undefined ? "" : `<p class="note">${e(block.caption)}</p>`
      }`;
    }
    case "progress":
      return `<p><label>${e(block.label)} <progress max="1" value="${String(block.value)}">${String(
        Math.round(block.value * 100),
      )}%</progress> ${String(Math.round(block.value * 100))}%</label></p>${
        block.detail === undefined ? "" : `<p class="note">${e(block.detail)}</p>`
      }`;
    case "status":
      return `<p>${e(block.label)}: <span class="status tone-${e(block.tone)}">${e(block.value)}</span></p>`;
    case "key-value":
      return table(
        ["Field", "Value"],
        block.entries.map((entry) => [e(entry.key), scalar(entry.value)]),
      );
    case "table":
      return table(
        block.columns.map((column) => column.label),
        block.rows.map((row) =>
          block.columns.map((column, index) => scalar(row[index] ?? null, column.format)),
        ),
      );
    case "chart": {
      const caption = `${block.chartType} chart, shown as data`;
      if (block.chartType === "sankey") {
        return table(
          ["From", "To", "Value"],
          (block.links ?? []).map((link) => [
            e(link.source),
            e(link.target),
            scalar(link.value, block.format),
          ]),
          caption,
        );
      }
      return table(
        ["Series", "X", "Y"],
        block.series.flatMap((series) =>
          series.points.map((point) => [
            e(series.label),
            scalar(point.x, block.format),
            scalar(point.y, block.format),
          ]),
        ),
        caption,
      );
    }
    case "timeline":
      return list(
        block.items.map(
          (item) =>
            `<time datetime="${e(item.startAt)}">${e(item.startAt.slice(0, 10))}</time> ${e(item.title)}${
              item.detail === undefined ? "" : ` — ${e(item.detail)}`
            }`,
        ),
      );
    case "plan": {
      const phases = block.phases
        .map((phase) => {
          const tasks = block.tasks.filter(
            (task) => String(task.phaseId) === String(phase.phaseId),
          );
          return `${heading(3, phase.title)}${list(
            tasks.map((task) => {
              const when = [task.startAt, task.dueAt]
                .filter((value) => value !== undefined)
                .map((value) => value.slice(0, 10))
                .join(" → ");
              return `${e(task.title)} <span class="status">${e(task.status)}</span>${
                task.owner?.label === undefined ? "" : `, ${e(task.owner.label)}`
              }${task.estimate === undefined ? "" : `, ${e(task.estimate)}`}${
                when === "" ? "" : `, ${e(when)}`
              }${task.notes === undefined ? "" : ` — ${e(task.notes)}`}`;
            }),
          )}`;
        })
        .join("");
      return `${heading(2, block.title)}${phases}`;
    }
    case "diagram": {
      const names = new Map(block.nodes.map((node) => [String(node.nodeId), node.label]));
      return [
        heading(3, "Nodes"),
        list(block.nodes.map((node) => e(node.label))),
        heading(3, "Connections"),
        list(
          block.edges.map((edge) => {
            const from = names.get(String(edge.source)) ?? "node";
            const to = names.get(String(edge.target)) ?? "node";
            return `${e(from)} ${edge.style === "dashed" ? "⇢" : "→"} ${e(to)}${
              edge.label === undefined ? "" : `: ${e(edge.label)}`
            }`;
          }),
        ),
        ...(block.groups === undefined || block.groups.length === 0
          ? []
          : [
              heading(3, "Groups"),
              list(
                block.groups.map(
                  (group) =>
                    `${e(group.label)}: ${group.nodeIds
                      .map((nodeId) => e(names.get(String(nodeId)) ?? "node"))
                      .join(", ")}`,
                ),
              ),
            ]),
      ].join("");
    }
    case "sequence": {
      const names = new Map(
        block.participants.map((participant) => [
          String(participant.participantId),
          participant.label,
        ]),
      );
      return [
        heading(3, "Participants"),
        list(block.participants.map((participant) => e(participant.label))),
        heading(3, "Messages"),
        list(
          [
            ...block.messages.map(
              (message) =>
                `${e(names.get(String(message.from)) ?? "participant")} → ${e(
                  names.get(String(message.to)) ?? "participant",
                )}: ${e(message.label)}`,
            ),
            ...(block.notes ?? []).map((note) => `Note: ${e(note.text)}`),
          ],
          true,
        ),
      ].join("");
    }
    case "state": {
      const names = new Map(block.states.map((state) => [String(state.stateId), state.label]));
      return [
        heading(3, "States"),
        list(
          block.states.map((state) =>
            state.role === undefined ? e(state.label) : `${e(state.label)} (${state.role})`,
          ),
        ),
        heading(3, "Transitions"),
        list(
          block.transitions.map(
            (transition) =>
              `${e(names.get(String(transition.source)) ?? "state")} → ${e(
                names.get(String(transition.target)) ?? "state",
              )}: ${e(transition.label)}`,
          ),
        ),
      ].join("");
    }
    case "er": {
      const names = new Map(
        block.entities.map((entity) => [String(entity.entityId), entity.label]),
      );
      const rows = block.entities.flatMap((entity) =>
        entity.attributes.length === 0
          ? [[e(entity.label), "", "", ""]]
          : entity.attributes.map((attribute) => [
              e(entity.label),
              e(attribute.name),
              e(attribute.type),
              attribute.key === true ? "key" : "",
            ]),
      );
      return `${table(["Entity", "Attribute", "Type", "Key"], rows)}${list(
        block.relationships.map(
          (relationship) =>
            `${e(names.get(String(relationship.source)) ?? "entity")} ${relationship.sourceCardinality} — ${
              relationship.targetCardinality
            } ${e(names.get(String(relationship.target)) ?? "entity")}${
              relationship.label === undefined ? "" : ` (${e(relationship.label)})`
            }`,
        ),
      )}`;
    }
    case "swimlane": {
      const names = new Map(block.steps.map((step) => [String(step.stepId), step.label]));
      return `${block.lanes
        .map(
          (lane) =>
            `${heading(3, lane.label)}${list(
              block.steps
                .filter((step) => String(step.laneId) === String(lane.laneId))
                .map((step) => e(step.label)),
              true,
            )}`,
        )
        .join("")}${list(
        block.connections.map(
          (connection) =>
            `${e(names.get(String(connection.source)) ?? "step")} → ${e(
              names.get(String(connection.target)) ?? "step",
            )}${connection.label === undefined ? "" : `: ${e(connection.label)}`}`,
        ),
      )}`;
    }
    case "mindmap": {
      const nodes = new Map(block.nodes.map((node) => [String(node.nodeId), node]));
      const children = new Map<string, string[]>();
      let root: string | undefined;
      for (const node of block.nodes) {
        const id = String(node.nodeId);
        if (node.parentId === undefined) {
          root ??= id;
          continue;
        }
        children.set(String(node.parentId), [...(children.get(String(node.parentId)) ?? []), id]);
      }
      const items: Array<{ readonly depth: number; readonly text: string }> = [];
      const walk = (id: string, depth: number, seen: ReadonlySet<string>): void => {
        const node = nodes.get(id);
        if (node === undefined || seen.has(id)) return;
        items.push({
          depth,
          text: node.note === undefined ? node.label : `${node.label} — ${node.note}`,
        });
        for (const child of children.get(id) ?? []) walk(child, depth + 1, new Set([...seen, id]));
      };
      if (root !== undefined) walk(root, 0, new Set());
      return tree(items);
    }
    case "mockup":
      return mockup(block);
    case "treemap": {
      const kids = treemapChildren(block);
      const totals = block.measures.map((measure) =>
        treemapTotals(block, String(measure.measureId)),
      );
      const nodes = new Map(block.nodes.map((node) => [String(node.nodeId), node]));
      const rows: Array<ReadonlyArray<string>> = [];
      const walk = (id: string, depth: number, seen: ReadonlySet<string>): void => {
        const node = nodes.get(id);
        if (node === undefined || seen.has(id)) return;
        rows.push([
          `<span class="depth-${String(Math.min(depth, 8))}">${e(node.label)}</span>`,
          ...block.measures.map((measure, index) =>
            scalar(totals[index]?.get(id) ?? 0, measure.format),
          ),
        ]);
        for (const child of kids.get(id) ?? []) walk(child, depth + 1, new Set([...seen, id]));
      };
      walk(treemapRootId(block), 0, new Set());
      return table(["Item", ...block.measures.map((measure) => measure.label)], rows);
    }
    case "heatmap": {
      if (block.layout === "matrix") {
        const totals = heatmapRowTotals(block);
        const byCoordinate = new Map(
          block.cells.map((cell) => [
            `${String(cell.rowId)}\u0000${String(cell.columnId)}`,
            cell.value,
          ]),
        );
        return table(
          ["Row", ...block.columns.map((column) => column.label), "Total"],
          block.rows.map((row) => [
            e(row.label),
            ...block.columns.map((column) => {
              const value = byCoordinate.get(
                `${String(row.rowId)}\u0000${String(column.columnId)}`,
              );
              return value === undefined ? "" : scalar(value, block.format);
            }),
            scalar(totals.get(String(row.rowId)) ?? 0, block.format),
          ]),
        );
      }
      return table(
        ["Date", block.valueLabel ?? "Value", "Note"],
        block.days.map((day) => [
          e(day.date),
          scalar(day.value, block.format),
          day.note === undefined ? "" : e(day.note),
        ]),
      );
    }
    case "bar-list": {
      const secondary = block.rows.some((row) => row.secondaryValue !== undefined);
      return table(
        [
          "Item",
          block.valueLabel ?? "Value",
          ...(secondary ? [block.secondaryLabel ?? "Second"] : []),
        ],
        layoutCanvasBarList(block).rows.map((row) => [
          e(row.label),
          scalar(row.value, block.format),
          ...(secondary
            ? [
                row.secondaryValue === undefined
                  ? ""
                  : scalar(row.secondaryValue, block.secondaryFormat ?? block.format),
              ]
            : []),
        ]),
      );
    }
    case "comparison-matrix":
      return comparisonMatrix(block);
    case "math":
      if (block.layout === "display") {
        return `<p class="math"><code>${e(block.source)}</code></p>${
          block.caption === undefined ? "" : `<p class="note">${e(block.caption)}</p>`
        }`;
      }
      return `<p>${block.runs
        .map((run) => ("math" in run ? `<code>${e(run.math)}</code>` : e(run.text)))
        .join("")}</p>`;
    case "code-excerpt":
      return `<pre><code class="language-${e(block.language)}">${e(block.code)}</code></pre>`;
    case "pseudocode":
      return `<pre><code>${e(block.code)}</code></pre>`;
    case "diff":
      return `<pre class="diff"><code>${block.hunks
        .map(
          (hunk) =>
            `<span class="diff-header">${e(hunk.header)}</span>\n${hunk.lines
              .map((line) => {
                const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
                return `<span class="diff-${line.kind}">${prefix} ${e(line.text)}</span>`;
              })
              .join("\n")}`,
        )
        .join("\n")}</code></pre>`;
    case "summary":
      return `${heading(2, block.title)}${list(
        block.items.map((item) =>
          item.value === undefined ? e(item.label) : `${e(item.label)}: ${scalar(item.value)}`,
        ),
      )}`;
    case "source-reference":
    case "artifact-reference":
    case "file-reference":
    case "preview-reference":
    case "browser-reference":
    case "evidence-reference":
      return labelled(block.label, block.detail);
    case "image":
      // No image leaves the host, so the alt text stands where it was.
      return `<figure class="image-placeholder"><figcaption>${e(block.alt)}${
        block.caption === undefined ? "" : ` — ${e(block.caption)}`
      }</figcaption></figure>`;
    case "design":
      return design(block, ctx);
    case "dashboard":
    case "tabs":
    case "columns":
      // Drawn by the reading order together with the blocks they place.
      return "";
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

function placed(item: CanvasPlacedReadingItem<Block>, ctx: RenderContext): string {
  if (item.kind === "block") return section(item.block, blockBody(item.block, ctx));
  return section(
    item.dashboard,
    `${heading(2, item.dashboard.title)}<div class="dashboard">${item.cells
      .map(
        (cell) =>
          `<div class="dashboard-cell">${section(cell.block, blockBody(cell.block, ctx))}</div>`,
      )
      .join("")}</div>`,
  );
}

/** The document's blocks as escaped HTML, in the order the Canvas reads. */
export function renderBlocks(blocks: ReadonlyArray<Block>, ctx: RenderContext): string {
  return canvasReadingOrder(blocks)
    .map((item) => {
      if (item.kind !== "group") return placed(item, ctx);
      const group = item.group;
      const sections = item.sections.map((children, index) => {
        const label = group.kind === "tabs" ? group.panes[index]?.label : undefined;
        const body = children.map((child) => placed(child, ctx)).join("");
        return group.kind === "tabs"
          ? `<section class="pane">${label === undefined ? "" : heading(3, label)}${body}</section>`
          : `<div class="column">${body}</div>`;
      });
      return section(
        group,
        group.kind === "tabs"
          ? sections.join("")
          : `<div class="columns">${sections.join("")}</div>`,
      );
    })
    .join("\n");
}

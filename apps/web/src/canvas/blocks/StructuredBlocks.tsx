import type { CanvasBlock, CanvasStatusTone } from "@octant/contracts/canvas";
import { ChartBlock } from "./ChartBlock";
import { DiagramBoard, type DiagramBoardLayoutRuntime } from "./DiagramBoard";
import { TableBlock } from "./TableBlock";

type Block = Extract<CanvasBlock, { readonly kind: "table" | "chart" | "timeline" | "diagram" }>;

export function StructuredBlocks({
  block,
  layoutRuntime,
}: {
  readonly block: Block;
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
}) {
  switch (block.kind) {
    case "table":
      return <TableBlock block={block} />;
    case "chart":
      return <ChartBlock block={block} />;
    case "timeline":
      return <TimelineBlock block={block} />;
    case "diagram":
      return (
        <DiagramBlock block={block} {...(layoutRuntime === undefined ? {} : { layoutRuntime })} />
      );
  }
}

function TimelineBlock({
  block,
}: {
  readonly block: Extract<Block, { readonly kind: "timeline" }>;
}) {
  return (
    <TimelineList items={block.items.map((item) => ({ ...item, key: String(item.itemId) }))} />
  );
}

/** One dated entry on a timeline; plans draw their dated tasks with it too. */
export interface TimelineEntry {
  readonly key: string;
  readonly title: string;
  readonly startAt: string;
  readonly status?: CanvasStatusTone | undefined;
  readonly detail?: string | undefined;
}

export function TimelineList({ items }: { readonly items: ReadonlyArray<TimelineEntry> }) {
  return (
    <ol className="canvas-block__timeline">
      {items.map((item) => (
        <li
          key={item.key}
          className={`canvas-block__timeline-item${item.status !== undefined ? ` canvas-block__timeline-item--${item.status}` : ""}`}
        >
          <time dateTime={item.startAt}>{formatDate(item.startAt)}</time>
          <strong>{item.title}</strong>
          {item.status !== undefined ? (
            <span className="canvas-block__timeline-status">{item.status}</span>
          ) : null}
          {item.detail !== undefined ? <p>{item.detail}</p> : null}
        </li>
      ))}
    </ol>
  );
}

function DiagramBlock({
  block,
  layoutRuntime,
}: {
  readonly block: Extract<Block, { readonly kind: "diagram" }>;
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
}) {
  return (
    <figure aria-label={diagramLabel(block)} className="canvas-block__diagram">
      <DiagramBoard block={block} {...(layoutRuntime === undefined ? {} : { layoutRuntime })} />
      {/* The drawing said in words, for a reader who cannot see it. The labels
        are already on the boxes, so this describes what connects to what rather
        than repeating the names on their own. */}
      <figcaption className="canvas-block__diagram-fallback visually-hidden">
        <ul>
          {(block.groups ?? []).map((group) => (
            <li key={group.groupId}>{`${group.label}: ${groupMembers(block, group.nodeIds)}`}</li>
          ))}
          {block.edges.map((edge) => (
            <li key={edge.edgeId}>{describeEdge(block, edge)}</li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

function nodeLabel(block: Extract<Block, { readonly kind: "diagram" }>, nodeId: string): string {
  return (
    block.nodes.find((node) => String(node.nodeId) === String(nodeId))?.label ?? String(nodeId)
  );
}

function groupMembers(
  block: Extract<Block, { readonly kind: "diagram" }>,
  nodeIds: ReadonlyArray<string>,
): string {
  return nodeIds.map((nodeId) => nodeLabel(block, nodeId)).join(", ");
}

function describeEdge(
  block: Extract<Block, { readonly kind: "diagram" }>,
  edge: Extract<Block, { readonly kind: "diagram" }>["edges"][number],
): string {
  const relation = edge.label === undefined ? "to" : edge.label;
  return `${nodeLabel(block, edge.source)} ${relation} ${nodeLabel(block, edge.target)}`;
}

function diagramLabel(block: Extract<Block, { readonly kind: "diagram" }>): string {
  const groups = block.groups ?? [];
  const parts = [
    `Diagram with ${String(block.nodes.length)} nodes and ${String(block.edges.length)} edges`,
  ];
  if (groups.length > 0) parts.push(`in ${String(groups.length)} groups`);
  return parts.join(" ");
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toISOString();
}

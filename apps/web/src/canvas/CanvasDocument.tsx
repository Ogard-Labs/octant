import type { CanvasDefinition } from "@octant/contracts/canvas";
import { canvasDesignSystemStyle } from "./canvasDesignSystemStyle";
import type { ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import type { CanvasActionBlock } from "@octant/contracts/canvas-actions";
import { canvasReadingOrder, type CanvasReadingItem } from "@octant/domain/canvas-dashboard-layout";
import { canvasBlockLabel } from "./canvasBlockLabel";
import type { CanvasCommentMark } from "./canvasTools";
import { CanvasBlockRenderer } from "./blocks/CanvasBlock";
import { CanvasLayoutGroup } from "./blocks/LayoutGroups";
import { DashboardBlock } from "./blocks/DashboardBlock";
import { FlowBoard } from "./blocks/FlowBoard";
import { DeckBlock } from "./blocks/DeckBlock";
import type { DiagramBoardLayoutRuntime } from "./blocks/DiagramBoard";
import type { PlanTaskRuntime } from "./blocks/PlanBlock";
import { OctantButton } from "../ui/base/OctantButton";
import { CanvasActionPanel } from "./CanvasActionPanel";
import type { CanvasActionRuntime } from "./canvasActionRuntime";
import type { DesignAssetRuntime } from "./blocks/designDocument";
import type { DesignRunRuntime } from "./blocks/designRunningFrame";
import type { CanvasChoiceRuntime } from "./blocks/ChoiceBlock";

export interface CanvasDocumentProps {
  readonly definition: CanvasDefinition;
  /**
   * Host-owned dispatch for typed actions. Actions are only offered when the
   * workspace supplies a runtime; without one the blocks stay declarative and
   * no control is rendered, because the renderer never mints authority.
   */
  readonly actionRuntime?: CanvasActionRuntime;
  /**
   * Host-owned journaling for a board drag. Without it a diagram still zooms
   * and pans but its nodes stay where the version put them.
   */
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
  /** Host-owned journaling for a plan task's status. Without it a plan reads only. */
  readonly planRuntime?: PlanTaskRuntime;
  /**
   * Host-owned resolution of a design's declared images, asked on every
   * draw. Without it a design draws each image as a placeholder.
   */
  readonly designAssetRuntime?: DesignAssetRuntime;
  /**
   * Host-owned tickets for a prototype's page. Without it a design that runs
   * script says it cannot run here.
   */
  readonly designRunRuntime?: DesignRunRuntime;
  /**
   * Sends a person's answer to a choice block to the Canvas's own thread, or
   * says why this surface cannot. Without it a choice reads only.
   */
  readonly choiceRuntime?: CanvasChoiceRuntime;
  /**
   * Comment markers beside each block and on each table row that carries an
   * id. Offered only when the host journals comments; `openCounts` holds the
   * unresolved threads anchored to a block, including those on its rows or
   * nodes, and `openRowCounts` those on each row, by block then row id.
   */
  readonly comments?: CanvasDocumentComments;
  /**
   * `thread` draws the document inside a conversation, where the frame around
   * it already names the Canvas, so the document drops its own title.
   */
  readonly placement?: "document" | "thread";
}

export interface CanvasDocumentComments {
  readonly openCounts: ReadonlyMap<string, number>;
  readonly openRowCounts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Unresolved threads anchored to a mockup or board node, by block then node. */
  readonly openNodeCounts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /**
   * The marks drawn over a block: those of its unresolved threads, and the
   * one a person has just made and not yet commented on.
   */
  readonly marks?: ReadonlyMap<string, ReadonlyArray<CanvasBlockMark>>;
  readonly onOpen: (blockId: string, rowId?: string) => void;
}

/** One mark on a block, in percent of the block's drawn box. */
export interface CanvasBlockMark {
  readonly key: string;
  readonly mark: CanvasCommentMark;
  /** A note's words, drawn where it is pinned. */
  readonly text?: string;
  /** Made and waiting for its comment. */
  readonly draft?: boolean;
}

const NO_ROW_COMMENTS: ReadonlyMap<string, number> = new Map();

export function CanvasDocument({
  definition,
  actionRuntime,
  layoutRuntime,
  planRuntime,
  designAssetRuntime,
  designRunRuntime,
  choiceRuntime,
  comments,
  placement = "document",
}: CanvasDocumentProps) {
  // Action blocks are collected out of the inline flow into one panel so the
  // document reads as content and every offered action sits under a single
  // labeled group, rather than a heading repeating per block.
  const actions: ReadonlyArray<CanvasActionBlock> = definition.blocks.filter(
    (block): block is CanvasActionBlock => block.kind === "action",
  );
  const content = definition.blocks.filter((block) => block.kind !== "action");
  const designSystemStyle = canvasDesignSystemStyle(definition.designSystem);
  // What comments add to a block: its marker in the margin and the marks
  // people drew on it.
  const commentMarks = (block: CanvasDefinition["blocks"][number]) =>
    comments === undefined ? null : (
      <>
        {(comments.marks?.get(String(block.blockId)) ?? []).map((item) => (
          <BlockMark item={item} key={item.key} />
        ))}
        <CommentMarker
          count={comments.openCounts.get(String(block.blockId)) ?? 0}
          label={canvasBlockLabel(block)}
          onOpen={() => comments.onOpen(String(block.blockId))}
        />
      </>
    );
  const blockSection = (block: CanvasDefinition["blocks"][number]) => (
    <section
      key={block.blockId}
      className="canvas-block"
      data-block-id={block.blockId}
      data-block-kind={block.kind}
    >
      <CanvasBlockRenderer
        block={block}
        {...(layoutRuntime === undefined ? {} : { layoutRuntime })}
        {...(planRuntime === undefined ? {} : { planRuntime })}
        {...(actionRuntime === undefined ? {} : { actionRuntime })}
        {...(designAssetRuntime === undefined ? {} : { designAssetRuntime })}
        {...(designRunRuntime === undefined ? {} : { designRunRuntime })}
        {...(choiceRuntime === undefined ? {} : { choiceRuntime })}
        {...(comments === undefined || block.kind !== "table"
          ? {}
          : {
              rowComments: {
                openCounts: comments.openRowCounts.get(String(block.blockId)) ?? NO_ROW_COMMENTS,
                onOpen: (rowId: string) => comments.onOpen(String(block.blockId), rowId),
              },
            })}
        {...(comments === undefined || block.kind !== "mockup"
          ? {}
          : {
              nodeComments: {
                openCounts: comments.openNodeCounts.get(String(block.blockId)) ?? NO_ROW_COMMENTS,
                onOpen: () => comments.onOpen(String(block.blockId)),
              },
            })}
      />
      {commentMarks(block)}
    </section>
  );

  const dashboardSection = (item: Extract<ReadingItem, { readonly kind: "dashboard" }>) => (
    <section
      key={item.dashboard.blockId}
      className="canvas-block"
      data-block-id={item.dashboard.blockId}
      data-block-kind="dashboard"
    >
      <DashboardBlock
        title={item.dashboard.title}
        columns={item.columns}
        cells={item.cells}
        cellKey={(block) => String(block.blockId)}
        cellKind={(block) => block.kind}
        renderCell={(block) => blockSection(block)}
      />
      {commentMarks(item.dashboard)}
    </section>
  );

  const flowSection = (item: Extract<ReadingItem, { readonly kind: "flow" }>) => (
    <section
      key={item.flow.blockId}
      className="canvas-block"
      data-block-id={item.flow.blockId}
      data-block-kind="flow"
    >
      <FlowBoard
        block={item.flow}
        blocks={definition.blocks}
        {...(layoutRuntime === undefined ? {} : { layoutRuntime })}
        {...(designAssetRuntime === undefined ? {} : { designAssetRuntime })}
      />
      {commentMarks(item.flow)}
    </section>
  );

  const deckSection = (item: Extract<ReadingItem, { readonly kind: "deck" }>) => (
    <section
      key={item.deck.blockId}
      className="canvas-block"
      data-block-id={item.deck.blockId}
      data-block-kind="deck"
    >
      <DeckBlock
        block={item.deck}
        blocks={definition.blocks}
        {...(designSystemStyle === undefined ? {} : { designSystemStyle })}
        {...(designAssetRuntime === undefined ? {} : { designAssetRuntime })}
      />
      {commentMarks(item.deck)}
    </section>
  );

  // A tab pane or a column draws its children through the same flow as the
  // document, so a dashboard in a pane is the same grid it is at the top.
  const flow = (items: ReadonlyArray<ReadingItem>): ReactNode =>
    runsOfMetrics(items).map((run) => {
      const first = run[0];
      if (first?.kind === "dashboard") return dashboardSection(first);
      if (first?.kind === "flow") return flowSection(first);
      if (first?.kind === "deck") return deckSection(first);
      if (first?.kind === "group") {
        // The group is a block a comment can anchor to, so it carries its own
        // marker just as a dashboard does; its children keep theirs.
        return (
          <section
            key={first.group.blockId}
            className="canvas-block canvas-block--group"
            data-block-id={first.group.blockId}
            data-block-kind={first.group.kind}
          >
            <CanvasLayoutGroup
              block={first.group}
              renderSection={(index) => flow(first.sections[index] ?? [])}
            />
            {commentMarks(first.group)}
          </section>
        );
      }
      const sections = run.map((item) => (item.kind === "block" ? blockSection(item.block) : null));
      return first?.kind === "block" && first.block.kind === "metric" ? (
        <div className="canvas-metrics" key={`metrics-${first.block.blockId}`}>
          {sections}
        </div>
      ) : (
        sections
      );
    });
  return (
    <article
      className={placement === "thread" ? "canvas-view canvas-view--thread" : "canvas-view"}
      aria-label={definition.title}
      data-design-system={definition.designSystem?.name}
      style={designSystemStyle}
    >
      {placement === "thread" ? null : (
        <header className="canvas-view__header">
          <h1>{definition.title}</h1>
        </header>
      )}
      <div className="canvas-view__body">{flow(canvasReadingOrder(content))}</div>
      {actionRuntime !== undefined && actions.length > 0 ? (
        <CanvasActionPanel
          actions={actions}
          availability={actionRuntime.availability}
          onExecute={actionRuntime.onExecute}
          {...(actionRuntime.onCancel === undefined ? {} : { onCancel: actionRuntime.onCancel })}
        />
      ) : null}
    </article>
  );
}

type ReadingItem = CanvasReadingItem<CanvasDefinition["blocks"][number]>;

/**
 * The document in reading order, with each run of consecutive metrics
 * gathered so they sit side by side as tiles instead of one number per line.
 * A dashboard is its own run; the metrics it places are tiles in its grid.
 */
function runsOfMetrics(
  items: ReadonlyArray<ReadingItem>,
): ReadonlyArray<ReadonlyArray<ReadingItem>> {
  const runs: Array<Array<ReadingItem>> = [];
  for (const item of items) {
    const last = runs.at(-1)?.[0];
    const isMetric = item.kind === "block" && item.block.kind === "metric";
    if (isMetric && last?.kind === "block" && last.block.kind === "metric") runs.at(-1)?.push(item);
    else runs.push([item]);
  }
  return runs;
}

/**
 * A mark over its block. It is hidden from assistive technology because the
 * comment it belongs to is already counted on the block's marker and read in
 * the drawer; the mark only shows a sighted reader where it sits.
 */
function BlockMark({ item }: { readonly item: CanvasBlockMark }) {
  const { mark } = item;
  const draft = item.draft === true ? "true" : "false";
  if (mark.kind === "stroke") {
    return (
      <svg
        aria-hidden="true"
        className="canvas-block__stroke"
        data-draft={draft}
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
      >
        <polyline
          points={mark.points.map((point) => `${String(point.x)},${String(point.y)}`).join(" ")}
        />
      </svg>
    );
  }
  if (mark.kind === "note") {
    return (
      <span
        aria-hidden="true"
        className="canvas-block__note"
        data-draft={draft}
        style={{ left: `${String(mark.x)}%`, top: `${String(mark.y)}%` }}
      >
        {item.text === undefined ? null : (
          <span className="canvas-block__note-text">{item.text}</span>
        )}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="canvas-block__area"
      data-draft={draft}
      style={{
        left: `${String(mark.x)}%`,
        top: `${String(mark.y)}%`,
        width: `${String(mark.width)}%`,
        height: `${String(mark.height)}%`,
      }}
    />
  );
}

function CommentMarker(props: {
  readonly count: number;
  readonly label: string;
  readonly onOpen: () => void;
}) {
  return (
    <OctantButton
      aria-label={
        props.count === 0
          ? `Comment on ${props.label}`
          : `${String(props.count)} open ${props.count === 1 ? "comment" : "comments"} on ${props.label}`
      }
      className="canvas-block__comment-marker"
      data-has-comments={props.count === 0 ? "false" : "true"}
      onClick={props.onOpen}
      type="button"
      variant="bare"
    >
      <MessageSquare aria-hidden="true" size={12} strokeWidth={1.8} />
      {props.count === 0 ? null : <span>{props.count}</span>}
    </OctantButton>
  );
}

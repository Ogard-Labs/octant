import type { CanvasDefinition } from "@octant/contracts/canvas";
import type { ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import type { CanvasActionBlock } from "@octant/contracts/canvas-actions";
import { canvasReadingOrder, type CanvasReadingItem } from "@octant/domain/canvas-dashboard-layout";
import { canvasBlockLabel } from "./canvasBlockLabel";
import { CanvasBlockRenderer } from "./blocks/CanvasBlock";
import { CanvasLayoutGroup } from "./blocks/LayoutGroups";
import { DashboardBlock } from "./blocks/DashboardBlock";
import type { DiagramBoardLayoutRuntime } from "./blocks/DiagramBoard";
import type { PlanTaskRuntime } from "./blocks/PlanBlock";
import { OctantButton } from "../ui/base/OctantButton";
import { CanvasActionPanel } from "./CanvasActionPanel";
import type { CanvasActionRuntime } from "./canvasActionRuntime";
import type { DesignAssetRuntime } from "./blocks/designDocument";
import type { DesignRunRuntime } from "./blocks/designRunningFrame";

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
  readonly onOpen: (blockId: string, rowId?: string) => void;
}

const NO_ROW_COMMENTS: ReadonlyMap<string, number> = new Map();

export function CanvasDocument({
  definition,
  actionRuntime,
  layoutRuntime,
  planRuntime,
  designAssetRuntime,
  designRunRuntime,
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
  const blockSection = (block: CanvasDefinition["blocks"][number]) => (
    <section key={block.blockId} className="canvas-block" data-block-kind={block.kind}>
      <CanvasBlockRenderer
        block={block}
        {...(layoutRuntime === undefined ? {} : { layoutRuntime })}
        {...(planRuntime === undefined ? {} : { planRuntime })}
        {...(actionRuntime === undefined ? {} : { actionRuntime })}
        {...(designAssetRuntime === undefined ? {} : { designAssetRuntime })}
        {...(designRunRuntime === undefined ? {} : { designRunRuntime })}
        {...(comments === undefined || block.kind !== "table"
          ? {}
          : {
              rowComments: {
                openCounts: comments.openRowCounts.get(String(block.blockId)) ?? NO_ROW_COMMENTS,
                onOpen: (rowId: string) => comments.onOpen(String(block.blockId), rowId),
              },
            })}
      />
      {comments === undefined ? null : (
        <CommentMarker
          count={comments.openCounts.get(String(block.blockId)) ?? 0}
          label={canvasBlockLabel(block)}
          onOpen={() => comments.onOpen(String(block.blockId))}
        />
      )}
    </section>
  );

  const dashboardSection = (item: Extract<ReadingItem, { readonly kind: "dashboard" }>) => (
    <section key={item.dashboard.blockId} className="canvas-block" data-block-kind="dashboard">
      <DashboardBlock
        title={item.dashboard.title}
        columns={item.columns}
        cells={item.cells}
        cellKey={(block) => String(block.blockId)}
        cellKind={(block) => block.kind}
        renderCell={(block) => blockSection(block)}
      />
      {comments === undefined ? null : (
        <CommentMarker
          count={comments.openCounts.get(String(item.dashboard.blockId)) ?? 0}
          label={canvasBlockLabel(item.dashboard)}
          onOpen={() => comments.onOpen(String(item.dashboard.blockId))}
        />
      )}
    </section>
  );

  // A tab pane or a column draws its children through the same flow as the
  // document, so a dashboard in a pane is the same grid it is at the top.
  const flow = (items: ReadonlyArray<ReadingItem>): ReactNode =>
    runsOfMetrics(items).map((run) => {
      const first = run[0];
      if (first?.kind === "dashboard") return dashboardSection(first);
      if (first?.kind === "group") {
        // The group is a block a comment can anchor to, so it carries its own
        // marker just as a dashboard does; its children keep theirs.
        return (
          <section
            key={first.group.blockId}
            className="canvas-block canvas-block--group"
            data-block-kind={first.group.kind}
          >
            <CanvasLayoutGroup
              block={first.group}
              renderSection={(index) => flow(first.sections[index] ?? [])}
            />
            {comments === undefined ? null : (
              <CommentMarker
                count={comments.openCounts.get(String(first.group.blockId)) ?? 0}
                label={canvasBlockLabel(first.group)}
                onOpen={() => comments.onOpen(String(first.group.blockId))}
              />
            )}
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

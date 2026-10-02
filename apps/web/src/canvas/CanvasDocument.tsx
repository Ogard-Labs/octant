import type { CanvasDefinition } from "@octant/contracts/canvas";
import { MessageSquare } from "lucide-react";
import type { CanvasActionBlock } from "@octant/contracts/canvas-actions";
import { CanvasBlockRenderer } from "./blocks/CanvasBlock";
import type { DiagramBoardLayoutRuntime } from "./blocks/DiagramBoard";
import { OctantButton } from "../ui/base/OctantButton";
import { CanvasActionPanel } from "./CanvasActionPanel";
import type { CanvasActionRuntime } from "./canvasActionRuntime";

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
  /**
   * Comment markers beside each block. Offered only when the host journals
   * comments; `openCounts` holds the unresolved threads anchored to a block,
   * including those on its rows or nodes.
   */
  readonly comments?: CanvasDocumentComments;
}

export interface CanvasDocumentComments {
  readonly openCounts: ReadonlyMap<string, number>;
  readonly onOpen: (blockId: string) => void;
}

/** What a reader would call a block, for a marker's accessible name. */
export function canvasBlockLabel(block: CanvasDefinition["blocks"][number]): string {
  switch (block.kind) {
    case "heading":
      return block.text;
    case "diagram":
      return "Board";
    case "callout":
      return block.title ?? "Callout";
    default:
      return block.kind.replace("-", " ");
  }
}

export function CanvasDocument({
  definition,
  actionRuntime,
  layoutRuntime,
  comments,
}: CanvasDocumentProps) {
  // Action blocks are collected out of the inline flow into one panel so the
  // document reads as content and every offered action sits under a single
  // labeled group, rather than a heading repeating per block.
  const actions: ReadonlyArray<CanvasActionBlock> = definition.blocks.filter(
    (block): block is CanvasActionBlock => block.kind === "action",
  );
  const content = definition.blocks.filter((block) => block.kind !== "action");

  return (
    <article className="canvas-view" aria-label={definition.title}>
      <header className="canvas-view__header">
        <h1>{definition.title}</h1>
      </header>
      <div className="canvas-view__body">
        {content.map((block) => (
          <section key={block.blockId} className="canvas-block" data-block-kind={block.kind}>
            <CanvasBlockRenderer
              block={block}
              {...(layoutRuntime === undefined ? {} : { layoutRuntime })}
            />
            {comments === undefined ? null : (
              <CommentMarker
                count={comments.openCounts.get(String(block.blockId)) ?? 0}
                label={canvasBlockLabel(block)}
                onOpen={() => comments.onOpen(String(block.blockId))}
              />
            )}
          </section>
        ))}
      </div>
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

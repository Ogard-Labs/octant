import type { CanvasDefinition } from "@octant/contracts/canvas";
import type { CanvasActionBlock } from "@octant/contracts/canvas-actions";
import { CanvasBlockRenderer } from "./blocks/CanvasBlock";
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
}

export function CanvasDocument({ definition, actionRuntime }: CanvasDocumentProps) {
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
            <CanvasBlockRenderer block={block} />
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

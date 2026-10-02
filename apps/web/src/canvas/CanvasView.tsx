import { CanvasDocument, type CanvasDocumentComments } from "./CanvasDocument";
import type { CanvasActionRuntime } from "./canvasActionRuntime";
import type { DiagramBoardLayoutRuntime } from "./blocks/DiagramBoard";
import type { PlanTaskRuntime } from "./blocks/PlanBlock";
import { decodeCanvasForRender } from "./canvasRuntime";

export interface CanvasViewProps {
  readonly input: unknown;
  /** Host-owned typed-action dispatch; omitted when actions are unavailable. */
  readonly actionRuntime?: CanvasActionRuntime;
  /** Host-owned journaling for a board drag; omitted when the host has none. */
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
  /** Host-owned journaling for a plan task's status; omitted when the host has none. */
  readonly planRuntime?: PlanTaskRuntime;
  readonly comments?: CanvasDocumentComments;
}

export function CanvasView({
  input,
  actionRuntime,
  layoutRuntime,
  planRuntime,
  comments,
}: CanvasViewProps) {
  const gate = decodeCanvasForRender(input);
  if (!gate.ok) {
    return (
      <div role="alert" className="canvas-view__denied">
        <h2>Unable to render canvas</h2>
        <p>The canvas did not pass the safety check, so its content was not rendered.</p>
      </div>
    );
  }
  return (
    <CanvasDocument
      definition={gate.definition}
      {...(actionRuntime === undefined ? {} : { actionRuntime })}
      {...(layoutRuntime === undefined ? {} : { layoutRuntime })}
      {...(planRuntime === undefined ? {} : { planRuntime })}
      {...(comments === undefined ? {} : { comments })}
    />
  );
}

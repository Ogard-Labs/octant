import { CanvasDocument } from "./CanvasDocument";
import type { CanvasActionRuntime } from "./canvasActionRuntime";
import type { DiagramBoardLayoutRuntime } from "./blocks/DiagramBoard";
import { decodeCanvasForRender } from "./canvasRuntime";

export interface CanvasViewProps {
  readonly input: unknown;
  /** Host-owned typed-action dispatch; omitted when actions are unavailable. */
  readonly actionRuntime?: CanvasActionRuntime;
  /** Host-owned journaling for a board drag; omitted when the host has none. */
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
}

export function CanvasView({ input, actionRuntime, layoutRuntime }: CanvasViewProps) {
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
    />
  );
}

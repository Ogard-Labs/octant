import { CanvasDocument } from "./CanvasDocument";
import type { CanvasActionRuntime } from "./canvasActionRuntime";
import { decodeCanvasForRender } from "./canvasRuntime";

export interface CanvasViewProps {
  readonly input: unknown;
  /** Host-owned typed-action dispatch; omitted when actions are unavailable. */
  readonly actionRuntime?: CanvasActionRuntime;
}

export function CanvasView({ input, actionRuntime }: CanvasViewProps) {
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
    />
  );
}

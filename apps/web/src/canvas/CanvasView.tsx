import { useMemo } from "react";
import { CanvasDocument, type CanvasDocumentComments } from "./CanvasDocument";
import type { CanvasActionRuntime } from "./canvasActionRuntime";
import type { DiagramBoardLayoutRuntime } from "./blocks/DiagramBoard";
import type { PlanTaskRuntime } from "./blocks/PlanBlock";
import type { DesignAssetRuntime } from "./blocks/designDocument";
import type { DesignRunRuntime } from "./blocks/designRunningFrame";
import { decodeCanvasForRender } from "./canvasRuntime";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface CanvasViewProps {
  readonly input: unknown;
  /** Host-owned typed-action dispatch; omitted when actions are unavailable. */
  readonly actionRuntime?: CanvasActionRuntime;
  /** Host-owned journaling for a board drag; omitted when the host has none. */
  readonly layoutRuntime?: DiagramBoardLayoutRuntime;
  /** Host-owned journaling for a plan task's status; omitted when the host has none. */
  readonly planRuntime?: PlanTaskRuntime;
  /** Host-owned resolution of a design's images; omitted when the host has none. */
  readonly designAssetRuntime?: DesignAssetRuntime;
  /** Host-owned tickets for a prototype's page; omitted when the host has none. */
  readonly designRunRuntime?: DesignRunRuntime;
  readonly comments?: CanvasDocumentComments;
  readonly placement?: "document" | "thread";
}

export function CanvasView({
  input,
  actionRuntime,
  layoutRuntime,
  planRuntime,
  designAssetRuntime,
  designRunRuntime,
  comments,
  placement,
}: CanvasViewProps) {
  // Validating builds a new definition, block by block. Doing it on every
  // draw handed each block a new identity whenever anything around the Canvas
  // redrew, which a running prototype read as a new version and restarted.
  const gate = useMemo(() => decodeCanvasForRender(input), [input]);
  if (!gate.ok) {
    return (
      <OctantAlert className="canvas-view__denied" tone="warning">
        <h2>Unable to render canvas</h2>
        <p>The canvas did not pass the safety check, so its content was not rendered.</p>
      </OctantAlert>
    );
  }
  return (
    <CanvasDocument
      definition={gate.definition}
      {...(actionRuntime === undefined ? {} : { actionRuntime })}
      {...(layoutRuntime === undefined ? {} : { layoutRuntime })}
      {...(planRuntime === undefined ? {} : { planRuntime })}
      {...(designAssetRuntime === undefined ? {} : { designAssetRuntime })}
      {...(designRunRuntime === undefined ? {} : { designRunRuntime })}
      {...(comments === undefined ? {} : { comments })}
      {...(placement === undefined ? {} : { placement })}
    />
  );
}

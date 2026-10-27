import {
  Component,
  Fragment,
  lazy,
  Suspense,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { CanvasDocumentComments } from "./CanvasDocument";
import type { CanvasActionRuntime } from "./canvasActionRuntime";
import type { DiagramBoardLayoutRuntime } from "./blocks/DiagramBoard";
import type { PlanTaskRuntime } from "./blocks/PlanBlock";
import type { DesignAssetRuntime } from "./blocks/designDocument";
import type { DesignRunRuntime } from "./blocks/designRunningFrame";
import { decodeCanvasForRender } from "./canvasRuntime";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

const lazyCanvasDocument = () =>
  lazy(() => import("./CanvasDocument").then((module) => ({ default: module.CanvasDocument })));

// A lazy component remembers a rejected import for good, so a retry needs a new one.
let LazyCanvasDocument = lazyCanvasDocument();

function CanvasDocument(props: ComponentProps<typeof LazyCanvasDocument>) {
  return <LazyCanvasDocument {...props} />;
}

interface CanvasLoadBoundaryState {
  readonly failed: boolean;
  readonly attempt: number;
}

/** A Canvas that fails to load or render (a host updated under a remote client) cannot blank its thread. */
class CanvasLoadBoundary extends Component<
  { readonly children: ReactNode },
  CanvasLoadBoundaryState
> {
  override state = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Pick<CanvasLoadBoundaryState, "failed"> {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) {
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
    return (
      <OctantAlert
        action={
          <OctantButton
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              LazyCanvasDocument = lazyCanvasDocument();
              this.setState(({ attempt }) => ({ failed: false, attempt: attempt + 1 }));
            }}
          >
            Try again
          </OctantButton>
        }
        tone="warning"
      >
        Canvas could not be shown.
      </OctantAlert>
    );
  }
}

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
    <CanvasLoadBoundary>
      <Suspense
        fallback={
          <p className="canvas-view__loading" role="status">
            Opening canvas…
          </p>
        }
      >
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
      </Suspense>
    </CanvasLoadBoundary>
  );
}

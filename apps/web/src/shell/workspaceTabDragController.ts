import type {
  WorkspaceDragPoint,
  WorkspaceSurfaceDragSource,
  WorkspaceSurfaceDropDestination,
} from "./workspaceTabDragGeometry";
import { hasCrossedWorkspaceSurfaceDragThreshold } from "./workspaceTabDragGeometry";

export type WorkspaceSurfaceDragSnapshot =
  | { readonly phase: "idle" }
  | {
      readonly phase: "pending" | "dragging";
      readonly source: WorkspaceSurfaceDragSource;
      readonly point: WorkspaceDragPoint;
      readonly destination: WorkspaceSurfaceDropDestination | null;
    };

export interface WorkspaceSurfaceDragControllerOptions {
  readonly onDrop: (
    source: WorkspaceSurfaceDragSource,
    destination: WorkspaceSurfaceDropDestination,
  ) => void;
  readonly resolveDestination: (
    point: WorkspaceDragPoint,
    source: WorkspaceSurfaceDragSource,
  ) => WorkspaceSurfaceDropDestination | null;
  readonly onSnapshotChange?: (snapshot: WorkspaceSurfaceDragSnapshot) => void;
}

export class WorkspaceSurfaceDragController {
  #snapshot: WorkspaceSurfaceDragSnapshot = { phase: "idle" };
  #origin: WorkspaceDragPoint | null = null;
  #pointerId: number | null = null;
  #suppressedClickKey: string | null = null;

  readonly #options: WorkspaceSurfaceDragControllerOptions;

  constructor(options: WorkspaceSurfaceDragControllerOptions) {
    this.#options = options;
  }

  getSnapshot(): WorkspaceSurfaceDragSnapshot {
    return this.#snapshot;
  }

  start(pointerId: number, source: WorkspaceSurfaceDragSource, point: WorkspaceDragPoint): void {
    this.#pointerId = pointerId;
    this.#origin = point;
    this.#setSnapshot({ phase: "pending", source, point, destination: null });
  }

  move(pointerId: number, point: WorkspaceDragPoint): void {
    if (pointerId !== this.#pointerId || this.#snapshot.phase === "idle" || this.#origin === null)
      return;
    if (
      this.#snapshot.phase === "pending" &&
      !hasCrossedWorkspaceSurfaceDragThreshold(this.#origin, point)
    ) {
      return;
    }
    this.#setSnapshot({
      phase: "dragging",
      source: this.#snapshot.source,
      point,
      destination: this.#options.resolveDestination(point, this.#snapshot.source),
    });
  }

  /** `point` is where the pointer let go; without one, its last move. */
  drop(pointerId: number, point?: WorkspaceDragPoint): void {
    if (pointerId !== this.#pointerId) return;
    const dropped = this.#snapshot.phase === "dragging" ? this.#snapshot : null;
    if (dropped !== null) this.#suppressedClickKey = dropped.source.dragKey;
    this.#reset();
    if (dropped === null) return;
    // The target is found again where the pointer let go: what decides it can
    // change after the last move, as when the sidebar's drop rules finish
    // loading during the first row drag, and so can the point itself.
    const destination = this.#options.resolveDestination(point ?? dropped.point, dropped.source);
    if (destination !== null) this.#options.onDrop(dropped.source, destination);
  }

  cancel(): void {
    if (this.#snapshot.phase === "idle") return;
    // Escape and pointercancel produce no trailing click on the row, so
    // leaving click suppression set would swallow the person's next real click.
    this.#suppressedClickKey = null;
    this.#reset();
  }

  consumeClickSuppression(dragKey: string): boolean {
    if (this.#suppressedClickKey !== dragKey) return false;
    this.#suppressedClickKey = null;
    return true;
  }

  #reset(): void {
    this.#pointerId = null;
    this.#origin = null;
    this.#setSnapshot({ phase: "idle" });
  }

  #setSnapshot(snapshot: WorkspaceSurfaceDragSnapshot): void {
    this.#snapshot = snapshot;
    this.#options.onSnapshotChange?.(snapshot);
  }
}

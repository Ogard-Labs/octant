import type { TabGroupId, WorkspaceTabId } from "@octant/contracts/shell";
import type { WorkspaceDragPoint, WorkspaceTabDropDestination } from "./workspaceTabDragGeometry";
import { hasCrossedWorkspaceTabDragThreshold } from "./workspaceTabDragGeometry";

export interface WorkspaceTabDragSource {
  readonly groupId: TabGroupId;
  readonly tabId: WorkspaceTabId;
  readonly index: number;
  readonly title: string;
}

export type WorkspaceTabDragSnapshot =
  | { readonly phase: "idle" }
  | {
      readonly phase: "pending" | "dragging";
      readonly source: WorkspaceTabDragSource;
      readonly point: WorkspaceDragPoint;
      readonly destination: WorkspaceTabDropDestination | null;
    };

export interface WorkspaceTabDragControllerOptions {
  readonly onDrop: (destination: WorkspaceTabDropDestination) => void;
  readonly resolveDestination: (
    point: WorkspaceDragPoint,
    source: WorkspaceTabDragSource,
  ) => WorkspaceTabDropDestination | null;
  readonly onSnapshotChange?: (snapshot: WorkspaceTabDragSnapshot) => void;
}

export class WorkspaceTabDragController {
  private snapshot: WorkspaceTabDragSnapshot = { phase: "idle" };
  private origin: WorkspaceDragPoint | null = null;
  private pointerId: number | null = null;
  private suppressedClickTabId: WorkspaceTabId | null = null;

  constructor(private readonly options: WorkspaceTabDragControllerOptions) {}

  getSnapshot(): WorkspaceTabDragSnapshot {
    return this.snapshot;
  }

  start(pointerId: number, source: WorkspaceTabDragSource, point: WorkspaceDragPoint): void {
    this.pointerId = pointerId;
    this.origin = point;
    this.setSnapshot({ phase: "pending", source, point, destination: null });
  }

  move(pointerId: number, point: WorkspaceDragPoint): void {
    if (pointerId !== this.pointerId || this.snapshot.phase === "idle" || this.origin === null)
      return;
    if (
      this.snapshot.phase === "pending" &&
      !hasCrossedWorkspaceTabDragThreshold(this.origin, point)
    ) {
      return;
    }
    this.setSnapshot({
      phase: "dragging",
      source: this.snapshot.source,
      point,
      destination: this.options.resolveDestination(point, this.snapshot.source),
    });
  }

  drop(pointerId: number): void {
    if (pointerId !== this.pointerId) return;
    const destination = this.snapshot.phase === "dragging" ? this.snapshot.destination : null;
    if (this.snapshot.phase === "dragging") this.suppressedClickTabId = this.snapshot.source.tabId;
    this.reset();
    if (destination !== null) this.options.onDrop(destination);
  }

  cancel(): void {
    if (this.snapshot.phase === "idle") return;
    if (this.snapshot.phase === "dragging") this.suppressedClickTabId = this.snapshot.source.tabId;
    this.reset();
  }

  consumeClickSuppression(tabId: WorkspaceTabId): boolean {
    if (this.suppressedClickTabId !== tabId) return false;
    this.suppressedClickTabId = null;
    return true;
  }

  private reset(): void {
    this.pointerId = null;
    this.origin = null;
    this.setSnapshot({ phase: "idle" });
  }

  private setSnapshot(snapshot: WorkspaceTabDragSnapshot): void {
    this.snapshot = snapshot;
    this.options.onSnapshotChange?.(snapshot);
  }
}

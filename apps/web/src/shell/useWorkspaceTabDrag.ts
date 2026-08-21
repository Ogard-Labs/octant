import type { PaneId } from "@octant/contracts/shell";
import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  WorkspaceSurfaceDragController as PointerDragController,
  type WorkspaceSurfaceDragSnapshot,
} from "./workspaceTabDragController";
import {
  resolveWorkspaceSurfaceDropDestination,
  type WorkspaceDragPaneGeometry,
  type WorkspaceSurfaceDragSource,
  type WorkspaceSurfaceDropDestination,
} from "./workspaceTabDragGeometry";

export interface WorkspaceSurfaceDragState {
  readonly destination: WorkspaceSurfaceDropDestination | null;
  readonly point: { readonly x: number; readonly y: number };
  readonly source: WorkspaceSurfaceDragSource;
}

export interface WorkspaceSurfaceDragHandle {
  readonly active: WorkspaceSurfaceDragState | null;
  readonly consumeSuppressedClick: (dragKey: string) => boolean;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    source: WorkspaceSurfaceDragSource,
  ) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Attached to the workspace root; pane rects are measured under it. */
  readonly rootRef: RefObject<HTMLDivElement | null>;
}

/**
 * A sidebar thread row offered as a drag source. The shell mints the surface
 * for the row's thread, so the row itself never learns the workspace's surface
 * vocabulary.
 */
export interface SidebarThreadDragRow {
  readonly rowId: string;
  readonly threadId: string;
  readonly title: string;
  readonly projectId?: string;
}

export interface SidebarThreadDragTargets {
  readonly beginThreadDrag: (
    event: ReactPointerEvent<HTMLElement>,
    row: SidebarThreadDragRow,
  ) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Whether the row's click follows a completed drag and must not open it. */
  readonly consumeThreadClickSuppression: (rowId: string) => boolean;
}

/**
 * Reaches sidebar rows without threading drag props through every list layer.
 * `null` where no workspace accepts drops (tests rendering rows alone).
 */
export const SidebarThreadDragContext = createContext<SidebarThreadDragTargets | null>(null);

export function useWorkspaceSurfaceDrag(options: {
  readonly focusedPaneId?: PaneId;
  readonly onDrop: (
    source: WorkspaceSurfaceDragSource,
    destination: WorkspaceSurfaceDropDestination,
  ) => void;
}): WorkspaceSurfaceDragHandle {
  const [active, setActive] = useState<WorkspaceSurfaceDragState | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const captured = useRef<{ readonly element: HTMLElement; readonly pointerId: number } | null>(
    null,
  );
  const onDrop = useRef(options.onDrop);
  const resolveDestination = useRef(
    (_point: { readonly x: number; readonly y: number }, _source: WorkspaceSurfaceDragSource) =>
      null as WorkspaceSurfaceDropDestination | null,
  );
  onDrop.current = options.onDrop;
  resolveDestination.current = (point, source) => {
    const root = rootRef.current;
    if (root === null) return null;
    return resolveWorkspaceSurfaceDropDestination({
      point,
      workspaceRect: toRect(root.getBoundingClientRect()),
      panes: measurePanes(root),
      source,
      ...(options.focusedPaneId === undefined ? {} : { focusedPaneId: options.focusedPaneId }),
    });
  };
  const controller = useRef<PointerDragController | null>(null);
  if (controller.current === null) {
    controller.current = new PointerDragController({
      onDrop: (source, destination) => onDrop.current(source, destination),
      resolveDestination: (point, source) => resolveDestination.current(point, source),
      onSnapshotChange: (snapshot) => setActive(activeSnapshot(snapshot)),
    });
  }

  const cancel = useCallback(() => {
    releaseCapture(captured.current);
    captured.current = null;
    controller.current?.cancel();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || controller.current?.getSnapshot().phase === "idle") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const onBlur = () => cancel();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
      cancel();
    };
  }, [cancel]);

  return {
    active,
    consumeSuppressedClick: (dragKey) =>
      controller.current?.consumeClickSuppression(dragKey) ?? false,
    onPointerDown(event, source) {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      captured.current = { element: event.currentTarget, pointerId: event.pointerId };
      controller.current?.start(event.pointerId, source, { x: event.clientX, y: event.clientY });
    },
    onPointerMove(event) {
      controller.current?.move(event.pointerId, { x: event.clientX, y: event.clientY });
    },
    onPointerUp(event) {
      controller.current?.drop(event.pointerId);
      releaseCapture(captured.current);
      captured.current = null;
    },
    onPointerCancel: cancel,
    rootRef,
  };
}

function activeSnapshot(snapshot: WorkspaceSurfaceDragSnapshot): WorkspaceSurfaceDragState | null {
  return snapshot.phase === "dragging"
    ? { destination: snapshot.destination, point: snapshot.point, source: snapshot.source }
    : null;
}

function measurePanes(root: HTMLElement): Array<WorkspaceDragPaneGeometry> {
  return [...root.querySelectorAll<HTMLElement>("[data-workspace-pane-id]")].flatMap((pane) => {
    const paneId = pane.dataset.workspacePaneId as PaneId | undefined;
    if (paneId === undefined) return [];
    return [
      {
        paneId,
        rect: toRect(pane.getBoundingClientRect()),
        canSplit: pane.dataset.workspaceCanSplit !== "false",
      },
    ];
  });
}

function releaseCapture(
  capture: { readonly element: HTMLElement; readonly pointerId: number } | null,
) {
  if (capture?.element.hasPointerCapture?.(capture.pointerId)) {
    capture.element.releasePointerCapture(capture.pointerId);
  }
}

function toRect(rect: Pick<DOMRect, "height" | "left" | "top" | "width">) {
  return { height: rect.height, left: rect.left, top: rect.top, width: rect.width };
}

import type { TabGroupId, WorkspaceTabGroup, WorkspaceTabId } from "@octant/contracts/shell";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  WorkspaceTabDragController as PointerDragController,
  type WorkspaceTabDragSnapshot,
} from "./workspaceTabDragController";
import {
  resolveWorkspaceTabDropDestination,
  type WorkspaceDragGroupGeometry,
  type WorkspaceTabDropDestination,
} from "./workspaceTabDragGeometry";

interface DragSource {
  readonly groupId: TabGroupId;
  readonly index: number;
  readonly tabId: WorkspaceTabId;
  readonly title: string;
}

export interface WorkspaceTabDragState {
  readonly destination: WorkspaceTabDropDestination | null;
  readonly point: { readonly x: number; readonly y: number };
  readonly source: DragSource;
}

export interface WorkspaceTabDragController {
  readonly active: WorkspaceTabDragState | null;
  readonly consumeSuppressedClick: (tabId: WorkspaceTabId) => boolean;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    group: WorkspaceTabGroup,
    tabId: WorkspaceTabId,
    index: number,
    title: string,
  ) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
}

export function useWorkspaceTabDrag(options: {
  readonly focusedGroupId?: TabGroupId;
  readonly onDrop: (destination: WorkspaceTabDropDestination) => void;
  readonly rootRef: RefObject<HTMLDivElement | null>;
}): WorkspaceTabDragController {
  const [active, setActive] = useState<WorkspaceTabDragState | null>(null);
  const captured = useRef<{ readonly element: HTMLElement; readonly pointerId: number } | null>(
    null,
  );
  const onDrop = useRef(options.onDrop);
  const resolveDestination = useRef(
    (_point: { readonly x: number; readonly y: number }, _source: DragSource) =>
      null as WorkspaceTabDropDestination | null,
  );
  onDrop.current = options.onDrop;
  resolveDestination.current = (point, source) => {
    const root = options.rootRef.current;
    if (root === null) return null;
    return resolveWorkspaceTabDropDestination({
      point,
      workspaceRect: toRect(root.getBoundingClientRect()),
      groups: measureGroups(root),
      source: { groupId: source.groupId, tabId: source.tabId, index: source.index },
      ...(options.focusedGroupId === undefined ? {} : { focusedGroupId: options.focusedGroupId }),
    });
  };
  const controller = useRef<PointerDragController | null>(null);
  if (controller.current === null) {
    controller.current = new PointerDragController({
      onDrop: (destination) => onDrop.current(destination),
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
    consumeSuppressedClick: (tabId) => controller.current?.consumeClickSuppression(tabId) ?? false,
    onPointerDown(event, group, tabId, index, title) {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      captured.current = { element: event.currentTarget, pointerId: event.pointerId };
      controller.current?.start(
        event.pointerId,
        { groupId: group.groupId, index, tabId, title },
        { x: event.clientX, y: event.clientY },
      );
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
  };
}

function activeSnapshot(snapshot: WorkspaceTabDragSnapshot): WorkspaceTabDragState | null {
  return snapshot.phase === "dragging"
    ? { destination: snapshot.destination, point: snapshot.point, source: snapshot.source }
    : null;
}

function measureGroups(root: HTMLElement): Array<WorkspaceDragGroupGeometry> {
  return [...root.querySelectorAll<HTMLElement>("[data-workspace-group-id]")].flatMap((group) => {
    const groupId = group.dataset.workspaceGroupId as TabGroupId | undefined;
    const strip = group.querySelector<HTMLElement>("[data-workspace-tab-strip]");
    if (groupId === undefined || strip === null) return [];
    const tabs = [...strip.querySelectorAll<HTMLElement>("[data-workspace-tab-id]")].flatMap(
      (tab) => {
        const tabId = tab.dataset.workspaceTabId as WorkspaceTabId | undefined;
        return tabId === undefined ? [] : [{ tabId, rect: toRect(tab.getBoundingClientRect()) }];
      },
    );
    return [
      {
        groupId,
        rect: toRect(group.getBoundingClientRect()),
        tabCount: tabs.length,
        tabStrip: { rect: toRect(strip.getBoundingClientRect()), tabs },
        canSplit: group.dataset.workspaceCanSplit !== "false",
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

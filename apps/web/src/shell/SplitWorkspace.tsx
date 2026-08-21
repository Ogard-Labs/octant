import type {
  LayoutNodeId,
  PaneId,
  WorkspaceLayoutNode,
  WorkspacePane,
  WorkspaceTab,
} from "@octant/contracts/shell";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { GripVertical } from "lucide-react";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { OctantSlider } from "../ui/base/OctantSlider";
import { MENU_ITEM_CLASS } from "../projects/ThreadRowMenu";
import { WorkspaceDragStatus, WorkspaceDropOverlay } from "./WorkspaceDropOverlay";
import type { WorkspaceSurfaceDragHandle } from "./useWorkspaceTabDrag";

const splitContainerStyle = { height: "100%", minHeight: 0, minWidth: 0, width: "100%" };

export interface SplitWorkspaceProps {
  /**
   * The shared surface-drag pipeline. Owned above the workspace so sidebar
   * rows and pane grips feed the same drag; its `rootRef` attaches here, where
   * the droppable panes actually live.
   */
  readonly drag: WorkspaceSurfaceDragHandle;
  /**
   * The pane this window is about — dock subject, composer target, and the
   * one visible accessible active state. Distinct from {@link focusedPaneId},
   * which is temporary zoom of one pane.
   */
  readonly activePaneId?: PaneId;
  readonly focusedPaneId?: PaneId;
  readonly layout: WorkspaceLayoutNode;
  readonly mode: "chat" | "work" | "code";
  /** A pointer landing anywhere in a pane makes it the window's active pane. */
  readonly onActivatePane: (paneId: PaneId) => void;
  readonly onClearFocus: () => void;
  readonly onClosePane: (paneId: PaneId) => void;
  readonly onCommitResize: (splitNodeId: LayoutNodeId, ratio: number) => void;
  readonly onFocus: (paneId: PaneId) => void;
  readonly onPreviewResize: (splitNodeId: LayoutNodeId, ratio: number) => void;
  /** A keyboard path to the edge-drop gesture: split this pane, welcome in the new pane. */
  readonly onSplitPane: (
    paneId: PaneId,
    orientation: "horizontal" | "vertical",
    placement: "before" | "after",
  ) => void;
  readonly renderSurface: (surface: WorkspaceTab, paneId: PaneId) => React.ReactNode;
  readonly totalWorkspacePaneCount: number;
}

interface WorkspaceNodeProps extends SplitWorkspaceProps {
  readonly node: WorkspaceLayoutNode;
}

export function SplitWorkspace(props: SplitWorkspaceProps) {
  return (
    <div className="workspace-root" ref={props.drag.rootRef} style={splitContainerStyle}>
      <WorkspaceNode {...props} node={props.layout} />
      {props.drag.active === null ? null : <WorkspaceDragStatus drag={props.drag.active} />}
    </div>
  );
}

function WorkspaceNode(props: WorkspaceNodeProps) {
  if (props.node.kind === "pane") {
    return <WorkspacePaneView {...props} pane={props.node} />;
  }
  const split = props.node;
  const firstTrack = `minmax(0, ${split.ratio}fr)`;
  const secondTrack = `minmax(0, ${Number((1 - split.ratio).toFixed(6))}fr)`;
  const splitStyle =
    split.orientation === "horizontal"
      ? {
          ...splitContainerStyle,
          display: "grid",
          gridTemplateColumns: `${firstTrack} auto ${secondTrack}`,
        }
      : {
          ...splitContainerStyle,
          display: "grid",
          gridTemplateRows: `${firstTrack} auto ${secondTrack}`,
        };
  return (
    <div
      aria-label={`${split.orientation} workspace split`}
      className="workspace-split"
      data-orientation={split.orientation}
      role="group"
      style={splitStyle}
    >
      <WorkspaceNode {...props} node={split.first} />
      <WorkspaceSplitResize
        nodeId={split.nodeId}
        onCommit={props.onCommitResize}
        onPreview={props.onPreviewResize}
        orientation={split.orientation}
        ratio={split.ratio}
      />
      <WorkspaceNode {...props} node={split.second} />
    </div>
  );
}

function WorkspaceSplitResize(props: {
  readonly nodeId: LayoutNodeId;
  readonly onCommit: (splitNodeId: LayoutNodeId, ratio: number) => void;
  readonly onPreview: (splitNodeId: LayoutNodeId, ratio: number) => void;
  readonly orientation: "horizontal" | "vertical";
  readonly ratio: number;
}) {
  const latestProps = useRef(props);
  latestProps.current = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const activePointer = useRef<
    | {
        readonly element: HTMLLabelElement;
        readonly pointerId: number;
        readonly rect: DOMRect;
        readonly startPoint: number;
        readonly startRatio: number;
        lastRatio: number;
        moved: boolean;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      if (activePointer.current === undefined) return;
      event.preventDefault();
      cancelSplitResize(activePointer, latestProps.current);
    }
    function handleWindowBlur(): void {
      cancelSplitResize(activePointer, latestProps.current);
    }
    window.addEventListener("keydown", handleWindowKeyDown);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      cancelSplitResize(activePointer, latestProps.current);
      window.removeEventListener("keydown", handleWindowKeyDown);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  function pointerRatio(event: ReactPointerEvent<HTMLLabelElement>): number | undefined {
    const pointer = activePointer.current;
    if (pointer === undefined || pointer.pointerId !== event.pointerId) return undefined;
    const point = props.orientation === "horizontal" ? event.clientX : event.clientY;
    if (point === pointer.startPoint && !pointer.moved) return undefined;
    const start = props.orientation === "horizontal" ? pointer.rect.left : pointer.rect.top;
    const size = props.orientation === "horizontal" ? pointer.rect.width : pointer.rect.height;
    const ratio = clampSplitRatio((point - start) / size);
    pointer.moved = true;
    if (ratio !== pointer.lastRatio) {
      pointer.lastRatio = ratio;
      props.onPreview(props.nodeId, ratio);
    }
    return ratio;
  }

  function cancel(): void {
    cancelSplitResize(activePointer, props);
  }

  function finish(event: ReactPointerEvent<HTMLLabelElement>): void {
    const pointer = activePointer.current;
    if (pointer === undefined || pointer.pointerId !== event.pointerId) return;
    pointerRatio(event);
    activePointer.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (pointer.moved && pointer.lastRatio !== pointer.startRatio) {
      props.onCommit(props.nodeId, pointer.lastRatio);
    }
  }

  return (
    <label
      className="workspace-split__resize window-no-drag"
      onLostPointerCapture={cancel}
      onPointerCancel={cancel}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const rect = event.currentTarget.parentElement?.getBoundingClientRect();
        if (rect === undefined || rect.width <= 0 || rect.height <= 0) return;
        event.preventDefault();
        inputRef.current?.focus();
        activePointer.current = {
          element: event.currentTarget,
          pointerId: event.pointerId,
          rect,
          startPoint: props.orientation === "horizontal" ? event.clientX : event.clientY,
          startRatio: props.ratio,
          lastRatio: props.ratio,
          moved: false,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={pointerRatio}
      onPointerUp={finish}
    >
      <span className="sr-only">Resize split</span>
      <OctantSlider
        aria-label="Resize split"
        className="workspace-split__resize-input"
        max={0.8}
        min={0.2}
        onChange={(event) => props.onPreview(props.nodeId, Number(event.currentTarget.value))}
        onKeyUp={(event) => props.onCommit(props.nodeId, Number(event.currentTarget.value))}
        ref={inputRef}
        step={0.05}
        value={props.ratio}
      />
    </label>
  );
}

function cancelSplitResize(
  activePointer: React.RefObject<
    | {
        readonly element: HTMLLabelElement;
        readonly pointerId: number;
        readonly startRatio: number;
        readonly moved: boolean;
        readonly lastRatio: number;
      }
    | undefined
  >,
  props: {
    readonly nodeId: LayoutNodeId;
    readonly onPreview: (splitNodeId: LayoutNodeId, ratio: number) => void;
  },
): void {
  const pointer = activePointer.current;
  if (pointer === undefined) return;
  activePointer.current = undefined;
  if (pointer.element.hasPointerCapture?.(pointer.pointerId)) {
    pointer.element.releasePointerCapture(pointer.pointerId);
  }
  if (pointer.moved && pointer.lastRatio !== pointer.startRatio) {
    props.onPreview(props.nodeId, pointer.startRatio);
  }
}

function clampSplitRatio(value: number): number {
  return Number(Math.min(0.8, Math.max(0.2, value)).toFixed(6));
}

function WorkspacePaneView(props: WorkspaceNodeProps & { readonly pane: WorkspacePane }) {
  const pane = props.pane;
  const surface = pane.surface;
  const active = String(props.activePaneId) === String(pane.paneId);
  const focused = String(props.focusedPaneId) === String(pane.paneId);
  const canSplit = canSplitPane(props.layout, pane.paneId, props.totalWorkspacePaneCount);
  const dragKey = `pane:${String(pane.paneId)}`;
  return (
    <section
      aria-current={active ? "true" : undefined}
      aria-label={`Workspace pane: ${surface.title}`}
      className="workspace-pane"
      data-active={active ? "true" : "false"}
      data-focused={focused ? "true" : "false"}
      data-workspace-can-split={canSplit ? "true" : "false"}
      data-workspace-pane-id={pane.paneId}
      onBeforeInputCapture={() => props.onActivatePane(pane.paneId)}
      onKeyDownCapture={() => props.onActivatePane(pane.paneId)}
      onPointerDownCapture={() => props.onActivatePane(pane.paneId)}
    >
      {/* The header spans the window's title band, so the space the grip and
          the launcher do not claim has to stay a native drag region: with the
          grip stretched across it the window could not be moved at all. */}
      <ContextMenuPrimitive.Root>
        <ContextMenuPrimitive.Trigger
          className="workspace-pane__header window-drag-region"
          render={<div />}
        >
          <span
            className="workspace-pane__grip window-no-drag"
            onPointerCancel={props.drag.onPointerCancel}
            onPointerDown={(event) =>
              props.drag.onPointerDown(event, {
                dragKey,
                paneId: pane.paneId,
                surface,
                title: surface.title,
              })
            }
            onPointerMove={props.drag.onPointerMove}
            onPointerUp={props.drag.onPointerUp}
            title="Drag to move or split"
          >
            <GripVertical aria-hidden="true" size={13} strokeWidth={1.8} />
            <span className="workspace-pane__title">{surface.title}</span>
          </span>
        </ContextMenuPrimitive.Trigger>
        <PaneMenu
          canSplit={canSplit}
          focused={focused}
          onClearFocus={props.onClearFocus}
          onClose={() => props.onClosePane(pane.paneId)}
          onFocus={() => props.onFocus(pane.paneId)}
          onSplit={(orientation) => props.onSplitPane(pane.paneId, orientation, "after")}
          surface={surface}
        />
      </ContextMenuPrimitive.Root>
      <div className="workspace-pane__panel">{props.renderSurface(surface, pane.paneId)}</div>
      {props.drag.active === null ? null : (
        <WorkspaceDropOverlay
          destination={props.drag.active.destination}
          targetPaneId={String(pane.paneId)}
        />
      )}
    </section>
  );
}

/**
 * The pane's own actions, on right-click over its header.
 *
 * They used to sit behind a "…" button parked in every pane's title band. The
 * band is scarce — it is also the window's drag handle — and the button was
 * present on every pane at all times for actions taken rarely. Right-click is
 * where this window already puts a row's own actions, and it keeps focus,
 * split, and close reachable without a keyboard user losing them.
 */
function PaneMenu(props: {
  readonly canSplit: boolean;
  readonly focused: boolean;
  readonly onClearFocus: () => void;
  readonly onClose: () => void;
  readonly onFocus: () => void;
  readonly onSplit: (orientation: "horizontal" | "vertical") => void;
  readonly surface: WorkspaceTab;
}) {
  const focusLabel = props.focused ? "Show all panes" : "Focus this pane";
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-50 window-no-drag">
        <ContextMenuPrimitive.Popup className="window-no-drag z-50 min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
          <ContextMenuPrimitive.Group>
            <ContextMenuPrimitive.GroupLabel className="truncate px-2 py-1.5 text-xs text-muted-foreground">
              {props.surface.title}
            </ContextMenuPrimitive.GroupLabel>
          </ContextMenuPrimitive.Group>
          <ContextMenuPrimitive.Item
            className={MENU_ITEM_CLASS}
            closeOnClick
            label={focusLabel}
            onClick={() => (props.focused ? props.onClearFocus() : props.onFocus())}
          >
            {focusLabel}
          </ContextMenuPrimitive.Item>
          {/* A focused pane is presented alone, so a split made now would land
              where nobody can see it. The same rule the edge-drop follows. */}
          {props.canSplit && !props.focused ? (
            <>
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                closeOnClick
                label="Split right"
                onClick={() => props.onSplit("horizontal")}
              >
                Split right
              </ContextMenuPrimitive.Item>
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                closeOnClick
                label="Split down"
                onClick={() => props.onSplit("vertical")}
              >
                Split down
              </ContextMenuPrimitive.Item>
            </>
          ) : null}
          <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" />
          <ContextMenuPrimitive.Item
            className={MENU_ITEM_CLASS}
            closeOnClick
            label="Close pane"
            onClick={props.onClose}
          >
            Close pane
          </ContextMenuPrimitive.Item>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function canSplitPane(
  layout: WorkspaceLayoutNode,
  paneId: PaneId,
  totalWorkspacePaneCount: number,
  depth = 1,
): boolean {
  if (totalWorkspacePaneCount >= 8) return false;
  if (layout.kind === "pane") return String(layout.paneId) === String(paneId) && depth < 6;
  return (
    canSplitPane(layout.first, paneId, totalWorkspacePaneCount, depth + 1) ||
    canSplitPane(layout.second, paneId, totalWorkspacePaneCount, depth + 1)
  );
}

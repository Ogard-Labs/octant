import type { CodeThreadId } from "@octant/contracts/code";
import type {
  LayoutNodeId,
  TabGroupId,
  WorkspaceLayoutNode,
  WorkspaceSurfaceCatalog,
  WorkspaceSurfaceDescriptor,
  WorkspaceTab,
  WorkspaceTabGroup,
  WorkspaceTabId,
} from "@octant/contracts/shell";
import { Maximize2, MoreHorizontal, MoveRight, PanelsTopLeft } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { CodeOverviewSurfaceKind } from "../code/CodeOverview";
import { LAUNCHABLE_CODE_SURFACES, codeSurfaceTitle } from "../code/codeSurfaces";
import { OctantSlider } from "../ui/base/OctantSlider";
import { IconButton } from "./IconButton";
import { WorkspaceTabLauncher } from "./WorkspaceTabLauncher";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { WorkspaceDragStatus, WorkspaceDropOverlay } from "./WorkspaceDropOverlay";
import { useWorkspaceTabDrag } from "./useWorkspaceTabDrag";
import type { WorkspaceTabDropDestination } from "./workspaceTabDragGeometry";

const splitContainerStyle = { height: "100%", minHeight: 0, minWidth: 0, width: "100%" };

export interface SplitWorkspaceProps {
  readonly availableSurfaces?: WorkspaceSurfaceCatalog;
  readonly focusedGroupId?: TabGroupId;
  readonly layout: WorkspaceLayoutNode;
  readonly mode: "chat" | "work" | "code";
  readonly onActivate: (groupId: TabGroupId, tabId: WorkspaceTabId) => void;
  readonly onClearFocus: () => void;
  readonly onClose: (groupId: TabGroupId, tabId: WorkspaceTabId) => void;
  readonly onCommitResize: (splitNodeId: LayoutNodeId, ratio: number) => void;
  readonly onFocus: (groupId: TabGroupId) => void;
  readonly onDropTab: (destination: WorkspaceTabDropDestination) => void;
  readonly onMove: (
    fromGroupId: TabGroupId,
    toGroupId: TabGroupId,
    tabId: WorkspaceTabId,
    index: number,
  ) => void;
  /** Opens one of a Code thread's own surfaces as a tab beside it. */
  readonly onOpenCodeSurface?: (
    kind: CodeOverviewSurfaceKind,
    threadId: CodeThreadId,
    title: string,
  ) => void;
  readonly onOpenSurface?: (
    surface: WorkspaceSurfaceDescriptor["kind"],
    groupId: TabGroupId,
  ) => void;
  readonly onPreviewResize: (splitNodeId: LayoutNodeId, ratio: number) => void;
  readonly onReorder: (groupId: TabGroupId, tabId: WorkspaceTabId, index: number) => void;
  readonly onSplit: (
    groupId: TabGroupId,
    tabId: WorkspaceTabId,
    orientation: "horizontal" | "vertical",
    placement: "before" | "after",
  ) => void;
  readonly onToggleCanvasPin?: (groupId: TabGroupId, tab: WorkspaceTab) => void;
  readonly renderTab: (tab: WorkspaceTab, groupId: TabGroupId) => React.ReactNode;
  readonly renderTabAccessory?: (tab: WorkspaceTab, groupId: TabGroupId) => ReactNode;
  readonly totalWorkspaceGroupCount: number;
}

interface WorkspaceNodeProps extends SplitWorkspaceProps {
  readonly allGroups: ReadonlyArray<WorkspaceTabGroup>;
  readonly drag: ReturnType<typeof useWorkspaceTabDrag>;
  readonly node: WorkspaceLayoutNode;
  readonly onPaneFocusHandled: () => void;
  readonly onPaneFocusRequest: (request: PaneFocusRequest) => void;
  readonly paneFocusRequest: PaneFocusRequest | undefined;
}

interface PaneFocusRequest {
  readonly groupId: TabGroupId;
  readonly tabId: WorkspaceTabId;
}

export function SplitWorkspace(props: SplitWorkspaceProps) {
  const allGroups = collectGroups(props.layout);
  const rootRef = useRef<HTMLDivElement>(null);
  const [paneFocusRequest, setPaneFocusRequest] = useState<PaneFocusRequest>();
  const onPaneFocusHandled = useCallback(() => setPaneFocusRequest(undefined), []);
  const drag = useWorkspaceTabDrag({
    rootRef,
    onDrop: props.onDropTab,
    ...(props.focusedGroupId === undefined ? {} : { focusedGroupId: props.focusedGroupId }),
  });
  return (
    <div className="workspace-root" ref={rootRef} style={splitContainerStyle}>
      <WorkspaceNode
        {...props}
        allGroups={allGroups}
        drag={drag}
        node={props.layout}
        onPaneFocusHandled={onPaneFocusHandled}
        onPaneFocusRequest={setPaneFocusRequest}
        paneFocusRequest={paneFocusRequest}
      />
      {drag.active === null ? null : <WorkspaceDragStatus drag={drag.active} />}
    </div>
  );
}

function WorkspaceNode(props: WorkspaceNodeProps) {
  if (props.node.kind === "group") {
    return <WorkspaceGroup {...props} group={props.node} />;
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

function WorkspaceGroup(props: WorkspaceNodeProps & { readonly group: WorkspaceTabGroup }) {
  const activeTab = props.group.tabs.find((tab) => tab.id === props.group.activeTabId)!;
  const groupIndex = props.allGroups.findIndex((group) => group.groupId === props.group.groupId);
  const nextGroup = props.allGroups[(groupIndex + 1) % props.allGroups.length];
  const openCodeSurface = props.onOpenCodeSurface;
  // A thread's own surfaces are launchable only from the group showing that
  // thread, so the id comes from the active tab rather than from window state.
  const codeThreadId = activeTab.kind === "code-overview" ? activeTab.threadId : undefined;
  return (
    <section
      aria-label={`Tab group: ${activeTab.title}`}
      className="workspace-group"
      data-focused={props.focusedGroupId === props.group.groupId ? "true" : "false"}
      data-workspace-can-split={
        canSplitGroup(props.layout, props.group.groupId, props.totalWorkspaceGroupCount)
          ? "true"
          : "false"
      }
      data-workspace-group-id={props.group.groupId}
    >
      <div className="workspace-group__header">
        <WorkspaceTabs
          drag={props.drag}
          group={props.group}
          onActivate={(tabId) => props.onActivate(props.group.groupId, tabId)}
          onClose={(tabId) => props.onClose(props.group.groupId, tabId)}
          onReorder={(tabId, index) => props.onReorder(props.group.groupId, tabId, index)}
          onSplit={(tabId, orientation, placement) =>
            props.onSplit(props.group.groupId, tabId, orientation, placement)
          }
          {...(props.onToggleCanvasPin === undefined
            ? {}
            : {
                onToggleCanvasPin: (tab) => props.onToggleCanvasPin?.(props.group.groupId, tab),
              })}
          {...(props.renderTabAccessory === undefined
            ? {}
            : {
                renderAccessory: (tab: WorkspaceTab) =>
                  props.renderTabAccessory?.(tab, props.group.groupId),
              })}
        />
        {props.availableSurfaces === undefined || props.onOpenSurface === undefined ? null : (
          <WorkspaceTabLauncher
            catalog={props.availableSurfaces}
            mode={props.mode}
            onOpenSurface={(surface) => props.onOpenSurface?.(surface, props.group.groupId)}
            {...(openCodeSurface === undefined || codeThreadId === undefined
              ? {}
              : {
                  onOpenThreadSurface: (kind: CodeOverviewSurfaceKind) =>
                    openCodeSurface(kind, codeThreadId, codeSurfaceTitle(kind)),
                  threadSurfaces: LAUNCHABLE_CODE_SURFACES.map((kind) => ({
                    kind,
                    label: codeSurfaceTitle(kind),
                  })),
                })}
            owningThreadAvailable={hasBrowserOwningThread(activeTab)}
          />
        )}
        <PaneActions
          activeTab={activeTab}
          focused={props.focusedGroupId === props.group.groupId}
          groupId={props.group.groupId}
          onClearFocus={props.onClearFocus}
          onFocus={() => props.onFocus(props.group.groupId)}
          onPaneFocusHandled={props.onPaneFocusHandled}
          paneFocusRequest={props.paneFocusRequest}
          {...(nextGroup === undefined
            ? {}
            : {
                onMove: () => {
                  props.onPaneFocusRequest({
                    groupId: nextGroup.groupId,
                    tabId: props.group.activeTabId,
                  });
                  props.onMove(
                    props.group.groupId,
                    nextGroup.groupId,
                    props.group.activeTabId,
                    nextGroup.tabs.length,
                  );
                },
              })}
        />
      </div>
      <div
        aria-labelledby={`workspace-tab-${activeTab.id}`}
        className="workspace-group__panel"
        id={`workspace-panel-${activeTab.id}`}
        role="tabpanel"
        tabIndex={0}
      >
        {props.renderTab(activeTab, props.group.groupId)}
      </div>
      {props.drag.active === null ? null : (
        <WorkspaceDropOverlay
          destination={props.drag.active.destination}
          targetGroupId={props.group.groupId}
        />
      )}
    </section>
  );
}

function hasBrowserOwningThread(tab: WorkspaceTab): boolean {
  return (
    "mode" in tab &&
    tab.mode !== "chat" &&
    "threadId" in tab &&
    typeof tab.threadId === "string" &&
    tab.threadId.length > 0
  );
}

function PaneActions(props: {
  readonly activeTab: WorkspaceTab;
  readonly focused: boolean;
  readonly groupId: TabGroupId;
  readonly onClearFocus: () => void;
  readonly onFocus: () => void;
  readonly onPaneFocusHandled: () => void;
  readonly onMove?: () => void;
  readonly paneFocusRequest: PaneFocusRequest | undefined;
}) {
  const [open, setOpen] = useState(false);
  const disclosureId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) firstAction.current?.focus();
  }, [open]);

  useEffect(() => {
    const request = props.paneFocusRequest;
    if (request === undefined) return;
    if (request.groupId !== props.groupId || request.tabId !== props.activeTab.id) return;
    trigger.current?.focus();
    props.onPaneFocusHandled();
  }, [props.activeTab.id, props.groupId, props.onPaneFocusHandled, props.paneFocusRequest]);

  function close(): void {
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  }

  function select(action: () => void): void {
    action();
    close();
  }

  return (
    <div className="workspace-pane-actions window-no-drag">
      <IconButton
        aria-controls={disclosureId}
        aria-expanded={open}
        className="workspace-pane-actions__trigger"
        data-workspace-pane-trigger-tab-id={props.activeTab.id}
        icon={MoreHorizontal}
        label={`Pane actions for ${props.activeTab.title}`}
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
      />
      {open ? (
        <div
          className="workspace-disclosure workspace-pane-actions__disclosure"
          id={disclosureId}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <PaneAction
            buttonRef={firstAction}
            icon={props.focused ? PanelsTopLeft : Maximize2}
            label={props.focused ? "Show all groups" : "Focus this group"}
            onClick={() => select(props.focused ? props.onClearFocus : props.onFocus)}
          />
          {props.onMove === undefined ? null : (
            <PaneAction
              icon={MoveRight}
              label="Move active tab to next group"
              onClick={() => select(props.onMove!)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function PaneAction(props: {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly icon: typeof Maximize2;
  readonly label: string;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      className="workspace-disclosure__action window-no-drag"
      onClick={props.onClick}
      ref={props.buttonRef}
      type="button"
    >
      <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
      <span>{props.label}</span>
    </button>
  );
}

function collectGroups(layout: WorkspaceLayoutNode): Array<WorkspaceTabGroup> {
  return layout.kind === "group"
    ? [layout]
    : [...collectGroups(layout.first), ...collectGroups(layout.second)];
}

function canSplitGroup(
  layout: WorkspaceLayoutNode,
  groupId: TabGroupId,
  totalWorkspaceGroupCount: number,
  depth = 1,
): boolean {
  if (totalWorkspaceGroupCount >= 8) return false;
  if (layout.kind === "group") return layout.groupId === groupId && depth < 6;
  return (
    canSplitGroup(layout.first, groupId, totalWorkspaceGroupCount, depth + 1) ||
    canSplitGroup(layout.second, groupId, totalWorkspaceGroupCount, depth + 1)
  );
}

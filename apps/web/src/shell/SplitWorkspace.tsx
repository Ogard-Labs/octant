import type { ReactNode } from "react";
import { useMemo } from "react";
import type { WorkspaceContentTabs } from "./workspaceContentTabs";
import { WorkspaceContentViewContext } from "./WorkspaceContentView";
import { OctantTabs, OctantTabsList, OctantTabsTab } from "../ui/base/OctantTabs";
import type {
  LayoutNodeId,
  PaneId,
  WorkspaceLayoutNode,
  WorkspacePane,
  WorkspaceTab,
} from "@octant/contracts/shell";
import type {
  ThreadBoardPullRequestIdentity,
  ThreadBoardPullRequestSummary,
} from "@octant/contracts";
import { GripVertical, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { OctantIconButton } from "../ui/base/OctantButton";
import { OctantSlider } from "../ui/base/OctantSlider";
import {
  OctantContextMenuContent,
  OctantContextMenuGroup,
  OctantContextMenuItem,
  OctantContextMenuLabel,
  OctantContextMenuRoot,
  OctantContextMenuSeparator,
  OctantContextMenuTrigger,
} from "../ui/base/OctantContextMenu";
import { WorkspaceDragStatus, WorkspaceDropOverlay } from "./WorkspaceDropOverlay";
import type { WorkspaceSurfaceDragHandle } from "./useWorkspaceTabDrag";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { workspaceSurfaceTitle } from "./workspaceTabLifecycle";
import { PullRequestChip } from "../code/PullRequestChip";
import type { ThreadProviderIdentity } from "./navigationModel";

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
  readonly contentTabs?: WorkspaceContentTabs;
  readonly onActivateContentTab?: (paneId: PaneId, tabId: WorkspaceTab["id"]) => void;
  readonly onCloseContentTab?: (paneId: PaneId, tabId: WorkspaceTab["id"]) => void;
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
  /** Provider identity for thread-owned surfaces, used by the compact pane tab. */
  readonly providerByThreadId?: ReadonlyMap<string, ThreadProviderIdentity>;
  /** The same preference controls provider marks in navigation and pane tabs. */
  readonly showProviderIcons?: boolean;
  /**
   * The Project the window's panes live in, worn as a chip beside each
   * thread's title. Every pane shares it: placement across Projects is
   * server-refused, so one label is true of them all.
   */
  readonly contextLabel?: string;
  /**
   * What a thread's pane says about where its work is: the pull request it
   * carries and its Project/branch. Read the way a person names a change,
   * so two panes on one Project tell apart by more than their titles.
   */
  readonly paneFactsByThreadId?: ReadonlyMap<string, PaneFacts>;
  /**
   * Selects a pull request named on a pane tab for the dock's Review pane.
   * Without it the chip is a mark with nowhere to go.
   */
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
  /** Start screens alone in the window keep the title band clear. */
  readonly showSinglePaneHeader?: boolean;
  readonly totalWorkspacePaneCount: number;
}

export interface PaneFacts {
  /** The pull request the thread carries, with the identity that opens it. */
  readonly pullRequest?: ThreadBoardPullRequestSummary;
  readonly path?: string;
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
  const [localViews, setLocalViews] = useState<
    ReadonlyArray<{ readonly key: string; readonly title: string; readonly content: ReactNode }>
  >([]);
  const [activeLocalView, setActiveLocalView] = useState<string>();
  const contentView = useMemo(
    () => ({
      open: (key: string, title: string, render: (close: () => void) => ReactNode) => {
        const close = () => {
          setLocalViews((views) => views.filter((view) => view.key !== key));
          setActiveLocalView((activeKey) => (activeKey === key ? undefined : activeKey));
        };
        setLocalViews((views) =>
          views.some((view) => view.key === key)
            ? views
            : [...views, { key, title, content: render(close) }],
        );
        setActiveLocalView(key);
      },
    }),
    [],
  );
  useEffect(() => setActiveLocalView(undefined), [surface.id]);
  const rememberedNavigation = props.contentTabs?.get(pane.paneId);
  const navigation =
    rememberedNavigation?.some((entry) => String(entry.id) === String(surface.id)) === true
      ? rememberedNavigation
      : [surface];
  const showTabs =
    navigation.length > 1 ||
    localViews.length > 0 ||
    ["code-file", "preview", "canvas"].includes(surface.kind);
  const active = String(props.activePaneId) === String(pane.paneId);
  const focused = String(props.focusedPaneId) === String(pane.paneId);
  const canSplit = canSplitPane(props.layout, pane.paneId, props.totalWorkspacePaneCount);
  const dragKey = `pane:${String(pane.paneId)}`;
  const [menuOpen, setMenuOpen] = useState(false);
  const provider =
    props.showProviderIcons === false || !("threadId" in surface)
      ? undefined
      : props.providerByThreadId?.get(String(surface.threadId));
  const facts =
    "threadId" in surface ? props.paneFactsByThreadId?.get(String(surface.threadId)) : undefined;
  const pullRequest = facts?.pullRequest;
  const selectPullRequest = props.onSelectPullRequest;
  const path = "threadId" in surface ? (facts?.path ?? props.contextLabel) : undefined;
  const showHeader = props.layout.kind !== "pane" || props.showSinglePaneHeader !== false;
  const title = workspaceSurfaceTitle(surface);
  const activateUnlessClosing = (target: EventTarget | null) => {
    // Activating can open another dock and resize the pane between pointer
    // down and click, moving its close button away from the pointer.
    if (target instanceof Element && target.closest(".workspace-pane__close") !== null) return;
    props.onActivatePane(pane.paneId);
  };
  return (
    <WorkspaceContentViewContext.Provider value={contentView}>
      <section
        aria-current={active ? "true" : undefined}
        aria-label={`Workspace pane: ${title}`}
        className="workspace-pane"
        data-active={active ? "true" : "false"}
        data-focused={focused ? "true" : "false"}
        data-header={showHeader ? "true" : "false"}
        data-workspace-can-split={canSplit ? "true" : "false"}
        data-workspace-pane-id={pane.paneId}
        onBeforeInputCapture={() => props.onActivatePane(pane.paneId)}
        onKeyDownCapture={(event) => activateUnlessClosing(event.target)}
        onPointerDownCapture={(event) => activateUnlessClosing(event.target)}
      >
        {showHeader || showTabs ? (
          <OctantContextMenuRoot onOpenChange={setMenuOpen}>
            <OctantContextMenuTrigger
              aria-expanded={menuOpen}
              className="workspace-pane__header"
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
                    title,
                  })
                }
                onPointerMove={props.drag.onPointerMove}
                onPointerUp={props.drag.onPointerUp}
                title="Drag to move or split"
              >
                <GripVertical aria-hidden="true" size={14} strokeWidth={1.8} />
                {provider === undefined ? null : (
                  <span
                    aria-hidden="true"
                    className="workspace-pane__provider"
                    title={provider.displayName}
                  >
                    <ProviderGlyph
                      displayName={provider.displayName}
                      driverKind={provider.driverKind}
                      size={14}
                    />
                  </span>
                )}
                {pullRequest === undefined ? null : (
                  <PullRequestChip
                    className="workspace-pane__pull-request"
                    number={pullRequest.identity.number}
                    state={pullRequest.state}
                    {...(pullRequest.checks === undefined ? {} : { checks: pullRequest.checks })}
                    {...(selectPullRequest === undefined
                      ? {}
                      : { onOpen: () => selectPullRequest(pullRequest.identity) })}
                  />
                )}
                {showTabs ? null : <span className="workspace-pane__title">{title}</span>}
              </span>
              {showTabs ? (
                <OctantTabs
                  className="workspace-content-tabs"
                  value={activeLocalView ?? surface.id}
                  onValueChange={(value) => {
                    if (typeof value !== "string") return;
                    if (localViews.some((view) => view.key === value)) {
                      setActiveLocalView(value);
                      return;
                    }
                    const entry = navigation.find((tab) => tab.id === value);
                    if (entry === undefined) return;
                    setActiveLocalView(undefined);
                    if (entry.id !== surface.id)
                      props.onActivateContentTab?.(pane.paneId, entry.id);
                  }}
                >
                  <OctantTabsList
                    aria-label="Open content"
                    className="workspace-content-tabs__list"
                  >
                    {navigation.map((entry) => (
                      <div className="workspace-content-tabs__entry" key={entry.id}>
                        <OctantTabsTab value={entry.id} title={workspaceSurfaceTitle(entry)}>
                          <span>{workspaceSurfaceTitle(entry)}</span>
                        </OctantTabsTab>
                        <OctantIconButton
                          label={`Close ${workspaceSurfaceTitle(entry)}`}
                          onClick={() => props.onCloseContentTab?.(pane.paneId, entry.id)}
                        >
                          <X aria-hidden="true" size={12} />
                        </OctantIconButton>
                      </div>
                    ))}
                    {localViews.map((view) => (
                      <div className="workspace-content-tabs__entry" key={view.key}>
                        <OctantTabsTab value={view.key}>
                          <span>{view.title}</span>
                        </OctantTabsTab>
                        <OctantIconButton
                          label={`Close ${view.title}`}
                          onClick={() => {
                            setLocalViews((views) => views.filter((item) => item.key !== view.key));
                            setActiveLocalView((key) => (key === view.key ? undefined : key));
                          }}
                        >
                          <X aria-hidden="true" size={12} />
                        </OctantIconButton>
                      </div>
                    ))}
                  </OctantTabsList>
                </OctantTabs>
              ) : null}
              {path === undefined || showTabs ? null : (
                <span aria-hidden="true" className="workspace-pane__path" title={path}>
                  {path}
                </span>
              )}
              <span
                aria-hidden="true"
                className="workspace-pane__window-drag-space window-drag-region"
              />
              {/* Alone in the window there is nothing to close into; the × is a
                split's control, for giving one pane's room back to the other. */}
              {props.layout.kind === "pane" ? null : (
                <OctantIconButton
                  className="workspace-pane__close"
                  label={`Close ${title}`}
                  onClick={() => props.onClosePane(pane.paneId)}
                  type="button"
                >
                  <X aria-hidden="true" size={14} strokeWidth={1.8} />
                </OctantIconButton>
              )}
            </OctantContextMenuTrigger>
            <PaneMenu
              canSplit={canSplit}
              focused={focused}
              onClearFocus={props.onClearFocus}
              onClose={() => props.onClosePane(pane.paneId)}
              onFocus={() => props.onFocus(pane.paneId)}
              onSplit={(orientation) => props.onSplitPane(pane.paneId, orientation, "after")}
              surface={surface}
            />
          </OctantContextMenuRoot>
        ) : null}
        <div className="workspace-pane__panel" hidden={activeLocalView !== undefined}>
          {props.renderSurface(surface, pane.paneId)}
        </div>
        {localViews.map((view) => (
          <div
            className="workspace-pane__panel workspace-content-view"
            role="region"
            aria-label={view.title}
            hidden={activeLocalView !== view.key}
            key={view.key}
          >
            {view.content}
          </div>
        ))}
        {props.drag.active === null ? null : (
          <WorkspaceDropOverlay
            destination={props.drag.active.destination}
            targetPaneId={String(pane.paneId)}
          />
        )}
      </section>
    </WorkspaceContentViewContext.Provider>
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
    <OctantContextMenuContent>
      <OctantContextMenuGroup>
        <OctantContextMenuLabel>{workspaceSurfaceTitle(props.surface)}</OctantContextMenuLabel>
      </OctantContextMenuGroup>
      <OctantContextMenuItem
        label={focusLabel}
        onClick={() => (props.focused ? props.onClearFocus() : props.onFocus())}
      >
        {focusLabel}
      </OctantContextMenuItem>
      {/* A focused pane is presented alone, so a split made now would land
              where nobody can see it. The same rule the edge-drop follows. */}
      {props.canSplit && !props.focused ? (
        <>
          <OctantContextMenuItem label="Split right" onClick={() => props.onSplit("horizontal")}>
            Split right
          </OctantContextMenuItem>
          <OctantContextMenuItem label="Split down" onClick={() => props.onSplit("vertical")}>
            Split down
          </OctantContextMenuItem>
        </>
      ) : null}
      <OctantContextMenuSeparator />
      <OctantContextMenuItem label="Close pane" onClick={props.onClose}>
        Close pane
      </OctantContextMenuItem>
    </OctantContextMenuContent>
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

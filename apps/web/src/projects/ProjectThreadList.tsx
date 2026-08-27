import { memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { Archive, GitBranch, MoreHorizontal, Pin, PinOff } from "lucide-react";
import type { ChatThreadNavigationItem, ThreadRowActivity } from "../shell/navigationModel";
import { SidebarThreadDragContext } from "../shell/useWorkspaceTabDrag";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { ThreadRenameField } from "./ThreadRenameField";
import { type ThreadRowActions, ThreadRowMenu, threadRowMenuIsEmpty } from "./ThreadRowMenu";
import {
  lineageParentTitle,
  threadAncestorChain,
  threadDirectDescendants,
  threadHasLineage,
} from "./threadLineage";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantContextMenuRoot, OctantContextMenuTrigger } from "../ui/base/OctantContextMenu";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantTooltip } from "../ui/base/OctantTooltip";

/**
 * Thread rows and their honest states, shared by the Project sidebar and the
 * Project Overview.
 *
 * The sidebar composes the pieces itself — one status for the whole mode, one
 * row list per Project — while the Overview renders {@link ProjectThreadList},
 * which puts the same status above the same rows for a single Project. Neither
 * surface owns its own row markup, so the unread and follow-up markers, the
 * selection handler, and the empty-versus-unavailable distinction cannot drift
 * apart.
 */
export type ProjectThreadListStatus = "loading" | "ready" | "unavailable";

export interface ProjectThreadStatusProps {
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  readonly status: Exclude<ProjectThreadListStatus, "ready">;
}

/**
 * Says why threads are missing. A list that is still loading, or that the host
 * refused, must never render as an empty list that reads as "no threads".
 */
export function ProjectThreadStatus(props: ProjectThreadStatusProps) {
  return props.status === "loading" ? (
    <p className="project-nav__status" role="status">
      Loading threads…
    </p>
  ) : (
    <div aria-label="Thread list status" className="project-nav__status" role="status">
      <span>{props.errorMessage ?? "Threads are unavailable."}</span>
      {props.onRetry === undefined ? null : (
        <OctantButton onClick={props.onRetry} type="button" variant="ghost">
          Retry threads
        </OctantButton>
      )}
    </div>
  );
}

const ACTIVITY_LABELS: Record<Exclude<ThreadRowActivity, "idle">, string> = {
  working: "Working",
  attention: "Needs attention",
  unread: "New activity",
};

/**
 * The row's state, as a dot that says what it means.
 *
 * A state worth noticing carries its word, so the mark is never colour alone.
 * A thread at rest carries none: "Idle" in front of every quiet thread's title
 * would bury the titles a screen reader is there to read.
 */
function ThreadStatusDot(props: { readonly activity: ThreadRowActivity }) {
  if (props.activity === "idle") {
    return (
      <span aria-hidden="true" className="sidebar-navigation__thread-status" data-activity="idle" />
    );
  }
  return (
    <span
      aria-label={ACTIVITY_LABELS[props.activity]}
      className="sidebar-navigation__thread-status"
      data-activity={props.activity}
      role="img"
      title={ACTIVITY_LABELS[props.activity]}
    />
  );
}

/**
 * The state a row shows when the caller did not compute one. Follow-up and
 * unread are the two the sidebar can always see for itself, so a caller that
 * knows nothing more still gets an honest dot rather than a blank one.
 */
function activityOf(thread: ChatThreadNavigationItem): ThreadRowActivity {
  if (thread.activity !== undefined) return thread.activity;
  if (thread.followUp === true) return "attention";
  if (thread.unread === true) return "unread";
  return "idle";
}

/**
 * Builds a compact, screen-reader-friendly fact line for a thread row tooltip.
 * Only uses values already present in the navigation item and Project context;
 * unparseable timestamps are omitted rather than rendered as "Invalid Date".
 */
function threadRowFacts(props: {
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}): string {
  const facts: string[] = [];
  if (props.thread.pinned === true) facts.push("Pinned");
  if (props.thread.unread === true) facts.push("Unread");
  if (props.thread.followUp === true) facts.push("Follow-up");
  if (props.thread.provider !== undefined) facts.push(props.thread.provider.displayName);
  if (props.projectName !== undefined) facts.push(props.projectName);
  if (props.lineageParentTitle !== undefined) {
    facts.push(`Forked from ${props.lineageParentTitle}`);
  } else if (props.thread.lineageParentThreadId !== undefined) {
    facts.push("Forked from origin no longer available");
  }
  if (props.thread.updatedAt !== undefined) {
    const date = new Date(props.thread.updatedAt);
    if (!Number.isNaN(date.getTime())) {
      facts.push(`Updated ${date.toLocaleDateString()}`);
    }
  }
  return facts.join(" · ");
}

/**
 * A delayed, non-modal summary of the facts the navigation row and its Project
 * context already carry. It does not invent transcript detail, model names, or
 * turn counts; those are not in the row's contract.
 */
function ThreadRowInfoCard(props: {
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}) {
  return (
    <span className="thread-row-info-card">
      <span className="thread-row-info-card__title">{props.thread.title}</span>
      <span className="thread-row-info-card__facts">
        {threadRowFacts({
          ...(props.lineageParentTitle === undefined
            ? {}
            : { lineageParentTitle: props.lineageParentTitle }),
          projectName: props.projectName,
          thread: props.thread,
        })}
      </span>
    </span>
  );
}

/**
 * Wraps a row trigger so the info card appears after a short delay. The popup
 * is rendered in a portal so it is never clipped by the sidebar.
 */
function ThreadRowTooltip(props: {
  readonly children: ReactElement;
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}) {
  return (
    <OctantTooltip
      label={
        <ThreadRowInfoCard
          {...(props.lineageParentTitle === undefined
            ? {}
            : { lineageParentTitle: props.lineageParentTitle })}
          projectName={props.projectName}
          thread={props.thread}
        />
      }
    >
      {props.children}
    </OctantTooltip>
  );
}

/**
 * The stable trailing action gutter for a thread row. Renders inline Pin/Unpin
 * and Archive buttons when the caller provides callbacks, plus an overflow menu
 * that carries the same actions for coarse pointers or narrow viewports.
 */
function ThreadRowActionsGutter(props: {
  readonly actions: ThreadRowActions;
  readonly thread: ChatThreadNavigationItem;
}) {
  const threadId = props.thread.navigationId ?? props.thread.threadId;
  const pinned = props.thread.pinned === true;
  const pinLabel = pinned ? "Unpin thread" : "Pin thread";
  const overflowItems: ReadonlyArray<OctantMenuItem> = [
    ...(props.actions.onPinThread === undefined
      ? []
      : [
          {
            icon: pinned ? (
              <PinOff aria-hidden="true" size={14} strokeWidth={1.8} />
            ) : (
              <Pin aria-hidden="true" size={14} strokeWidth={1.8} />
            ),
            label: pinLabel,
            value: "pin",
          } as const,
        ]),
    ...(props.actions.onArchiveThread === undefined
      ? []
      : [
          {
            icon: <Archive aria-hidden="true" size={14} strokeWidth={1.8} />,
            label: "Archive thread",
            value: "archive",
          } as const,
        ]),
  ];
  return (
    <span className="sidebar-navigation__thread-actions">
      {props.actions.onPinThread === undefined ? null : (
        <OctantIconButton
          className="sidebar-navigation__thread-action sidebar-navigation__thread-action--inline"
          label={pinLabel}
          onClick={() => props.actions.onPinThread?.(threadId, !pinned)}
          title={pinLabel}
          type="button"
        >
          {pinned ? (
            <PinOff aria-hidden="true" size={14} strokeWidth={1.8} />
          ) : (
            <Pin aria-hidden="true" size={14} strokeWidth={1.8} />
          )}
        </OctantIconButton>
      )}
      {props.actions.onArchiveThread === undefined ? null : (
        <OctantIconButton
          className="sidebar-navigation__thread-action sidebar-navigation__thread-action--inline"
          label="Archive thread"
          onClick={() => props.actions.onArchiveThread?.(threadId)}
          title="Archive thread"
          type="button"
        >
          <Archive aria-hidden="true" size={14} strokeWidth={1.8} />
        </OctantIconButton>
      )}
      {overflowItems.length === 0 ? null : (
        <OctantMenu
          items={overflowItems}
          onValueChange={(value) => {
            if (value === "pin") props.actions.onPinThread?.(threadId, !pinned);
            if (value === "archive") props.actions.onArchiveThread?.(threadId);
          }}
          selectionMode="action"
          trigger={<MoreHorizontal aria-hidden="true" size={14} strokeWidth={1.8} />}
          triggerClassName="sidebar-navigation__thread-action sidebar-navigation__thread-action--overflow"
          triggerLabel="Thread actions"
          value=""
        />
      )}
    </span>
  );
}

/**
 * Whether the caller has supplied any action that should be rendered as an
 * inline thread-row button. Renaming alone does not count as an inline action.
 */
function hasInlineActions(actions: ThreadRowActions | undefined): boolean {
  if (actions === undefined) return false;
  return actions.onPinThread !== undefined || actions.onArchiveThread !== undefined;
}

function selectionIdFor(
  threadId: string,
  threads: ReadonlyArray<ChatThreadNavigationItem>,
): string {
  const id = String(threadId);
  for (const thread of threads) {
    if (String(thread.threadId) === id) return thread.navigationId ?? thread.threadId;
  }
  return id;
}

/**
 * Fork mark on a thread row. It sits beside the status dot as its own control
 * so activating it cannot be mistaken for selecting the row, and so a nested
 * button never lands inside the row's own button.
 */
function ThreadLineagePopover(props: {
  readonly onSelectThread: (threadId: string) => void;
  readonly thread: ChatThreadNavigationItem;
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
}) {
  const [open, setOpen] = useState(false);
  const ancestors = threadAncestorChain(props.thread.threadId, props.threads);
  const descendants = threadDirectDescendants(props.thread.threadId, props.threads);
  const select = (threadId: string) => {
    props.onSelectThread(selectionIdFor(threadId, props.threads));
    setOpen(false);
  };
  return (
    <OctantPopover
      className="thread-lineage"
      onOpenChange={setOpen}
      open={open}
      side="bottom"
      title="Fork lineage"
      trigger={<GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />}
      triggerClassName="sidebar-navigation__thread-lineage"
      triggerLabel="Fork lineage"
      triggerVariant="ghost-icon"
    >
      <ol className="thread-lineage__chain">
        {ancestors.map((ancestor) =>
          ancestor.kind === "origin-unavailable" ? (
            <li className="thread-lineage__unavailable" key="origin-unavailable">
              origin no longer available
            </li>
          ) : (
            <li key={ancestor.threadId}>
              <OctantButton
                className="thread-lineage__entry justify-start"
                onClick={() => select(ancestor.threadId)}
                type="button"
                variant="ghost"
              >
                {ancestor.title}
              </OctantButton>
            </li>
          ),
        )}
        <li>
          <OctantButton
            aria-current="true"
            className="thread-lineage__entry justify-start"
            onClick={() => select(props.thread.threadId)}
            type="button"
            variant="ghost"
          >
            <span>{props.thread.title}</span>
            <span>Current</span>
          </OctantButton>
        </li>
      </ol>
      {descendants.length === 0 ? null : (
        <div>
          <h3 className="thread-lineage__heading">Forks</h3>
          <ul className="thread-lineage__forks">
            {descendants.map((fork) => (
              <li key={fork.threadId}>
                <OctantButton
                  className="thread-lineage__entry justify-start"
                  onClick={() => select(fork.threadId)}
                  type="button"
                  variant="ghost"
                >
                  {fork.title}
                </OctantButton>
              </li>
            ))}
          </ul>
        </div>
      )}
    </OctantPopover>
  );
}

export interface ProjectThreadRowsProps {
  /** What the row offers on right-click. Absent leaves the rows without a menu. */
  readonly actions?: ThreadRowActions;
  readonly activeThreadId?: string;
  /** Absent when the host cannot accept a rename, which hides the affordance. */
  readonly onRenameThread?: (threadId: string, title: string) => void;
  readonly onSelectThread: (threadId: string) => void;
  /** Resolves the Project name for the thread; used only by the hover info card. */
  readonly projectNameForThread?: (thread: ChatThreadNavigationItem) => string | undefined;
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
}

const THREAD_VIRTUALIZATION_THRESHOLD = 40;
const THREAD_ROW_ESTIMATE = 32;
const THREAD_ROW_OVERSCAN = 6;

function nearestScrollableAncestor(element: HTMLElement | null): HTMLElement | null {
  let ancestor = element?.parentElement ?? null;
  while (ancestor !== null) {
    const style = getComputedStyle(ancestor);
    if (/^(auto|overlay|scroll)$/.test(style.overflowY)) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function scrollMarginFor(list: HTMLElement, scrollElement: HTMLElement): number {
  const listRect = list.getBoundingClientRect();
  const scrollRect = scrollElement.getBoundingClientRect();
  return listRect.top - scrollRect.top + scrollElement.scrollTop;
}

interface ProjectThreadRowProps {
  readonly actions: ThreadRowActions;
  readonly activeThreadId?: string;
  readonly isRenaming: boolean;
  readonly lineageThreads: ReadonlyArray<ChatThreadNavigationItem>;
  readonly onCancelRename: () => void;
  readonly onRenameThread?: (threadId: string, title: string) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly projectNameForThread?: (thread: ChatThreadNavigationItem) => string | undefined;
  readonly thread: ChatThreadNavigationItem;
}

const ProjectThreadRow = memo(function ProjectThreadRow(props: ProjectThreadRowProps) {
  const drag = useContext(SidebarThreadDragContext);
  const rowId = props.thread.navigationId ?? props.thread.threadId;
  const projectName = props.projectNameForThread?.(props.thread);
  const hasMenu = !threadRowMenuIsEmpty(props.actions);
  const inlineActions = hasInlineActions(props.actions);
  const showLineage = threadHasLineage(props.thread, props.lineageThreads);
  const parentTitle = lineageParentTitle(props.thread, props.lineageThreads);
  const lineageMark = showLineage ? (
    <ThreadLineagePopover
      onSelectThread={props.onSelectThread}
      thread={props.thread}
      threads={props.lineageThreads}
    />
  ) : null;
  const onSelect = useCallback(() => {
    if (drag?.consumeThreadClickSuppression(rowId) === true) return;
    props.onSelectThread(rowId);
  }, [drag, props.onSelectThread, rowId]);
  const onRename = useCallback(
    (title: string) => {
      props.onCancelRename();
      props.onRenameThread?.(rowId, title);
    },
    [props.onCancelRename, props.onRenameThread, rowId],
  );
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (drag === null) return;
      drag.beginThreadDrag(event, {
        rowId,
        threadId: props.thread.threadId,
        title: props.thread.title,
        ...(props.thread.projectId === undefined ? {} : { projectId: props.thread.projectId }),
      });
    },
    [drag, props.thread, rowId],
  );
  if (props.isRenaming) {
    return (
      <ThreadRenameField
        onCancel={props.onCancelRename}
        onRename={onRename}
        title={props.thread.title}
      />
    );
  }
  const row = (
    <OctantButton
      aria-current={props.activeThreadId === rowId ? "page" : undefined}
      className="sidebar-navigation__thread project-threads__thread justify-start"
      data-follow-up={
        props.thread.followUp === undefined ? undefined : props.thread.followUp ? "true" : "false"
      }
      data-pinned={props.thread.pinned === true ? "true" : undefined}
      data-thread-id={props.thread.threadId}
      data-unread={
        props.thread.unread === undefined ? undefined : props.thread.unread ? "true" : "false"
      }
      onClick={onSelect}
      {...(drag === null
        ? {}
        : {
            onPointerCancel: drag.onPointerCancel,
            onPointerDown,
            onPointerMove: drag.onPointerMove,
            onPointerUp: drag.onPointerUp,
          })}
      type="button"
      variant="ghost"
    >
      {/* The dot leads the row from a gutter every row reserves, so a
          busy and an idle title start on the same edge. It is never
          colour alone: the label says the state in words. */}
      <ThreadStatusDot activity={activityOf(props.thread)} />
      {props.thread.provider === undefined ? null : (
        <span
          className="sidebar-navigation__thread-provider"
          title={props.thread.provider.displayName}
        >
          <ProviderGlyph
            displayName={props.thread.provider.displayName}
            driverKind={props.thread.provider.driverKind}
            size={14}
          />
        </span>
      )}
      <span className="sidebar-navigation__thread-copy">
        <span className="sidebar-navigation__thread-title">{props.thread.title}</span>
      </span>
    </OctantButton>
  );
  const wrappedRow = (
    <ThreadRowTooltip
      {...(parentTitle === undefined ? {} : { lineageParentTitle: parentTitle })}
      projectName={projectName}
      thread={props.thread}
    >
      {row}
    </ThreadRowTooltip>
  );
  if (!hasMenu) {
    return (
      <div className="sidebar-navigation__thread-row">
        {lineageMark}
        {wrappedRow}
        {inlineActions ? (
          <ThreadRowActionsGutter actions={props.actions} thread={props.thread} />
        ) : null}
      </div>
    );
  }
  return (
    <ThreadRowContextMenu
      actions={props.actions}
      inlineActions={inlineActions}
      leading={lineageMark}
      {...(parentTitle === undefined ? {} : { lineageParentTitle: parentTitle })}
      projectName={projectName}
      row={row}
      thread={props.thread}
    />
  );
});

/**
 * One button per thread. Attention markers are never colour alone: the unread
 * mark is a dot glyph carrying its own label, the way the Recents rows already
 * mark one, so a reader who cannot see the colour still reads the state.
 *
 * The row ends with the provider's mark rather than the model name. Right-click
 * opens the row's own menu when the caller passed actions for it; renaming
 * happens in place, replacing the row with its field. Pin/Unpin and Archive are
 * offered directly in the trailing gutter on hover or keyboard focus; the same
 * actions remain reachable from the right-click menu as a secondary route.
 */
export function ProjectThreadRows(props: ProjectThreadRowsProps) {
  const [renamingThreadId, setRenamingThreadId] = useState<string>();
  const renameable = props.onRenameThread !== undefined;
  const onStartRenameThread = useCallback((threadId: string) => {
    setRenamingThreadId(threadId);
  }, []);
  const onCancelRename = useCallback(() => {
    setRenamingThreadId(undefined);
  }, []);
  const actions = useMemo<ThreadRowActions>(
    () => ({
      ...props.actions,
      ...(renameable ? { onStartRenameThread } : {}),
    }),
    [onStartRenameThread, props.actions, renameable],
  );
  const virtualized = props.threads.length > THREAD_VIRTUALIZATION_THRESHOLD;
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualizer = useVirtualizer({
    count: virtualized ? props.threads.length : 0,
    estimateSize: () => THREAD_ROW_ESTIMATE,
    getItemKey: (index) => {
      const thread = props.threads[index];
      return thread === undefined ? String(index) : (thread.navigationId ?? thread.threadId);
    },
    getScrollElement: () => nearestScrollableAncestor(listRef.current),
    gap: 2,
    overscan: THREAD_ROW_OVERSCAN,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const pinned = new Set(indexes);
      for (const id of [renamingThreadId, props.activeThreadId]) {
        if (id === undefined) continue;
        const index = props.threads.findIndex(
          (thread) => (thread.navigationId ?? thread.threadId) === id,
        );
        if (index >= 0) pinned.add(index);
      }
      if (pinned.size === indexes.length) return indexes;
      return [...pinned].sort((left, right) => left - right);
    },
    scrollMargin,
    ...(!virtualized ? { enabled: false } : {}),
  });

  useLayoutEffect(() => {
    if (!virtualized) return;
    const list = listRef.current;
    const scrollElement = nearestScrollableAncestor(list);
    if (list === null || scrollElement === null) return;
    const update = () => {
      const nextScrollMargin = scrollMarginFor(list, scrollElement);
      setScrollMargin((currentScrollMargin) =>
        currentScrollMargin === nextScrollMargin ? currentScrollMargin : nextScrollMargin,
      );
    };
    update();
    // A sibling project block can grow without resizing this list or the
    // scroller viewport, and without firing scroll when scrollTop is 0.
    scrollElement.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    const observeLayout = () => {
      observer?.observe(list);
      observer?.observe(scrollElement);
      for (const child of scrollElement.children) {
        if (child instanceof Element) observer?.observe(child);
      }
    };
    observeLayout();
    const mutations =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(() => {
            observeLayout();
            update();
          });
    mutations?.observe(scrollElement, { childList: true, subtree: true });
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      scrollElement.removeEventListener("scroll", update);
    };
  }, [props.threads.length, virtualized]);

  const row = (thread: ChatThreadNavigationItem) => (
    <ProjectThreadRow
      actions={actions}
      {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
      isRenaming={renameable && (thread.navigationId ?? thread.threadId) === renamingThreadId}
      onCancelRename={onCancelRename}
      {...(props.onRenameThread === undefined ? {} : { onRenameThread: props.onRenameThread })}
      onSelectThread={props.onSelectThread}
      lineageThreads={props.threads}
      {...(props.projectNameForThread === undefined
        ? {}
        : { projectNameForThread: props.projectNameForThread })}
      key={thread.navigationId ?? thread.threadId}
      thread={thread}
    />
  );

  if (!virtualized) {
    return <>{props.threads.map((thread) => row(thread))}</>;
  }
  return (
    <div
      className="project-threads__virtual-list"
      ref={listRef}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const thread = props.threads[virtualItem.index];
        if (thread === undefined) return null;
        return (
          <div
            data-index={virtualItem.index}
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            style={{
              left: 0,
              position: "absolute",
              top: 0,
              transform: `translateY(${String(virtualItem.start - scrollMargin)}px)`,
              width: "100%",
            }}
          >
            {row(thread)}
          </div>
        );
      })}
    </div>
  );
}

function ThreadRowContextMenu(props: {
  readonly actions: ThreadRowActions;
  readonly inlineActions: boolean;
  readonly leading?: ReactNode;
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly row: ReactElement;
  readonly thread: ChatThreadNavigationItem;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sidebar-navigation__thread-row">
      {props.leading}
      <OctantContextMenuRoot onOpenChange={setOpen}>
        <ThreadRowTooltip
          {...(props.lineageParentTitle === undefined
            ? {}
            : { lineageParentTitle: props.lineageParentTitle })}
          projectName={props.projectName}
          thread={props.thread}
        >
          <OctantContextMenuTrigger aria-expanded={open} aria-haspopup="menu" render={props.row} />
        </ThreadRowTooltip>
        {props.inlineActions ? (
          <ThreadRowActionsGutter actions={props.actions} thread={props.thread} />
        ) : null}
        <ThreadRowMenu actions={props.actions} thread={props.thread} />
      </OctantContextMenuRoot>
    </div>
  );
}

export interface ProjectThreadListProps {
  readonly actions?: ThreadRowActions;
  readonly activeThreadId?: string;
  readonly onRenameThread?: (threadId: string, title: string) => void;
  /** Shown only when the list is ready and genuinely holds no threads. */
  readonly emptyMessage?: string;
  readonly errorMessage?: string;
  readonly id?: string;
  /**
   * Names the list as its own region. Omit when an enclosing region already
   * names it: two landmarks holding the same rows under the same name is worse
   * for landmark navigation than one.
   */
  readonly label?: string;
  readonly onRetry?: () => void;
  readonly onSelectThread: (threadId: string) => void;
  /** Resolves the Project name for the thread; used only by the hover info card. */
  readonly projectNameForThread?: (thread: ChatThreadNavigationItem) => string | undefined;
  readonly status?: ProjectThreadListStatus;
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
}

/**
 * A list of one Project's threads, optionally its own focusable region. A
 * partial list keeps its status above the rows it did receive rather than
 * hiding them.
 */
export function ProjectThreadList(props: ProjectThreadListProps) {
  const status = props.status ?? "ready";
  return (
    <div
      {...(props.label === undefined
        ? {}
        : { "aria-label": props.label, role: "region", tabIndex: -1 })}
      className="project-threads"
      {...(props.id === undefined ? {} : { id: props.id })}
    >
      {status === "ready" ? null : (
        <ProjectThreadStatus
          {...(props.errorMessage === undefined ? {} : { errorMessage: props.errorMessage })}
          {...(props.onRetry === undefined ? {} : { onRetry: props.onRetry })}
          status={status}
        />
      )}
      {props.threads.length > 0 ? (
        <ProjectThreadRows
          {...(props.actions === undefined ? {} : { actions: props.actions })}
          {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
          {...(props.onRenameThread === undefined ? {} : { onRenameThread: props.onRenameThread })}
          onSelectThread={props.onSelectThread}
          {...(props.projectNameForThread === undefined
            ? {}
            : { projectNameForThread: props.projectNameForThread })}
          threads={props.threads}
        />
      ) : status === "ready" && props.emptyMessage !== undefined ? (
        <p className="project-threads__empty">{props.emptyMessage}</p>
      ) : null}
    </div>
  );
}

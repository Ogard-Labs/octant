import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { threadRowShortAge } from "./threadRowShortAge";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  Archive,
  BellRing,
  ChevronRight,
  CircleCheck,
  Check,
  Clock,
  GitBranch,
  GitPullRequest,
  MoreHorizontal,
  Pin,
  PinOff,
  RotateCcw,
  Undo2,
} from "../ui/icons";
import { resolveSnoozePresets } from "@octant/domain";
import {
  threadRowActivity,
  threadRowStatusInput,
  type ChatThreadNavigationItem,
} from "../shell/navigationModel";
import { SIDEBAR_THREAD_STATUS_LABEL } from "@octant/domain/sidebar-thread-status-policy";
import {
  morePullRequestsThanTheFirst,
  NO_THREAD_ROW_COUNTS,
  threadRowCounts,
  THREAD_ROW_MENU_INLINE_PULL_REQUESTS,
  threadRowPullRequestDestinations,
} from "./threadRowPullRequests";
import { SidebarThreadDragContext } from "../shell/useWorkspaceTabDrag";
import { threadRowFileDrop } from "./sidebarRowDrop";
import { LazyPartBoundary } from "../shell/windowNotice";
import { SidebarThreadTabsContext } from "../shell/sidebarThreadTabs";
import { useSidebarRowProperties } from "../shell/sidebarRowProperties";
import {
  groupCoordinatorThreads,
  groupThreadsByCheckout,
  nestFollowUpThreads,
  type CheckoutThreadGroup,
  type CoordinatorThreadGroup,
} from "./projectThreadGrouping";
import { readFoldedCoordinators, writeFoldedCoordinators } from "../shell/activityViewModel";
import { useMinuteClock } from "./minuteClock";
import { FollowUpLineageContext } from "../followUps/followUpLineage";
import { SidebarThreadRowContent, sidebarThreadRowLabel } from "./SidebarThreadRowContent";
import { NO_THREAD_ROW_STATE, sidebarThreadStatusIcon, threadRowState } from "./threadRowState";
import { ThreadRenameField } from "./ThreadRenameField";
import {
  ThreadCoordinatorMenuItems,
  threadCoordinatorMenuOffers,
  type ThreadRowActions,
  threadRowMenuIsEmpty,
} from "./ThreadRowMenu";
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
import { OctantPreviewCard } from "../ui/base/OctantPreviewCard";

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

/**
 * Distance from now in the coarsest unit that still reads as true, so the
 * header carries recency without the reader parsing a date. Falls back to the
 * absolute date past a year, where "14mo ago" stops being useful.
 */

/**
 * The time a row shows: when a snoozed thread returns, otherwise how long ago
 * it last moved, and only while the view shows Last updated.
 */
export { threadRowShortAge };

export function threadRowAgeFact(
  thread: {
    readonly wakeLabel?: string;
    readonly snooze?: { readonly until: string };
    readonly updatedAt?: string;
  },
  showsLastUpdated: boolean,
  now: number = Date.now(),
): { readonly label: string; readonly title?: string } | undefined {
  if (thread.wakeLabel !== undefined) {
    return {
      label: thread.wakeLabel,
      ...(thread.snooze === undefined
        ? {}
        : { title: `Wakes ${new Date(thread.snooze.until).toLocaleString()}` }),
    };
  }
  if (!showsLastUpdated) return undefined;
  const label = threadRowShortAge(thread.updatedAt, now);
  if (label === undefined || thread.updatedAt === undefined) return undefined;
  // The tooltip and the spoken label carry the full moment, which the one
  // short word at the row's edge cannot.
  const title = `Updated ${new Date(thread.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
  return { label, title };
}

interface ThreadRowInfoCardProps {
  readonly actions: ThreadRowActions;
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}

interface LoadedThreadRowInfoCard {
  readonly default: ComponentType<ThreadRowInfoCardProps>;
}

/**
 * The card and its styles load on the first approach to a row, not with the
 * window: a row is drawn at startup, its card only when someone asks for it.
 * A card that cannot load (a tab left open across an update asks for a file
 * the host no longer has) names the thread instead: thrown out of render, the
 * failure would take the whole window down for a hover.
 *
 * Awaited in a try rather than given a rejection handler: the window build
 * moves a `.then` on an import inside its own stylesheet wait, where the
 * handler never sees a stylesheet that failed.
 */
async function importThreadRowInfoCard(): Promise<LoadedThreadRowInfoCard> {
  try {
    const module = await import("./ThreadRowInfoCard");
    return { default: module.ThreadRowInfoCard };
  } catch {
    return { default: ({ thread }) => <span>{thread.title}</span> };
  }
}

// Shared by the approach and the card: a second import would not wait for a
// stylesheet the first is still loading, and would draw the card unstyled.
let threadRowInfoCard: Promise<LoadedThreadRowInfoCard> | undefined;
const loadThreadRowInfoCard = () => (threadRowInfoCard ??= importThreadRowInfoCard());
const ThreadRowInfoCard = lazy(loadThreadRowInfoCard);

/**
 * Wraps a row trigger so the info card appears after a short delay on hover or
 * keyboard focus. The popup is rendered in a portal so it is never clipped by
 * the sidebar, and it is a preview card rather than a tooltip because the
 * pull-request references inside it are controls the pointer has to reach.
 */
export function ThreadRowInfoPopup(props: {
  readonly actions: ThreadRowActions;
  readonly children: ReactElement;
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}) {
  return (
    <OctantPreviewCard
      align="start"
      besideSidebar
      delay={400}
      content={
        <Suspense fallback={null}>
          <ThreadRowInfoCard
            actions={props.actions}
            {...(props.lineageParentTitle === undefined
              ? {}
              : { lineageParentTitle: props.lineageParentTitle })}
            projectName={props.projectName}
            thread={props.thread}
          />
        </Suspense>
      }
      label="Thread details"
      onApproach={() => void loadThreadRowInfoCard()}
      side="right"
    >
      {props.children}
    </OctantPreviewCard>
  );
}

/**
 * The stable trailing action gutter for a thread row. Renders inline Pin/Unpin
 * and Archive buttons when the caller provides callbacks, plus an overflow menu
 * that carries the same actions for coarse pointers or narrow viewports.
 */
export function ThreadRowActionsGutter(props: {
  readonly actions: ThreadRowActions;
  readonly thread: ChatThreadNavigationItem;
}) {
  const threadId = props.thread.navigationId ?? props.thread.threadId;
  const pinned = props.thread.pinned === true;
  const pinLabel = pinned ? "Unpin thread" : "Pin thread";
  // The gutter's second button settles or un-settles the thread, the action a
  // finished row most often wants; Archive moves to the menus for such rows,
  // since the slot holds two buttons and a third would cut every title short.
  const settled = props.thread.completedAt !== undefined;
  // The overflow menu is flat, so it lists only the first few pull requests;
  // the right-click menu and the hover card reach the rest.
  const pullRequestDestinations = threadRowPullRequestDestinations(
    props.thread,
    props.actions,
    THREAD_ROW_MENU_INLINE_PULL_REQUESTS,
  );
  // The overflow menu is flat, so each wake time is its own row here; the
  // right-click menu folds the same times under one Snooze item.
  const snoozePresets =
    props.actions.onSnoozeThread === undefined || props.thread.snooze !== undefined
      ? []
      : resolveSnoozePresets(new Date());
  const overflowItems: ReadonlyArray<OctantMenuItem> = [
    ...(props.actions.onPinThread === undefined
      ? []
      : [
          {
            icon: pinned ? (
              <PinOff aria-hidden="true" size={14} />
            ) : (
              <Pin aria-hidden="true" size={14} />
            ),
            label: pinLabel,
            value: "pin",
          } as const,
        ]),
    ...(props.actions.onArchiveThread === undefined
      ? []
      : [
          {
            destructive: true,
            icon: <Archive aria-hidden="true" size={14} />,
            label: "Archive thread",
            value: "archive",
          } as const,
        ]),
    ...(props.thread.markedDone === true || props.actions.onMarkThreadDone === undefined
      ? []
      : [
          {
            icon: <CircleCheck aria-hidden="true" size={14} />,
            label: "Mark thread done",
            value: "mark-done",
          } as const,
        ]),
    ...(props.thread.completedAt !== undefined || props.thread.markedDone === true
      ? props.actions.onReopenThread === undefined
        ? []
        : [
            {
              icon: <RotateCcw aria-hidden="true" size={14} />,
              label: "Un-settle thread",
              value: "reopen",
            } as const,
          ]
      : props.actions.onCompleteThread === undefined
        ? []
        : [
            {
              icon: <Check aria-hidden="true" size={14} />,
              label: "Settle thread",
              value: "complete",
            } as const,
          ]),
    ...(props.thread.snooze !== undefined
      ? props.actions.onWakeThread === undefined
        ? []
        : [
            {
              icon: <BellRing aria-hidden="true" size={14} />,
              label: "Wake thread",
              value: "wake",
            } as const,
          ]
      : props.actions.onSnoozeThread === undefined
        ? []
        : snoozePresets.map((preset) => ({
            description: preset.whenLabel,
            icon: <Clock aria-hidden="true" size={14} />,
            label: `Snooze · ${preset.label}`,
            value: `snooze:${preset.id}`,
          }))),
    ...pullRequestDestinations.map((destination) => ({
      icon: <GitPullRequest aria-hidden="true" size={14} />,
      label: destination.label,
      value: destination.key,
    })),
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
          variant="bare"
        >
          {pinned ? <PinOff aria-hidden="true" size={14} /> : <Pin aria-hidden="true" size={14} />}
        </OctantIconButton>
      )}
      {settled && props.actions.onReopenThread !== undefined ? (
        <OctantIconButton
          className="sidebar-navigation__thread-action sidebar-navigation__thread-action--inline"
          label="Un-settle thread"
          onClick={() => props.actions.onReopenThread?.(threadId)}
          title="Un-settle thread"
          type="button"
          variant="bare"
        >
          <Undo2 aria-hidden="true" size={14} />
        </OctantIconButton>
      ) : !settled && props.actions.onCompleteThread !== undefined ? (
        <OctantIconButton
          className="sidebar-navigation__thread-action sidebar-navigation__thread-action--inline"
          label="Settle thread"
          onClick={() => props.actions.onCompleteThread?.(threadId)}
          title="Settle thread"
          type="button"
          variant="bare"
        >
          <Check aria-hidden="true" size={14} />
        </OctantIconButton>
      ) : props.actions.onArchiveThread === undefined ? null : (
        <OctantIconButton
          className="sidebar-navigation__thread-action sidebar-navigation__thread-action--inline"
          label="Archive thread"
          onClick={() => props.actions.onArchiveThread?.(threadId)}
          title="Archive thread"
          type="button"
          variant="bare"
        >
          <Archive aria-hidden="true" size={14} />
        </OctantIconButton>
      )}
      {overflowItems.length === 0 ? null : (
        <OctantMenu
          items={overflowItems}
          onValueChange={(value) => {
            if (value === "pin") props.actions.onPinThread?.(threadId, !pinned);
            if (value === "archive") props.actions.onArchiveThread?.(threadId);
            if (value === "complete") props.actions.onCompleteThread?.(threadId);
            if (value === "reopen") props.actions.onReopenThread?.(threadId);
            if (value === "mark-done") props.actions.onMarkThreadDone?.(threadId);
            if (value === "wake") props.actions.onWakeThread?.(threadId);
            const preset = snoozePresets.find((candidate) => `snooze:${candidate.id}` === value);
            if (preset !== undefined) props.actions.onSnoozeThread?.(threadId, preset.until);
            pullRequestDestinations.find((destination) => destination.key === value)?.run();
          }}
          selectionMode="action"
          trigger={<MoreHorizontal aria-hidden="true" size={14} />}
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
export function hasInlineActions(actions: ThreadRowActions | undefined): boolean {
  if (actions === undefined) return false;
  return (
    actions.onPinThread !== undefined ||
    actions.onArchiveThread !== undefined ||
    actions.onCompleteThread !== undefined ||
    actions.onReopenThread !== undefined
  );
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
      trigger={<GitBranch aria-hidden="true" size={12} />}
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
  /** Every thread this window has open, so a split view marks all of them. */
  readonly openThreadIds?: ReadonlyArray<string>;
  /** Absent when the host cannot accept a rename, which hides the affordance. */
  readonly onRenameThread?: (threadId: string, title: string) => void;
  readonly onSelectThread: (threadId: string) => void;
  /** Resolves the Project name for the thread; used only by the hover info card. */
  readonly projectNameForThread?: (thread: ChatThreadNavigationItem) => string | undefined;
  /**
   * The threads fork and lineage marks resolve against. A list that shows only
   * part of a Project's threads passes them all, so a fork on another
   * checkout still finds its parent. Absent uses the rows themselves.
   */
  readonly lineageThreads?: ReadonlyArray<ChatThreadNavigationItem>;
  /**
   * Leaves the branch fact off every row. A checkout heading above the rows
   * already says it once, and repeating it on each row only adds a line.
   */
  readonly hideCheckoutFact?: boolean;
  /**
   * Whether a thread's row takes one more step in. A worker's row already sits
   * one step in, so a thread it started takes another.
   */
  readonly indents?: ((thread: ChatThreadNavigationItem) => boolean) | undefined;
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
  /**
   * Rows shown before the list folds behind Show more. Absent shows every
   * row. The active thread always stays visible, so folding never hides the
   * row the person is reading.
   */
  readonly collapsedLimit?: number;
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

// The right-click menu's items load with the first right-click rather than
// with the window.
const DeferredThreadRowMenu = lazy(() =>
  import("./ThreadRowMenuItems").then((module) => ({ default: module.ThreadRowMenu })),
);

interface ProjectThreadRowProps {
  readonly actions: ThreadRowActions;
  readonly activeThreadId?: string;
  /** Every thread this window has open, so a split view marks all of them. */
  readonly openThreadIds?: ReadonlyArray<string>;
  readonly hideCheckoutFact?: boolean;
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
  const tabs = useContext(SidebarThreadTabsContext);
  const followUpParent = useContext(FollowUpLineageContext).get(props.thread.threadId);
  const nestedUnderParent =
    followUpParent !== undefined &&
    props.lineageThreads.some((thread) => thread.threadId === followUpParent);
  const shows = useSidebarRowProperties();
  const now = useMinuteClock();
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
    tabs?.openAsPreview(props.thread.threadId);
    props.onSelectThread(rowId);
  }, [drag, props.onSelectThread, props.thread.threadId, rowId, tabs]);
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
        ...(props.thread.pinned === true ? { pinned: true } : {}),
        ...(props.thread.shelf === undefined ? {} : { shelf: props.thread.shelf }),
      });
    },
    [drag, props.thread, rowId],
  );

  const activity = threadRowActivity(props.thread);
  const unread = activity === "unread" || props.thread.unread === true;
  if (props.isRenaming) {
    return (
      <ThreadRenameField
        onCancel={props.onCancelRename}
        onRename={onRename}
        title={props.thread.title}
      />
    );
  }
  const rowPullRequest = shows.pullRequest ? props.thread.pullRequests?.items[0] : undefined;
  const morePullRequests = morePullRequestsThanTheFirst(props.thread.pullRequests);
  const rowCounts = shows.pullRequest ? threadRowCounts(props.thread) : NO_THREAD_ROW_COUNTS;
  const rowCheckout =
    shows.branch && props.hideCheckoutFact !== true ? props.thread.checkoutChip : undefined;
  // A snoozed row says when it comes back, not when it was last touched; a row
  // whose snooze ended says so until it is opened, because it reappears where
  // it was rather than at the top. Hiding Last updated hides the timestamp,
  // never the wake time: a rested thread that never says when it returns reads
  // as one that is simply gone.
  const rowAge = threadRowAgeFact(props.thread, shows.lastUpdated, now);
  const rowState = shows.status
    ? threadRowState({
        activity,
        unread,
        woke: props.thread.woke === true,
        followUp: props.thread.followUp === true,
        startedAt: props.thread.turnStartedAt,
        waitingSince: props.thread.waitingSince,
        awaitingKind: props.thread.awaitingKind,
        limited: props.thread.limited,
        shelf: props.thread.shelf,
        now,
      })
    : NO_THREAD_ROW_STATE;
  const row = (
    <OctantButton
      aria-current={props.activeThreadId === rowId ? "page" : undefined}
      aria-label={sidebarThreadRowLabel({
        title: props.thread.title,
        ...(rowCheckout === undefined ? {} : { branch: rowCheckout.label }),
        ...(rowPullRequest === undefined ? {} : { pullRequest: rowPullRequest, morePullRequests }),
        ...rowCounts,
        ...(rowState.label === undefined ? {} : { state: rowState.label }),
        ...(rowAge === undefined ? {} : { age: rowAge.title ?? rowAge.label }),
      })}
      className="sidebar-navigation__thread project-threads__thread justify-start"
      /* Open is not the same as focused. With several panes showing several
         threads, marking only the focused row misstates what the window
         holds, so every open thread carries a quiet mark and the focused one
         keeps the stronger current-page treatment on top of it. */
      data-open={
        props.openThreadIds?.some((candidate) => candidate === rowId) === true ? "true" : undefined
      }
      data-follow-up={
        props.thread.followUp === undefined ? undefined : props.thread.followUp ? "true" : "false"
      }
      data-nested-task={nestedUnderParent ? "true" : undefined}
      data-pinned={props.thread.pinned === true ? "true" : undefined}
      data-shelf={props.thread.shelf}
      data-thread-id={props.thread.threadId}
      data-unread={
        props.thread.unread === undefined ? undefined : props.thread.unread ? "true" : "false"
      }
      onClick={onSelect}
      onDoubleClick={() => tabs?.keep(props.thread.threadId)}
      {...threadRowFileDrop(
        () => {
          tabs?.openAsPreview(props.thread.threadId);
          props.onSelectThread(rowId);
        },
        drag === null ? undefined : (files) => drag.offerFiles(props.thread.threadId, files),
      )}
      {...(drag === null
        ? {}
        : {
            onPointerCancel: drag.onPointerCancel,
            onPointerDown,
            onPointerMove: drag.onPointerMove,
            onPointerUp: drag.onPointerUp,
          })}
      type="button"
      variant="bare"
    >
      <SidebarThreadRowContent
        {...(rowAge === undefined || rowState.state !== undefined ? {} : { age: rowAge })}
        {...(rowCheckout === undefined ? {} : { checkout: rowCheckout })}
        {...(props.thread.coordinator === true ? { coordinator: true } : {})}
        {...(props.thread.coordinatorTitle === undefined
          ? {}
          : { workerOf: props.thread.coordinatorTitle })}
        {...(props.thread.provider === undefined ? {} : { provider: props.thread.provider })}
        {...(rowPullRequest === undefined ? {} : { pullRequest: rowPullRequest, morePullRequests })}
        {...rowCounts}
        {...(rowState.state === undefined ? {} : { state: rowState.state })}
        threadId={props.thread.threadId}
        unread={rowState.unread}
        title={props.thread.title}
      />
    </OctantButton>
  );
  const wrappedRow = (
    <ThreadRowInfoPopup
      actions={props.actions}
      {...(parentTitle === undefined ? {} : { lineageParentTitle: parentTitle })}
      projectName={projectName}
      thread={props.thread}
    >
      {row}
    </ThreadRowInfoPopup>
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
  const [showingAll, setShowingAll] = useState(false);
  const folded =
    props.collapsedLimit !== undefined &&
    !showingAll &&
    props.threads.length > props.collapsedLimit;
  const threads = useMemo(() => {
    if (!folded || props.collapsedLimit === undefined) return props.threads;
    const shown = props.threads.slice(0, props.collapsedLimit);
    const active = props.threads.find(
      (thread) => (thread.navigationId ?? thread.threadId) === props.activeThreadId,
    );
    return active !== undefined && !shown.includes(active) ? [...shown, active] : shown;
  }, [folded, props.activeThreadId, props.collapsedLimit, props.threads]);
  const foldedCount = props.threads.length - threads.length;
  const virtualized = threads.length > THREAD_VIRTUALIZATION_THRESHOLD;
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualizer = useVirtualizer({
    count: virtualized ? threads.length : 0,
    estimateSize: () => THREAD_ROW_ESTIMATE,
    useAnimationFrameWithResizeObserver: true,
    getItemKey: (index) => {
      const thread = threads[index];
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
        const index = threads.findIndex(
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
  }, [threads.length, virtualized]);

  const row = (thread: ChatThreadNavigationItem) => {
    if (props.indents?.(thread) !== true) return threadRow(thread);
    // Set here, not in the sidebar's stylesheet: that loads before first paint
    // and has no room under its budget.
    return (
      <div
        key={thread.navigationId ?? thread.threadId}
        style={{ marginInlineStart: "var(--oct-space-3)" }}
      >
        {threadRow(thread)}
      </div>
    );
  };
  const threadRow = (thread: ChatThreadNavigationItem) => (
    <ProjectThreadRow
      actions={actions}
      {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
      {...(props.openThreadIds === undefined ? {} : { openThreadIds: props.openThreadIds })}
      isRenaming={renameable && (thread.navigationId ?? thread.threadId) === renamingThreadId}
      onCancelRename={onCancelRename}
      {...(props.onRenameThread === undefined ? {} : { onRenameThread: props.onRenameThread })}
      onSelectThread={props.onSelectThread}
      lineageThreads={props.lineageThreads ?? props.threads}
      {...(props.hideCheckoutFact === true ? { hideCheckoutFact: true } : {})}
      {...(props.projectNameForThread === undefined
        ? {}
        : { projectNameForThread: props.projectNameForThread })}
      key={thread.navigationId ?? thread.threadId}
      thread={thread}
    />
  );

  // Show more folds a long list behind one quiet row; Show less folds it back.
  const fold =
    props.collapsedLimit === undefined || props.threads.length <= props.collapsedLimit ? null : (
      <OctantButton
        aria-expanded={!folded}
        className="project-threads__more justify-start window-no-drag"
        onClick={() => setShowingAll((current) => !current)}
        type="button"
        variant="bare"
      >
        {folded ? `Show more (${String(foldedCount)})` : "Show less"}
      </OctantButton>
    );
  if (!virtualized) {
    return (
      <>
        {threads.map((thread) => row(thread))}
        {fold}
      </>
    );
  }
  // The fold sits outside the measured list on this branch too: expanding a
  // long list is what turns virtualization on, so leaving it to the unmeasured
  // branch alone takes Show less away exactly when it is needed.
  return (
    <>
      <div
        className="project-threads__virtual-list"
        ref={listRef}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const thread = threads[virtualItem.index];
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
      {fold}
    </>
  );
}

export function ThreadRowContextMenu(props: {
  readonly actions: ThreadRowActions;
  readonly inlineActions: boolean;
  readonly leading?: ReactNode;
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly row: ReactElement;
  readonly thread: ChatThreadNavigationItem;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  // The items load when the menu first opens and stay drawn after, so the
  // menu's close animation runs as it always has.
  const [wanted, setWanted] = useState(false);
  // Each opening, so a menu that failed to load says so again when reopened.
  const [asked, setAsked] = useState(0);
  return (
    <div className={["sidebar-navigation__thread-row", props.className].filter(Boolean).join(" ")}>
      {props.leading}
      <OctantContextMenuRoot
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setWanted(true);
            setAsked((count) => count + 1);
          }
        }}
      >
        <ThreadRowInfoPopup
          actions={props.actions}
          {...(props.lineageParentTitle === undefined
            ? {}
            : { lineageParentTitle: props.lineageParentTitle })}
          projectName={props.projectName}
          thread={props.thread}
        >
          <OctantContextMenuTrigger aria-expanded={open} aria-haspopup="menu" render={props.row} />
        </ThreadRowInfoPopup>
        {props.inlineActions ? (
          <ThreadRowActionsGutter actions={props.actions} thread={props.thread} />
        ) : null}
        {wanted ? (
          <LazyPartBoundary asked={asked} what="this thread's menu">
            <Suspense fallback={null}>
              <DeferredThreadRowMenu
                actions={props.actions}
                {...(threadCoordinatorMenuOffers(props.thread, props.actions)
                  ? {
                      coordinatorItems: (
                        <ThreadCoordinatorMenuItems actions={props.actions} thread={props.thread} />
                      ),
                    }
                  : {})}
                thread={props.thread}
              />
            </Suspense>
          </LazyPartBoundary>
        ) : null}
      </OctantContextMenuRoot>
    </div>
  );
}

export interface ProjectThreadListProps {
  /** Rows shown before the list folds behind Show more; absent shows every row. */
  readonly collapsedLimit?: number;
  readonly actions?: ThreadRowActions;
  readonly activeThreadId?: string;
  /** Every thread this window has open, so a split view marks all of them. */
  readonly openThreadIds?: ReadonlyArray<string>;
  readonly onRenameThread?: (threadId: string, title: string) => void;
  /**
   * Nests the rows under the checkout they run in, when the list has threads in
   * two or more. The Project tree opts in; a flat list of one Project's threads
   * elsewhere has no use for the extra level.
   */
  readonly groupByCheckout?: boolean;
  /**
   * Lists the Project's coordinators first, each with its open workers folded
   * beneath it, and leaves those workers out of the rows below. The sidebar's
   * Project tree opts in (docs/design/workspace.md#coordinators).
   */
  readonly groupCoordinators?: boolean;
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
  // A thread started from a suggested task sits under the thread that
  // suggested it; grouping by checkout happens on the rest, so a worktree
  // child stays under its primary-checkout parent.
  const followUpParents = useContext(FollowUpLineageContext);
  // Nesting runs on the whole list first: a coordinator's or worker's
  // follow-up child must not be left at the top level just because the
  // coordinator split removed its parent before nesting saw it.
  const nesting = useMemo(() => {
    if (!props.groupCoordinators) return nestFollowUpThreads(props.threads, followUpParents);
    const parents = new Map(followUpParents);
    // A thread can become a coordinator after it started as a follow-up.
    // Its section and its managed workers take precedence over that origin.
    for (const { coordinator, workers } of groupCoordinatorThreads(props.threads).coordinators) {
      parents.delete(coordinator.threadId);
      for (const worker of workers) parents.delete(worker.threadId);
    }
    return nestFollowUpThreads(props.threads, parents);
  }, [props.groupCoordinators, props.threads, followUpParents]);
  const coordinatorSplit = useMemo(
    () =>
      props.groupCoordinators === true
        ? groupCoordinatorThreads(nesting.topLevel)
        : { coordinators: [], others: nesting.topLevel },
    [props.groupCoordinators, nesting.topLevel],
  );
  const groups =
    props.groupByCheckout === true ? groupThreadsByCheckout(coordinatorSplit.others) : undefined;
  const rows = (threads: ReadonlyArray<ChatThreadNavigationItem>, grouped: boolean) => (
    <ProjectThreadRows
      {...(props.actions === undefined ? {} : { actions: props.actions })}
      {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
      {...(props.openThreadIds === undefined ? {} : { openThreadIds: props.openThreadIds })}
      {...(props.onRenameThread === undefined ? {} : { onRenameThread: props.onRenameThread })}
      onSelectThread={props.onSelectThread}
      {...(props.projectNameForThread === undefined
        ? {}
        : { projectNameForThread: props.projectNameForThread })}
      {...(props.collapsedLimit === undefined ? {} : { collapsedLimit: props.collapsedLimit })}
      {...(grouped ? { hideCheckoutFact: true, lineageThreads: props.threads } : {})}
      threads={threads}
    />
  );
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
      {coordinatorSplit.coordinators.length === 0 ? null : (
        <CoordinatorThreadSection
          {...(props.actions === undefined ? {} : { actions: props.actions })}
          {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
          {...(props.openThreadIds === undefined ? {} : { openThreadIds: props.openThreadIds })}
          {...(props.onRenameThread === undefined ? {} : { onRenameThread: props.onRenameThread })}
          {...(props.projectNameForThread === undefined
            ? {}
            : { projectNameForThread: props.projectNameForThread })}
          groups={coordinatorSplit.coordinators}
          expandThreads={nesting.expand}
          lineageThreads={props.threads}
          onSelectThread={props.onSelectThread}
        />
      )}
      {coordinatorSplit.others.length > 0 ? (
        groups === undefined ? (
          rows(nesting.expand(coordinatorSplit.others), false)
        ) : (
          groups.map((group) => (
            <ProjectCheckoutGroup group={group} key={group.key}>
              {rows(nesting.expand(group.threads), true)}
            </ProjectCheckoutGroup>
          ))
        )
      ) : props.threads.length === 0 && status === "ready" && props.emptyMessage !== undefined ? (
        <p className="project-threads__empty">{props.emptyMessage}</p>
      ) : null}
    </div>
  );
}

/**
 * A Project's coordinators, above its other threads. Each coordinator row has a
 * fold button that shows or hides its open workers beneath it; folded, the row
 * says how many of them are working and how many need input, so folding never
 * hides a request. The window remembers each fold for the session.
 */
function CoordinatorThreadSection(props: {
  readonly actions?: ThreadRowActions;
  readonly activeThreadId?: string;
  readonly openThreadIds?: ReadonlyArray<string>;
  readonly onRenameThread?: (threadId: string, title: string) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly projectNameForThread?: (thread: ChatThreadNavigationItem) => string | undefined;
  readonly groups: ReadonlyArray<CoordinatorThreadGroup>;
  /** Re-attaches each listed thread's nested follow-up children, depth first. */
  readonly expandThreads: (
    list: ReadonlyArray<ChatThreadNavigationItem>,
  ) => ReadonlyArray<ChatThreadNavigationItem>;
  readonly lineageThreads: ReadonlyArray<ChatThreadNavigationItem>;
}) {
  const [folded, setFolded] = useState(() => readFoldedCoordinators());
  const workersId = useId();
  function toggle(coordinatorId: string) {
    const next = new Set(folded);
    if (next.has(coordinatorId)) next.delete(coordinatorId);
    else next.add(coordinatorId);
    setFolded(next);
    writeFoldedCoordinators(next);
  }
  const rows = (
    threads: ReadonlyArray<ChatThreadNavigationItem>,
    indents?: (thread: ChatThreadNavigationItem) => boolean,
  ) => (
    <ProjectThreadRows
      {...(props.actions === undefined ? {} : { actions: props.actions })}
      {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
      indents={indents}
      {...(props.openThreadIds === undefined ? {} : { openThreadIds: props.openThreadIds })}
      {...(props.onRenameThread === undefined ? {} : { onRenameThread: props.onRenameThread })}
      {...(props.projectNameForThread === undefined
        ? {}
        : { projectNameForThread: props.projectNameForThread })}
      lineageThreads={props.lineageThreads}
      onSelectThread={props.onSelectThread}
      threads={threads}
    />
  );
  return (
    <div aria-label="Coordinators" className="project-coordinators" role="group">
      <div aria-hidden="true" className="project-coordinators__heading">
        Coordinators
      </div>
      {props.groups.map((group) => {
        const coordinatorId = group.coordinator.threadId;
        const open = !folded.has(coordinatorId);
        const listId = `${workersId}-${coordinatorId}`;
        const hasWorkers = group.workers.length > 0;
        // The coordinator's own follow-up children sit between its row and
        // its counted workers; a worker's children ride inside the worker
        // rows. Neither is a managed worker, so the counts stay workers-only.
        const childRows = props.expandThreads([group.coordinator]).slice(1);
        const workerRows = props.expandThreads(group.workers);
        const hasRows = hasWorkers || childRows.length > 0;
        // Workers the Show workers setting leaves out of the list: the row
        // keeps saying how many are working and how many need you, always.
        const hidden = group.coordinator.hiddenWorkers;
        return (
          <div
            className="project-coordinator"
            key={group.coordinator.navigationId ?? coordinatorId}
          >
            <div className="project-coordinator__row" data-open={open ? "true" : "false"}>
              <OctantIconButton
                aria-controls={open && hasRows ? listId : undefined}
                aria-expanded={open}
                className="project-coordinator__fold window-no-drag"
                disabled={!hasRows}
                label={
                  hasRows
                    ? hasWorkers
                      ? `${open ? "Hide" : "Show"} workers of ${group.coordinator.title}`
                      : `${open ? "Hide" : "Show"} threads of ${group.coordinator.title}`
                    : hidden !== undefined
                      ? `Workers of ${group.coordinator.title} are in its thread`
                      : `${group.coordinator.title} has no open workers`
                }
                onClick={() => toggle(coordinatorId)}
                type="button"
                variant="bare"
              >
                <ChevronRight aria-hidden="true" size={12} />
              </OctantIconButton>
              <div className="project-coordinator__thread">{rows([group.coordinator])}</div>
              {open && hidden === undefined ? null : (
                <CoordinatorWorkerCounts
                  coordinatorTitle={group.coordinator.title}
                  {...(hidden === undefined ? {} : { hidden })}
                  workers={group.workers}
                />
              )}
            </div>
            {open && hasRows ? (
              <div className="project-coordinator__workers" id={listId}>
                {rows(childRows)}
                {rows(workerRows, (thread) => !group.workers.includes(thread))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * What a folded coordinator says about its workers: how many are working and
 * how many need input, read through the sidebar status policy's facts so the
 * counts match the marks the worker rows wear once unfolded. It obeys the
 * Status row property, as a folded Project's roll-up does.
 */
export function CoordinatorWorkerCounts(props: {
  readonly coordinatorTitle: string;
  readonly workers: ReadonlyArray<ChatThreadNavigationItem>;
  /** Workers the list leaves out, already counted. */
  readonly hidden?: { readonly working: number; readonly attention: number };
}) {
  const shows = useSidebarRowProperties();
  if (!shows.status) return null;
  const counts = {
    working: props.hidden?.working ?? 0,
    attention: props.hidden?.attention ?? 0,
  };
  for (const worker of props.workers) {
    const facts = threadRowStatusInput(worker);
    if (facts.working) counts.working += 1;
    if (facts.attention) counts.attention += 1;
  }
  const reported = (["attention", "working"] as const).filter((status) => counts[status] > 0);
  if (reported.length === 0) return null;
  const label = `${props.coordinatorTitle}: ${reported
    .map(
      (status) => `${String(counts[status])} ${SIDEBAR_THREAD_STATUS_LABEL[status].toLowerCase()}`,
    )
    .join(", ")}`;
  return (
    <span aria-label={label} className="project-coordinator__counts" role="img" title={label}>
      {reported.map((status) => {
        const Icon = sidebarThreadStatusIcon(status);
        return (
          <span className="project-coordinator__count" key={status}>
            <span
              aria-hidden="true"
              className="sidebar-navigation__thread-status"
              data-activity={status}
            >
              {Icon === undefined ? null : (
                <Icon aria-hidden="true" className="size-(--oct-icon-xs)" size={12} />
              )}
            </span>
            <span aria-hidden="true">{counts[status]}</span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * The checkout a run of threads belongs to: a heading that names the branch and
 * what kind of checkout it is, and the threads indented one step beneath it.
 *
 * The heading is inert. Nothing about a checkout is opened or changed from the
 * tree, so making it a button would add a tab stop that does nothing; the group
 * carries the same text as its accessible name instead.
 */
function ProjectCheckoutGroup(props: {
  readonly children: ReactNode;
  readonly group: CheckoutThreadGroup;
}) {
  const kind = props.group.kind === "primary" ? "Primary checkout" : "Worktree";
  return (
    <div
      aria-label={props.group.branch === undefined ? kind : `${kind}, ${props.group.branch}`}
      className="project-checkout"
      data-kind={props.group.kind}
      role="group"
    >
      <div aria-hidden="true" className="project-checkout__row">
        <span className="project-checkout__glyph">
          <GitBranch aria-hidden="true" size={12} />
        </span>
        {props.group.branch === undefined ? null : (
          <span className="project-checkout__branch" title={props.group.branch}>
            {props.group.branch}
          </span>
        )}
        <span className="project-checkout__kind">{kind}</span>
      </div>
      <div className="project-checkout__threads">{props.children}</div>
    </div>
  );
}

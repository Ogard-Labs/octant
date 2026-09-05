import { memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { ThreadBoardPullRequestSummaries } from "@octant/contracts";
import {
  Archive,
  Cpu,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitFork,
  GitPullRequest,
  MoreHorizontal,
  Pin,
  PinOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ChatThreadNavigationItem, ThreadRowActivity } from "../shell/navigationModel";
import { describePullRequestSummary } from "../threadBoard/ThreadBoardPullRequestSummaries";
import { githubPullRequestUrl } from "../threadBoard/githubPullRequestUrl";
import { pullRequestKey, threadRowPullRequestDestinations } from "./threadRowPullRequests";
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
 * The states worth naming at the top of the card, most actionable first. A row
 * can hold several at once, so each is its own marker rather than a joined
 * phrase.
 */
function threadRowStates(thread: ChatThreadNavigationItem): ReadonlyArray<string> {
  const states: string[] = [];
  if (thread.followUp === true) states.push("Follow-up");
  if (thread.unread === true) states.push("Unread");
  if (thread.pinned === true) states.push("Pinned");
  return states;
}

/**
 * Distance from now in the coarsest unit that still reads as true, so the
 * header carries recency without the reader parsing a date. Falls back to the
 * absolute date past a year, where "14mo ago" stops being useful.
 */
function threadRowAge(updatedAt: string | undefined): string | undefined {
  if (updatedAt === undefined) return undefined;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days}d ago`;
  return date.toLocaleDateString();
}

/** One icon-and-label line of the info card. */
interface ThreadRowFact {
  readonly icon: LucideIcon;
  readonly key: string;
  readonly label: string;
}

/**
 * Builds the card's fact rows from values already present in the navigation
 * item and Project context. It does not invent transcript detail, model names,
 * or turn counts; those are not in the row's contract.
 */
function threadRowFacts(props: {
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}): ReadonlyArray<ThreadRowFact> {
  const facts: ThreadRowFact[] = [];
  if (props.projectName !== undefined) {
    facts.push({ icon: FolderGit2, key: "project", label: props.projectName });
  }
  if (props.thread.checkoutChip !== undefined) {
    facts.push({ icon: GitBranch, key: "checkout", label: props.thread.checkoutChip.label });
  }
  if (props.thread.provider !== undefined) {
    facts.push({ icon: Cpu, key: "provider", label: props.thread.provider.displayName });
  }
  if (props.lineageParentTitle !== undefined) {
    facts.push({ icon: GitFork, key: "lineage", label: `Forked from ${props.lineageParentTitle}` });
  } else if (props.thread.lineageParentThreadId !== undefined) {
    facts.push({
      icon: GitFork,
      key: "lineage",
      label: "Forked from a thread no longer available",
    });
  }
  return facts;
}

/**
 * Compact references to the row's exact linked pull requests, inside the card.
 *
 * A click opens the pull request in Octant's Review dock; Cmd-click (Ctrl on
 * other platforms) and the trailing control go to github.com, so both
 * destinations stay one gesture apart. Without a Review route the reference
 * is plain text — a button that could open nothing would read as broken —
 * and without an external route neither the control nor the modifier is
 * offered. The facts come from the cached snapshot the row already carries;
 * nothing here asks GitHub for more.
 */
function ThreadRowPullRequests(props: {
  readonly actions: ThreadRowActions;
  readonly summaries: ThreadBoardPullRequestSummaries;
}) {
  const openInReview = props.actions.onOpenPullRequest;
  const openOnGithub = props.actions.onOpenPullRequestOnGithub;
  return (
    <span aria-label="Linked pull requests" className="thread-row-info-card__prs" role="group">
      {props.summaries.items.map((summary) => {
        const number = String(summary.identity.number);
        const repo = `${summary.identity.repositoryOwner}/${summary.identity.repositoryName}`;
        const meta = [repo, ...describePullRequestSummary(summary)].join(" · ");
        const externalUrl =
          openOnGithub === undefined ? undefined : githubPullRequestUrl(summary.identity);
        const reference = (
          <>
            <GitPullRequest aria-hidden="true" size={14} strokeWidth={1.7} />
            <span className="thread-row-info-card__pr-title">
              #{number} {summary.title}
            </span>
            <span className="thread-row-info-card__pr-meta">{meta}</span>
          </>
        );
        return (
          <span className="thread-row-info-card__pr" key={pullRequestKey(summary.identity)}>
            {openInReview === undefined ? (
              <span className="thread-row-info-card__pr-reference">{reference}</span>
            ) : (
              <OctantButton
                aria-label={`Open pull request #${number}: ${summary.title} · ${meta}`}
                className="thread-row-info-card__pr-reference thread-row-info-card__pr-open"
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey) {
                    if (externalUrl !== undefined) openOnGithub?.(summary.identity);
                    return;
                  }
                  openInReview(summary.identity);
                }}
                title={
                  externalUrl === undefined
                    ? "Opens in Review"
                    : "Opens in Review. Cmd-click opens on GitHub."
                }
                type="button"
                variant="ghost"
              >
                {reference}
              </OctantButton>
            )}
            {externalUrl === undefined ? null : (
              <OctantIconButton
                className="thread-row-info-card__pr-github"
                label={`Open #${number} on GitHub`}
                onClick={() => openOnGithub?.(summary.identity)}
                title={`Open #${number} on GitHub`}
                type="button"
              >
                <ExternalLink aria-hidden="true" size={14} strokeWidth={1.8} />
              </OctantIconButton>
            )}
          </span>
        );
      })}
      {props.summaries.hiddenCount === 0 ? null : (
        <span className="thread-row-info-card__pr-more">
          +{String(props.summaries.hiddenCount)} more
        </span>
      )}
    </span>
  );
}

/**
 * A delayed, non-modal summary of the facts the navigation row and its Project
 * context already carry, plus the row's exact linked pull requests.
 *
 * It reads on the ordinary raised surface rather than the inverted tooltip
 * ground: the card's own tokens paint `--oct-fg` text, which on the tooltip's
 * `--oct-fg` background rendered the title invisible and left the facts at a
 * grey that failed against near-black.
 */
function ThreadRowInfoCard(props: {
  readonly actions: ThreadRowActions;
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}) {
  const states = threadRowStates(props.thread);
  const age = threadRowAge(props.thread.updatedAt);
  const facts = threadRowFacts({
    ...(props.lineageParentTitle === undefined
      ? {}
      : { lineageParentTitle: props.lineageParentTitle }),
    projectName: props.projectName,
    thread: props.thread,
  });
  return (
    <span className="thread-row-info-card">
      {states.length === 0 && age === undefined ? null : (
        <span className="thread-row-info-card__header">
          <span className="thread-row-info-card__states">
            {states.map((state) => (
              <span className="thread-row-info-card__state" key={state}>
                {state}
              </span>
            ))}
          </span>
          {age === undefined ? null : <span className="thread-row-info-card__age">{age}</span>}
        </span>
      )}
      <span className="thread-row-info-card__title">{props.thread.title}</span>
      {facts.length === 0 ? null : (
        <span className="thread-row-info-card__facts">
          {facts.map((fact) => (
            <span className="thread-row-info-card__fact" key={fact.key}>
              <fact.icon aria-hidden="true" size={14} strokeWidth={1.7} />
              <span className="thread-row-info-card__fact-label">{fact.label}</span>
            </span>
          ))}
        </span>
      )}
      {props.thread.pullRequests === undefined ||
      (props.thread.pullRequests.items.length === 0 &&
        props.thread.pullRequests.hiddenCount === 0) ? null : (
        <ThreadRowPullRequests actions={props.actions} summaries={props.thread.pullRequests} />
      )}
    </span>
  );
}

/**
 * Wraps a row trigger so the info card appears after a short delay on hover or
 * keyboard focus. The popup is rendered in a portal so it is never clipped by
 * the sidebar, and it is a preview card rather than a tooltip because the
 * pull-request references inside it are controls the pointer has to reach.
 */
function ThreadRowInfoPopup(props: {
  readonly actions: ThreadRowActions;
  readonly children: ReactElement;
  readonly lineageParentTitle?: string;
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}) {
  return (
    <OctantPreviewCard
      align="start"
      content={
        <ThreadRowInfoCard
          actions={props.actions}
          {...(props.lineageParentTitle === undefined
            ? {}
            : { lineageParentTitle: props.lineageParentTitle })}
          projectName={props.projectName}
          thread={props.thread}
        />
      }
      label="Thread details"
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
function ThreadRowActionsGutter(props: {
  readonly actions: ThreadRowActions;
  readonly thread: ChatThreadNavigationItem;
}) {
  const threadId = props.thread.navigationId ?? props.thread.threadId;
  const pinned = props.thread.pinned === true;
  const pinLabel = pinned ? "Unpin thread" : "Pin thread";
  const pullRequestDestinations = threadRowPullRequestDestinations(props.thread, props.actions);
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
    ...pullRequestDestinations.map((destination) => ({
      icon: <GitPullRequest aria-hidden="true" size={14} strokeWidth={1.8} />,
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
            pullRequestDestinations.find((destination) => destination.key === value)?.run();
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
  /** Every thread this window has open, so a split view marks all of them. */
  readonly openThreadIds?: ReadonlyArray<string>;
  /** Absent when the host cannot accept a rename, which hides the affordance. */
  readonly onRenameThread?: (threadId: string, title: string) => void;
  readonly onSelectThread: (threadId: string) => void;
  /** Resolves the Project name for the thread; used only by the hover info card. */
  readonly projectNameForThread?: (thread: ChatThreadNavigationItem) => string | undefined;
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

interface ProjectThreadRowProps {
  readonly actions: ThreadRowActions;
  readonly activeThreadId?: string;
  /** Every thread this window has open, so a split view marks all of them. */
  readonly openThreadIds?: ReadonlyArray<string>;
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
  const activity = activityOf(props.thread);
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
  const row = (
    <OctantButton
      aria-current={props.activeThreadId === rowId ? "page" : undefined}
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
          colour alone: the label says the state in words. Unread is the
          one state that sits at the row's end instead, as a small dot,
          so a quiet list reads as titles with a mark on what is new. */}
      <ThreadStatusDot activity={activity === "unread" ? "idle" : activity} />
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
        {props.thread.checkoutChip === undefined ? null : (
          <span
            className="sidebar-navigation__thread-checkout"
            title={props.thread.checkoutChip.label}
          >
            <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
            <span className="sidebar-navigation__thread-checkout-label">
              {props.thread.checkoutChip.label}
            </span>
          </span>
        )}
      </span>
      {unread ? (
        <span
          aria-label={ACTIVITY_LABELS.unread}
          className="sidebar-navigation__thread-unread-dot"
          data-indicator="unread"
          role="img"
          title={ACTIVITY_LABELS.unread}
        />
      ) : null}
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

  const row = (thread: ChatThreadNavigationItem) => (
    <ProjectThreadRow
      actions={actions}
      {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
      {...(props.openThreadIds === undefined ? {} : { openThreadIds: props.openThreadIds })}
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

  // Show more folds a long list behind one quiet row; Show less folds it back.
  const fold =
    props.collapsedLimit === undefined || props.threads.length <= props.collapsedLimit ? null : (
      <OctantButton
        aria-expanded={!folded}
        className="project-threads__more justify-start window-no-drag"
        onClick={() => setShowingAll((current) => !current)}
        type="button"
        variant="ghost"
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
        <ThreadRowMenu actions={props.actions} thread={props.thread} />
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
          {...(props.openThreadIds === undefined ? {} : { openThreadIds: props.openThreadIds })}
          {...(props.onRenameThread === undefined ? {} : { onRenameThread: props.onRenameThread })}
          onSelectThread={props.onSelectThread}
          {...(props.projectNameForThread === undefined
            ? {}
            : { projectNameForThread: props.projectNameForThread })}
          {...(props.collapsedLimit === undefined ? {} : { collapsedLimit: props.collapsedLimit })}
          threads={props.threads}
        />
      ) : status === "ready" && props.emptyMessage !== undefined ? (
        <p className="project-threads__empty">{props.emptyMessage}</p>
      ) : null}
    </div>
  );
}

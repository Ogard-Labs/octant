import { useContext, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Archive, MoreHorizontal, Pin, PinOff } from "lucide-react";
import type { ChatThreadNavigationItem, ThreadRowActivity } from "../shell/navigationModel";
import { SidebarThreadDragContext } from "../shell/useWorkspaceTabDrag";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { ThreadRenameField } from "./ThreadRenameField";
import { type ThreadRowActions, ThreadRowMenu, threadRowMenuIsEmpty } from "./ThreadRowMenu";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantContextMenuRoot, OctantContextMenuTrigger } from "../ui/base/OctantContextMenu";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";
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
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}): string {
  const facts: string[] = [];
  if (props.thread.pinned === true) facts.push("Pinned");
  if (props.thread.unread === true) facts.push("Unread");
  if (props.thread.followUp === true) facts.push("Follow-up");
  if (props.thread.provider !== undefined) facts.push(props.thread.provider.displayName);
  if (props.projectName !== undefined) facts.push(props.projectName);
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
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}) {
  return (
    <span className="thread-row-info-card">
      <span className="thread-row-info-card__title">{props.thread.title}</span>
      <span className="thread-row-info-card__facts">
        {threadRowFacts({ projectName: props.projectName, thread: props.thread })}
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
  readonly projectName: string | undefined;
  readonly thread: ChatThreadNavigationItem;
}) {
  return (
    <OctantTooltip
      label={<ThreadRowInfoCard projectName={props.projectName} thread={props.thread} />}
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
  // The workspace's surface drag, when a workspace is present to drop into.
  // A completed drag ends over a pane, yet the pointer began on this row, so
  // the click that follows it must not also open the thread.
  const drag = useContext(SidebarThreadDragContext);
  const renameable = props.onRenameThread !== undefined;
  const actions: ThreadRowActions = {
    ...props.actions,
    ...(renameable ? { onStartRenameThread: setRenamingThreadId } : {}),
  };
  const hasMenu = !threadRowMenuIsEmpty(actions);
  const inlineActions = hasInlineActions(actions);
  return (
    <>
      {props.threads.map((thread) => {
        const rowId = thread.navigationId ?? thread.threadId;
        const projectName = props.projectNameForThread?.(thread);
        if (renameable && renamingThreadId === rowId) {
          return (
            <ThreadRenameField
              key={rowId}
              onCancel={() => setRenamingThreadId(undefined)}
              onRename={(title) => {
                setRenamingThreadId(undefined);
                props.onRenameThread?.(rowId, title);
              }}
              title={thread.title}
            />
          );
        }
        const row = (
          <OctantButton
            aria-current={props.activeThreadId === rowId ? "page" : undefined}
            className="sidebar-navigation__thread project-threads__thread justify-start"
            data-follow-up={
              thread.followUp === undefined ? undefined : thread.followUp ? "true" : "false"
            }
            data-pinned={thread.pinned === true ? "true" : undefined}
            data-thread-id={thread.threadId}
            data-unread={thread.unread === undefined ? undefined : thread.unread ? "true" : "false"}
            onClick={() => {
              if (drag?.consumeThreadClickSuppression(rowId) === true) return;
              props.onSelectThread(rowId);
            }}
            {...(drag === null
              ? {}
              : {
                  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) =>
                    drag.beginThreadDrag(event, {
                      rowId,
                      threadId: thread.threadId,
                      title: thread.title,
                      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
                    }),
                  onPointerMove: drag.onPointerMove,
                  onPointerUp: drag.onPointerUp,
                  onPointerCancel: drag.onPointerCancel,
                })}
            type="button"
            variant="ghost"
          >
            {/* The dot leads the row from a gutter every row reserves, so a
                busy and an idle title start on the same edge. It is never
                colour alone: the label says the state in words. */}
            <ThreadStatusDot activity={activityOf(thread)} />
            {thread.provider === undefined ? null : (
              <span
                className="sidebar-navigation__thread-provider"
                title={thread.provider.displayName}
              >
                <ProviderGlyph
                  displayName={thread.provider.displayName}
                  driverKind={thread.provider.driverKind}
                  size={14}
                />
              </span>
            )}
            <span className="sidebar-navigation__thread-copy">
              <span className="sidebar-navigation__thread-title">{thread.title}</span>
            </span>
          </OctantButton>
        );
        const wrappedRow = (
          <ThreadRowTooltip projectName={projectName} thread={thread}>
            {row}
          </ThreadRowTooltip>
        );
        if (!hasMenu) {
          return (
            <div key={rowId} className="sidebar-navigation__thread-row">
              {wrappedRow}
              {inlineActions ? <ThreadRowActionsGutter actions={actions} thread={thread} /> : null}
            </div>
          );
        }
        return (
          <ThreadRowContextMenu
            actions={actions}
            inlineActions={inlineActions}
            key={rowId}
            projectName={projectName}
            row={row}
            thread={thread}
          />
        );
      })}
    </>
  );
}

function ThreadRowContextMenu(props: {
  readonly actions: ThreadRowActions;
  readonly inlineActions: boolean;
  readonly projectName: string | undefined;
  readonly row: ReactElement;
  readonly thread: ChatThreadNavigationItem;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sidebar-navigation__thread-row">
      <OctantContextMenuRoot onOpenChange={setOpen}>
        <ThreadRowTooltip projectName={props.projectName} thread={props.thread}>
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

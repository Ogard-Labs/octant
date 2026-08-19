import { useState } from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import type { ChatThreadNavigationItem, ThreadRowActivity } from "../shell/navigationModel";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { ThreadRenameField } from "./ThreadRenameField";
import { type ThreadRowActions, ThreadRowMenu, threadRowMenuIsEmpty } from "./ThreadRowMenu";
import { OctantButton } from "../ui/base/OctantButton";

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

export interface ProjectThreadRowsProps {
  /** What the row offers on right-click. Absent leaves the rows without a menu. */
  readonly actions?: ThreadRowActions;
  readonly activeThreadId?: string;
  /** Absent when the host cannot accept a rename, which hides the affordance. */
  readonly onRenameThread?: (threadId: string, title: string) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
}

/**
 * One button per thread. Attention markers are never colour alone: the unread
 * mark is a dot glyph carrying its own label, the way the Recents rows already
 * mark one, so a reader who cannot see the colour still reads the state.
 *
 * The row ends with the provider's mark rather than the model name. Right-click
 * opens the row's own menu when the caller passed actions for it; renaming
 * happens in place, replacing the row with its field.
 */
export function ProjectThreadRows(props: ProjectThreadRowsProps) {
  const [renamingThreadId, setRenamingThreadId] = useState<string>();
  const renameable = props.onRenameThread !== undefined;
  const actions: ThreadRowActions = {
    ...props.actions,
    ...(renameable ? { onStartRenameThread: setRenamingThreadId } : {}),
  };
  const hasMenu = !threadRowMenuIsEmpty(actions);
  return (
    <>
      {props.threads.map((thread) => {
        const rowId = thread.navigationId ?? thread.threadId;
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
            onClick={() => props.onSelectThread(rowId)}
            type="button"
            variant="ghost"
          >
            {/* The dot leads the row from a gutter every row reserves, so a
                busy and an idle title start on the same edge. It is never
                colour alone: the label says the state in words. */}
            <ThreadStatusDot activity={activityOf(thread)} />
            <span className="sidebar-navigation__thread-copy">
              <span className="sidebar-navigation__thread-title">{thread.title}</span>
            </span>
            {thread.provider === undefined ? null : (
              <span
                className="sidebar-navigation__thread-provider"
                title={thread.provider.displayName}
              >
                <ProviderGlyph
                  displayName={thread.provider.displayName}
                  driverKind={thread.provider.driverKind}
                  size={15}
                />
              </span>
            )}
          </OctantButton>
        );
        if (!hasMenu) return <div key={rowId}>{row}</div>;
        return (
          <ContextMenuPrimitive.Root key={rowId}>
            <ContextMenuPrimitive.Trigger render={row} />
            <ThreadRowMenu actions={actions} thread={thread} />
          </ContextMenuPrimitive.Root>
        );
      })}
    </>
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
          threads={props.threads}
        />
      ) : status === "ready" && props.emptyMessage !== undefined ? (
        <p className="project-threads__empty">{props.emptyMessage}</p>
      ) : null}
    </div>
  );
}

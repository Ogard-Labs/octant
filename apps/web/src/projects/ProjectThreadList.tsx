import type { ChatThreadNavigationItem } from "../shell/navigationModel";
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

export interface ProjectThreadRowsProps {
  readonly activeThreadId?: string;
  readonly onSelectThread: (threadId: string) => void;
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
}

/** One button per thread. Attention markers carry text, never colour alone. */
export function ProjectThreadRows(props: ProjectThreadRowsProps) {
  return (
    <>
      {props.threads.map((thread) => (
        <OctantButton
          aria-current={
            props.activeThreadId === (thread.navigationId ?? thread.threadId) ? "page" : undefined
          }
          className="sidebar-navigation__thread project-threads__thread justify-start"
          data-follow-up={
            thread.followUp === undefined ? undefined : thread.followUp ? "true" : "false"
          }
          data-thread-id={thread.threadId}
          data-unread={thread.unread === undefined ? undefined : thread.unread ? "true" : "false"}
          key={thread.navigationId ?? thread.threadId}
          onClick={() => props.onSelectThread(thread.navigationId ?? thread.threadId)}
          type="button"
          variant="ghost"
        >
          <span className="sidebar-navigation__thread-copy">
            <span className="sidebar-navigation__thread-title">{thread.title}</span>
          </span>
          {thread.meta !== undefined ? (
            <span className="sidebar-navigation__thread-follow-up" data-indicator="meta">
              {thread.meta}
            </span>
          ) : null}
          {thread.unread ? (
            <span className="sidebar-navigation__thread-unread" data-indicator="unread">
              Unread
            </span>
          ) : null}
          {thread.followUp ? (
            <span className="sidebar-navigation__thread-follow-up" data-indicator="follow-up">
              Follow-up
            </span>
          ) : null}
        </OctantButton>
      ))}
    </>
  );
}

export interface ProjectThreadListProps {
  readonly activeThreadId?: string;
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
          {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
          onSelectThread={props.onSelectThread}
          threads={props.threads}
        />
      ) : status === "ready" && props.emptyMessage !== undefined ? (
        <p className="project-threads__empty">{props.emptyMessage}</p>
      ) : null}
    </div>
  );
}

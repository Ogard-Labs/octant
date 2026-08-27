import type { ProjectSummary } from "@octant/contracts/projects";
import { createContext, useContext, type ReactNode } from "react";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { orderThreadsByRecency, threadsInProject } from "./projectThreadGrouping";
import { ProjectThreadList, type ProjectThreadListStatus } from "./ProjectThreadList";

/**
 * The active mode's thread navigation, offered to whatever Project Overview the
 * workspace renders.
 *
 * The Overview sits several layers below the shell that owns thread navigation,
 * and the layers between it belong to other surfaces. Rather than thread props
 * through them, the shell publishes the same list and the same selection
 * handler the sidebar uses.
 */
export interface ProjectThreadsAccess {
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  /** The sidebar's own handler, so a row opens the thread the same way. */
  readonly onSelectThread: (navigationId: string) => void;
  readonly status: ProjectThreadListStatus;
  /** Every thread the mode navigates, unfiltered; this section groups it. */
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
}

const ProjectThreadsContext = createContext<ProjectThreadsAccess | undefined>(undefined);

export function ProjectThreadsProvider(props: {
  readonly children: ReactNode;
  readonly value: ProjectThreadsAccess;
}) {
  return (
    <ProjectThreadsContext.Provider value={props.value}>
      {props.children}
    </ProjectThreadsContext.Provider>
  );
}

/**
 * A Project's threads, newest activity first.
 *
 * "Recent activity" here is exactly the thread rows the app already holds,
 * ordered by the `updatedAt` the host reports, with the unread and follow-up
 * markers the navigation already carries. Nothing summarizes a thread's last
 * message, author, or turn count: the renderer has no such projection, and
 * inventing one would read as host truth. A richer feed would need the server
 * to project per-thread last-event detail into thread navigation.
 *
 * Renders nothing when no surface published thread navigation — a surface that
 * never offered threads must not claim this Project has none.
 */
export function ProjectThreadsSection(props: { readonly project: ProjectSummary }) {
  const access = useContext(ProjectThreadsContext);
  if (access === undefined) return null;
  const threads = orderThreadsByRecency(threadsInProject(access.threads, props.project.id));
  return (
    <section
      aria-label={`Threads and recent activity in ${props.project.name}`}
      className="project-overview__threads"
    >
      <header className="project-overview__threads-header">
        <h2>Threads and recent activity</h2>
        <p>Threads in this Project, most recently updated first.</p>
      </header>
      <ProjectThreadList
        emptyMessage="No threads in this Project yet."
        {...(access.errorMessage === undefined ? {} : { errorMessage: access.errorMessage })}
        {...(access.onRetry === undefined ? {} : { onRetry: access.onRetry })}
        onSelectThread={access.onSelectThread}
        projectNameForThread={() => props.project.name}
        status={access.status}
        threads={threads}
      />
    </section>
  );
}

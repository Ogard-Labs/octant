import { Network, SquarePen } from "lucide-react";
import type { ProjectId } from "@octant/contracts/projects";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { OctantButton } from "../ui/base/OctantButton";
import { ProjectThreadList, type ProjectThreadListProps } from "./ProjectThreadList";
import type { RemoteCodeProject } from "./sshRemoteProjectEntries";

/**
 * The Code sidebar's Projects on SSH targets, under the local ones. Each says
 * where it is (`destination:folder`) and whether its target is connected, as
 * the host last reported it, and lists its threads. Choosing a Project opens
 * a new thread's composer in it, which is what binds the window to it; the
 * host refuses that binding and every command a window may not make.
 */
export function RemoteProjectsSidebarGroup(props: {
  readonly projects: ReadonlyArray<RemoteCodeProject>;
  /** The Code threads of this window; only those in a listed Project appear here. */
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
  readonly activeProjectId?: ProjectId;
  readonly activeThreadId?: string;
  readonly openThreadIds?: ReadonlyArray<string>;
  readonly actions?: ProjectThreadListProps["actions"];
  readonly onOpenProject: (projectId: ProjectId) => void;
  readonly onSelectThread: (threadId: string) => void;
}) {
  if (props.projects.length === 0) return null;
  return (
    <section aria-label="On SSH targets" className="project-section remote-project-section">
      <div className="project-section__header sidebar-section">
        <h2>On SSH targets</h2>
      </div>
      {props.projects.map((project) => {
        const threads = props.threads.filter(
          (thread) =>
            thread.projectId !== undefined && thread.projectId === String(project.projectId),
        );
        const connection = connectionLabel(project);
        const active =
          props.activeProjectId !== undefined &&
          String(props.activeProjectId) === String(project.projectId) &&
          !threads.some(
            (thread) =>
              String(thread.navigationId ?? thread.threadId) === String(props.activeThreadId),
          );
        return (
          <div className="project-block" key={String(project.projectId)}>
            <div
              className="project-row"
              data-active={active ? "true" : "false"}
              data-folder-state={threads.length > 0 ? "open" : "closed"}
            >
              <OctantButton
                aria-label={`${project.name} on ${project.location}, ${connection}. New task`}
                className="project-row__select justify-start window-no-drag"
                onClick={() => props.onOpenProject(project.projectId)}
                title={`${project.location} · ${connection}`}
                type="button"
                variant="bare"
              >
                <Network aria-hidden="true" size={16} strokeWidth={1.5} />
                <span className="project-row__copy">
                  <span>
                    {project.name}
                    <span className="project-row__where">{` · ${project.location}`}</span>
                  </span>
                </span>
              </OctantButton>
              <span
                className="remote-project-section__connection"
                data-connected={project.target?.connection === "connected" ? "true" : "false"}
                title={connection}
              >
                <span className="sr-only">{connection}</span>
              </span>
              <OctantButton
                aria-label={`New task in ${project.name}`}
                className="project-row__action project-row__action--icon project-row__new-thread window-no-drag"
                onClick={() => props.onOpenProject(project.projectId)}
                size="icon-sm"
                title="New task"
                type="button"
                variant="ghost"
              >
                <SquarePen aria-hidden="true" size={14} strokeWidth={1.7} />
              </OctantButton>
            </div>
            {threads.length === 0 ? null : (
              <ProjectThreadList
                {...(props.actions === undefined ? {} : { actions: props.actions })}
                {...(props.activeThreadId === undefined
                  ? {}
                  : { activeThreadId: props.activeThreadId })}
                {...(props.openThreadIds === undefined
                  ? {}
                  : { openThreadIds: props.openThreadIds })}
                label={`Threads in ${project.name}`}
                onSelectThread={props.onSelectThread}
                projectNameForThread={() => project.name}
                threads={threads}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}

function connectionLabel(project: RemoteCodeProject): string {
  if (project.target === undefined) return "Target removed";
  return project.target.connection === "connected" ? "Connected" : "Not connected";
}

import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProjectSummary } from "@octant/contracts/projects";
import { ProjectMemoryInspector } from "./ProjectMemoryInspector";
import { useProjectMemory } from "./useProjectMemory";

export interface ProjectMemorySectionProps {
  readonly client: ProjectClient;
  readonly onChanged?: () => void;
  readonly project: ProjectSummary;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly readOnly?: boolean;
}

/**
 * The Overview home for Project memory. Each Overview instance owns the
 * Project it is showing, so a split with two Overviews cannot share one
 * in-flight view.
 */
export function ProjectMemorySection(props: ProjectMemorySectionProps) {
  const memory = useProjectMemory(props.client, props.onChanged);
  return (
    <section aria-label="Project memory" className="project-overview__memory">
      <ProjectMemoryInspector
        busy={memory.busy}
        embedded
        {...(memory.errorMessage === undefined ? {} : { errorMessage: memory.errorMessage })}
        {...(memory.memory === undefined ? {} : { memory: memory.memory })}
        onCreate={memory.create}
        onLoad={memory.load}
        onRetract={memory.retract}
        onRetry={memory.retry}
        onSupersede={memory.supersede}
        onTransfer={memory.transfer}
        project={props.project}
        projects={props.projects}
        {...(props.readOnly === undefined ? {} : { readOnly: props.readOnly })}
        status={memory.status}
      />
    </section>
  );
}

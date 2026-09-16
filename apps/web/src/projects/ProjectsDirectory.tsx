import type { ProjectAvailability, ProjectId, ProjectSummary } from "@octant/contracts/projects";
import { Folder, PanelLeftClose, Plus, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

type ProjectModeFilter = "all" | ProjectSummary["type"];

export interface ProjectsDirectoryProps {
  readonly availabilityByProject?: ReadonlyMap<ProjectId, ProjectAvailability>;
  readonly onAddProject?: () => void;
  readonly onDismiss?: () => void;
  readonly onOpenProject: (project: ProjectSummary) => void;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly selectedProjectId?: ProjectId;
}

const MODE_FILTERS: ReadonlyArray<{ readonly id: ProjectModeFilter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "chat", label: "Chat" },
  { id: "work", label: "Work" },
  { id: "code", label: "Code" },
];

export function ProjectsDirectory(props: ProjectsDirectoryProps) {
  const [mode, setMode] = useState<ProjectModeFilter>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const visibleProjects = props.projects.filter(
    (project) =>
      (mode === "all" || project.type === mode) &&
      (deferredQuery === "" || project.name.toLocaleLowerCase().includes(deferredQuery)),
  );

  return (
    <nav aria-label="Projects" className="projects-directory">
      <header className="projects-directory__header">
        <h1 className="oct-title">Projects</h1>
        {props.onAddProject === undefined && props.onDismiss === undefined ? null : (
          <div className="projects-directory__header-actions">
            {props.onAddProject === undefined ? null : (
              <OctantButton
                aria-label="Add Project"
                onClick={props.onAddProject}
                size="icon"
                title="Add Project"
                type="button"
                variant="ghost"
              >
                <Plus aria-hidden="true" size={16} strokeWidth={1.7} />
              </OctantButton>
            )}
            {props.onDismiss === undefined ? null : (
              <OctantButton
                aria-label="Close Projects"
                className="projects-directory__dismiss"
                onClick={props.onDismiss}
                size="icon"
                title="Close Projects"
                type="button"
                variant="ghost"
              >
                <PanelLeftClose aria-hidden="true" size={16} strokeWidth={1.7} />
              </OctantButton>
            )}
          </div>
        )}
      </header>
      <label className="projects-directory__search">
        <span className="sr-only">Search Projects</span>
        <Search aria-hidden="true" size={14} strokeWidth={1.6} />
        <OctantInput
          aria-label="Search Projects"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search Projects"
          type="search"
          value={query}
        />
      </label>
      <div aria-label="Project modes" className="projects-directory__modes" role="group">
        {MODE_FILTERS.map((filter) => (
          <OctantButton
            aria-pressed={mode === filter.id}
            key={filter.id}
            onClick={() => setMode(filter.id)}
            size="sm"
            type="button"
            variant={mode === filter.id ? "secondary" : "ghost"}
          >
            {filter.label}
          </OctantButton>
        ))}
      </div>
      <div className="projects-directory__list">
        {visibleProjects.length === 0 ? (
          <p className="projects-directory__empty" role="status">
            No Projects match this view.
          </p>
        ) : (
          visibleProjects.map((project) => {
            const selected = String(project.id) === String(props.selectedProjectId);
            const status = projectStatus(project, props.availabilityByProject?.get(project.id));
            return (
              <OctantButton
                aria-current={selected ? "page" : undefined}
                aria-label={`${project.name}, ${projectModeLabel(project.type)} Project, ${status}`}
                className="projects-directory__project justify-start"
                key={String(project.id)}
                onClick={() => props.onOpenProject(project)}
                type="button"
                variant={selected ? "secondary" : "ghost"}
              >
                <Folder aria-hidden="true" size={16} strokeWidth={1.6} />
                <span className="projects-directory__project-copy">
                  <span className="oct-row-label">{project.name}</span>
                  <span className="oct-meta">{projectModeLabel(project.type)}</span>
                </span>
                <span className="projects-directory__project-status" data-status={status}>
                  {status}
                </span>
              </OctantButton>
            );
          })
        )}
      </div>
    </nav>
  );
}

function projectModeLabel(type: ProjectSummary["type"]): string {
  return type === "chat" ? "Chat" : type === "work" ? "Work" : "Code";
}

function projectStatus(project: ProjectSummary, availability?: ProjectAvailability): string {
  if (project.lifecycle === "archived") return "Archived";
  if (project.type === "chat") return "Available";
  if (availability?.status === "unavailable") return "Relink required";
  if (availability?.status === "unverified") return "Unverified";
  return "Available";
}

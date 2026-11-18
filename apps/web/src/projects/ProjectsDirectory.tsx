import { OctantEmpty } from "../ui/base/OctantEmpty";
import type { ProjectAvailability, ProjectId, ProjectSummary } from "@octant/contracts/projects";
import { Folder, FolderPlus, PanelLeftClose, Plus, Search } from "../ui/icons";
import { useDeferredValue, useState } from "react";
import { Surface, SurfaceHeader } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { ProjectIcon } from "./ProjectIcon";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

type ProjectModeFilter = "all" | ProjectSummary["type"];

export interface ProjectsDirectoryProps {
  readonly availabilityByProject?: ReadonlyMap<ProjectId, ProjectAvailability>;
  /** Threads per Project, where the window knows them; a Project absent here shows no count. */
  readonly threadCountByProject?: ReadonlyMap<string, number>;
  readonly onAddProject?: () => void;
  /** Leaves the page for the workspace; the same ghost control every destination page offers. */
  readonly onBack?: () => void;
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
  const filtered = mode !== "all" || query.trim() !== "";
  const clearFilters = () => {
    setMode("all");
    setQuery("");
  };
  const actions =
    props.onAddProject === undefined && props.onDismiss === undefined ? undefined : (
      <>
        {props.onAddProject === undefined ? null : (
          <OctantButton onClick={props.onAddProject} size="sm" type="button" variant="secondary">
            <Plus aria-hidden="true" size={12} />
            Add Project
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
            <PanelLeftClose aria-hidden="true" size={16} />
          </OctantButton>
        )}
      </>
    );
  const emptyProps = filtered
    ? {
        title: "No Projects match this view",
        action: (
          <OctantButton onClick={clearFilters} size="sm" type="button" variant="outline">
            Clear filters
          </OctantButton>
        ),
      }
    : {
        title: "No Projects yet",
        detail: "Add a Project to see it here.",
        icon: <FolderPlus size={20} />,
        ...(props.onAddProject === undefined
          ? {}
          : {
              action: (
                <OctantButton
                  onClick={props.onAddProject}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Add Project
                </OctantButton>
              ),
            }),
      };

  return (
    <Surface ariaLabel="Projects" className="projects-directory" landmark="nav" measure="wide">
      <SurfaceHeader
        title="Projects"
        {...(actions === undefined ? {} : { actions })}
        {...(props.onBack === undefined ? {} : { onBack: props.onBack })}
      />
      <div className="surface-toolbar">
        <label className="surface-toolbar__search">
          <Search aria-hidden="true" size={14} />
          <span className="sr-only">Search Projects</span>
          <OctantInput
            aria-label="Search Projects"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Projects"
            type="search"
            value={query}
          />
        </label>
        <OctantToggleGroup<ProjectModeFilter>
          aria-label="Project modes"
          onValueChange={(value) => {
            const selected = value[0];
            if (selected !== undefined) setMode(selected);
          }}
          value={[mode]}
        >
          {MODE_FILTERS.map((filter) => (
            <OctantToggleGroupItem key={filter.id} value={filter.id}>
              {filter.label}
            </OctantToggleGroupItem>
          ))}
        </OctantToggleGroup>
      </div>
      {visibleProjects.length === 0 ? (
        <OctantEmpty layout="line" {...emptyProps} />
      ) : (
        <ul className="surface-list">
          {visibleProjects.map((project) => {
            const selected = String(project.id) === String(props.selectedProjectId);
            const status = projectStatus(project, props.availabilityByProject?.get(project.id));
            const count = props.threadCountByProject?.get(String(project.id));
            // A healthy Project shows how many threads it holds; only a state
            // that needs the person (archived, relink) is said in words.
            const trailing =
              status === "Available"
                ? count === undefined
                  ? undefined
                  : `${String(count)} ${count === 1 ? "thread" : "threads"}`
                : status;
            return (
              <li className="surface-row" key={String(project.id)}>
                <OctantButton
                  aria-current={selected ? "page" : undefined}
                  aria-label={`${project.name}, ${projectModeLabel(project.type)} Project, ${status}`}
                  className="projects-directory__row"
                  onClick={() => props.onOpenProject(project)}
                  type="button"
                  variant="ghost"
                >
                  <ProjectIcon
                    fallback={<Folder aria-hidden="true" size={16} />}
                    projectId={String(project.id)}
                    size={16}
                  />
                  <span className="surface-row__copy">
                    <span className="oct-row-label">{project.name}</span>
                    <span className="oct-meta">{projectModeLabel(project.type)}</span>
                  </span>
                  {trailing === undefined ? null : (
                    <span className="oct-meta projects-directory__status" data-status={status}>
                      {trailing}
                    </span>
                  )}
                </OctantButton>
              </li>
            );
          })}
        </ul>
      )}
    </Surface>
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

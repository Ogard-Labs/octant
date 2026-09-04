import type { ProjectAvailability, ProjectId, ProjectSummary } from "@octant/contracts/projects";
import type { ContextHealth } from "@octant/contracts/context";
import type { ProjectViewSwitcherPresentation } from "@octant/contracts/shell";
import {
  Box,
  Briefcase,
  Bug,
  Bell,
  Clock3,
  Code,
  Flag,
  Folder,
  FolderOpen,
  FolderGit,
  Layers,
  ListFilter,
  ListTree,
  MoreHorizontal,
  Plus,
  Rocket,
  Sparkles,
  SquarePen,
  Star,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { groupProjectsForView, sortProjectsForView } from "@octant/domain";
import { ContextHealthWarning } from "../context/ContextHealthWarning";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantContextMenu } from "../ui/base/OctantContextMenu";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantField, OctantFieldLabel } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import {
  OctantMenu,
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuSub,
  OctantMenuSubPopup,
  OctantMenuSubTrigger,
  OctantMenuTrigger,
  type OctantMenuItem,
} from "../ui/base/OctantMenu";
import {
  ALL_CODE_PROJECTS_VIEW_ID,
  ALL_CODE_PROJECTS_VIEW_NAME,
  CODE_PROJECT_VIEW_COLORS,
  CODE_PROJECT_VIEW_ICONS,
  DEFAULT_CODE_PROJECT_VIEW_COLOR,
  DEFAULT_CODE_PROJECT_VIEW_ICON,
  createCodeProjectView,
  createCodeProjectViewId,
  deleteCodeProjectView,
  filterProjectViewThreads,
  filterProjectsForView,
  normalizeProjectViewFilters,
  projectViewActivityRangeError,
  projectViewFiltersFor,
  readProjectViewPreferences,
  readProjectViewState,
  selectCodeProjectView,
  updateCodeProjectView,
  updateCodeProjectViewFilters,
  visibleCodeProjects,
  writeProjectViewPreferences,
  writeProjectViewState,
  type CodeProjectView,
  type CodeProjectViewColor,
  type CodeProjectViewIcon,
  type CodeProjectViewInput,
  type CodeProjectViewState,
  type ProjectViewEnvironment,
  type ProjectViewFilters,
  type ProjectViewMode,
} from "../code/codeProjectViewModel";
import {
  buildSidebarActivityView,
  matchesSidebarSearch,
  readActivityViewEnabled,
  writeActivityViewEnabled,
  type SidebarActivityMode,
  type SidebarActivityThread,
} from "../shell/activityViewModel";
import { IconButton } from "../shell/IconButton";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { groupThreadsByProject } from "./projectThreadGrouping";
import { ProjectThreadList, ProjectThreadRows, ProjectThreadStatus } from "./ProjectThreadList";
import type { ThreadRowActions } from "./ThreadRowMenu";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type ThreadGroupId = "recents" | "all" | "unfiled";

/** Thread rows a Project or the Chats group shows before folding behind Show more. */
const SIDEBAR_THREAD_LIMIT = 8;
type ProjectSort = "manual" | "updated" | "name";

const CODE_PROJECT_VIEW_ICON_COMPONENTS: Readonly<Record<CodeProjectViewIcon, LucideIcon>> = {
  folder: Folder,
  "folder-git": FolderGit,
  code: Code,
  terminal: Terminal,
  box: Box,
  layers: Layers,
  rocket: Rocket,
  star: Star,
  flag: Flag,
  bug: Bug,
  briefcase: Briefcase,
  sparkles: Sparkles,
};

const CODE_PROJECT_VIEW_ICON_LABELS: Readonly<Record<CodeProjectViewIcon, string>> = {
  folder: "Folder",
  "folder-git": "Folder with Git",
  code: "Code",
  terminal: "Terminal",
  box: "Box",
  layers: "Layers",
  rocket: "Rocket",
  star: "Star",
  flag: "Flag",
  bug: "Bug",
  briefcase: "Briefcase",
  sparkles: "Sparkles",
};

const CODE_PROJECT_VIEW_COLOR_LABELS: Readonly<Record<CodeProjectViewColor, string>> = {
  neutral: "Neutral",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
};

function CodeProjectViewGlyph(props: {
  readonly color: CodeProjectViewColor;
  readonly icon: CodeProjectViewIcon;
  readonly size?: number;
}) {
  const Icon = CODE_PROJECT_VIEW_ICON_COMPONENTS[props.icon];
  return (
    <span className="code-project-views__glyph" data-view-color={props.color}>
      <Icon aria-hidden="true" size={props.size ?? 14} strokeWidth={1.7} />
    </span>
  );
}

/**
 * A search/filter that hides every thread is a view state, not a deletion —
 * this explains that explicitly rather than leaving "no matching threads" to
 * read as data loss.
 */
const FILTERED_THREADS_EMPTY_MESSAGE =
  "No threads match the current filters. Nothing was deleted — clear search or change environment filters to see more.";

const PROJECT_SORT_ITEMS: ReadonlyArray<OctantMenuItem> = [
  {
    description: "Keep your saved Project order",
    icon: <ListTree aria-hidden="true" size={14} strokeWidth={1.8} />,
    label: "Manual order",
    value: "manual",
  },
  {
    description: "Most recently changed first",
    icon: <Clock3 aria-hidden="true" size={14} strokeWidth={1.8} />,
    label: "Last updated",
    value: "updated",
  },
  {
    description: "Project name",
    icon: <Folder aria-hidden="true" size={14} strokeWidth={1.8} />,
    label: "Alphabetical",
    value: "name",
  },
];

export interface ProjectSidebarSectionProps {
  readonly activeProjectId?: ProjectId;
  readonly activeThreadId?: string;
  readonly archivedProjects: ReadonlyArray<ProjectSummary>;
  readonly availabilityByProject: ReadonlyMap<ProjectId, ProjectAvailability>;
  /**
   * Each Project's last known context health. A Project the window has never
   * planned context for is simply absent: an unmeasured Project must not read
   * as a healthy one, and it must not read as a warning either.
   */
  readonly contextHealthByProject?: ReadonlyMap<ProjectId, ContextHealth>;
  /** Absent leaves the health mark out; nothing else can act on it here. */
  readonly onOpenContextHealth?: (projectId: ProjectId, opener: HTMLElement) => void;
  /** Requests a visible, keyboard-reachable complete thread list for a Project Overview action. */
  readonly expandProjectThreadsRequest?: Readonly<{
    readonly projectId: ProjectId;
    readonly sequence: number;
  }>;
  readonly onArchive: (projectId: ProjectId) => void;
  readonly onMove: (projectId: ProjectId, pinned: boolean) => void;
  readonly onNewChatInProject?: (projectId: ProjectId) => void;
  readonly onNewThreadInProject?: (projectId: ProjectId) => void;
  readonly newThreadVerb?: "chat" | "thread";
  readonly onReorder: (
    projectId: ProjectId,
    pinned: boolean,
    beforeProjectId?: ProjectId,
    afterProjectId?: ProjectId,
  ) => void;
  readonly onRestore: (projectId: ProjectId) => void;
  readonly onAddProject?: () => void;
  readonly addProjectLabel?: "chat-project" | "folder";
  readonly onProjectOpen: (project: ProjectSummary) => void;
  readonly onSelectThread?: (threadId: string) => void;
  /** What a thread row offers on right-click. Absent leaves the rows without a menu. */
  readonly threadActions?: ThreadRowActions;
  /** Absent when the host cannot accept a thread rename, which hides the affordance. */
  readonly onRenameThread?: (threadId: string, title: string) => void;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly unfiledLabel?: "Unfiled" | "Recents" | "Chats";
  readonly threads?: ReadonlyArray<ChatThreadNavigationItem>;
  readonly threadGroups?: Readonly<Record<ThreadGroupId, ReadonlyArray<ChatThreadNavigationItem>>>;
  readonly threadStatus?: "loading" | "ready" | "unavailable";
  readonly threadErrorMessage?: string;
  readonly onRetryThreads?: () => void;
  readonly projectViewsEnabled?: boolean;
  readonly projectViewsMode?: ProjectViewMode;
  readonly projectViewSwitcherPresentation?: ProjectViewSwitcherPresentation;
  /** Authoritative host identity for a Project, when the server supplied it. */
  readonly projectViewEnvironments?: ReadonlyMap<string, ProjectViewEnvironment>;
  /** Authoritative host catalog; only these names appear in the filter. */
  readonly projectViewEnvironmentOptions?: ReadonlyArray<ProjectViewEnvironment>;
  readonly now?: Date;
  readonly activityMode?: SidebarActivityMode;
  /** In-place filter of the current mode's visible thread rows. */
  readonly searchQuery?: string;
}

export function ProjectSidebarSection(props: ProjectSidebarSectionProps) {
  const [projectSort, setProjectSort] = useState<ProjectSort>("manual");
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<ProjectId>>(
    () => new Set(),
  );
  const [focusedProjectThreads, setFocusedProjectThreads] = useState<ProjectId>();
  const [projectViewState, setProjectViewState] = useState(() =>
    props.projectViewsEnabled === true
      ? readProjectViewState(props.projectViewsMode ?? "code")
      : undefined,
  );
  const [allProjectsPreferences, setAllProjectsPreferences] = useState(() =>
    props.projectViewsEnabled === true
      ? readProjectViewPreferences(props.projectViewsMode ?? "code")
      : undefined,
  );
  const [projectViewEditor, setProjectViewEditor] = useState<
    { readonly mode: "create" } | { readonly mode: "edit"; readonly viewId: string } | undefined
  >();
  const activityMode = props.activityMode ?? "chat";
  const [activityView, setActivityView] = useState(() =>
    readActivityViewEnabled(undefined, globalThis, activityMode),
  );
  const searchQuery = props.searchQuery ?? "";
  const searching = searchQuery.trim() !== "";
  const listedThreads = props.threadGroups?.all ?? props.threads;
  const unfiledLabel = props.unfiledLabel ?? "Unfiled";
  const projectNames = useMemo(
    () => new Map(props.projects.map((project) => [String(project.id), project.name])),
    [props.projects],
  );
  const folderLabelFor = (thread: ChatThreadNavigationItem): string =>
    thread.projectId === undefined
      ? unfiledLabel
      : (projectNames.get(thread.projectId) ?? unfiledLabel);
  /** Resolves the Project name shown in a thread row's hover info card. */
  const projectNameForThread = (thread: ChatThreadNavigationItem): string =>
    thread.projectId === undefined
      ? unfiledLabel
      : (projectNames.get(thread.projectId) ?? unfiledLabel);
  const currentFilters =
    projectViewState === undefined || allProjectsPreferences === undefined
      ? undefined
      : projectViewFiltersFor(
          projectViewState,
          projectViewState.activeViewId,
          allProjectsPreferences,
        );
  // Search and environment filters both hide threads without deleting them.
  const filteringThreads =
    searching || (currentFilters !== undefined && currentFilters.environmentIds.length > 0);
  const threadsReady = props.threadStatus === undefined || props.threadStatus === "ready";
  const timeFilteredThreads =
    currentFilters === undefined || listedThreads === undefined
      ? listedThreads
      : filterProjectViewThreads(listedThreads, currentFilters, props.now);
  const projectCandidates =
    props.projectViewsEnabled === true && projectViewState !== undefined
      ? filterProjectsForView(
          [...props.projects, ...props.archivedProjects].map((project) => ({
            ...project,
            id: String(project.id),
          })),
          projectViewState,
          allProjectsPreferences,
          props.projectViewEnvironments,
        ).flatMap((visible) => {
          const match = [...props.projects, ...props.archivedProjects].find(
            (project) => String(project.id) === visible.id,
          );
          return match === undefined ? [] : [match];
        })
      : props.projects;
  const visibleProjects =
    currentFilters === undefined
      ? projectCandidates
      : sortProjectsForView(projectCandidates, currentFilters.sorting, timeFilteredThreads ?? []);
  const visibleProjectIds = new Set(visibleProjects.map((project) => String(project.id)));
  const viewScopedThreads =
    currentFilters === undefined || timeFilteredThreads === undefined
      ? timeFilteredThreads
      : timeFilteredThreads.filter(
          (thread) =>
            thread.projectId !== undefined && visibleProjectIds.has(String(thread.projectId)),
        );
  const threads =
    viewScopedThreads === undefined || !searching
      ? viewScopedThreads
      : viewScopedThreads.filter((thread) =>
          matchesSidebarSearch(searchQuery, thread.title, folderLabelFor(thread)),
        );
  const onNewThread = props.onNewThreadInProject ?? props.onNewChatInProject;
  const newThreadVerb = props.newThreadVerb ?? "chat";
  const nestThreads = threads !== undefined && props.onSelectThread !== undefined;
  const threadsByProject =
    threads !== undefined && props.onSelectThread !== undefined
      ? groupThreadsByProject(threads, props.projects)
      : undefined;
  const unfiled = threadsByProject?.unfiled ?? [];
  const projectHasVisibleThreads = (project: ProjectSummary): boolean =>
    (threadsByProject?.byProjectId.get(String(project.id))?.length ?? 0) > 0;
  const hideEmptyProjects = searching || currentFilters?.showEmptyProjects === false;
  const projectRows = hideEmptyProjects
    ? visibleProjects.filter(projectHasVisibleThreads)
    : visibleProjects;
  const listedPinned = projectRows.filter((project) => project.pinned);
  const listedOrdinary = projectRows.filter((project) => !project.pinned);
  const pinned =
    currentFilters === undefined ? sortProjects(listedPinned, projectSort) : listedPinned;
  const ordinary =
    currentFilters === undefined ? sortProjects(listedOrdinary, projectSort) : listedOrdinary;
  const viewGrouping = currentFilters?.grouping ?? "project";
  const groupedViewProjects =
    viewGrouping === "project"
      ? []
      : groupProjectsForView(projectRows, viewGrouping, props.projectViewEnvironments);
  const activity = useMemo(() => {
    const view = buildSidebarActivityView({
      ...(props.now === undefined ? {} : { now: props.now }),
      projects: visibleProjects.map((project) => ({
        id: String(project.id),
        name: project.name,
      })),
      unfiledLabel,
      threads: threads ?? [],
    });
    return view;
  }, [threads, props.now, visibleProjects, unfiledLabel]);
  const hasVisibleThreads =
    (threadsByProject !== undefined &&
      (unfiled.length > 0 ||
        [...threadsByProject.byProjectId.values()].some((group) => group.length > 0))) ||
    activity.groups.some((group) => group.threads.length > 0);
  const showFilteredThreadsEmpty = filteringThreads && threadsReady && !hasVisibleThreads;

  useEffect(() => {
    setActivityView(readActivityViewEnabled(undefined, globalThis, activityMode));
  }, [activityMode]);

  function toggleActivityView() {
    setActivityView((current) => {
      const next = !current;
      writeActivityViewEnabled(next, undefined, globalThis, activityMode);
      return next;
    });
  }

  useEffect(() => {
    if (props.projectViewsEnabled === true) {
      const mode = props.projectViewsMode ?? "code";
      setProjectViewState(readProjectViewState(mode));
      setAllProjectsPreferences(readProjectViewPreferences(mode));
      return;
    }
    setProjectViewState(undefined);
    setAllProjectsPreferences(undefined);
    setProjectViewEditor(undefined);
  }, [props.projectViewsEnabled, props.projectViewsMode]);

  useEffect(() => {
    const request = props.expandProjectThreadsRequest;
    if (request === undefined) return;
    setCollapsedProjects((current) => {
      if (!current.has(request.projectId)) return current;
      const next = new Set(current);
      next.delete(request.projectId);
      return next;
    });
    setFocusedProjectThreads(request.projectId);
  }, [props.expandProjectThreadsRequest]);

  useEffect(() => {
    if (focusedProjectThreads === undefined || collapsedProjects.has(focusedProjectThreads)) return;
    const list = document.getElementById(projectThreadListId(focusedProjectThreads));
    if (list instanceof HTMLElement) list.focus();
    setFocusedProjectThreads(undefined);
  }, [collapsedProjects, focusedProjectThreads]);

  function toggleProject(projectId: ProjectId) {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function persistProjectViewState(next: CodeProjectViewState) {
    setProjectViewState(next);
    writeProjectViewState(props.projectViewsMode ?? "code", next);
  }

  function persistProjectViewFilters(next: ProjectViewFilters): void {
    if (projectViewState === undefined || allProjectsPreferences === undefined) return;
    const normalized = normalizeProjectViewFilters(next);
    if (projectViewState.activeViewId === ALL_CODE_PROJECTS_VIEW_ID) {
      const preferences = { filters: normalized };
      setAllProjectsPreferences(preferences);
      writeProjectViewPreferences(props.projectViewsMode ?? "code", preferences);
      return;
    }
    persistProjectViewState(
      updateCodeProjectViewFilters(projectViewState, projectViewState.activeViewId, normalized),
    );
  }

  const editingView =
    projectViewEditor?.mode === "edit"
      ? projectViewState?.views.find((view) => view.id === projectViewEditor.viewId)
      : undefined;

  function renderProjectGroup(
    label: string,
    projects: ReadonlyArray<ProjectSummary>,
    options: { readonly allowAdd?: boolean } = {},
  ): React.ReactNode {
    return (
      <ProjectGroup
        key={label}
        {...(props.activeProjectId === undefined ? {} : { activeProjectId: props.activeProjectId })}
        {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
        availabilityByProject={props.availabilityByProject}
        collapsedProjects={collapsedProjects}
        {...(props.contextHealthByProject === undefined
          ? {}
          : { contextHealthByProject: props.contextHealthByProject })}
        {...(props.onOpenContextHealth === undefined
          ? {}
          : { onOpenContextHealth: props.onOpenContextHealth })}
        hideWhenEmpty={hideEmptyProjects}
        label={label}
        onArchive={props.onArchive}
        onMove={props.onMove}
        onRestore={props.onRestore}
        {...(onNewThread === undefined ? {} : { newThreadVerb, onNewThreadInProject: onNewThread })}
        onReorder={props.onReorder}
        onProjectOpen={props.onProjectOpen}
        {...(options.allowAdd === true && props.onAddProject !== undefined
          ? { onAddProject: props.onAddProject }
          : {})}
        {...(options.allowAdd === true && props.addProjectLabel !== undefined
          ? { addProjectLabel: props.addProjectLabel }
          : {})}
        {...(options.allowAdd === true ? { onSortChange: setProjectSort } : {})}
        onToggleProject={toggleProject}
        {...(props.onSelectThread === undefined ? {} : { onSelectThread: props.onSelectThread })}
        {...(props.threadActions === undefined ? {} : { threadActions: props.threadActions })}
        {...(props.onRenameThread === undefined ? {} : { onRenameThread: props.onRenameThread })}
        projectNameForThread={projectNameForThread}
        projects={projects}
        revealThreads={searching}
        sort={projectSort}
        {...(threadsByProject === undefined
          ? {}
          : { threadsByProjectId: threadsByProject.byProjectId })}
      />
    );
  }

  return (
    <nav aria-label="Projects" className="project-nav window-no-drag">
      {props.projectViewsEnabled === true && projectViewState !== undefined ? (
        <CodeProjectViewSwitcher
          onCreate={() => setProjectViewEditor({ mode: "create" })}
          onDelete={(viewId) =>
            persistProjectViewState(deleteCodeProjectView(projectViewState, viewId))
          }
          onEdit={(viewId) => setProjectViewEditor({ mode: "edit", viewId })}
          onSelect={(viewId) =>
            persistProjectViewState(selectCodeProjectView(projectViewState, viewId))
          }
          filters={currentFilters ?? normalizeProjectViewFilters(undefined)}
          onFiltersChange={persistProjectViewFilters}
          environmentOptions={
            props.projectViewEnvironmentOptions ?? [{ id: "local", name: "Local" }]
          }
          presentation={props.projectViewSwitcherPresentation ?? "dropdown"}
          projectCountFor={(viewId) =>
            visibleCodeProjects(
              props.projects.map((project) => ({ ...project, id: String(project.id) })),
              { ...projectViewState, activeViewId: viewId },
            ).length
          }
          state={projectViewState}
        />
      ) : null}
      {projectViewEditor === undefined || projectViewState === undefined ? null : (
        <CodeProjectViewEditorDialog
          mode={projectViewEditor.mode}
          onClose={() => setProjectViewEditor(undefined)}
          onSave={(input) => {
            persistProjectViewState(
              projectViewEditor.mode === "create"
                ? createCodeProjectView(projectViewState, input)
                : updateCodeProjectView(projectViewState, input),
            );
            setProjectViewEditor(undefined);
          }}
          projects={props.projects}
          {...(editingView === undefined ? {} : { view: editingView })}
        />
      )}
      {nestThreads ? (
        <ActivityViewToggle enabled={activityView} onToggle={toggleActivityView} />
      ) : null}
      {props.threadStatus === "loading" || props.threadStatus === "unavailable" ? (
        <ProjectThreadStatus
          {...(props.threadErrorMessage === undefined
            ? {}
            : { errorMessage: props.threadErrorMessage })}
          {...(props.onRetryThreads === undefined ? {} : { onRetry: props.onRetryThreads })}
          status={props.threadStatus}
        />
      ) : null}
      {showFilteredThreadsEmpty ? (
        <p className="project-nav__empty" role="status">
          {FILTERED_THREADS_EMPTY_MESSAGE}
        </p>
      ) : null}
      {showFilteredThreadsEmpty ? null : nestThreads && activityView ? (
        <ActivityThreadList
          {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
          {...(filteringThreads && threadsReady
            ? { emptyLabel: FILTERED_THREADS_EMPTY_MESSAGE }
            : {})}
          groups={activity.groups}
          onSelectThread={props.onSelectThread!}
        />
      ) : (
        <>
          {viewGrouping === "project"
            ? [
                renderProjectGroup("Pinned", pinned),
                renderProjectGroup("Projects", ordinary, { allowAdd: true }),
              ]
            : groupedViewProjects.map((group) => renderProjectGroup(group.label, group.projects))}
          {unfiled.length > 0 && props.onSelectThread !== undefined ? (
            <section aria-label={unfiledLabel} className="project-section project-section--unfiled">
              <h2 className="sidebar-section">{unfiledLabel}</h2>
              <div className="project-threads">
                <ProjectThreadRows
                  {...(props.threadActions === undefined ? {} : { actions: props.threadActions })}
                  {...(props.activeThreadId === undefined
                    ? {}
                    : { activeThreadId: props.activeThreadId })}
                  {...(props.onRenameThread === undefined
                    ? {}
                    : { onRenameThread: props.onRenameThread })}
                  collapsedLimit={SIDEBAR_THREAD_LIMIT}
                  onSelectThread={props.onSelectThread}
                  projectNameForThread={projectNameForThread}
                  threads={unfiled}
                />
              </div>
            </section>
          ) : null}
        </>
      )}
      {(currentFilters === undefined || currentFilters.lifecycle === "active") &&
      props.archivedProjects.length > 0 ? (
        <details className="project-archive">
          <summary>
            Archive <span>{props.archivedProjects.length}</span>
          </summary>
          {props.archivedProjects.map((project) => (
            <div className="project-row project-row--archived" key={project.id}>
              <span className="project-row__archived-name">{project.name}</span>
              <OctantButton
                aria-label={`Restore ${project.name}`}
                className="project-row__action window-no-drag"
                onClick={() => props.onRestore(project.id)}
                type="button"
                variant="ghost"
              >
                Restore
              </OctantButton>
            </div>
          ))}
        </details>
      ) : null}
    </nav>
  );
}

function projectThreadListId(projectId: ProjectId): string {
  return `project-threads-${String(projectId)}`;
}

function ProjectGroup(props: {
  readonly activeProjectId?: ProjectId;
  readonly activeThreadId?: string;
  readonly availabilityByProject: ReadonlyMap<ProjectId, ProjectAvailability>;
  readonly collapsedProjects: ReadonlySet<ProjectId>;
  readonly contextHealthByProject?: ReadonlyMap<ProjectId, ContextHealth>;
  readonly onOpenContextHealth?: (projectId: ProjectId, opener: HTMLElement) => void;
  readonly hideWhenEmpty?: boolean;
  readonly label: string;
  readonly onAddProject?: () => void;
  readonly addProjectLabel?: "chat-project" | "folder";
  readonly onArchive: (projectId: ProjectId) => void;
  readonly onMove: (projectId: ProjectId, pinned: boolean) => void;
  readonly onRestore: (projectId: ProjectId) => void;
  readonly newThreadVerb?: "chat" | "thread";
  readonly onNewThreadInProject?: (projectId: ProjectId) => void;
  readonly onReorder: (
    projectId: ProjectId,
    pinned: boolean,
    beforeProjectId?: ProjectId,
    afterProjectId?: ProjectId,
  ) => void;
  readonly onProjectOpen: (project: ProjectSummary) => void;
  readonly onSortChange?: (sort: ProjectSort) => void;
  readonly onSelectThread?: (threadId: string) => void;
  readonly threadActions?: ThreadRowActions;
  readonly onRenameThread?: (threadId: string, title: string) => void;
  readonly onToggleProject: (projectId: ProjectId) => void;
  readonly projectNameForThread?: (thread: ChatThreadNavigationItem) => string | undefined;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly revealThreads?: boolean;
  readonly sort?: ProjectSort;
  readonly threadsByProjectId?: ReadonlyMap<string, ReadonlyArray<ChatThreadNavigationItem>>;
}) {
  if (props.projects.length === 0 && (props.label !== "Projects" || props.hideWhenEmpty === true)) {
    return null;
  }
  return (
    <section aria-label={props.label} className="project-section">
      <div className="project-section__header sidebar-section">
        <h2>{props.label}</h2>
        {props.onAddProject === undefined &&
        (props.onSortChange === undefined || props.sort === undefined) ? null : (
          <div className="project-section__header-actions">
            {props.onAddProject === undefined ? null : (
              <OctantButton
                aria-label={
                  props.addProjectLabel === "chat-project" ? "New Chat Project" : "Add folder"
                }
                className="project-section__add"
                onClick={props.onAddProject}
                size="icon"
                title={props.addProjectLabel === "chat-project" ? "New Chat Project" : "Add folder"}
                type="button"
                variant="ghost"
              >
                <Plus aria-hidden="true" size={14} strokeWidth={1.8} />
              </OctantButton>
            )}
            {props.onSortChange === undefined || props.sort === undefined ? null : (
              <OctantMenu
                items={PROJECT_SORT_ITEMS}
                onValueChange={(value) => {
                  if (value === "manual" || value === "updated" || value === "name") {
                    props.onSortChange?.(value);
                  }
                }}
                trigger={<MoreHorizontal aria-hidden="true" size={16} strokeWidth={1.8} />}
                triggerLabel="Project organization"
                value={props.sort}
              />
            )}
          </div>
        )}
      </div>
      {props.projects.map((project, index) => {
        const availability = props.availabilityByProject.get(project.id);
        const unavailable = project.type !== "chat" && availability?.status === "unavailable";
        // Only a degraded reading is worth a mark. "Healthy" and "never
        // measured" both mean there is nothing here for the reader to act on,
        // and they must not be collapsed into the same claim anywhere else.
        const contextHealth = props.contextHealthByProject?.get(project.id);
        const degradedContext =
          contextHealth === undefined || contextHealth === "healthy" ? undefined : contextHealth;
        const nestedThreads = props.threadsByProjectId?.get(String(project.id)) ?? [];
        const showNested =
          props.onSelectThread !== undefined && props.threadsByProjectId !== undefined;
        const expanded = props.revealThreads === true || !props.collapsedProjects.has(project.id);
        return (
          <div className="project-block" key={project.id}>
            <div
              className="project-row"
              // A selected thread already marks the row the reader chose. The
              // Project it lives in stays the active Project, but it does not
              // wear the same selected background and compete with it.
              data-active={
                props.activeProjectId === project.id &&
                !nestedThreads.some(
                  (thread) =>
                    String(thread.navigationId ?? thread.threadId) === String(props.activeThreadId),
                )
                  ? "true"
                  : "false"
              }
            >
              <OctantButton
                aria-expanded={showNested ? expanded : undefined}
                aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
                className="project-row__select justify-start window-no-drag"
                onClick={() => props.onToggleProject(project.id)}
                type="button"
                variant="ghost"
              >
                <ProjectFolderIcon expanded={showNested && expanded} project={project} />
                <span className="project-row__copy">
                  <span>{project.name}</span>
                  {unavailable ? <small>Relink required</small> : null}
                </span>
              </OctantButton>
              {degradedContext === undefined || props.onOpenContextHealth === undefined ? null : (
                <ContextHealthWarning
                  health={degradedContext}
                  label={project.name}
                  onOpen={(opener) => props.onOpenContextHealth!(project.id, opener)}
                />
              )}
              <ProjectActionsMenu
                canMoveDown={
                  (props.sort === undefined || props.sort === "manual") &&
                  index < props.projects.length - 1
                }
                canMoveUp={(props.sort === undefined || props.sort === "manual") && index > 0}
                onArchive={props.onArchive}
                onMove={props.onMove}
                onOpen={props.onProjectOpen}
                onReorder={props.onReorder}
                onRestore={props.onRestore}
                project={project}
                {...(props.projects[index - 1] === undefined
                  ? {}
                  : { previousProjectId: props.projects[index - 1]!.id })}
                {...(props.projects[index + 1] === undefined
                  ? {}
                  : { nextProjectId: props.projects[index + 1]!.id })}
              />
              {props.onNewThreadInProject === undefined ? null : (
                <OctantButton
                  aria-label={
                    props.newThreadVerb === "thread"
                      ? `New thread in ${project.name}`
                      : `New chat in ${project.name}`
                  }
                  className="project-row__action project-row__action--icon project-row__new-thread window-no-drag"
                  onClick={() => props.onNewThreadInProject!(project.id)}
                  size="icon"
                  title={props.newThreadVerb === "thread" ? "New thread" : "New chat"}
                  type="button"
                  variant="ghost"
                >
                  <SquarePen aria-hidden="true" size={14} strokeWidth={1.7} />
                </OctantButton>
              )}
            </div>
            {showNested && expanded && nestedThreads.length > 0 ? (
              <ProjectThreadList
                {...(props.threadActions === undefined ? {} : { actions: props.threadActions })}
                {...(props.activeThreadId === undefined
                  ? {}
                  : { activeThreadId: props.activeThreadId })}
                {...(props.onRenameThread === undefined
                  ? {}
                  : { onRenameThread: props.onRenameThread })}
                collapsedLimit={SIDEBAR_THREAD_LIMIT}
                id={projectThreadListId(project.id)}
                label={`Threads in ${project.name}`}
                onSelectThread={props.onSelectThread!}
                {...(props.projectNameForThread === undefined
                  ? {}
                  : { projectNameForThread: props.projectNameForThread })}
                threads={nestedThreads}
              />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function ProjectFolderIcon(props: {
  readonly expanded: boolean;
  readonly project: ProjectSummary;
}) {
  const Icon = props.expanded ? FolderOpen : props.project.type === "code" ? FolderGit : Folder;
  return (
    <span
      aria-hidden="true"
      className="project-row__folder-icon"
      data-folder-state={props.expanded ? "open" : "closed"}
      data-project-icon={props.project.type}
    >
      <Icon size={14} strokeWidth={1.65} />
    </span>
  );
}

function ProjectActionsMenu(props: {
  readonly canMoveDown: boolean;
  readonly canMoveUp: boolean;
  readonly nextProjectId?: ProjectId;
  readonly onArchive: (projectId: ProjectId) => void;
  readonly onMove: (projectId: ProjectId, pinned: boolean) => void;
  readonly onOpen: (project: ProjectSummary) => void;
  readonly onReorder: (
    projectId: ProjectId,
    pinned: boolean,
    beforeProjectId?: ProjectId,
    afterProjectId?: ProjectId,
  ) => void;
  readonly onRestore: (projectId: ProjectId) => void;
  readonly previousProjectId?: ProjectId;
  readonly project: ProjectSummary;
}) {
  const items: ReadonlyArray<OctantMenuItem> = [
    { label: "Open Project", value: "open" },
    { label: props.project.pinned ? "Unpin Project" : "Pin Project", value: "pin" },
    { disabled: !props.canMoveUp, label: "Move up", value: "up" },
    { disabled: !props.canMoveDown, label: "Move down", value: "down" },
    {
      label: props.project.lifecycle === "archived" ? "Restore Project" : "Archive Project",
      value: props.project.lifecycle === "archived" ? "restore" : "archive",
    },
  ];
  return (
    <OctantMenu
      items={items}
      onValueChange={(value) => {
        if (value === "open") props.onOpen(props.project);
        if (value === "pin") props.onMove(props.project.id, !props.project.pinned);
        if (value === "up") {
          props.onReorder(props.project.id, props.project.pinned, props.previousProjectId);
        }
        if (value === "down") {
          props.onReorder(props.project.id, props.project.pinned, undefined, props.nextProjectId);
        }
        if (value === "archive") props.onArchive(props.project.id);
        if (value === "restore") props.onRestore(props.project.id);
      }}
      trigger={<MoreHorizontal aria-hidden="true" size={14} strokeWidth={1.8} />}
      triggerClassName="project-row__action project-row__action--icon inline-flex items-center justify-center"
      triggerLabel={`Project actions for ${props.project.name}`}
      value=""
      selectionMode="action"
    />
  );
}

function sortProjects(
  projects: ReadonlyArray<ProjectSummary>,
  sort: ProjectSort,
): ReadonlyArray<ProjectSummary> {
  if (sort === "manual") return projects;
  return [...projects].sort((left, right) =>
    sort === "updated"
      ? String(right.updatedAt).localeCompare(String(left.updatedAt))
      : left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

function ActivityViewToggle(props: { readonly enabled: boolean; readonly onToggle: () => void }) {
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => {
    setHost(document.querySelector("[data-octant-sidebar-chrome-actions]"));
  }, []);
  const button = (
    <IconButton
      aria-pressed={props.enabled}
      className="project-nav__activity-toggle"
      // The inbox glyph now belongs to the Inbox destination; activity keeps
      // its recency-feed behavior under a bell so the two never read as one.
      icon={Bell}
      label={props.enabled ? "Turn off activity view" : "Turn on activity view"}
      onClick={props.onToggle}
    />
  );
  return host === null ? button : createPortal(button, host);
}

function ActivityThreadList(props: {
  readonly activeThreadId?: string;
  readonly emptyLabel?: string;
  readonly groups: ReturnType<typeof buildSidebarActivityView>["groups"];
  readonly onSelectThread: (threadId: string) => void;
}) {
  if (props.groups.length === 0) {
    return props.emptyLabel === undefined ? (
      <p className="project-nav__empty">No threads in this mode.</p>
    ) : (
      <p className="project-nav__empty" role="status">
        {props.emptyLabel}
      </p>
    );
  }
  return (
    <div className="activity-nav">
      {props.groups.map((group) => (
        <section aria-label={group.label} className="activity-nav__group" key={group.id}>
          <h2 className="sidebar-section">{group.label}</h2>
          <div className="activity-nav__threads">
            {group.threads.map((thread) => (
              <ActivityThreadButton
                {...(props.activeThreadId === undefined
                  ? {}
                  : { activeThreadId: props.activeThreadId })}
                key={thread.navigationId}
                onSelectThread={props.onSelectThread}
                thread={thread}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ActivityThreadButton(props: {
  readonly activeThreadId?: string;
  readonly onSelectThread: (threadId: string) => void;
  readonly thread: SidebarActivityThread;
}) {
  const selected = props.activeThreadId === props.thread.navigationId;
  return (
    <OctantButton
      aria-current={selected ? "page" : undefined}
      className="sidebar-navigation__thread activity-nav__thread justify-start"
      data-attention={props.thread.attention}
      data-thread-id={props.thread.threadId}
      onClick={() => props.onSelectThread(props.thread.navigationId)}
      type="button"
      variant="ghost"
    >
      {/* The mark leads the row from a gutter every row reserves, so the marked
          and unmarked titles start on the same edge. */}
      {props.thread.attention === "unread" ? (
        <span aria-label="Unread" className="activity-nav__glyph" data-indicator="unread">
          ●
        </span>
      ) : props.thread.attention === "follow-up" ? (
        <span aria-label="Follow-up" className="activity-nav__glyph" data-indicator="follow-up">
          ◆
        </span>
      ) : props.thread.attention === "live" ? (
        <span aria-label="Live" className="activity-nav__glyph" data-indicator="live">
          ◐
        </span>
      ) : (
        <span aria-hidden="true" className="activity-nav__glyph" />
      )}
      <span className="sidebar-navigation__thread-copy">
        <span className="sidebar-navigation__thread-title">{props.thread.title}</span>
        <span className="sidebar-navigation__thread-project">{props.thread.projectName}</span>
      </span>
    </OctantButton>
  );
}

function CodeProjectViewSwitcher(props: {
  readonly onCreate: () => void;
  readonly onDelete: (viewId: string) => void;
  readonly onEdit: (viewId: string) => void;
  readonly onSelect: (viewId: string) => void;
  readonly filters: ProjectViewFilters;
  readonly onFiltersChange: (filters: ProjectViewFilters) => void;
  readonly environmentOptions: ReadonlyArray<ProjectViewEnvironment>;
  readonly presentation: ProjectViewSwitcherPresentation;
  readonly projectCountFor: (viewId: string) => number;
  readonly state: CodeProjectViewState;
}) {
  const allProjectsView = {
    id: ALL_CODE_PROJECTS_VIEW_ID,
    name: ALL_CODE_PROJECTS_VIEW_NAME,
    icon: DEFAULT_CODE_PROJECT_VIEW_ICON,
    color: DEFAULT_CODE_PROJECT_VIEW_COLOR,
  } as const;
  const options: ReadonlyArray<Pick<CodeProjectView, "id" | "name" | "icon" | "color">> = [
    allProjectsView,
    ...props.state.views,
  ];
  const active =
    options.find((option) => option.id === props.state.activeViewId) ?? allProjectsView;
  const newViewButton = (
    <OctantButton
      aria-label="New project view"
      className="code-project-views__new"
      onClick={props.onCreate}
      size="icon"
      title="New project view"
      type="button"
      variant="ghost"
    >
      <Plus aria-hidden="true" size={14} strokeWidth={1.7} />
    </OctantButton>
  );
  const contextItemsFor = (
    view: Pick<CodeProjectView, "id" | "name">,
  ): ReadonlyArray<OctantMenuItem> => [
    {
      disabled: true,
      label: `${view.name} · Projects ${props.projectCountFor(view.id)}`,
      value: "summary",
    },
    ...(view.id === ALL_CODE_PROJECTS_VIEW_ID
      ? []
      : [
          { label: "Edit view", value: "edit" },
          { label: "Delete view", value: "delete" },
        ]),
  ];
  const onContextValue = (view: Pick<CodeProjectView, "id" | "name">, value: string): void => {
    if (value === "edit") props.onEdit(view.id);
    if (value === "delete") props.onDelete(view.id);
  };
  return (
    <div className="code-project-views">
      {props.presentation === "inline" ? (
        <div aria-label="Project views" className="code-project-views__inline" role="group">
          {options.map((option) => (
            <CodeProjectViewChip
              key={option.id}
              onDelete={props.onDelete}
              onEdit={props.onEdit}
              onSelect={props.onSelect}
              projectCount={props.projectCountFor(option.id)}
              selected={option.id === active.id}
              view={option}
            />
          ))}
          {newViewButton}
        </div>
      ) : (
        <div className="code-project-views__row">
          <OctantContextMenu
            items={contextItemsFor(active)}
            onValueChange={(value) => onContextValue(active, value)}
            triggerClassName="code-project-views__trigger-wrap"
          >
            <OctantMenu
              actions={[
                {
                  icon: <Plus aria-hidden="true" size={14} strokeWidth={1.7} />,
                  label: "New view",
                  onSelect: props.onCreate,
                },
              ]}
              items={options.map((option) => ({
                icon: <CodeProjectViewGlyph color={option.color} icon={option.icon} />,
                label: option.name,
                value: option.id,
              }))}
              onValueChange={props.onSelect}
              trigger={
                <span className="code-project-views__trigger">
                  <CodeProjectViewGlyph color={active.color} icon={active.icon} />
                  <span>{active.name}</span>
                </span>
              }
              triggerLabel="Project view"
              value={props.state.activeViewId}
            />
          </OctantContextMenu>
        </div>
      )}
      <ProjectViewFilterMenu
        environmentOptions={props.environmentOptions}
        filters={props.filters}
        onChange={props.onFiltersChange}
      />
    </div>
  );
}

/**
 * One project view in the rail: click to switch to it, right-click to ask about
 * it.
 *
 * The count and the two edits used to sit pinned under the rail, describing
 * whichever view happened to be active. There they read as a permanent part of
 * the sidebar and answered for a view the reader had not asked about. On the
 * view itself they are about the one that was right-clicked, and they are only
 * there when someone asks.
 */
function CodeProjectViewChip(props: {
  readonly onDelete: (viewId: string) => void;
  readonly onEdit: (viewId: string) => void;
  readonly onSelect: (viewId: string) => void;
  readonly projectCount: number;
  readonly selected: boolean;
  readonly view: Pick<CodeProjectView, "id" | "name" | "icon" | "color">;
}) {
  return (
    <OctantContextMenu
      items={[
        {
          disabled: true,
          label: `${props.view.name} · Projects ${props.projectCount}`,
          value: "summary",
        },
        ...(props.view.id === ALL_CODE_PROJECTS_VIEW_ID
          ? []
          : [
              { label: "Edit view", value: "edit" },
              { label: "Delete view", value: "delete" },
            ]),
      ]}
      onValueChange={(value) => {
        if (value === "edit") props.onEdit(props.view.id);
        if (value === "delete") props.onDelete(props.view.id);
      }}
    >
      <OctantButton
        aria-label={props.view.name}
        aria-pressed={props.selected}
        className="code-project-views__inline-button"
        onClick={() => props.onSelect(props.view.id)}
        size="icon"
        title={props.view.name}
        type="button"
        variant="ghost"
      >
        <CodeProjectViewGlyph color={props.view.color} icon={props.view.icon} />
      </OctantButton>
    </OctantContextMenu>
  );
}

const PROJECT_VIEW_LIFECYCLE_OPTIONS = [
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
  { id: "all", label: "All" },
] as const;
const PROJECT_VIEW_GROUPING_OPTIONS = [
  { id: "project", label: "Project" },
  { id: "environment", label: "Environment" },
  { id: "status", label: "Status" },
  { id: "none", label: "None" },
] as const;
const PROJECT_VIEW_SORTING_OPTIONS = [
  { id: "recency", label: "Recency" },
  { id: "alphabetical", label: "Alphabetical" },
  { id: "created", label: "Created time" },
] as const;
const PROJECT_VIEW_ACTIVITY_OPTIONS = [
  { id: "all", label: "Any activity" },
  { id: "today", label: "Today" },
  { id: "3-days", label: "Last 3 days" },
  { id: "7-days", label: "Last 7 days" },
  { id: "14-days", label: "Last 14 days" },
  { id: "30-days", label: "Last 30 days" },
  { id: "custom", label: "Custom range" },
] as const;

function ProjectViewFilterMenu(props: {
  readonly environmentOptions: ReadonlyArray<ProjectViewEnvironment>;
  readonly filters: ProjectViewFilters;
  readonly onChange: (filters: ProjectViewFilters) => void;
}) {
  const activityRangeErrorId = useId();
  const options = useMemo(() => {
    const local = { id: "local", name: "Local" };
    return [local, ...props.environmentOptions.filter((option) => option.id !== local.id)].filter(
      (option, index, all) => all.findIndex((candidate) => candidate.id === option.id) === index,
    );
  }, [props.environmentOptions]);
  const environmentSelection = props.filters.environmentIds;
  const activityRangeError = projectViewActivityRangeError(props.filters);
  const activeCount =
    (props.filters.lifecycle === "active" ? 0 : 1) +
    (environmentSelection.length > 0 ? 1 : 0) +
    (props.filters.showEmptyProjects ? 0 : 1) +
    (props.filters.grouping === "project" ? 0 : 1) +
    (props.filters.sorting === "recency" ? 0 : 1) +
    (props.filters.activity === "all" ? 0 : 1);
  const triggerLabel =
    activeCount === 0 ? "Project view filters" : `Project view filters, ${activeCount} active`;

  function update(change: Partial<ProjectViewFilters>): void {
    props.onChange({ ...props.filters, ...change });
  }

  function toggleEnvironment(id: string): void {
    if (environmentSelection.length === 0) {
      update({ environmentIds: [id] });
      return;
    }
    const next = environmentSelection.includes(id)
      ? environmentSelection.filter((candidate) => candidate !== id)
      : [...environmentSelection, id];
    update({ environmentIds: next });
  }

  return (
    <OctantMenuRoot>
      <OctantMenuTrigger
        aria-label={triggerLabel}
        className="code-project-views__filter window-no-drag"
        title={triggerLabel}
      >
        <ListFilter aria-hidden="true" size={14} strokeWidth={1.8} />
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner
          align="end"
          className="z-50 outline-none window-no-drag"
          side="bottom"
        >
          <OctantMenuPopup
            aria-label="Project view filters"
            className="min-w-56 max-w-[calc(100vw-24px)]"
          >
            <OctantMenuGroup>
              <OctantMenuGroupLabel>Filters</OctantMenuGroupLabel>
              <FilterRadioSubmenu
                label="Lifecycle"
                onValueChange={(value) => {
                  const option = PROJECT_VIEW_LIFECYCLE_OPTIONS.find(
                    (candidate) => candidate.id === value,
                  );
                  if (option !== undefined) update({ lifecycle: option.id });
                }}
                options={PROJECT_VIEW_LIFECYCLE_OPTIONS}
                value={props.filters.lifecycle}
              />
              <OctantMenuSub>
                <OctantMenuSubTrigger>Environment</OctantMenuSubTrigger>
                <OctantMenuSubPopup>
                  <OctantMenuCheckboxItem
                    checked={environmentSelection.length === 0}
                    onCheckedChange={(checked) => {
                      if (checked) update({ environmentIds: [] });
                    }}
                  >
                    All environments
                  </OctantMenuCheckboxItem>
                  {options.map((option) => (
                    <OctantMenuCheckboxItem
                      checked={environmentSelection.includes(option.id)}
                      key={option.id}
                      onCheckedChange={() => toggleEnvironment(option.id)}
                    >
                      {option.name}
                    </OctantMenuCheckboxItem>
                  ))}
                </OctantMenuSubPopup>
              </OctantMenuSub>
              <OctantMenuCheckboxItem
                checked={props.filters.showEmptyProjects}
                onCheckedChange={(checked) => update({ showEmptyProjects: checked })}
              >
                Show empty Projects
              </OctantMenuCheckboxItem>
            </OctantMenuGroup>
            <OctantMenuSeparator />
            <OctantMenuGroup>
              <FilterRadioSubmenu
                label="Group by"
                onValueChange={(value) => {
                  const option = PROJECT_VIEW_GROUPING_OPTIONS.find(
                    (candidate) => candidate.id === value,
                  );
                  if (option !== undefined) update({ grouping: option.id });
                }}
                options={PROJECT_VIEW_GROUPING_OPTIONS}
                value={props.filters.grouping}
              />
              <FilterRadioSubmenu
                label="Sort by"
                onValueChange={(value) => {
                  const option = PROJECT_VIEW_SORTING_OPTIONS.find(
                    (candidate) => candidate.id === value,
                  );
                  if (option !== undefined) update({ sorting: option.id });
                }}
                options={PROJECT_VIEW_SORTING_OPTIONS}
                value={props.filters.sorting}
              />
            </OctantMenuGroup>
            <OctantMenuSeparator />
            <OctantMenuSub>
              <OctantMenuSubTrigger>Activity</OctantMenuSubTrigger>
              <OctantMenuSubPopup>
                <OctantMenuRadioGroup
                  onValueChange={(value) => {
                    const option = PROJECT_VIEW_ACTIVITY_OPTIONS.find(
                      (candidate) => candidate.id === value,
                    );
                    if (option !== undefined) update({ activity: option.id });
                  }}
                  value={props.filters.activity}
                >
                  {PROJECT_VIEW_ACTIVITY_OPTIONS.map((option) => (
                    <OctantMenuRadioItem closeOnClick={false} key={option.id} value={option.id}>
                      {option.label}
                    </OctantMenuRadioItem>
                  ))}
                </OctantMenuRadioGroup>
                {props.filters.activity === "custom" ? (
                  <>
                    <OctantMenuSeparator />
                    <OctantField className="gap-1 px-2 py-1.5">
                      <OctantFieldLabel>From</OctantFieldLabel>
                      <OctantInput
                        aria-describedby={
                          activityRangeError === undefined ? undefined : activityRangeErrorId
                        }
                        aria-invalid={activityRangeError === undefined ? undefined : true}
                        aria-label="Activity from"
                        onChange={(event) =>
                          update({
                            activityRange: {
                              ...(props.filters.activityRange?.to === undefined
                                ? {}
                                : { to: props.filters.activityRange.to }),
                              from: event.currentTarget.value,
                            },
                          })
                        }
                        onKeyDown={(event) => event.stopPropagation()}
                        type="date"
                        value={props.filters.activityRange?.from ?? ""}
                      />
                    </OctantField>
                    <OctantField className="gap-1 px-2 py-1.5">
                      <OctantFieldLabel>To</OctantFieldLabel>
                      <OctantInput
                        aria-describedby={
                          activityRangeError === undefined ? undefined : activityRangeErrorId
                        }
                        aria-invalid={activityRangeError === undefined ? undefined : true}
                        aria-label="Activity to"
                        onChange={(event) =>
                          update({
                            activityRange: {
                              ...(props.filters.activityRange?.from === undefined
                                ? {}
                                : { from: props.filters.activityRange.from }),
                              to: event.currentTarget.value,
                            },
                          })
                        }
                        onKeyDown={(event) => event.stopPropagation()}
                        type="date"
                        value={props.filters.activityRange?.to ?? ""}
                      />
                    </OctantField>
                    {activityRangeError === undefined ? null : (
                      <p
                        className="px-2 pb-1.5 text-sm text-destructive"
                        id={activityRangeErrorId}
                        role="alert"
                      >
                        {activityRangeError}
                      </p>
                    )}
                  </>
                ) : null}
              </OctantMenuSubPopup>
            </OctantMenuSub>
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

function FilterRadioSubmenu(props: {
  readonly label: string;
  readonly onValueChange: (value: string) => void;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly value: string;
}) {
  return (
    <OctantMenuSub>
      <OctantMenuSubTrigger>{props.label}</OctantMenuSubTrigger>
      <OctantMenuSubPopup>
        <OctantMenuRadioGroup
          onValueChange={(value) => {
            if (typeof value === "string") props.onValueChange(value);
          }}
          value={props.value}
        >
          {props.options.map((option) => (
            <OctantMenuRadioItem closeOnClick={false} key={option.id} value={option.id}>
              {option.label}
            </OctantMenuRadioItem>
          ))}
        </OctantMenuRadioGroup>
      </OctantMenuSubPopup>
    </OctantMenuSub>
  );
}

function CodeProjectViewEditorDialog(props: {
  readonly mode: "create" | "edit";
  readonly onClose: () => void;
  readonly onSave: (input: CodeProjectViewInput) => void;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly view?: CodeProjectView;
}) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(props.view?.name ?? "");
  const [icon, setIcon] = useState<CodeProjectViewIcon>(
    props.view?.icon ?? DEFAULT_CODE_PROJECT_VIEW_ICON,
  );
  const [color, setColor] = useState<CodeProjectViewColor>(
    props.view?.color ?? DEFAULT_CODE_PROJECT_VIEW_COLOR,
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(props.view?.projectIds ?? []),
  );
  const title = props.mode === "create" ? "New project view" : "Edit project view";

  function toggle(projectId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalized = name.trim();
    if (normalized === "") return;
    props.onSave({
      id: props.view?.id ?? createCodeProjectViewId(),
      name: normalized,
      projectIds: [...selected],
      icon,
      color,
    });
  }

  return (
    <OctantDialog
      className="project-dialog"
      initialFocus={nameInputRef}
      label={title}
      onClose={props.onClose}
      open
      popupId="code-project-view-dialog"
    >
      <div className="project-dialog__header">
        <div>
          <span>Code</span>
          <h1>{title}</h1>
        </div>
        <OctantButton
          aria-label="Close project view"
          onClick={props.onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          ×
        </OctantButton>
      </div>
      <p>
        Choose which saved Code Projects appear in this sidebar view. Authority stays on each
        Project.
      </p>
      <form noValidate onSubmit={submit}>
        <label htmlFor="code-project-view-name">Project view name</label>
        <OctantInput
          id="code-project-view-name"
          onChange={(event) => setName(event.currentTarget.value)}
          placeholder="Main"
          ref={nameInputRef}
          required
          value={name}
        />
        <fieldset className="code-project-views__fieldset">
          <legend>Icon</legend>
          <div className="code-project-views__swatches">
            {CODE_PROJECT_VIEW_ICONS.map((candidate) => (
              <OctantButton
                aria-label={CODE_PROJECT_VIEW_ICON_LABELS[candidate]}
                aria-pressed={candidate === icon}
                className="code-project-views__swatch"
                key={candidate}
                onClick={() => setIcon(candidate)}
                size="icon"
                title={CODE_PROJECT_VIEW_ICON_LABELS[candidate]}
                type="button"
                variant="ghost"
              >
                <CodeProjectViewGlyph color={color} icon={candidate} size={16} />
              </OctantButton>
            ))}
          </div>
        </fieldset>
        <fieldset className="code-project-views__fieldset">
          <legend>Color</legend>
          <div className="code-project-views__swatches">
            {CODE_PROJECT_VIEW_COLORS.map((candidate) => (
              <OctantButton
                aria-label={CODE_PROJECT_VIEW_COLOR_LABELS[candidate]}
                aria-pressed={candidate === color}
                className="code-project-views__swatch"
                key={candidate}
                onClick={() => setColor(candidate)}
                size="icon"
                title={CODE_PROJECT_VIEW_COLOR_LABELS[candidate]}
                type="button"
                variant="ghost"
              >
                <span
                  aria-hidden="true"
                  className="code-project-views__color-dot"
                  data-view-color={candidate}
                />
              </OctantButton>
            ))}
          </div>
        </fieldset>
        <fieldset className="code-project-views__fieldset">
          <legend>Projects</legend>
          {props.projects.map((project) => (
            <label className="code-project-views__choice" key={project.id}>
              <OctantCheckbox
                checked={selected.has(String(project.id))}
                onChange={() => toggle(String(project.id))}
              />
              <span>{project.name}</span>
            </label>
          ))}
        </fieldset>
        <div className="project-dialog__actions">
          <OctantButton
            onClick={props.onClose}
            type="button"
            className="project-button project-button--quiet"
            variant="ghost"
          >
            Cancel
          </OctantButton>
          <OctantButton disabled={name.trim() === ""} type="submit">
            {props.mode === "create" ? "Create project view" : "Save project view"}
          </OctantButton>
        </div>
      </form>
    </OctantDialog>
  );
}

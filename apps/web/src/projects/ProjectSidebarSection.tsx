import type { ProjectAvailability, ProjectId, ProjectSummary } from "@octant/contracts/projects";
import type { ProjectViewSwitcherPresentation } from "@octant/contracts/shell";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
  Box,
  Briefcase,
  Bug,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code,
  Flag,
  Folder,
  FolderGit,
  Inbox,
  Layers,
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
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";
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
  readCodeProjectViewState,
  selectCodeProjectView,
  updateCodeProjectView,
  visibleCodeProjects,
  writeCodeProjectViewState,
  type CodeProjectView,
  type CodeProjectViewColor,
  type CodeProjectViewIcon,
  type CodeProjectViewInput,
  type CodeProjectViewState,
} from "../code/codeProjectViewModel";
import {
  buildSidebarActivityView,
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
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type ThreadGroupId = "recents" | "all" | "unfiled";
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
  readonly unfiledLabel?: "Unfiled" | "Recents";
  readonly threads?: ReadonlyArray<ChatThreadNavigationItem>;
  readonly threadGroups?: Readonly<Record<ThreadGroupId, ReadonlyArray<ChatThreadNavigationItem>>>;
  readonly threadStatus?: "loading" | "ready" | "unavailable";
  readonly threadErrorMessage?: string;
  readonly onRetryThreads?: () => void;
  readonly projectViewsEnabled?: boolean;
  readonly projectViewSwitcherPresentation?: ProjectViewSwitcherPresentation;
  readonly now?: Date;
  readonly activityMode?: SidebarActivityMode;
}

export function ProjectSidebarSection(props: ProjectSidebarSectionProps) {
  const [projectSort, setProjectSort] = useState<ProjectSort>("manual");
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<ProjectId>>(
    () => new Set(),
  );
  const [focusedProjectThreads, setFocusedProjectThreads] = useState<ProjectId>();
  const [projectViewState, setProjectViewState] = useState(() =>
    props.projectViewsEnabled === true ? readCodeProjectViewState() : undefined,
  );
  const [projectViewEditor, setProjectViewEditor] = useState<
    { readonly mode: "create" } | { readonly mode: "edit"; readonly viewId: string } | undefined
  >();
  const activityMode = props.activityMode ?? "chat";
  const [activityView, setActivityView] = useState(() =>
    readActivityViewEnabled(undefined, globalThis, activityMode),
  );
  const threads = props.threadGroups?.all ?? props.threads;
  const visibleProjects =
    props.projectViewsEnabled === true && projectViewState !== undefined
      ? visibleCodeProjects(
          props.projects.map((project) => ({ ...project, id: String(project.id) })),
          projectViewState,
        ).flatMap((visible) => {
          const match = props.projects.find((project) => String(project.id) === visible.id);
          return match === undefined ? [] : [match];
        })
      : props.projects;
  const pinned = sortProjects(
    visibleProjects.filter((project) => project.pinned),
    projectSort,
  );
  const ordinary = sortProjects(
    visibleProjects.filter((project) => !project.pinned),
    projectSort,
  );
  const onNewThread = props.onNewThreadInProject ?? props.onNewChatInProject;
  const newThreadVerb = props.newThreadVerb ?? "chat";
  const nestThreads = threads !== undefined && props.onSelectThread !== undefined;
  const threadsByProject = nestThreads
    ? groupThreadsByProject(threads!, props.projects)
    : undefined;
  const unfiled = threadsByProject?.unfiled ?? [];
  const unfiledLabel = props.unfiledLabel ?? "Unfiled";
  const activity = useMemo(
    () =>
      buildSidebarActivityView({
        ...(props.now === undefined ? {} : { now: props.now }),
        projects: props.projects.map((project) => ({
          id: String(project.id),
          name: project.name,
        })),
        unfiledLabel,
        threads: threads ?? [],
      }),
    [props.now, props.projects, unfiledLabel, threads],
  );

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
      setProjectViewState((current) => current ?? readCodeProjectViewState());
      return;
    }
    setProjectViewState(undefined);
    setProjectViewEditor(undefined);
  }, [props.projectViewsEnabled]);

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
    writeCodeProjectViewState(next);
  }

  const editingView =
    projectViewEditor?.mode === "edit"
      ? projectViewState?.views.find((view) => view.id === projectViewEditor.viewId)
      : undefined;

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
      {props.projects.length === 0 && unfiled.length === 0 ? (
        <p className="project-nav__empty">No Projects in this mode.</p>
      ) : null}
      {nestThreads && activityView ? (
        <ActivityThreadList
          {...(props.activeThreadId === undefined ? {} : { activeThreadId: props.activeThreadId })}
          groups={activity.groups}
          onSelectThread={props.onSelectThread!}
        />
      ) : (
        <>
          <ProjectGroup
            {...(props.activeProjectId === undefined
              ? {}
              : { activeProjectId: props.activeProjectId })}
            {...(props.activeThreadId === undefined
              ? {}
              : { activeThreadId: props.activeThreadId })}
            availabilityByProject={props.availabilityByProject}
            collapsedProjects={collapsedProjects}
            label="Pinned"
            onArchive={props.onArchive}
            onMove={props.onMove}
            {...(onNewThread === undefined
              ? {}
              : { newThreadVerb, onNewThreadInProject: onNewThread })}
            onReorder={props.onReorder}
            onProjectOpen={props.onProjectOpen}
            onToggleProject={toggleProject}
            {...(props.onSelectThread === undefined
              ? {}
              : { onSelectThread: props.onSelectThread })}
            projects={pinned}
            sort={projectSort}
            {...(threadsByProject === undefined
              ? {}
              : { threadsByProjectId: threadsByProject.byProjectId })}
          />
          <ProjectGroup
            {...(props.activeProjectId === undefined
              ? {}
              : { activeProjectId: props.activeProjectId })}
            {...(props.activeThreadId === undefined
              ? {}
              : { activeThreadId: props.activeThreadId })}
            availabilityByProject={props.availabilityByProject}
            collapsedProjects={collapsedProjects}
            label="Projects"
            onArchive={props.onArchive}
            onMove={props.onMove}
            {...(onNewThread === undefined
              ? {}
              : { newThreadVerb, onNewThreadInProject: onNewThread })}
            onReorder={props.onReorder}
            onProjectOpen={props.onProjectOpen}
            {...(props.onAddProject === undefined ? {} : { onAddProject: props.onAddProject })}
            {...(props.addProjectLabel === undefined
              ? {}
              : { addProjectLabel: props.addProjectLabel })}
            onSortChange={setProjectSort}
            onToggleProject={toggleProject}
            {...(props.onSelectThread === undefined
              ? {}
              : { onSelectThread: props.onSelectThread })}
            {...(props.threadActions === undefined ? {} : { threadActions: props.threadActions })}
            {...(props.onRenameThread === undefined
              ? {}
              : { onRenameThread: props.onRenameThread })}
            projects={ordinary}
            sort={projectSort}
            {...(threadsByProject === undefined
              ? {}
              : { threadsByProjectId: threadsByProject.byProjectId })}
          />
          {unfiled.length > 0 && props.onSelectThread !== undefined ? (
            <section aria-label={unfiledLabel} className="project-section project-section--unfiled">
              <h2>{unfiledLabel}</h2>
              <div className="project-threads">
                <ProjectThreadRows
                  {...(props.threadActions === undefined ? {} : { actions: props.threadActions })}
                  {...(props.activeThreadId === undefined
                    ? {}
                    : { activeThreadId: props.activeThreadId })}
                  {...(props.onRenameThread === undefined
                    ? {}
                    : { onRenameThread: props.onRenameThread })}
                  onSelectThread={props.onSelectThread}
                  threads={unfiled}
                />
              </div>
            </section>
          ) : null}
        </>
      )}
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
  readonly label: string;
  readonly onAddProject?: () => void;
  readonly addProjectLabel?: "chat-project" | "folder";
  readonly onArchive: (projectId: ProjectId) => void;
  readonly onMove: (projectId: ProjectId, pinned: boolean) => void;
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
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly sort?: ProjectSort;
  readonly threadsByProjectId?: ReadonlyMap<string, ReadonlyArray<ChatThreadNavigationItem>>;
}) {
  if (props.projects.length === 0 && props.label !== "Projects") return null;
  return (
    <section aria-label={props.label} className="project-section">
      <div className="project-section__header">
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
                trigger={<MoreHorizontal aria-hidden="true" size={15} strokeWidth={1.8} />}
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
        const nestedThreads = props.threadsByProjectId?.get(String(project.id)) ?? [];
        const showNested =
          props.onSelectThread !== undefined && props.threadsByProjectId !== undefined;
        const expanded = !props.collapsedProjects.has(project.id);
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
                <span className="project-row__disclosure" aria-hidden="true">
                  {showNested ? (
                    expanded ? (
                      <ChevronDown size={12} strokeWidth={1.8} />
                    ) : (
                      <ChevronRight size={12} strokeWidth={1.8} />
                    )
                  ) : null}
                </span>
                <Folder
                  aria-hidden="true"
                  className="project-row__folder"
                  size={15}
                  strokeWidth={1.7}
                />
                <span className="project-row__copy">
                  <span>{project.name}</span>
                  {unavailable ? <small>Relink required</small> : null}
                </span>
              </OctantButton>
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
                  <SquarePen aria-hidden="true" size={13} strokeWidth={1.7} />
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
                id={projectThreadListId(project.id)}
                label={`Threads in ${project.name}`}
                onSelectThread={props.onSelectThread!}
                threads={nestedThreads}
              />
            ) : null}
          </div>
        );
      })}
    </section>
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
  readonly previousProjectId?: ProjectId;
  readonly project: ProjectSummary;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        aria-label={`Project actions for ${props.project.name}`}
        className="project-row__action project-row__action--icon window-no-drag inline-flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
        ref={triggerRef}
      >
        <MoreHorizontal aria-hidden="true" size={14} strokeWidth={1.8} />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner align="end" className="z-50 window-no-drag" sideOffset={4}>
          <MenuPrimitive.Popup
            className="window-no-drag z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none"
            finalFocus={triggerRef}
          >
            <MenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              label="Open Project"
              onClick={() => props.onOpen(props.project)}
            >
              Open Project
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              label={props.project.pinned ? "Unpin Project" : "Pin Project"}
              onClick={() => props.onMove(props.project.id, !props.project.pinned)}
            >
              {props.project.pinned ? "Unpin Project" : "Pin Project"}
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              disabled={!props.canMoveUp}
              label="Move up"
              onClick={() =>
                props.onReorder(props.project.id, props.project.pinned, props.previousProjectId)
              }
            >
              Move up
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              disabled={!props.canMoveDown}
              label="Move down"
              onClick={() =>
                props.onReorder(
                  props.project.id,
                  props.project.pinned,
                  undefined,
                  props.nextProjectId,
                )
              }
            >
              Move down
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              label="Archive Project"
              onClick={() => props.onArchive(props.project.id)}
            >
              Archive Project
            </MenuPrimitive.Item>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
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
      icon={Inbox}
      label={props.enabled ? "Turn off activity view" : "Turn on activity view"}
      onClick={props.onToggle}
    />
  );
  return host === null ? button : createPortal(button, host);
}

function ActivityThreadList(props: {
  readonly activeThreadId?: string;
  readonly groups: ReturnType<typeof buildSidebarActivityView>["groups"];
  readonly onSelectThread: (threadId: string) => void;
}) {
  if (props.groups.length === 0) {
    return <p className="project-nav__empty">No threads in this mode.</p>;
  }
  return (
    <div className="activity-nav">
      {props.groups.map((group) => (
        <section aria-label={group.label} className="activity-nav__group" key={group.id}>
          <h2>{group.label}</h2>
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
          <ContextMenuPrimitive.Root>
            <ContextMenuPrimitive.Trigger
              render={<span className="code-project-views__trigger-wrap" />}
            >
              <OctantMenu
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
            </ContextMenuPrimitive.Trigger>
            <CodeProjectViewMenu
              onDelete={props.onDelete}
              onEdit={props.onEdit}
              projectCount={props.projectCountFor(active.id)}
              view={active}
            />
          </ContextMenuPrimitive.Root>
          {newViewButton}
        </div>
      )}
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
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger
        render={
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
        }
      />
      <CodeProjectViewMenu
        onDelete={props.onDelete}
        onEdit={props.onEdit}
        projectCount={props.projectCount}
        view={props.view}
      />
    </ContextMenuPrimitive.Root>
  );
}

/** What a project view answers when it is asked about: how many Projects it
 * holds, and the two edits that only a saved view can take. */
function CodeProjectViewMenu(props: {
  readonly onDelete: (viewId: string) => void;
  readonly onEdit: (viewId: string) => void;
  readonly projectCount: number;
  readonly view: Pick<CodeProjectView, "id" | "name">;
}) {
  // All Projects is not a saved view: it has no definition to edit and nothing
  // to delete, so its menu says what it holds and stops there.
  const savedView = String(props.view.id) !== String(ALL_CODE_PROJECTS_VIEW_ID);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-50 window-no-drag">
        <ContextMenuPrimitive.Popup className="window-no-drag z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
          <ContextMenuPrimitive.Group>
            <ContextMenuPrimitive.GroupLabel className="px-2 py-1.5 text-xs text-muted-foreground">
              {props.view.name} &middot; Projects {props.projectCount}
            </ContextMenuPrimitive.GroupLabel>
          </ContextMenuPrimitive.Group>
          {savedView ? (
            <>
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                closeOnClick
                label="Edit view"
                onClick={() => props.onEdit(props.view.id)}
              >
                Edit view
              </ContextMenuPrimitive.Item>
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                closeOnClick
                label="Delete view"
                onClick={() => props.onDelete(props.view.id)}
              >
                Delete view
              </ContextMenuPrimitive.Item>
            </>
          ) : null}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

const MENU_ITEM_CLASS =
  "window-no-drag relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground";

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
      <form onSubmit={submit}>
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
          <OctantButton
            disabled={name.trim() === ""}
            type="submit"
            className="project-button project-button--primary"
            variant="ghost"
          >
            {props.mode === "create" ? "Create project view" : "Save project view"}
          </OctantButton>
        </div>
      </form>
    </OctantDialog>
  );
}

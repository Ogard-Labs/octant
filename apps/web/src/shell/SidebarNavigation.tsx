import {
  CircleDot,
  Columns3,
  FileStack,
  Folder,
  GitFork,
  GitPullRequest,
  Inbox,
  ImagePlus,
  ListTodo,
  Puzzle,
  SquarePen,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  buildSidebarNavigation,
  sidebarNavigationDescriptor,
  type SidebarNavigationDescriptorId,
  type SidebarNavigationInput,
} from "./navigationModel";
import { OctantButton } from "../ui/base/OctantButton";

export interface SidebarNavigationProps {
  readonly activeDestination?: SidebarNavigationDescriptorId;
  readonly actions: Partial<Readonly<Record<SidebarNavigationDescriptorId, () => void>>>;
  /** Row counts (e.g. threads waiting in the Inbox); zero and absent render nothing. */
  readonly counts?: Partial<Readonly<Record<SidebarNavigationDescriptorId, number>>>;
  readonly input: SidebarNavigationInput;
  /**
   * The More row that reveals the menu-only destinations, placed as the last
   * destination row, before the Project and thread lists.
   */
  readonly more?: ReactNode;
  readonly projectAction?: ReactNode;
  readonly projectSection?: ReactNode;
  /**
   * Resolved row order from the person's destination customization. Absent
   * falls back to the mode's default ordering.
   */
  readonly rows?: ReadonlyArray<SidebarNavigationDescriptorId>;
}

export function SidebarNavigation(props: SidebarNavigationProps) {
  const descriptors =
    props.rows === undefined
      ? buildSidebarNavigation(props.input)
      : props.rows.map((id) => sidebarNavigationDescriptor(id));

  // Thread content follows all static destinations, including More, even when
  // the Projects destination is reordered within the navigation group.
  const rows: ReactNode[] = [];
  let projectContent: ReactNode;
  for (const descriptor of descriptors) {
    if (descriptor.id === "projects") {
      const action = props.actions.projects;
      if (action !== undefined) {
        rows.push(
          <OctantButton
            aria-current={props.activeDestination === "projects" ? "page" : undefined}
            aria-label={descriptor.label}
            className="sidebar-item window-no-drag justify-start"
            data-navigation-id={descriptor.id}
            key={descriptor.id}
            onClick={() => action()}
            type="button"
            variant="ghost"
          >
            <Folder aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
            <span className="sidebar-label">{descriptor.label}</span>
          </OctantButton>,
        );
        if (props.projectSection !== undefined && props.projectSection !== null) {
          projectContent = (
            <div className="sidebar-navigation__project-threads">{props.projectSection}</div>
          );
        }
      } else if (props.projectSection !== undefined && props.projectSection !== null) {
        projectContent = (
          <div className="sidebar-navigation__projects">
            {props.projectAction}
            {props.projectSection}
          </div>
        );
      }
      continue;
    }
    const action = props.actions[descriptor.id];
    if (action === undefined) continue;
    const Icon = navigationIcon(descriptor.id);
    if (Icon === undefined) continue;
    const count = props.counts?.[descriptor.id] ?? 0;
    rows.push(
      <OctantButton
        // The name is stated outright rather than computed from the label
        // span: the compact sidebar clips that span to one pixel, and the
        // shell's accessibility tree has reported these rows as unnamed
        // buttons. The name always starts with the visible label.
        aria-label={count > 0 ? `${descriptor.label}, ${count} waiting` : descriptor.label}
        aria-current={props.activeDestination === descriptor.id ? "page" : undefined}
        className="sidebar-item window-no-drag justify-start"
        data-navigation-id={descriptor.id}
        key={descriptor.id}
        // Invoked without arguments: some handlers take an optional payload
        // (New chat's prompt) and must not receive the click event as one.
        onClick={() => action()}
        type="button"
        variant="ghost"
      >
        <Icon aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
        <span className="sidebar-label">{descriptor.label}</span>
        {count > 0 ? (
          <span aria-hidden="true" className="count">
            {count}
          </span>
        ) : null}
      </OctantButton>,
    );
  }
  return (
    <div className="sidebar-navigation">
      {rows}
      {props.more}
      {projectContent}
    </div>
  );
}

export function navigationIcon(id: SidebarNavigationDescriptorId) {
  switch (id) {
    case "new-chat":
    case "new-code-thread":
    case "new-work-thread":
      return SquarePen;
    case "automations":
      return Workflow;
    case "agents":
      return GitFork;
    case "plugins":
      return Puzzle;
    case "inbox":
      return Inbox;
    case "artifact-library":
      return FileStack;
    case "image-library":
      return ImagePlus;
    case "thread-board":
      return Columns3;
    case "pull-requests":
      return GitPullRequest;
    case "github-issues":
      return CircleDot;
    case "linear-issues":
      return ListTodo;
    case "projects":
      return Folder;
    default:
      return undefined;
  }
}

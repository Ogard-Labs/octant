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
import { Fragment } from "react";
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
   * destination row — before the Project tree whenever Projects closes the
   * list.
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

  // The More row is the last destination row: it sits between the destination
  // rows and the Project tree when Projects closes the list, and after the
  // rows otherwise, so the reveal never drifts away from the rows it belongs
  // with — however the person reordered or hid Projects.
  const projectsLast = descriptors[descriptors.length - 1]?.id === "projects";
  const rows: ReactNode[] = [];
  let morePending = props.more !== undefined;
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
          rows.push(
            <div className="sidebar-navigation__project-threads" key="project-threads">
              {props.projectSection}
            </div>,
          );
        }
      } else if (props.projectSection !== undefined && props.projectSection !== null) {
        if (projectsLast && morePending) {
          rows.push(<Fragment key="sidebar-more">{props.more}</Fragment>);
          morePending = false;
        }
        rows.push(
          <div className="sidebar-navigation__projects" key={descriptor.id}>
            {props.projectAction}
            {props.projectSection}
          </div>,
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
  if (morePending) {
    rows.push(<Fragment key="sidebar-more">{props.more}</Fragment>);
  }
  return <div className="sidebar-navigation">{rows}</div>;
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

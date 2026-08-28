import {
  CircleDot,
  Columns3,
  FileStack,
  GitFork,
  GitPullRequest,
  ListTodo,
  Puzzle,
  SquarePen,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  buildSidebarNavigation,
  type SidebarNavigationDescriptorId,
  type SidebarNavigationInput,
} from "./navigationModel";
import { OctantButton } from "../ui/base/OctantButton";

export interface SidebarNavigationProps {
  readonly actions: Partial<Readonly<Record<SidebarNavigationDescriptorId, () => void>>>;
  readonly input: SidebarNavigationInput;
  readonly projectAction?: ReactNode;
  readonly projectSection?: ReactNode;
}

export function SidebarNavigation(props: SidebarNavigationProps) {
  const descriptors = buildSidebarNavigation(props.input);

  return (
    <div className="sidebar-navigation">
      {descriptors.map((descriptor) => {
        if (descriptor.id === "projects") {
          if (props.projectSection === undefined || props.projectSection === null) return null;
          return (
            <div className="sidebar-navigation__projects" key={descriptor.id}>
              {props.projectAction}
              {props.projectSection}
            </div>
          );
        }
        const action = props.actions[descriptor.id];
        if (action === undefined) return null;
        const Icon = navigationIcon(descriptor.id);
        if (Icon === undefined) return null;
        return (
          <OctantButton
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
          </OctantButton>
        );
      })}
    </div>
  );
}

function navigationIcon(id: SidebarNavigationDescriptorId) {
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
    case "artifact-library":
      return FileStack;
    case "thread-board":
      return Columns3;
    case "pull-requests":
      return GitPullRequest;
    case "github-issues":
      return CircleDot;
    case "linear-issues":
      return ListTodo;
    default:
      return undefined;
  }
}

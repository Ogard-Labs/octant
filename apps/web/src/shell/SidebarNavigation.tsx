import {
  Blocks,
  Bot,
  Code2,
  GitPullRequest,
  Kanban,
  Library,
  MessageSquarePlus,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  buildSidebarNavigation,
  type SidebarNavigationDescriptorId,
  type SidebarNavigationInput,
} from "./navigationModel";

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
          <button
            className="sidebar-item window-no-drag"
            data-navigation-id={descriptor.id}
            key={descriptor.id}
            // Invoked without arguments: some handlers take an optional payload
            // (New chat's prompt) and must not receive the click event as one.
            onClick={() => action()}
            type="button"
          >
            <Icon aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
            <span className="sidebar-label">{descriptor.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function navigationIcon(id: SidebarNavigationDescriptorId) {
  switch (id) {
    case "new-chat":
      return MessageSquarePlus;
    case "new-code-thread":
      return Code2;
    case "new-work-thread":
      return MessageSquarePlus;
    case "automations":
      return Bot;
    case "agents":
      return Users;
    case "plugins":
      return Blocks;
    case "artifact-library":
      return Library;
    case "thread-board":
      return Kanban;
    case "pull-requests":
      return GitPullRequest;
    default:
      return undefined;
  }
}

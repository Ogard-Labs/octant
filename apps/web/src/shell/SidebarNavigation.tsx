import { Blocks, Bot, Code2, GitPullRequest, Kanban, MessageSquarePlus } from "lucide-react";
import type { ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
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
        if (descriptor.id === "new-chat") {
          const action = props.actions["new-chat"];
          if (action === undefined) return null;
          return (
            <OctantButton
              className="sidebar-navigation__item sidebar__utility justify-start"
              data-navigation-id={descriptor.id}
              key={descriptor.id}
              onClick={() => action()}
              type="button"
              variant="ghost"
            >
              <MessageSquarePlus aria-hidden="true" size={14} strokeWidth={1.7} />
              <span>{descriptor.label}</span>
            </OctantButton>
          );
        }
        const action = props.actions[descriptor.id];
        if (action === undefined) return null;
        const Icon = navigationIcon(descriptor.id);
        if (Icon === undefined) return null;
        return (
          <OctantButton
            className="sidebar-navigation__item sidebar__utility justify-start"
            data-navigation-id={descriptor.id}
            key={descriptor.id}
            onClick={action}
            type="button"
            variant="ghost"
          >
            <Icon aria-hidden="true" size={14} strokeWidth={1.7} />
            <span>{descriptor.label}</span>
          </OctantButton>
        );
      })}
    </div>
  );
}

function navigationIcon(id: SidebarNavigationDescriptorId) {
  switch (id) {
    case "new-code-thread":
      return Code2;
    case "new-work-thread":
      return MessageSquarePlus;
    case "automations":
      return Bot;
    case "plugins":
      return Blocks;
    case "thread-board":
      return Kanban;
    case "pull-requests":
      return GitPullRequest;
    default:
      return undefined;
  }
}

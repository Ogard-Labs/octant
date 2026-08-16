import { useState } from "react";
import type { CodeThreadNavigationItem } from "./useCodeController";
import { OctantButton } from "../ui/base/OctantButton";

export interface CodeSidebarSectionProps {
  readonly activeThreadId?: string;
  readonly onSelectThread: (threadId: string) => void;
  readonly threads: ReadonlyArray<CodeThreadNavigationItem>;
}

export function CodeSidebarSection(props: CodeSidebarSectionProps) {
  const [followUpOnly, setFollowUpOnly] = useState(false);
  if (props.threads.length === 0) {
    return <p className="project-nav__status">No Code threads in this Project.</p>;
  }
  const hasFollowUp = props.threads.some((thread) => thread.followUp === true);
  const visible = followUpOnly
    ? props.threads.filter((thread) => thread.followUp === true)
    : props.threads;
  return (
    <nav aria-label="Code threads" className="sidebar-navigation__threads">
      {hasFollowUp ? (
        <label className="sidebar-navigation__thread-filter">
          <input
            checked={followUpOnly}
            onChange={(event) => setFollowUpOnly(event.target.checked)}
            type="checkbox"
          />
          <span>Follow-up only</span>
        </label>
      ) : null}
      {visible.length === 0 ? (
        <p className="project-nav__status">No Code threads need follow-up.</p>
      ) : null}
      {visible.map((thread) => (
        <OctantButton
          aria-current={props.activeThreadId === String(thread.threadId) ? "page" : undefined}
          className="sidebar-navigation__thread"
          data-code-lifecycle={thread.lifecycle}
          data-execution-policy={thread.executionPolicy}
          data-follow-up={
            thread.followUp === undefined ? undefined : thread.followUp ? "true" : "false"
          }
          data-thread-id={thread.threadId}
          key={thread.threadId}
          onClick={() => props.onSelectThread(String(thread.threadId))}
          type="button"
          variant="ghost"
        >
          <span className="sidebar-navigation__thread-title">{thread.title}</span>
          <span className="sidebar-navigation__thread-meta">
            {lifecycleLabel(thread.lifecycle)}
          </span>
          <span className="sidebar-navigation__thread-meta">
            {policyLabel(thread.executionPolicy)}
          </span>
          {thread.followUp ? (
            <span className="sidebar-navigation__thread-follow-up" data-indicator="follow-up">
              Follow-up
            </span>
          ) : null}
        </OctantButton>
      ))}
    </nav>
  );
}

function lifecycleLabel(lifecycle: CodeThreadNavigationItem["lifecycle"]): string {
  switch (lifecycle) {
    case "active":
      return "Active";
    case "waiting":
      return "Waiting";
    case "interrupted":
      return "Interrupted";
    case "archived":
      return "Archived";
  }
}

function policyLabel(policy: CodeThreadNavigationItem["executionPolicy"]): string {
  switch (policy) {
    case "plan":
      return "Plan · read-only";
    case "approval-gated":
      return "Approval gated";
    case "auto-accept-edits":
      return "Auto-accept edits";
    case "full-access":
      return "Full access";
  }
}

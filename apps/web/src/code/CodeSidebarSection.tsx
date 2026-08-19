import { useState } from "react";
import { Pin, PinOff } from "lucide-react";
import type { CodeThreadNavigationItem } from "./useCodeController";
import { ThreadRenameField } from "../projects/ThreadRenameField";
import { OctantButton } from "../ui/base/OctantButton";

export interface CodeSidebarSectionProps {
  readonly activeThreadId?: string;
  readonly onSelectThread: (threadId: string) => void;
  readonly threads: ReadonlyArray<CodeThreadNavigationItem>;
  /** Absent when the host cannot accept a rename, which hides the affordance. */
  readonly onRenameThread?: (threadId: string, title: string) => void;
  /** Absent when the host cannot accept a pin, which hides the affordance. */
  readonly onPinThread?: (threadId: string, pinned: boolean) => void;
}

export function CodeSidebarSection(props: CodeSidebarSectionProps) {
  const [followUpOnly, setFollowUpOnly] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string>();
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
      {visible.map((thread) => {
        const threadId = String(thread.threadId);
        if (props.onRenameThread !== undefined && renamingThreadId === threadId) {
          return (
            <ThreadRenameField
              key={threadId}
              label="Rename Code thread"
              onCancel={() => setRenamingThreadId(undefined)}
              onRename={(title) => {
                setRenamingThreadId(undefined);
                props.onRenameThread?.(threadId, title);
              }}
              title={thread.title}
            />
          );
        }
        return (
          <div className="sidebar-navigation__thread-row" key={threadId}>
            <OctantButton
              aria-current={props.activeThreadId === threadId ? "page" : undefined}
              className="sidebar-navigation__thread"
              data-code-lifecycle={thread.lifecycle}
              data-execution-policy={thread.executionPolicy}
              data-follow-up={
                thread.followUp === undefined ? undefined : thread.followUp ? "true" : "false"
              }
              data-pinned={thread.pinned === true ? "true" : undefined}
              data-thread-id={thread.threadId}
              // Renaming from the keyboard needs no pointer; F2 is the platform
              // convention and the double-click is the pointer equivalent.
              onDoubleClick={() => setRenamingThreadId(threadId)}
              onKeyDown={(event) => {
                if (event.key !== "F2" || props.onRenameThread === undefined) return;
                event.preventDefault();
                setRenamingThreadId(threadId);
              }}
              onClick={() => props.onSelectThread(threadId)}
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
              {thread.pinned === true ? (
                <span className="sidebar-navigation__thread-meta" data-indicator="pinned">
                  Pinned
                </span>
              ) : null}
              {/* Stated in words, not by a coloured dot alone, so the mark
                survives a reader who cannot see the colour. */}
              {thread.unread === true ? (
                <span className="sidebar-navigation__thread-unread" data-indicator="unread">
                  New activity
                </span>
              ) : null}
              {thread.followUp ? (
                <span className="sidebar-navigation__thread-follow-up" data-indicator="follow-up">
                  Follow-up
                </span>
              ) : null}
            </OctantButton>
            {props.onPinThread === undefined ? null : (
              <OctantButton
                aria-label={
                  thread.pinned === true ? `Unpin ${thread.title}` : `Pin ${thread.title}`
                }
                aria-pressed={thread.pinned === true}
                className="sidebar-navigation__thread-pin"
                onClick={() => props.onPinThread?.(threadId, thread.pinned !== true)}
                type="button"
                variant="ghost"
              >
                {thread.pinned === true ? (
                  <PinOff aria-hidden="true" size={13} strokeWidth={1.8} />
                ) : (
                  <Pin aria-hidden="true" size={13} strokeWidth={1.8} />
                )}
              </OctantButton>
            )}
          </div>
        );
      })}
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

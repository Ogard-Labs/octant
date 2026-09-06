import type {
  ChatThreadId,
  CodeThreadId,
  HostId,
  ProjectId,
  WorkspaceTab,
  WorkThreadId,
} from "@octant/contracts";
import type { OctantMode } from "@octant/contracts/modes";
import type { ThreadBoardPullRequestState } from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { Cloud, Laptop, Pin, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";

/** The pull request a thread delivers to, worn on its tab as "PR #n". */
export interface WorkspaceThreadTabPullRequest {
  readonly number: number;
  readonly state: ThreadBoardPullRequestState;
}

export type WorkspaceThreadTab =
  | {
      readonly key: string;
      readonly mode: "chat";
      readonly threadId: ChatThreadId;
      readonly title: string;
      readonly projectId?: ProjectId;
      readonly projectLabel?: string;
    }
  | {
      readonly key: string;
      readonly mode: "work";
      readonly threadId: WorkThreadId;
      readonly title: string;
      readonly projectId?: ProjectId;
      readonly projectLabel?: string;
      readonly hostId?: HostId;
    }
  | {
      readonly key: string;
      readonly mode: "code";
      readonly threadId: CodeThreadId;
      readonly title: string;
      readonly projectId?: ProjectId;
      readonly projectLabel?: string;
      readonly hostId?: HostId;
      readonly pullRequest?: WorkspaceThreadTabPullRequest;
    };

interface OpenWorkspaceThreadTab {
  readonly tab: WorkspaceThreadTab;
  readonly pinned: boolean;
}

export interface WorkspaceThreadTabsProps {
  readonly activeTab?: WorkspaceThreadTab;
  readonly contextLabel?: string;
  readonly fallbackTitle: string;
  readonly mode: OctantMode;
  readonly onActivate: (tab: WorkspaceThreadTab) => void;
}

export function workspaceThreadTabFromSurface(
  surface: WorkspaceTab,
  projectId: ProjectId | undefined,
  titleOverride?: string,
  projectLabel?: string,
  pullRequest?: WorkspaceThreadTabPullRequest,
): WorkspaceThreadTab | undefined {
  const title = titleOverride ?? surface.title;
  const container = {
    ...(projectId === undefined ? {} : { projectId }),
    ...(projectLabel === undefined ? {} : { projectLabel }),
  };
  if (surface.kind === "chat-thread") {
    return {
      key: `chat:${String(surface.threadId)}`,
      mode: "chat",
      threadId: surface.threadId,
      title,
      ...container,
    };
  }
  if (surface.kind === "work-thread") {
    return {
      key: `work:${String(surface.hostId ?? "local")}:${String(surface.threadId)}`,
      mode: "work",
      threadId: surface.threadId,
      title,
      ...container,
      ...(surface.hostId === undefined ? {} : { hostId: surface.hostId }),
    };
  }
  if (surface.kind !== "code-overview") return undefined;
  return {
    key: `code:${String(surface.hostId ?? "local")}:${String(surface.threadId)}`,
    mode: "code",
    threadId: surface.threadId,
    title,
    ...container,
    ...(surface.hostId === undefined ? {} : { hostId: surface.hostId }),
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

/**
 * Where the thread runs, which is the first thing a person needs to know
 * about a tab: a laptop for this machine, a cloud for a paired host. A tab
 * with no host is local — only Work and Code carry one, and Chat never
 * leaves the machine it was started on.
 */
function runsOnThisMachine(tab: WorkspaceThreadTab): boolean {
  if (tab.mode === "chat") return true;
  return tab.hostId === undefined || String(tab.hostId) === String(LOCAL_HOST_ID);
}

/**
 * Window-local thread switching layered over the authoritative pane layout.
 *
 * One unpinned tab acts as the current preview. Pinning it keeps the thread in
 * the strip when another thread opens. Activating a tab still routes through
 * the ordinary server-authorized open command; this component retains only
 * presentation history and never owns thread or Project authority.
 */
export function WorkspaceThreadTabs(props: WorkspaceThreadTabsProps) {
  const [open, setOpen] = useState<ReadonlyArray<OpenWorkspaceThreadTab>>([]);
  const activeKey = props.activeTab?.key;

  useEffect(() => {
    if (props.activeTab === undefined) return;
    const active = props.activeTab;
    setOpen((current) => {
      const existing = current.find((entry) => entry.tab.key === active.key);
      const retained = current.filter((entry) => entry.pinned || entry.tab.key === active.key);
      const updated = { tab: active, pinned: existing?.pinned ?? false };
      const index = retained.findIndex((entry) => entry.tab.key === active.key);
      if (index < 0) return [...retained, updated];
      return retained.map((entry, entryIndex) => (entryIndex === index ? updated : entry));
    });
  }, [props.activeTab]);

  function activateRelative(event: KeyboardEvent<HTMLDivElement>) {
    if (open.length === 0) return;
    const current = Math.max(
      0,
      open.findIndex((entry) => entry.tab.key === activeKey),
    );
    let next: OpenWorkspaceThreadTab | undefined;
    if (event.key === "ArrowRight") next = open[(current + 1) % open.length];
    else if (event.key === "ArrowLeft") next = open[(current - 1 + open.length) % open.length];
    else if (event.key === "Home") next = open[0];
    else if (event.key === "End") next = open.at(-1);
    if (next === undefined) return;
    event.preventDefault();
    props.onActivate(next.tab);
  }

  function closeTab(key: string) {
    const index = open.findIndex((entry) => entry.tab.key === key);
    if (index < 0) return;
    const remaining = open.filter((entry) => entry.tab.key !== key);
    setOpen(remaining);
    if (key !== activeKey) return;
    const fallback = remaining[index] ?? remaining[index - 1];
    if (fallback !== undefined) props.onActivate(fallback.tab);
  }

  return (
    <header className="workspace-thread-tabs window-drag-region">
      <div
        aria-label="Open threads"
        className="workspace-thread-tabs__list window-no-drag"
        onKeyDown={activateRelative}
        role="tablist"
      >
        {open.map((entry) => (
          <span
            className="workspace-thread-tabs__item"
            data-active={entry.tab.key === activeKey ? "true" : "false"}
            data-pinned={entry.pinned ? "true" : "false"}
            key={entry.tab.key}
          >
            <OctantButton
              aria-selected={entry.tab.key === activeKey}
              className="workspace-thread-tabs__select"
              onClick={() => props.onActivate(entry.tab)}
              role="tab"
              size="sm"
              tabIndex={entry.tab.key === activeKey ? 0 : -1}
              title={tabTitle(entry.tab, props.contextLabel)}
              type="button"
              variant="ghost"
            >
              {/* Where the thread runs is stated in the tab's tooltip, not as a
                  label on the glyph: an icon that names itself joins the tab's
                  accessible name, so every tab would announce as "Runs on this
                  machine <title>" instead of the thread the person asked for. */}
              {runsOnThisMachine(entry.tab) ? (
                <Laptop
                  aria-hidden="true"
                  className="workspace-thread-tabs__where"
                  size={14}
                  strokeWidth={1.7}
                />
              ) : (
                <Cloud
                  aria-hidden="true"
                  className="workspace-thread-tabs__where"
                  size={14}
                  strokeWidth={1.7}
                />
              )}
              {entry.tab.mode === "code" && entry.tab.pullRequest !== undefined ? (
                <span
                  className="workspace-thread-tabs__pr"
                  data-state={entry.tab.pullRequest.state}
                  title={`Pull request #${String(entry.tab.pullRequest.number)} · ${entry.tab.pullRequest.state}`}
                >
                  PR #{String(entry.tab.pullRequest.number)}
                </span>
              ) : null}
              <span className="workspace-thread-tabs__title">{entry.tab.title}</span>
              {/* The chip repeats what the tab's tooltip already states, so it
                  stays out of the accessible name: joined to the title it read
                  as one run-together word ("First threadPlanning"). */}
              {projectNameFor(entry.tab, props.contextLabel) === undefined ? null : (
                <span aria-hidden="true" className="workspace-thread-tabs__project">
                  {projectNameFor(entry.tab, props.contextLabel)}
                </span>
              )}
            </OctantButton>
            <OctantButton
              aria-label={`${entry.pinned ? "Unpin" : "Pin"} ${entry.tab.title}`}
              aria-pressed={entry.pinned}
              className="workspace-thread-tabs__pin"
              onClick={() =>
                setOpen((current) =>
                  current.map((candidate) =>
                    candidate.tab.key === entry.tab.key
                      ? { ...candidate, pinned: !candidate.pinned }
                      : candidate,
                  ),
                )
              }
              size="icon"
              title={`${entry.pinned ? "Unpin" : "Pin"} ${entry.tab.title}`}
              type="button"
              variant="ghost"
            >
              <Pin aria-hidden="true" size={12} strokeWidth={1.8} />
            </OctantButton>
            <OctantButton
              aria-label={`Close ${entry.tab.title}`}
              className="workspace-thread-tabs__close"
              onClick={() => closeTab(entry.tab.key)}
              size="icon"
              title={`Close ${entry.tab.title}`}
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" size={12} strokeWidth={1.8} />
            </OctantButton>
          </span>
        ))}
      </div>
      {activeKey === undefined ? (
        <span className="workspace-thread-tabs__surface">{props.fallbackTitle}</span>
      ) : null}
      <span aria-hidden="true" className="workspace-thread-tabs__drag-space" />
    </header>
  );
}

/**
 * The Project a tab belongs to. A tab that was opened before its Project was
 * resolved falls back to the pane's own container rather than showing nothing,
 * because the alternative reads as "this thread has no Project" — which a Work
 * or Code thread never is.
 */
function projectNameFor(tab: WorkspaceThreadTab, contextLabel?: string): string | undefined {
  return tab.projectLabel ?? contextLabel;
}

function tabTitle(tab: WorkspaceThreadTab, contextLabel?: string): string {
  const project = projectNameFor(tab, contextLabel);
  const where = runsOnThisMachine(tab) ? "this machine" : "a paired host";
  return project === undefined ? `${tab.title} — ${where}` : `${tab.title} — ${project} — ${where}`;
}

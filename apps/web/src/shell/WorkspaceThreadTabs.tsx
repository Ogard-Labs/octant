import type {
  ChatThreadId,
  CodeThreadId,
  HostId,
  ProjectId,
  WorkspaceTab,
  WorkThreadId,
} from "@octant/contracts";
import type { OctantMode } from "@octant/contracts/modes";
import { Folder, Pin, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export type WorkspaceThreadTab =
  | {
      readonly key: string;
      readonly mode: "chat";
      readonly threadId: ChatThreadId;
      readonly title: string;
      readonly projectId?: ProjectId;
    }
  | {
      readonly key: string;
      readonly mode: "work";
      readonly threadId: WorkThreadId;
      readonly title: string;
      readonly projectId?: ProjectId;
      readonly hostId?: HostId;
    }
  | {
      readonly key: string;
      readonly mode: "code";
      readonly threadId: CodeThreadId;
      readonly title: string;
      readonly projectId?: ProjectId;
      readonly hostId?: HostId;
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
): WorkspaceThreadTab | undefined {
  const title = titleOverride ?? surface.title;
  if (surface.kind === "chat-thread") {
    return {
      key: `chat:${String(surface.threadId)}`,
      mode: "chat",
      threadId: surface.threadId,
      title,
      ...(projectId === undefined ? {} : { projectId }),
    };
  }
  if (surface.kind === "work-thread") {
    return {
      key: `work:${String(surface.hostId ?? "local")}:${String(surface.threadId)}`,
      mode: "work",
      threadId: surface.threadId,
      title,
      ...(projectId === undefined ? {} : { projectId }),
      ...(surface.hostId === undefined ? {} : { hostId: surface.hostId }),
    };
  }
  if (surface.kind !== "code-overview") return undefined;
  return {
    key: `code:${String(surface.hostId ?? "local")}:${String(surface.threadId)}`,
    mode: "code",
    threadId: surface.threadId,
    title,
    ...(projectId === undefined ? {} : { projectId }),
    ...(surface.hostId === undefined ? {} : { hostId: surface.hostId }),
  };
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
      <div className="workspace-thread-tabs__context" title={props.contextLabel}>
        <Folder aria-hidden="true" size={16} strokeWidth={1.7} />
        <span>{props.contextLabel ?? modeLabel(props.mode)}</span>
        <span aria-hidden="true" className="workspace-thread-tabs__separator">
          /
        </span>
      </div>
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
              title={entry.tab.title}
              type="button"
              variant="ghost"
            >
              <span>{entry.tab.title}</span>
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

function modeLabel(mode: OctantMode): string {
  if (mode === "chat") return "Chat";
  if (mode === "work") return "Work";
  return "Code";
}

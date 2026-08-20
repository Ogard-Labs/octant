import type { ChatThreadId } from "@octant/contracts/chat";
import type { CodeThreadId } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import type { TabGroupId, WorkspaceLayoutNode, WorkspaceTab } from "@octant/contracts/shell";

export function activeSurfaceTitle(layout: WorkspaceLayoutNode, activeGroupId: TabGroupId): string {
  const group = findWorkspaceGroup(layout, activeGroupId);
  return group?.tabs.find((tab) => tab.id === group.activeTabId)?.title ?? "Octant";
}

export function activeChatThreadTabId(
  layout: WorkspaceLayoutNode,
  activeGroupId: TabGroupId,
): ChatThreadId | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  return tab?.kind === "chat-thread" ? tab.threadId : undefined;
}

export function activeDraftProjectId(
  layout: WorkspaceLayoutNode,
  activeGroupId: TabGroupId,
): ProjectId | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  return tab?.kind === "draft-thread" ? tab.projectId : undefined;
}

export function activeDraftTabKey(
  layout: WorkspaceLayoutNode,
  activeGroupId: TabGroupId,
): string | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  return tab?.kind === "draft-thread"
    ? `${String(tab.id)}:${tab.projectId === undefined ? "unfiled" : String(tab.projectId)}`
    : undefined;
}

/**
 * The local Code thread the focused group is showing. When the focused group
 * shows a utility surface (Browser, Files, Side Chat, Preview) instead, the
 * Code thread visible in a sibling split pane stays active so its transcript
 * is not unloaded just because the user clicked into the other pane.
 */
export function activeCodeThreadTabId(
  layout: WorkspaceLayoutNode,
  activeGroupId: TabGroupId,
): CodeThreadId | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  const focused = localCodeThreadTabId(tab);
  if (focused !== undefined) return focused;
  switch (tab?.kind) {
    case "browser":
    case "files":
    case "side-chat":
    case "preview":
      return visibleLocalCodeThreadTabId(layout);
    default:
      return undefined;
  }
}

/**
 * Every local Code thread this window has open, in any group of the Code tree.
 *
 * Keyed on the thread, not the tab: a thread's overview, diff, terminal, and
 * workbench are several tabs of one conversation, and giving each its own
 * controller would open the same thread's stream several times over.
 */
export function openLocalCodeThreadIds(layout: WorkspaceLayoutNode): ReadonlyArray<CodeThreadId> {
  const open: CodeThreadId[] = [];
  collect(layout);
  return open;

  function collect(node: WorkspaceLayoutNode): void {
    if (node.kind !== "group") {
      collect(node.first);
      collect(node.second);
      return;
    }
    for (const tab of node.tabs) {
      const threadId = openCodeTabThreadId(tab);
      if (threadId === undefined) continue;
      if (open.some((candidate) => String(candidate) === String(threadId))) continue;
      open.push(threadId);
    }
  }
}

function openCodeTabThreadId(tab: WorkspaceTab): CodeThreadId | undefined {
  const local = localCodeThreadTabId(tab);
  if (local !== undefined) return local;
  // An Apple workbench tab is bound to a Code thread like the other surfaces.
  // The active-thread lookup leaves it out because focus resting there does not
  // make it the thread in view; it still needs that thread's own controller.
  if (tab.kind !== "apple-workbench") return undefined;
  if ("hostId" in tab && tab.hostId !== undefined) return undefined;
  return tab.threadId;
}

function localCodeThreadTabId(tab: WorkspaceTab | undefined): CodeThreadId | undefined {
  if (tab !== undefined && "hostId" in tab && tab.hostId !== undefined) return undefined;
  switch (tab?.kind) {
    case "code-overview":
    case "code-file":
    case "code-diff":
    case "code-terminal":
    case "code-test":
    case "code-git":
    case "code-pr":
    case "code-local-review":
      return tab.threadId;
    default:
      return undefined;
  }
}

function visibleLocalCodeThreadTabId(layout: WorkspaceLayoutNode): CodeThreadId | undefined {
  if (layout.kind === "group") {
    return localCodeThreadTabId(layout.tabs.find((tab) => tab.id === layout.activeTabId));
  }
  return visibleLocalCodeThreadTabId(layout.first) ?? visibleLocalCodeThreadTabId(layout.second);
}

export function activeWorkThreadTabId(
  layout: WorkspaceLayoutNode,
  activeGroupId: TabGroupId,
): string | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  return tab?.kind === "work-thread" && tab.hostId === undefined ? String(tab.threadId) : undefined;
}

export function activeProjectTabId(
  layout: WorkspaceLayoutNode,
  activeGroupId: TabGroupId,
): ProjectId | undefined {
  const group = findWorkspaceGroup(layout, activeGroupId);
  if (group === undefined) return undefined;
  const tab = group.tabs.find((candidate) => candidate.id === group.activeTabId);
  return tab?.kind === "project" ? tab.projectId : undefined;
}

export function findWorkspaceGroup(
  layout: WorkspaceLayoutNode,
  groupId: TabGroupId,
): Extract<WorkspaceLayoutNode, { kind: "group" }> | undefined {
  if (layout.kind === "group") return layout.groupId === groupId ? layout : undefined;
  return findWorkspaceGroup(layout.first, groupId) ?? findWorkspaceGroup(layout.second, groupId);
}

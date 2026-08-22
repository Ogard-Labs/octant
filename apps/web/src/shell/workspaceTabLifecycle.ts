import type { ChatThreadId } from "@octant/contracts/chat";
import type { CodeThreadId } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import type {
  PaneId,
  WorkspaceLayoutNode,
  WorkspacePane,
  WorkspaceTab,
} from "@octant/contracts/shell";

export function activeSurfaceTitle(layout: WorkspaceLayoutNode, activePaneId: PaneId): string {
  return findWorkspacePane(layout, activePaneId)?.surface.title ?? "Octant";
}

export function activeChatThreadTabId(
  layout: WorkspaceLayoutNode,
  activePaneId: PaneId,
): ChatThreadId | undefined {
  const surface = findWorkspacePane(layout, activePaneId)?.surface;
  return surface?.kind === "chat-thread" ? surface.threadId : undefined;
}

export function activeDraftProjectId(
  layout: WorkspaceLayoutNode,
  activePaneId: PaneId,
): ProjectId | undefined {
  const surface = findWorkspacePane(layout, activePaneId)?.surface;
  return surface?.kind === "draft-thread" ? surface.projectId : undefined;
}

export function activeDraftTabKey(
  layout: WorkspaceLayoutNode,
  activePaneId: PaneId,
): string | undefined {
  const surface = findWorkspacePane(layout, activePaneId)?.surface;
  return surface?.kind === "draft-thread"
    ? `${String(surface.id)}:${surface.projectId === undefined ? "unfiled" : String(surface.projectId)}`
    : undefined;
}

/**
 * The local Code thread the active pane is showing. When the active pane shows
 * a utility surface (Browser, Files, Side Chat, Preview) instead, the Code
 * thread visible in a sibling pane stays active so its transcript is not
 * unloaded just because the user clicked into the other pane.
 */
export function activeCodeThreadTabId(
  layout: WorkspaceLayoutNode,
  activePaneId: PaneId,
): CodeThreadId | undefined {
  const surface = findWorkspacePane(layout, activePaneId)?.surface;
  const focused = localCodeThreadTabId(surface);
  if (focused !== undefined) return focused;
  switch (surface?.kind) {
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
 * Every local Code thread this window has open, in any pane of the Code tree.
 *
 * Keyed on the thread, not the surface: a thread's overview, terminal,
 * and workbench are several views of one conversation, and giving each its own
 * controller would open the same thread's stream several times over.
 */
export function openLocalCodeThreadIds(layout: WorkspaceLayoutNode): ReadonlyArray<CodeThreadId> {
  const open: CodeThreadId[] = [];
  collect(layout);
  return open;

  function collect(node: WorkspaceLayoutNode): void {
    if (node.kind !== "pane") {
      collect(node.first);
      collect(node.second);
      return;
    }
    const threadId = openCodeTabThreadId(node.surface);
    if (threadId === undefined) return;
    if (open.some((candidate) => String(candidate) === String(threadId))) return;
    open.push(threadId);
  }
}

function openCodeTabThreadId(surface: WorkspaceTab): CodeThreadId | undefined {
  const local = localCodeThreadTabId(surface);
  if (local !== undefined) return local;
  // An Apple workbench surface is bound to a Code thread like the others. The
  // active-thread lookup leaves it out because focus resting there does not
  // make it the thread in view; it still needs that thread's own controller.
  if (surface.kind !== "apple-workbench") return undefined;
  if ("hostId" in surface && surface.hostId !== undefined) return undefined;
  return surface.threadId;
}

function localCodeThreadTabId(surface: WorkspaceTab | undefined): CodeThreadId | undefined {
  if (surface !== undefined && "hostId" in surface && surface.hostId !== undefined)
    return undefined;
  switch (surface?.kind) {
    case "code-overview":
    case "code-file":
    case "code-terminal":
    case "code-test":
    case "code-git":
    case "code-pr":
    case "code-local-review":
      return surface.threadId;
    default:
      return undefined;
  }
}

function visibleLocalCodeThreadTabId(layout: WorkspaceLayoutNode): CodeThreadId | undefined {
  if (layout.kind === "pane") {
    return localCodeThreadTabId(layout.surface);
  }
  return visibleLocalCodeThreadTabId(layout.first) ?? visibleLocalCodeThreadTabId(layout.second);
}

export function activeWorkThreadTabId(
  layout: WorkspaceLayoutNode,
  activePaneId: PaneId,
): string | undefined {
  const surface = findWorkspacePane(layout, activePaneId)?.surface;
  return surface?.kind === "work-thread" && surface.hostId === undefined
    ? String(surface.threadId)
    : undefined;
}

export function activeProjectTabId(
  layout: WorkspaceLayoutNode,
  activePaneId: PaneId,
): ProjectId | undefined {
  const surface = findWorkspacePane(layout, activePaneId)?.surface;
  return surface?.kind === "project" ? surface.projectId : undefined;
}

export function findWorkspacePane(
  layout: WorkspaceLayoutNode,
  paneId: PaneId,
): WorkspacePane | undefined {
  if (layout.kind === "pane") {
    return String(layout.paneId) === String(paneId) ? layout : undefined;
  }
  return findWorkspacePane(layout.first, paneId) ?? findWorkspacePane(layout.second, paneId);
}

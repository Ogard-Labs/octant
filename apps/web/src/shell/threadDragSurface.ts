import { decodeChatThreadId, decodeCodeThreadId, decodeWorkThreadId } from "@octant/contracts";
import type { OctantMode } from "@octant/contracts/modes";
import { decodeWorkspaceTabId, type WorkspaceTab } from "@octant/contracts/shell";
import type { SidebarThreadDragRow } from "./useWorkspaceTabDrag";

/**
 * The mode a dragged sidebar row's thread belongs to. Chat and Work threads
 * share one list, so the window's active mode does not say which kind a row
 * is: with a Chat thread in the active pane, a Work row dragged out was
 * minted as a Chat thread, and the host refused the drop ("This surface could
 * not be resolved to an active Project"). The row's click decides the same
 * way: a thread the Chat list holds is Chat, any other is Work.
 */
export function sidebarRowMode(
  activeMode: OctantMode,
  threadId: string,
  chatThreadIds: ReadonlySet<string>,
): OctantMode {
  if (activeMode === "code") return "code";
  return chatThreadIds.has(threadId) ? "chat" : "work";
}

/**
 * The surface a sidebar thread row stands for while it is being dragged. It is
 * minted exactly like the row's click-open would mint it — same kind, same
 * identity fields, no hostId the click path would not resolve — so the domain's
 * visible-surface dedupe treats the drop and the click as the same thread.
 */
export function threadDragSurface(mode: OctantMode, row: SidebarThreadDragRow): WorkspaceTab {
  const id = decodeWorkspaceTabId(crypto.randomUUID());
  if (mode === "chat") {
    return {
      kind: "chat-thread",
      id,
      threadId: decodeChatThreadId(row.threadId),
      mode,
      title: row.title,
    };
  }
  if (mode === "code") {
    return {
      kind: "code-overview",
      id,
      threadId: decodeCodeThreadId(row.threadId),
      mode,
      title: row.title,
    };
  }
  return {
    kind: "work-thread",
    id,
    threadId: decodeWorkThreadId(row.threadId),
    mode,
    title: row.title,
  };
}

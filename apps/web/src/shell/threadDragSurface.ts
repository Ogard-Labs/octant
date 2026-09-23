import { decodeChatThreadId, decodeCodeThreadId, decodeWorkThreadId } from "@octant/contracts";
import type { OctantMode } from "@octant/contracts/modes";
import { decodeWorkspaceTabId, type WorkspaceTab } from "@octant/contracts/shell";
import type { SidebarThreadDragRow } from "./useWorkspaceTabDrag";

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

// Whether a window shows a moved thread's tombstone, for Remove worktree.
// The thread was erased here, so the Project checks that guard a live thread
// cannot pass; what remains is the window's own layout. Opening a tombstone
// binds no Project and carries no thread authority, so the pane proves only
// that the person is looking at that thread's tombstone in this window. The
// route that acts on it answers a local desktop window alone, and any such
// window may already read every departure this host records. Canonical:
// docs/design/hub-and-spokes.md "The tombstone and Remove worktree".

import {
  LOCAL_HOST_ID,
  type MovedThreadReference,
  type WindowWorkspace,
  type WorkspaceLayoutNode,
} from "@octant/contracts";

const THREAD_PANE_KIND = {
  chat: "chat-thread",
  code: "code-overview",
  work: "work-thread",
} as const;

/**
 * The window reads that mode on this computer and has the thread's own pane
 * open: not one of its other surfaces, and not a pane naming this computer's
 * thread id under another host.
 */
export function windowShowsDepartedThread(
  workspace: WindowWorkspace,
  thread: MovedThreadReference,
): boolean {
  if (String(workspace.contextByMode[thread.mode].host) !== String(LOCAL_HOST_ID)) return false;
  return layoutShowsThreadPane(workspace.layouts[thread.mode], thread);
}

function layoutShowsThreadPane(layout: WorkspaceLayoutNode, thread: MovedThreadReference): boolean {
  if (layout.kind === "split") {
    return (
      layoutShowsThreadPane(layout.first, thread) || layoutShowsThreadPane(layout.second, thread)
    );
  }
  const surface = layout.surface;
  if (surface.kind !== THREAD_PANE_KIND[thread.mode]) return false;
  if (!("threadId" in surface) || String(surface.threadId) !== thread.threadId) return false;
  return (
    !("hostId" in surface) ||
    surface.hostId === undefined ||
    String(surface.hostId) === String(LOCAL_HOST_ID)
  );
}

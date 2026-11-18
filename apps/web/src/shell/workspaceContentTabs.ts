import type {
  PaneId,
  WindowWorkspace,
  WorkspaceLayoutNode,
  WorkspacePane,
  WorkspaceTab,
} from "@octant/contracts";
import { sameWorkspaceSurface } from "@octant/domain/shell-policy";

export type WorkspaceContentTabs = ReadonlyMap<PaneId, ReadonlyArray<WorkspaceTab>>;

function panes(layout: WorkspaceLayoutNode): ReadonlyArray<WorkspacePane> {
  return layout.kind === "pane" ? [layout] : [...panes(layout.first), ...panes(layout.second)];
}

function isContent(surface: WorkspaceTab): boolean {
  return ["chat-thread", "work-thread", "code-overview", "code-file", "preview", "canvas"].includes(
    surface.kind,
  );
}

function isConversation(surface: WorkspaceTab): boolean {
  return ["chat-thread", "work-thread", "code-overview"].includes(surface.kind);
}

/**
 * A pane keeps one conversation: the one it shows, or the one it showed last
 * while a file, preview or canvas stands over it. Every thread a pane had
 * shown used to stay as a tab, so the title row grew a second list of threads
 * beside the sidebar's and read as a browser's tab strip. The conversation
 * keeps the place the pane's conversation had in the row, so the tabs beside
 * it do not move when another thread opens. A row restored from storage that
 * still holds several is pruned the same way.
 */
function withOneConversation(
  entries: ReadonlyArray<WorkspaceTab>,
  shown: WorkspaceTab,
  prior: WorkspaceTab | undefined,
): WorkspaceTab[] {
  const first = entries.findIndex(isConversation);
  if (first < 0) return [...entries];
  const wanted = isConversation(shown)
    ? shown
    : prior !== undefined && isConversation(prior)
      ? prior
      : undefined;
  const kept =
    (wanted === undefined
      ? undefined
      : entries.find((entry) => sameWorkspaceSurface(entry, wanted))) ??
    entries.findLast(isConversation);
  const rest = entries.filter((entry) => !isConversation(entry));
  if (kept !== undefined) rest.splice(first, 0, kept);
  return rest;
}

function threadIdOf(surface: WorkspaceTab): string | undefined {
  return "threadId" in surface && surface.threadId !== null ? String(surface.threadId) : undefined;
}

/**
 * Navigation references only. Every activation still goes through the host.
 *
 * A pane's row holds its one conversation and the files, previews and
 * canvases opened in it. A file opened over a thread always opens beside it:
 * while a pane kept every thread, a file took a single-click thread's tab in
 * place, which now would leave the row with no way back to the conversation.
 */
export function rememberWorkspaceContent(
  current: WorkspaceContentTabs,
  previous: WindowWorkspace,
  next: WindowWorkspace,
): WorkspaceContentTabs {
  const result = new Map<PaneId, ReadonlyArray<WorkspaceTab>>();
  for (const mode of ["chat", "work", "code"] as const) {
    const sameContext =
      JSON.stringify(previous.contextByMode[mode]) === JSON.stringify(next.contextByMode[mode]);
    for (const pane of panes(next.layouts[mode])) {
      const entries = sameContext ? [...(current.get(pane.paneId) ?? [])] : [];
      const prior = sameContext
        ? panes(previous.layouts[mode]).find((item) => item.paneId === pane.paneId)?.surface
        : undefined;
      for (const surface of [prior, pane.surface]) {
        if (surface === undefined || !isContent(surface)) continue;
        const index = entries.findIndex((entry) => sameWorkspaceSurface(entry, surface));
        if (index < 0) entries.push(surface);
        else entries[index] = surface;
      }
      result.set(pane.paneId, withOneConversation(entries, pane.surface, prior));
    }
  }
  return result;
}

/**
 * The thread a single click opened, and one a single click is about to open.
 * Only one thread is the preview at a time, and a preview another open
 * replaced is forgotten. A previewed thread's reference is not written to
 * storage (see workspaceContentPersistence); a double click keeps it.
 */
export interface ThreadPreview {
  readonly current?: string;
  readonly pending?: string;
}

function visibleThreads(workspace: WindowWorkspace): ReadonlySet<string> {
  const threads = new Set<string>();
  for (const mode of ["chat", "work", "code"] as const) {
    for (const pane of panes(workspace.layouts[mode])) {
      const thread = threadIdOf(pane.surface);
      if (thread !== undefined) threads.add(thread);
    }
  }
  return threads;
}

/** The preview after a committed workspace change. */
export function settleThreadPreview(
  preview: ThreadPreview,
  workspace: WindowWorkspace,
): ThreadPreview {
  const visible = visibleThreads(workspace);
  if (preview.pending !== undefined && visible.has(preview.pending)) {
    return { current: preview.pending };
  }
  const current =
    preview.current !== undefined && visible.has(preview.current) ? preview.current : undefined;
  return {
    ...(current === undefined ? {} : { current }),
    ...(preview.pending === undefined ? {} : { pending: preview.pending }),
  };
}

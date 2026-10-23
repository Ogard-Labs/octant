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

function threadIdOf(surface: WorkspaceTab): string | undefined {
  return "threadId" in surface && surface.threadId !== null ? String(surface.threadId) : undefined;
}

/**
 * Navigation references only. Every activation still goes through the host.
 *
 * `preview` names threads opened with a single click from the sidebar. When
 * a pane moves on from one of those, the next surface takes its tab in place
 * instead of adding one, so browsing threads does not grow the row; a thread
 * kept with a double click, or opened any other way, keeps its tab.
 */
export function rememberWorkspaceContent(
  current: WorkspaceContentTabs,
  previous: WindowWorkspace,
  next: WindowWorkspace,
  preview: ReadonlySet<string> = new Set(),
): WorkspaceContentTabs {
  const result = new Map<PaneId, ReadonlyArray<WorkspaceTab>>();
  for (const mode of ["chat", "work", "code"] as const) {
    const sameContext =
      JSON.stringify(previous.contextByMode[mode]) === JSON.stringify(next.contextByMode[mode]);
    for (const pane of panes(next.layouts[mode])) {
      let entries = sameContext ? [...(current.get(pane.paneId) ?? [])] : [];
      const prior = sameContext
        ? panes(previous.layouts[mode]).find((item) => item.paneId === pane.paneId)?.surface
        : undefined;
      const priorThread = prior === undefined ? undefined : threadIdOf(prior);
      const takesOver =
        prior !== undefined &&
        priorThread !== undefined &&
        preview.has(priorThread) &&
        isContent(pane.surface) &&
        !sameWorkspaceSurface(prior, pane.surface) &&
        !entries.some((entry) => sameWorkspaceSurface(entry, pane.surface));
      if (takesOver) {
        const index = entries.findIndex((entry) => sameWorkspaceSurface(entry, prior));
        if (index >= 0) entries[index] = pane.surface;
        else entries.push(pane.surface);
        result.set(pane.paneId, entries);
        continue;
      }
      for (const surface of [prior, pane.surface]) {
        if (surface === undefined || !isContent(surface)) continue;
        const index = entries.findIndex((entry) => sameWorkspaceSurface(entry, surface));
        if (index < 0) entries.push(surface);
        else entries[index] = surface;
      }
      result.set(pane.paneId, entries);
    }
  }
  return result;
}

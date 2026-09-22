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

/** Navigation references only. Every activation still goes through the host. */
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
      let entries = sameContext ? [...(current.get(pane.paneId) ?? [])] : [];
      const prior = sameContext
        ? panes(previous.layouts[mode]).find((item) => item.paneId === pane.paneId)?.surface
        : undefined;
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

import type { WorkspaceTab } from "@octant/contracts/shell";

export function isCanvasTabPinned(tab: WorkspaceTab): boolean {
  return tab.kind === "canvas" && tab.pinned === true;
}

export function orderTabsWithPinnedCanvasFirst(
  tabs: ReadonlyArray<WorkspaceTab>,
): ReadonlyArray<WorkspaceTab> {
  const pinned: WorkspaceTab[] = [];
  const rest: WorkspaceTab[] = [];
  for (const tab of tabs) {
    if (isCanvasTabPinned(tab)) pinned.push(tab);
    else rest.push(tab);
  }
  return [...pinned, ...rest];
}

export function withCanvasTabPin(tab: WorkspaceTab, pinned: boolean): WorkspaceTab {
  if (tab.kind !== "canvas") return tab;
  if (!pinned) {
    const { pinned: _pinned, ...unpinned } = tab;
    return unpinned;
  }
  return { ...tab, pinned: true };
}

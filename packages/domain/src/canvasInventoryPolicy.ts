import type { CanvasInventoryEntry, ChatThread, ProjectId } from "@octant/contracts";
import type { OctantMode } from "@octant/contracts/modes";

export type CanvasTabAuthority = "bound" | "unavailable";

export function classifyCanvasTabAuthority(input: {
  readonly tabProjectId: ProjectId;
  readonly activeProjectId: ProjectId | null;
}): CanvasTabAuthority {
  return input.activeProjectId === input.tabProjectId ? "bound" : "unavailable";
}

export type CanvasTabRestoreAuthority =
  | "bound"
  | "unavailable-project"
  | "unavailable-canvas"
  | "unavailable-mismatch";

export function classifyCanvasTabRestore(input: {
  readonly tabProjectId: ProjectId;
  readonly activeProjectId: ProjectId | null;
  readonly canvasProjectId: ProjectId | null;
}): CanvasTabRestoreAuthority {
  if (input.canvasProjectId === null) return "unavailable-canvas";
  if (String(input.tabProjectId) !== String(input.canvasProjectId)) {
    return "unavailable-mismatch";
  }
  if (
    input.activeProjectId === null ||
    String(input.activeProjectId) !== String(input.tabProjectId)
  ) {
    return "unavailable-project";
  }
  return "bound";
}

/**
 * A Canvas a Chat thread owns outside every Project is reachable while that
 * thread exists and is not deleted or deleting. Deletion takes the Canvas out
 * of reach before the purge erases it, and an archived thread still holds it.
 * The Canvas routes and the shell share this rule, so a tab is never kept for
 * a Canvas the routes would refuse.
 */
export function chatThreadHoldsCanvas(
  thread: { readonly lifecycle: ChatThread["lifecycle"] } | undefined,
): boolean {
  return thread !== undefined && thread.lifecycle !== "deleted" && thread.lifecycle !== "deleting";
}

export type ThreadOwnedCanvasTabAuthority = "bound" | "unavailable-canvas" | "unavailable-thread";

/**
 * A Canvas tab that names no Project stands only for a Canvas a Chat thread
 * owns outside every Project, in the Chat layout. The window's Project is not
 * consulted: the thread itself has no Project authority to match. Checking the
 * Canvas alone restored a tab whose thread had been deleted, which opened to
 * a refusal.
 */
export function classifyThreadOwnedCanvasTab(input: {
  readonly mode: OctantMode;
  readonly canvas: { readonly projectId: ProjectId | null } | undefined;
  readonly thread: { readonly lifecycle: ChatThread["lifecycle"] } | undefined;
}): ThreadOwnedCanvasTabAuthority {
  if (input.mode !== "chat" || input.canvas === undefined || input.canvas.projectId !== null) {
    return "unavailable-canvas";
  }
  return chatThreadHoldsCanvas(input.thread) ? "bound" : "unavailable-thread";
}

export function filterCanvasInventoryEntries(
  entries: ReadonlyArray<CanvasInventoryEntry>,
  query: string | undefined,
): ReadonlyArray<CanvasInventoryEntry> {
  const normalized = query?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return entries;
  return entries.filter((entry) => entry.title.toLowerCase().includes(normalized));
}

export function authorizeCanvasInventoryAccess(input: {
  readonly requestedProjectId: ProjectId;
  readonly activeProjectId: ProjectId | null;
  readonly activeMode: OctantMode;
  readonly projectMode: OctantMode | undefined;
}): boolean {
  if (input.projectMode === undefined) return false;
  if (input.projectMode !== input.activeMode) return false;
  if (input.activeProjectId === null) return false;
  return String(input.activeProjectId) === String(input.requestedProjectId);
}

export function projectInventoryEntryFromProjection(input: {
  readonly canvasId: CanvasInventoryEntry["canvasId"];
  readonly projectId: ProjectId;
  readonly mode: OctantMode;
  readonly title: string;
  readonly versionCount: number;
  readonly currentVersionId: CanvasInventoryEntry["currentVersionId"];
  readonly currentSequence: number;
  readonly updatedAt: CanvasInventoryEntry["updatedAt"];
}): CanvasInventoryEntry {
  return {
    canvasId: input.canvasId,
    projectId: input.projectId,
    mode: input.mode,
    title: input.title,
    versionCount: input.versionCount,
    currentVersionId: input.currentVersionId,
    currentSequence: input.currentSequence,
    updatedAt: input.updatedAt,
  };
}

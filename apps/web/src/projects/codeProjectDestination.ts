import type { ProjectId } from "@octant/contracts/projects";

export type CodeProjectDestination = "conversation" | "overview";

function storageKey(projectId: ProjectId): string {
  return `octant.code.project-destination.${String(projectId)}`;
}

export function rememberedProjectDestination(projectId: ProjectId): CodeProjectDestination {
  try {
    return globalThis.localStorage?.getItem(storageKey(projectId)) === "overview"
      ? "overview"
      : "conversation";
  } catch {
    return "conversation";
  }
}

export function rememberProjectDestination(
  projectId: ProjectId,
  destination: CodeProjectDestination,
): void {
  try {
    globalThis.localStorage?.setItem(storageKey(projectId), destination);
  } catch {
    // Opening either view still works when the window has no preference storage.
  }
}

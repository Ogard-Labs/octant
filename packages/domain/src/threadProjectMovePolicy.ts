/**
 * Pure policy for moving a Work or Code thread into another Project.
 *
 * A thread keeps its kind, history and guardrail level when it moves, and it
 * never gains reach the person did not bind: the destination must be a Project
 * of the same mode whose folder is the thread's current folder or contains it.
 * Nothing here reads a filesystem — callers pass canonical folders.
 */

export type MovableThreadMode = "work" | "code";

export type ThreadMoveRefusalReason =
  | "archived-thread"
  | "running"
  | "awaiting-input"
  | "same-project"
  | "destination-unavailable"
  | "different-mode"
  | "different-folder";

export const THREAD_MOVE_REFUSALS: Readonly<Record<ThreadMoveRefusalReason, string>> = {
  "archived-thread": "Reactivate this thread before moving it to another Project.",
  running: "Wait for the running turn to finish before moving this thread.",
  "awaiting-input": "This thread is waiting on you; answer it before moving it.",
  "same-project": "This thread is already in that Project.",
  "destination-unavailable": "That Project is not available to move this thread into.",
  "different-mode": "A thread can only move into a Project of its own kind.",
  "different-folder":
    "That Project is bound to a different folder. A thread can only move to a Project whose folder is the same as, or contains, the folder it works in.",
};

export interface MoveSourceProject {
  readonly id: string;
  readonly mode: MovableThreadMode;
  /** Canonical folder the thread's Project is bound to. */
  readonly folder: string;
}

export interface MoveDestinationProject {
  readonly id: string;
  readonly mode: "chat" | "work" | "code";
  readonly lifecycle: "active" | "archived";
  readonly folder: string;
}

export interface MovableThreadState {
  readonly lifecycle: string;
  readonly executing: boolean;
  readonly awaitingInput: boolean;
}

export type ThreadMoveDecision =
  | { readonly status: "allowed" }
  | { readonly status: "refused"; readonly reason: ThreadMoveRefusalReason };

// Code keeps two legacy lifecycle values beside active; only a closed thread is refused.
const CLOSED_LIFECYCLES: ReadonlySet<string> = new Set(["archived", "deleting", "deleted"]);

function trimTrailingSlash(folder: string): string {
  return folder.length > 1 ? folder.replace(/\/+$/, "") || "/" : folder;
}

/** Whether `outer` is `inner` or one of its ancestors, compared by whole path components. */
export function folderContains(outer: string, inner: string): boolean {
  const base = trimTrailingSlash(outer);
  const target = trimTrailingSlash(inner);
  if (base === target || base === "/") return true;
  return target.startsWith(`${base}/`);
}

/** `inner` written relative to `outer`: a dot for the same folder, undefined when it is not inside. */
export function folderRelativeTo(outer: string, inner: string): string | undefined {
  if (!folderContains(outer, inner)) return undefined;
  const base = trimTrailingSlash(outer);
  const target = trimTrailingSlash(inner);
  if (base === target) return ".";
  return target.slice(base === "/" ? 1 : base.length + 1);
}

export function decideThreadMove(input: {
  readonly thread: MovableThreadState;
  readonly source: MoveSourceProject;
  readonly destination: MoveDestinationProject;
}): ThreadMoveDecision {
  const { thread, source, destination } = input;
  if (CLOSED_LIFECYCLES.has(thread.lifecycle)) return refuse("archived-thread");
  if (thread.executing) return refuse("running");
  if (thread.awaitingInput) return refuse("awaiting-input");
  if (destination.id === source.id) return refuse("same-project");
  if (destination.mode !== source.mode) return refuse("different-mode");
  if (destination.lifecycle !== "active") return refuse("destination-unavailable");
  if (!folderContains(destination.folder, source.folder)) return refuse("different-folder");
  return { status: "allowed" };
}

function refuse(reason: ThreadMoveRefusalReason): ThreadMoveDecision {
  return { status: "refused", reason };
}

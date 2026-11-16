import type { OctantMode } from "@octant/contracts";
import type { Todo, TodoThreadLink } from "@octant/contracts/todos";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";

/** What a to-do row says about the newest thread started from it. */
export type TodoThreadPhase = "running" | "waiting" | "pull-request" | "done" | "started";

export interface TodoThreadState {
  readonly phase: TodoThreadPhase;
  readonly label: string;
  readonly title: string;
}

export function todoThreadKey(link: {
  readonly hostId: string;
  readonly mode: OctantMode;
  readonly threadId: TodoThreadLink["threadId"] | string;
}): string {
  return `${link.hostId}:${link.mode}:${String(link.threadId)}`;
}

/**
 * The row's badge, read from the window's own thread rows: the list host takes
 * no part, and no host projects another's threads (docs/design/todos.md). Done
 * wins, then a running turn, then a wait on the person, then the pull request
 * a Code thread opened.
 */
export function todoThreadState(row: ChatThreadNavigationItem): TodoThreadState {
  const title = row.title;
  if (row.completedAt !== undefined || row.markedDone === true) {
    return { phase: "done", label: "Done", title };
  }
  if (row.activity === "working") return { phase: "running", label: "Running", title };
  if (row.activity === "attention" || row.awaitingKind !== undefined) {
    return { phase: "waiting", label: "Waiting on you", title };
  }
  const pullRequest = row.pullRequests?.items[0];
  if (pullRequest !== undefined) {
    return {
      phase: "pull-request",
      label: `PR #${String(pullRequest.identity.number)}`,
      title,
    };
  }
  return { phase: "started", label: "Started", title };
}

/** The thread rows of every mode, by mode and thread id. */
export function todoThreadStates(
  hostId: string | undefined,
  rows: ReadonlyArray<{
    readonly mode: OctantMode;
    readonly rows: ReadonlyArray<ChatThreadNavigationItem>;
  }>,
): ReadonlyMap<string, TodoThreadState> {
  const states = new Map<string, TodoThreadState>();
  if (hostId === undefined) return states;
  for (const group of rows) {
    for (const row of group.rows) {
      states.set(
        todoThreadKey({ hostId, mode: group.mode, threadId: row.threadId }),
        todoThreadState(row),
      );
    }
  }
  return states;
}

export function newestTodoThread(todo: Todo): TodoThreadLink | undefined {
  return todo.threads[todo.threads.length - 1];
}

/** Where Start can take a to-do: Chat, or one of this host's active Projects. */
export type TodoStartTarget =
  | { readonly kind: "chat" }
  | {
      readonly kind: "project";
      readonly projectId: string;
      readonly name: string;
      readonly hostId?: string;
    };

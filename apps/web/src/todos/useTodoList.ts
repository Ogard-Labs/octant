import type { TodoClient } from "@octant/client-runtime/todo-client";
import type { TodoCommand, TodoListView, TodoRefused } from "@octant/contracts/todos";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";

export type TodoListRead =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: TodoListView }
  /** The last list read stays on screen; the page says it could not be read again. */
  | { readonly status: "failed"; readonly message: string; readonly view?: TodoListView };

export type TodoChangeOutcome =
  | { readonly status: "saved" }
  | { readonly status: "refused"; readonly refusal: TodoRefused }
  | { readonly status: "failed"; readonly message: string };

export interface TodoList {
  readonly read: TodoListRead;
  readonly change: (command: TodoCommand) => Promise<TodoChangeOutcome>;
}

/**
 * Other windows and the person's phone change the list too. The host's change
 * feed says so, and the list is read again on each change; the slow read while
 * the window is visible covers a feed that dropped and is reconnecting.
 */
const REREAD_MS = 30_000;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/** The person's to-do list on this host, shared by the sidebar badge and the To-dos page. */
export function useTodoList(
  client: TodoClient | undefined,
  /** The host's to-do change count; a new value reads the list again. */
  revision?: number,
  where?: {
    /** Names the list host; a new one is a different list, read from nothing. */
    readonly key: string;
    /**
     * Set while the list host cannot be reached: the last list read stays on
     * screen with this reason, and no change is sent.
     */
    readonly unreachable?: string;
  },
): TodoList {
  const [read, setRead] = useState<TodoListRead>({ status: "loading" });
  const key = where?.key;
  const unreachable = where?.unreachable;
  const shownKey = useRef(key);
  // Bumped with each list host, so an answer from the previous one is dropped.
  const generation = useRef(0);
  if (shownKey.current !== key) {
    generation.current += 1;
    // Render-time reset: the list of the previous host must not be drawn,
    // even for one frame, under the new one.
    shownKey.current = key;
    setRead({ status: "loading" });
  }
  useEffect(() => {
    if (unreachable === undefined) return;
    setRead((current) =>
      current.status === "loading"
        ? { status: "failed", message: unreachable }
        : current.status === "ready"
          ? { status: "failed", message: unreachable, view: current.view }
          : { ...current, message: unreachable },
    );
  }, [unreachable, key]);
  // A read that started before a change answered must not put the older list
  // back: each change's answer is the list as the host left it.
  const changes = useRef(0);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined || unreachable !== undefined) return;
      const before = changes.current;
      try {
        const view = await client.read(signal);
        if (changes.current === before) setRead({ status: "ready", view });
      } catch (error) {
        if (signal.aborted) return;
        const message = messageOf(error, "The to-do list could not be read.");
        setRead((current) =>
          current.status === "loading"
            ? { status: "failed", message }
            : current.status === "ready"
              ? { status: "failed", message, view: current.view }
              : { ...current, message },
        );
      }
    },
    [client, unreachable],
  );
  useVisibleRefresh(refresh, revision, REREAD_MS);

  const change = useCallback(
    async (command: TodoCommand): Promise<TodoChangeOutcome> => {
      if (client === undefined || unreachable !== undefined) {
        return { status: "failed", message: unreachable ?? "To-dos are not available." };
      }
      const sentTo = generation.current;
      try {
        const result = await client.change(command);
        if (generation.current !== sentTo) {
          return { status: "failed", message: "The list moved while this change was sent." };
        }
        if (result.kind === "todo-refused") {
          if (result.reason === "changed-elsewhere") {
            // The answer to a stale edit is the list as it is now.
            void refresh(new AbortController().signal);
          }
          return { status: "refused", refusal: result };
        }
        changes.current += 1;
        setRead({ status: "ready", view: result });
        return { status: "saved" };
      } catch (error) {
        return { status: "failed", message: messageOf(error, "The to-do could not be saved.") };
      }
    },
    [client, refresh, unreachable],
  );

  return useMemo(() => ({ read, change }), [read, change]);
}

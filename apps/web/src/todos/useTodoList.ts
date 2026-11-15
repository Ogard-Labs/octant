import type { TodoClient } from "@octant/client-runtime/todo-client";
import type { TodoCommand, TodoListView, TodoRefused } from "@octant/contracts/todos";
import { useCallback, useMemo, useRef, useState } from "react";
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
): TodoList {
  const [read, setRead] = useState<TodoListRead>({ status: "loading" });
  // A read that started before a change answered must not put the older list
  // back: each change's answer is the list as the host left it.
  const changes = useRef(0);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined) return;
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
    [client],
  );
  useVisibleRefresh(refresh, revision, REREAD_MS);

  const change = useCallback(
    async (command: TodoCommand): Promise<TodoChangeOutcome> => {
      if (client === undefined) return { status: "failed", message: "To-dos are not available." };
      try {
        const result = await client.change(command);
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
    [client, refresh],
  );

  return useMemo(() => ({ read, change }), [read, change]);
}

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
 * Other windows and the person's phone change the list too, and nothing tells
 * this window yet (live updates are later work in docs/design/todos.md), so the
 * list is read again while the window is visible.
 */
const REREAD_MS = 30_000;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/** The person's to-do list on this host, shared by the sidebar badge and the To-dos page. */
export function useTodoList(client: TodoClient | undefined): TodoList {
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
  useVisibleRefresh(refresh, undefined, REREAD_MS);

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

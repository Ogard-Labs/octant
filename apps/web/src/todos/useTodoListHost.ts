import type { TodoListHostClient } from "@octant/client-runtime/todo-client";
import { decodeTodoListHostCommand, type TodoListHostChoice } from "@octant/contracts/todos";
import { useCallback, useState } from "react";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import type { TodoListHostRead } from "./TodoListHostSettings";

/** The window's slow re-read; a change on this host also arrives through the change feed. */
const REREAD_MS = 60_000;

/** Which host keeps the list, as this host's person chose it. */
export function useTodoListHost(
  client: TodoListHostClient | undefined,
  revision: number | undefined,
): {
  readonly read: TodoListHostRead;
  readonly choose: (choice: TodoListHostChoice) => Promise<string | undefined>;
} {
  const [read, setRead] = useState<TodoListHostRead>({ status: "loading" });
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined) return;
      try {
        setRead({ status: "ready", view: await client.readListHost(signal) });
      } catch (error) {
        if (signal.aborted) return;
        setRead((current) =>
          current.status === "ready"
            ? current
            : {
                status: "failed",
                message:
                  error instanceof Error && error.message.length > 0
                    ? error.message
                    : "Where the to-do list is kept could not be read.",
              },
        );
      }
    },
    [client],
  );
  useVisibleRefresh(refresh, revision, REREAD_MS);
  const choose = useCallback(
    async (choice: TodoListHostChoice): Promise<string | undefined> => {
      if (client === undefined) return "To-dos are not available.";
      try {
        const result = await client.chooseListHost(
          decodeTodoListHostCommand({ kind: "choose-todo-list-host", choice }),
        );
        if (result.kind === "todo-refused") return result.message;
        setRead({ status: "ready", view: result });
        return undefined;
      } catch (error) {
        return error instanceof Error && error.message.length > 0
          ? error.message
          : "Where the to-do list is kept could not be changed.";
      }
    },
    [client],
  );
  return { read, choose };
}

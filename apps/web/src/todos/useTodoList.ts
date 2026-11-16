import type { TodoClient, TodoChangeCursor } from "@octant/client-runtime/todo-client";
import type { TodoCommand, TodoListView, TodoRefused } from "@octant/contracts/todos";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { waitForReconnect } from "../lib/waitForReconnect";

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
    readonly waitForChange?: (
      cursor: TodoChangeCursor | undefined,
      signal: AbortSignal,
    ) => Promise<TodoChangeCursor & { readonly changed: boolean }>;
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
      const readFrom = generation.current;
      try {
        const view = await client.read(signal);
        if (!signal.aborted && generation.current === readFrom && changes.current === before) {
          setRead({ status: "ready", view });
        }
      } catch (error) {
        if (signal.aborted || generation.current !== readFrom) return;
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
  const [remoteRevision, setRemoteRevision] = useState(0);
  useVisibleRefresh(refresh, (revision ?? 0) + remoteRevision, REREAD_MS);
  const waitForChange = where?.waitForChange;
  useEffect(() => {
    if (waitForChange === undefined || unreachable !== undefined) return;
    const controller = new AbortController();
    void (async () => {
      let cursor: TodoChangeCursor | undefined;
      while (!controller.signal.aborted) {
        try {
          const result = await waitForChange(cursor, controller.signal);
          if (controller.signal.aborted) return;
          cursor = result;
          if (result.changed) {
            setRemoteRevision((current) => current + 1);
            await waitForReconnect(controller.signal, 100);
          }
        } catch {
          if (controller.signal.aborted) return;
          cursor = undefined;
          await waitForReconnect(controller.signal, 1000);
        }
      }
    })();
    return () => controller.abort();
  }, [waitForChange, unreachable]);

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

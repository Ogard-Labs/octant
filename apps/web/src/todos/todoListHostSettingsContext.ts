import type { StableHostId } from "@octant/contracts/remote-access";
import type { TodoListHostChoice, TodoListHostView } from "@octant/contracts/todos";
import { createContext } from "react";

/*
 * What the to-do list's Settings row reads, apart from the row itself. The
 * window provides it from its first frame, so it lives here: imported from
 * the row's module, it drew every Settings row component into the first
 * paint, though Settings itself loads only when opened.
 */

export type TodoListHostRead =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: TodoListHostView }
  | { readonly status: "failed"; readonly message: string };

/** A computer this window is paired with, which could keep the list. */
export interface TodoListHostComputer {
  readonly hostId: StableHostId;
  readonly name: string;
}

export interface TodoListHostSettingsValue {
  readonly read: TodoListHostRead;
  readonly computers: ReadonlyArray<TodoListHostComputer>;
  /** Resolves to the host's refusal or failure, or undefined once saved. */
  readonly choose: (choice: TodoListHostChoice) => Promise<string | undefined>;
}

export const TodoListHostSettingsContext = createContext<TodoListHostSettingsValue | undefined>(
  undefined,
);

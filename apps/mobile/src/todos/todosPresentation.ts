import {
  TODO_TITLE_MAX_CHARACTERS,
  decodeTodoCommand,
  type Todo,
  type TodoCommand,
} from "@octant/contracts/todos";

/** The phone's two sections: what is open, then what was ticked off. */
export interface MobileTodoSections {
  readonly open: ReadonlyArray<Todo>;
  readonly done: ReadonlyArray<Todo>;
}

/** Dropped to-dos stay off the phone, as they stay out of the window's default view. */
export function mobileTodoSections(todos: ReadonlyArray<Todo>): MobileTodoSections {
  return {
    open: todos.filter((todo) => todo.state === "open"),
    done: todos.filter((todo) => todo.state === "done"),
  };
}

export function mobileTodoDetail(todo: Todo): string | undefined {
  const parts = [
    ...todo.projects.map((link) => link.name),
    ...todo.tags.map((tag) => `#${tag}`),
    ...(todo.state === "open" && todo.threads.length > 0 ? ["Started"] : []),
  ];
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** One line, newest on top; the phone names the id so a resent add lands once. */
export function mobileQuickAdd(
  text: string,
  todoId: string,
):
  | { readonly status: "ready"; readonly command: TodoCommand }
  | { readonly status: "empty" }
  | { readonly status: "too-long" } {
  const title = text.replace(/\s+/g, " ").trim();
  if (title === "") return { status: "empty" };
  if (title.length > TODO_TITLE_MAX_CHARACTERS) return { status: "too-long" };
  return { status: "ready", command: decodeTodoCommand({ kind: "add-todo", todoId, title }) };
}

export function mobileTickCommand(todo: Todo): TodoCommand {
  return decodeTodoCommand({
    kind: "set-todo-state",
    todoId: todo.id,
    state: todo.state === "done" ? "open" : "done",
  });
}

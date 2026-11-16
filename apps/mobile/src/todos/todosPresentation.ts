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

export function mobileTodoDetail(
  todo: Todo,
  options: { readonly unlinked?: boolean } = {},
): string | undefined {
  const parts = [
    ...todo.projects.map((link) => link.name),
    ...todo.tags.map((tag) => `#${tag}`),
    ...(todo.state !== "open"
      ? []
      : options.unlinked === true
        ? ["Thread started, not linked"]
        : todo.threads.length > 0
          ? ["Started"]
          : []),
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

/** What a Start fills the new-thread sheet with. Nothing starts until the person sends. */
export interface MobileTodoStartDraft {
  readonly prompt: string;
  readonly mode: "chat" | "work" | "code";
  readonly projectId?: string;
}

/**
 * The title, and the notes under it, as the prompt. The mode follows the
 * to-do's first Project that lives on the computer new threads go to (a Code
 * Project starts Code, a Work Project starts Work); without one it is a Chat,
 * which the person can still change in the sheet.
 */
export function mobileTodoStartDraft(
  todo: Todo,
  placement: {
    readonly hostId: string;
    readonly workProjects: ReadonlyArray<{ readonly projectId: string }>;
    readonly codeProjects: ReadonlyArray<{ readonly projectId: string }>;
  },
): MobileTodoStartDraft {
  const prompt = todo.notes === "" ? todo.title : `${todo.title}\n\n${todo.notes}`;
  for (const link of todo.projects) {
    if (String(link.hostId) !== placement.hostId) continue;
    const projectId = String(link.projectId);
    if (placement.codeProjects.some((project) => project.projectId === projectId)) {
      return { prompt, mode: "code", projectId };
    }
    if (placement.workProjects.some((project) => project.projectId === projectId)) {
      return { prompt, mode: "work", projectId };
    }
  }
  return { prompt, mode: "chat" };
}

/** The thread a Start made, named by the computer that owns it. */
export interface MobileStartedThread {
  readonly hostId: string;
  readonly threadId: string;
  readonly mode: "chat" | "work" | "code";
}

export function mobileTodoLinkCommand(todoId: string, thread: MobileStartedThread): TodoCommand {
  return decodeTodoCommand({ kind: "link-todo-thread", todoId, thread });
}

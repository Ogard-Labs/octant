import {
  TODO_CREATED,
  TODO_DELETED,
  TODO_EDITED,
  TODO_LIST_MAX,
  TODO_MAX_THREAD_LINKS,
  TODO_NOTES_MAX_CHARACTERS,
  TODO_ORDER_CHANGED,
  TODO_PROJECT_NAME_MAX_CHARACTERS,
  TODO_PROJECTS_SET,
  TODO_STATE_CHANGED,
  TODO_TAG_MAX_CHARACTERS,
  TODO_TAGS_SET,
  TODO_THREAD_LINKED,
  TODO_TITLE_MAX_CHARACTERS,
  type Todo,
  type TodoCommand,
  type TodoEvent,
  type TodoId,
  type TodoProjectLink,
  type TodoRefusalReason,
  type TodoTag,
  type TodoThreadLink,
} from "@octant/contracts/todos";
import type { UtcTimestamp } from "@octant/contracts";
import { redactSecrets } from "./secretGuardPolicy";

/**
 * A to-do as the list host keeps it: the view a client reads, plus the
 * version at which its title or notes last changed. An edit is refused only
 * when the text moved on after the version it was made on; a tick or a tag
 * on another device does not make a person's edit stale.
 */
export interface TodoRecord {
  readonly todo: Todo;
  readonly textVersion: number;
}

export interface TodoListState {
  readonly todos: ReadonlyMap<string, TodoRecord>;
  /** Ids of deleted to-dos; adding one again changes nothing. */
  readonly deleted: ReadonlySet<string>;
}

/** One event for one to-do's aggregate, appended at the version it was decided on. */
export interface TodoAppend {
  readonly todoId: TodoId;
  readonly expectedVersion: number;
  readonly event: TodoEvent;
}

export type TodoDecision =
  | { readonly kind: "append"; readonly appends: ReadonlyArray<TodoAppend> }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: TodoRefusalReason; readonly message: string };

const unchanged: TodoDecision = { kind: "unchanged" };

function refused(reason: TodoRefusalReason, message: string): TodoDecision {
  return { kind: "refused", reason, message };
}

function single(record: TodoRecord, event: TodoEvent): TodoDecision {
  return {
    kind: "append",
    appends: [{ todoId: record.todo.id, expectedVersion: record.todo.version, event }],
  };
}

/**
 * Text the person typed goes into the journal, so known secret shapes are
 * replaced first, as for every other text bound for the journal. A
 * replacement may be longer than the key it hides, so the result is clipped
 * back to the field's bound.
 */
export function todoTextForJournal(text: string, maxCharacters: number): string {
  return redactSecrets(text).text.slice(0, maxCharacters);
}

/** A one-line field after redaction: clipping can leave trailing space, which it may not end with. */
function lineForJournal(text: string, maxCharacters: number): string {
  return todoTextForJournal(text, maxCharacters).trimEnd();
}

function todoTitleForJournal(title: string): string {
  return lineForJournal(title, TODO_TITLE_MAX_CHARACTERS);
}

/**
 * Tags in the order given, redacted as a title is, each exact label once. A
 * key fits in a tag (an access-key id is 20 characters), so a tag is no less
 * journal-bound text than the title.
 */
export function uniqueTodoTags(tags: ReadonlyArray<TodoTag>): ReadonlyArray<TodoTag> {
  return [...new Set(tags.map((tag) => lineForJournal(tag, TODO_TAG_MAX_CHARACTERS)))];
}

/**
 * Project links in the order given, each Project on each host once; the first
 * name wins. The name is what the client sent, so it is redacted too.
 */
export function uniqueTodoProjects(
  projects: ReadonlyArray<TodoProjectLink>,
): ReadonlyArray<TodoProjectLink> {
  const seen = new Set<string>();
  return projects
    .filter((link) => {
      const key = `${String(link.hostId)}:${String(link.projectId)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((link) => ({
      ...link,
      name: lineForJournal(link.name, TODO_PROJECT_NAME_MAX_CHARACTERS),
    }));
}

function sameProjects(a: ReadonlyArray<TodoProjectLink>, b: ReadonlyArray<TodoProjectLink>) {
  return (
    a.length === b.length &&
    a.every(
      (link, index) =>
        String(link.hostId) === String(b[index]?.hostId) &&
        String(link.projectId) === String(b[index]?.projectId) &&
        link.name === b[index]?.name,
    )
  );
}

function sameTags(a: ReadonlyArray<TodoTag>, b: ReadonlyArray<TodoTag>) {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

function sameThread(a: TodoThreadLink, b: TodoThreadLink) {
  return String(a.hostId) === String(b.hostId) && String(a.threadId) === String(b.threadId);
}

/** Whether two places in the list hold the same to-do, or are both empty. */
function sameTodo(a: Todo | undefined, b: Todo | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return String(a.id) === String(b.id);
}

/** The list in the order a person sees it: by rank, then by when each was added. */
export function todosInOrder(todos: Iterable<Todo>): ReadonlyArray<Todo> {
  return [...todos].sort(
    (a, b) =>
      a.rank - b.rank ||
      a.createdAt.localeCompare(b.createdAt) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/** New to-dos go on top. */
export function rankForNewTodo(todos: Iterable<Todo>): number {
  let lowest: number | undefined;
  for (const todo of todos) if (lowest === undefined || todo.rank < lowest) lowest = todo.rank;
  return lowest === undefined ? 0 : lowest - 1;
}

/**
 * Where a moved to-do lands. Usually one new rank halfway between its new
 * neighbours. When repeated moves into the same gap have used up the
 * precision of a rank, every to-do is given a whole-number rank in the new
 * order instead, which is several appends.
 */
function decideMove(
  state: TodoListState,
  record: TodoRecord,
  beforeTodoId: TodoId | undefined,
): TodoDecision {
  const moving = record.todo;
  const others = todosInOrder([...state.todos.values()].map((entry) => entry.todo)).filter(
    (todo) => String(todo.id) !== String(moving.id),
  );
  let index = others.length;
  if (beforeTodoId !== undefined) {
    if (String(beforeTodoId) === String(moving.id)) return unchanged;
    index = others.findIndex((todo) => String(todo.id) === String(beforeTodoId));
    if (index === -1)
      return refused("not-found", "The to-do to move it before is not in the list.");
  }
  const previous = others[index - 1];
  const next = others[index];
  const current = todosInOrder([...state.todos.values()].map((entry) => entry.todo));
  const currentIndex = current.findIndex((todo) => String(todo.id) === String(moving.id));
  if (sameTodo(current[currentIndex - 1], previous) && sameTodo(current[currentIndex + 1], next)) {
    return unchanged;
  }
  let rank: number;
  if (previous === undefined && next === undefined) rank = 0;
  else if (previous === undefined && next !== undefined) rank = next.rank - 1;
  else if (previous !== undefined && next === undefined) rank = previous.rank + 1;
  else rank = ((previous?.rank ?? 0) + (next?.rank ?? 0)) / 2;
  const fits =
    (previous === undefined || previous.rank < rank) && (next === undefined || rank < next.rank);
  if (fits) {
    return single(record, { eventName: TODO_ORDER_CHANGED, payload: { todoId: moving.id, rank } });
  }
  const order = [...others.slice(0, index), moving, ...others.slice(index)];
  const appends: TodoAppend[] = [];
  order.forEach((todo, position) => {
    if (todo.rank === position) return;
    appends.push({
      todoId: todo.id,
      expectedVersion: todo.version,
      event: { eventName: TODO_ORDER_CHANGED, payload: { todoId: todo.id, rank: position } },
    });
  });
  return { kind: "append", appends };
}

/** What a command does to the list, decided before anything is appended. */
export function decideTodoCommand(state: TodoListState, command: TodoCommand): TodoDecision {
  if (command.kind === "add-todo") {
    const id = String(command.todoId);
    if (state.todos.has(id) || state.deleted.has(id)) return unchanged;
    if (state.todos.size >= TODO_LIST_MAX) {
      return refused(
        "list-full",
        `The list holds ${String(TODO_LIST_MAX)} to-dos. Delete some to add more.`,
      );
    }
    return {
      kind: "append",
      appends: [
        {
          todoId: command.todoId,
          expectedVersion: 0,
          event: {
            eventName: TODO_CREATED,
            payload: {
              todoId: command.todoId,
              title: todoTitleForJournal(command.title),
              notes: todoTextForJournal(command.notes ?? "", TODO_NOTES_MAX_CHARACTERS),
              projects: uniqueTodoProjects(command.projects ?? []),
              tags: uniqueTodoTags(command.tags ?? []),
              rank: rankForNewTodo([...state.todos.values()].map((entry) => entry.todo)),
            },
          },
        },
      ],
    };
  }

  const record = state.todos.get(String(command.todoId));
  if (record === undefined) return refused("not-found", "That to-do is not in the list.");
  const todo = record.todo;

  switch (command.kind) {
    case "edit-todo": {
      if (command.expectedVersion > todo.version) {
        return refused("malformed", "That version of the to-do does not exist.");
      }
      if (record.textVersion > command.expectedVersion) {
        return refused(
          "changed-elsewhere",
          "This to-do was changed on another device. Check the new text, then edit again.",
        );
      }
      const title = todoTitleForJournal(command.title);
      const notes = todoTextForJournal(command.notes, TODO_NOTES_MAX_CHARACTERS);
      if (title === todo.title && notes === todo.notes) return unchanged;
      return single(record, {
        eventName: TODO_EDITED,
        payload: { todoId: todo.id, title, notes },
      });
    }
    case "set-todo-state":
      if (command.state === todo.state) return unchanged;
      return single(record, {
        eventName: TODO_STATE_CHANGED,
        payload: { todoId: todo.id, state: command.state },
      });
    case "set-todo-projects": {
      const projects = uniqueTodoProjects(command.projects);
      if (sameProjects(projects, todo.projects)) return unchanged;
      return single(record, {
        eventName: TODO_PROJECTS_SET,
        payload: { todoId: todo.id, projects },
      });
    }
    case "set-todo-tags": {
      const tags = uniqueTodoTags(command.tags);
      if (sameTags(tags, todo.tags)) return unchanged;
      return single(record, { eventName: TODO_TAGS_SET, payload: { todoId: todo.id, tags } });
    }
    case "move-todo":
      return decideMove(state, record, command.beforeTodoId);
    case "link-todo-thread":
      if (todo.threads.some((thread) => sameThread(thread, command.thread))) return unchanged;
      return single(record, {
        eventName: TODO_THREAD_LINKED,
        payload: { todoId: todo.id, thread: command.thread },
      });
    case "delete-todo":
      return single(record, { eventName: TODO_DELETED, payload: { todoId: todo.id } });
  }
}

/**
 * A to-do after one of its events. Replaying a to-do's events in order from
 * nothing gives the record the host kept; a delete gives nothing.
 */
export function applyTodoEvent(
  record: TodoRecord | undefined,
  event: TodoEvent,
  committed: { readonly version: number; readonly occurredAt: UtcTimestamp },
): TodoRecord | undefined {
  const touched = { version: committed.version, updatedAt: committed.occurredAt };
  if (event.eventName === TODO_CREATED) {
    const created = event.payload;
    return {
      textVersion: committed.version,
      todo: {
        id: created.todoId,
        title: created.title,
        notes: created.notes,
        projects: created.projects,
        tags: created.tags,
        state: "open",
        threads: [],
        rank: created.rank,
        createdAt: committed.occurredAt,
        ...touched,
      },
    };
  }
  if (record === undefined) return undefined;
  const todo = record.todo;
  switch (event.eventName) {
    case TODO_EDITED:
      return {
        textVersion: committed.version,
        todo: { ...todo, title: event.payload.title, notes: event.payload.notes, ...touched },
      };
    case TODO_STATE_CHANGED:
      return { ...record, todo: { ...todo, state: event.payload.state, ...touched } };
    case TODO_PROJECTS_SET:
      return { ...record, todo: { ...todo, projects: event.payload.projects, ...touched } };
    case TODO_TAGS_SET:
      return { ...record, todo: { ...todo, tags: event.payload.tags, ...touched } };
    case TODO_ORDER_CHANGED:
      return { ...record, todo: { ...todo, rank: event.payload.rank, ...touched } };
    case TODO_THREAD_LINKED:
      return {
        ...record,
        todo: {
          ...todo,
          threads: [...todo.threads, event.payload.thread].slice(-TODO_MAX_THREAD_LINKS),
          ...touched,
        },
      };
    case TODO_DELETED:
      return undefined;
  }
}

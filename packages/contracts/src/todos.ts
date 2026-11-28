import { Schema } from "effect";
import { NonEmptyTrimmedString, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { StableHostId } from "./remoteAccess";
import { MentionableThreadId } from "./threadMentionIdentity";

/**
 * The person's own to-do list, kept on one list host. Who may change it, how
 * other devices reach it, and what a to-do may link to are in the To-dos
 * specification (docs/design/todos.md).
 */

export const TodoId = Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand("TodoId"));
export type TodoId = typeof TodoId.Type;

export const TODO_TITLE_MAX_CHARACTERS = 280;
export const TODO_NOTES_MAX_CHARACTERS = 8_000;
export const TODO_MAX_PROJECTS = 8;
export const TODO_MAX_TAGS = 12;
export const TODO_TAG_MAX_CHARACTERS = 40;
/** Threads a to-do remembers; a later start drops the oldest link. */
export const TODO_MAX_THREAD_LINKS = 20;
/** To-dos one list holds, done and dropped included. */
export const TODO_LIST_MAX = 5_000;
export const TODO_PROJECT_NAME_MAX_CHARACTERS = 200;

/** One line: a title is what a row shows, so it carries no line break. */
export const TodoTitle = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(TODO_TITLE_MAX_CHARACTERS),
  Schema.makeFilter((value) => !/[\r\n]/.test(value), { message: "A to-do title is one line." }),
);
export type TodoTitle = typeof TodoTitle.Type;

/** Empty notes mean none. */
export const TodoNotes = Schema.String.check(Schema.isMaxLength(TODO_NOTES_MAX_CHARACTERS));
export type TodoNotes = typeof TodoNotes.Type;

/**
 * An exact label, as a Canvas tag is: two tags that differ only in case are
 * two tags, because a list that silently merged them would look like a tag
 * that went missing.
 */
export const TodoTag = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(TODO_TAG_MAX_CHARACTERS),
);
export type TodoTag = typeof TodoTag.Type;

export const TodoState = Schema.Literals(["open", "done", "dropped"]);
export type TodoState = typeof TodoState.Type;

/**
 * A Project on any of the person's hosts. A pointer only: it grants nothing
 * on that host. The name is the one last seen, so a row still reads while
 * the host is unreachable.
 */
export const TodoProjectLink = Schema.Struct({
  hostId: StableHostId,
  projectId: ProjectId,
  name: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(TODO_PROJECT_NAME_MAX_CHARACTERS),
  ),
});
export type TodoProjectLink = typeof TodoProjectLink.Type;

/** A thread started from the to-do, on the host that owns it. Grants nothing. */
export const TodoThreadLink = Schema.Struct({
  hostId: StableHostId,
  threadId: MentionableThreadId,
  mode: OctantMode,
});
export type TodoThreadLink = typeof TodoThreadLink.Type;

export const Todo = Schema.Struct({
  id: TodoId,
  title: TodoTitle,
  notes: TodoNotes,
  projects: Schema.Array(TodoProjectLink).check(Schema.isMaxLength(TODO_MAX_PROJECTS)),
  tags: Schema.Array(TodoTag).check(Schema.isMaxLength(TODO_MAX_TAGS)),
  state: TodoState,
  /** Oldest first. */
  threads: Schema.Array(TodoThreadLink).check(Schema.isMaxLength(TODO_MAX_THREAD_LINKS)),
  /** Lower ranks list first. */
  rank: Schema.Number.check(Schema.isFinite()),
  /** The to-do's aggregate version; an edit names the one it was made on. */
  version: PositiveInt,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
});
export type Todo = typeof Todo.Type;

/** The whole list, in rank order. */
export const TodoListView = Schema.Struct({
  kind: Schema.Literal("todo-list"),
  /** The list host's own id, which names that host's Projects in a link. */
  hostId: StableHostId,
  todos: Schema.Array(Todo).check(Schema.isMaxLength(TODO_LIST_MAX)),
});
export type TodoListView = typeof TodoListView.Type;

const TodoProjectLinks = Schema.Array(TodoProjectLink).check(Schema.isMaxLength(TODO_MAX_PROJECTS));
const TodoTags = Schema.Array(TodoTag).check(Schema.isMaxLength(TODO_MAX_TAGS));

export const TodoCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("add-todo"),
    todoId: TodoId,
    title: TodoTitle,
    notes: Schema.optional(TodoNotes),
    projects: Schema.optional(TodoProjectLinks),
    tags: Schema.optional(TodoTags),
  }),
  Schema.Struct({
    kind: Schema.Literal("edit-todo"),
    todoId: TodoId,
    expectedVersion: PositiveInt,
    title: TodoTitle,
    notes: TodoNotes,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-todo-state"),
    todoId: TodoId,
    state: TodoState,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-todo-projects"),
    todoId: TodoId,
    projects: TodoProjectLinks,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-todo-tags"),
    todoId: TodoId,
    tags: TodoTags,
  }),
  Schema.Struct({
    kind: Schema.Literal("move-todo"),
    todoId: TodoId,
    beforeTodoId: Schema.optional(TodoId),
  }),
  Schema.Struct({
    kind: Schema.Literal("link-todo-thread"),
    todoId: TodoId,
    thread: TodoThreadLink,
  }),
  Schema.Struct({
    kind: Schema.Literal("delete-todo"),
    todoId: TodoId,
  }),
]);
export type TodoCommand = typeof TodoCommand.Type;

export const TodoRefusalReason = Schema.Literals([
  "malformed",
  "unauthorized",
  "not-found",
  "changed-elsewhere",
  "list-full",
  "list-not-empty",
  "kept-elsewhere",
]);
export type TodoRefusalReason = typeof TodoRefusalReason.Type;

export const TodoRefused = Schema.Struct({
  kind: Schema.Literal("todo-refused"),
  reason: TodoRefusalReason,
  message: NonEmptyTrimmedString,
});
export type TodoRefused = typeof TodoRefused.Type;

export const TodoResult = Schema.Union([TodoListView, TodoRefused]);
export type TodoResult = typeof TodoResult.Type;

export const TODO_AGGREGATE_TYPE = "todo";

export const TODO_CREATED = "todo.created@1";
export const TODO_EDITED = "todo.edited@1";
export const TODO_STATE_CHANGED = "todo.state-changed@1";
export const TODO_PROJECTS_SET = "todo.projects-set@1";
export const TODO_TAGS_SET = "todo.tags-set@1";
export const TODO_ORDER_CHANGED = "todo.order-changed@1";
export const TODO_THREAD_LINKED = "todo.thread-linked@1";
export const TODO_DELETED = "todo.deleted@1";

export const TodoCreated = Schema.Struct({
  todoId: TodoId,
  title: TodoTitle,
  notes: TodoNotes,
  projects: TodoProjectLinks,
  tags: TodoTags,
  rank: Schema.Number.check(Schema.isFinite()),
});
export type TodoCreated = typeof TodoCreated.Type;

export const TodoEdited = Schema.Struct({
  todoId: TodoId,
  title: TodoTitle,
  notes: TodoNotes,
});
export type TodoEdited = typeof TodoEdited.Type;

export const TodoStateChanged = Schema.Struct({
  todoId: TodoId,
  state: TodoState,
});
export type TodoStateChanged = typeof TodoStateChanged.Type;

export const TodoProjectsSet = Schema.Struct({
  todoId: TodoId,
  projects: TodoProjectLinks,
});
export type TodoProjectsSet = typeof TodoProjectsSet.Type;

export const TodoTagsSet = Schema.Struct({
  todoId: TodoId,
  tags: TodoTags,
});
export type TodoTagsSet = typeof TodoTagsSet.Type;

export const TodoOrderChanged = Schema.Struct({
  todoId: TodoId,
  rank: Schema.Number.check(Schema.isFinite()),
});
export type TodoOrderChanged = typeof TodoOrderChanged.Type;

export const TodoThreadLinked = Schema.Struct({
  todoId: TodoId,
  thread: TodoThreadLink,
});
export type TodoThreadLinked = typeof TodoThreadLinked.Type;

export const TodoDeleted = Schema.Struct({
  todoId: TodoId,
});
export type TodoDeleted = typeof TodoDeleted.Type;

/** One event a to-do's aggregate holds, by name. */
export type TodoEvent =
  | { readonly eventName: typeof TODO_CREATED; readonly payload: TodoCreated }
  | { readonly eventName: typeof TODO_EDITED; readonly payload: TodoEdited }
  | { readonly eventName: typeof TODO_STATE_CHANGED; readonly payload: TodoStateChanged }
  | { readonly eventName: typeof TODO_PROJECTS_SET; readonly payload: TodoProjectsSet }
  | { readonly eventName: typeof TODO_TAGS_SET; readonly payload: TodoTagsSet }
  | { readonly eventName: typeof TODO_ORDER_CHANGED; readonly payload: TodoOrderChanged }
  | { readonly eventName: typeof TODO_THREAD_LINKED; readonly payload: TodoThreadLinked }
  | { readonly eventName: typeof TODO_DELETED; readonly payload: TodoDeleted };

/**
 * Which host keeps the person's list, as this host's person chose it. Absent
 * a choice, this host keeps it. Another host is named by its stable id and the
 * name it was last seen under; reaching it is the window's own pairing, and the
 * choice grants nothing on it.
 */
export const TodoListHostChoice = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("this-host") }),
  Schema.Struct({
    kind: Schema.Literal("other-host"),
    hostId: StableHostId,
    name: Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(TODO_PROJECT_NAME_MAX_CHARACTERS),
    ),
  }),
]);
export type TodoListHostChoice = typeof TodoListHostChoice.Type;

export const TodoListHostView = Schema.Struct({
  kind: Schema.Literal("todo-list-host"),
  /** This host's own stable id: a thread or Project here is linked by it. */
  thisHostId: StableHostId,
  choice: TodoListHostChoice,
  /** The choice moves to another host only while this host's own list is empty. */
  ownListEmpty: Schema.Boolean,
});
export type TodoListHostView = typeof TodoListHostView.Type;

export const TodoListHostCommand = Schema.Struct({
  kind: Schema.Literal("choose-todo-list-host"),
  choice: TodoListHostChoice,
});
export type TodoListHostCommand = typeof TodoListHostCommand.Type;

export const TodoListHostResult = Schema.Union([TodoListHostView, TodoRefused]);
export type TodoListHostResult = typeof TodoListHostResult.Type;

export const TODO_LIST_HOST_AGGREGATE_TYPE = "todo-list-host";
/** One choice per host, so one fixed aggregate; journal aggregate ids are UUIDs. */
export const TODO_LIST_HOST_AGGREGATE_ID = "6f2d3a1e-7c44-4b8e-9d21-5a0f3c8e7b10";
export const TODO_LIST_HOST_CHOSEN = "todo.list-host-chosen@1";

export const TodoListHostChosen = Schema.Struct({ choice: TodoListHostChoice });
export type TodoListHostChosen = typeof TodoListHostChosen.Type;

export const decodeTodoId = Schema.decodeUnknownSync(TodoId, STRICT_DECODE_OPTIONS);
export const decodeTodoCommand = Schema.decodeUnknownSync(TodoCommand, STRICT_DECODE_OPTIONS);
export const decodeTodoResult = Schema.decodeUnknownSync(TodoResult, STRICT_DECODE_OPTIONS);
export const decodeTodoListView = Schema.decodeUnknownSync(TodoListView, STRICT_DECODE_OPTIONS);
export const decodeTodoListHostView = Schema.decodeUnknownSync(
  TodoListHostView,
  STRICT_DECODE_OPTIONS,
);
export const decodeTodoListHostCommand = Schema.decodeUnknownSync(
  TodoListHostCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeTodoListHostResult = Schema.decodeUnknownSync(
  TodoListHostResult,
  STRICT_DECODE_OPTIONS,
);

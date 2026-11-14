import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { StableHostId } from "./remoteAccess";
import { MentionableThreadId } from "./threadMentionIdentity";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The person's own to-do list, kept on one list host. Who may change it, how
 * other devices reach it, and what a to-do may link to are in the To-dos
 * specification (docs/design/todos.md).
 */

export const TodoId = Schema.UUID.pipe(Schema.brand("TodoId"));
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
export const TodoTitle = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(TODO_TITLE_MAX_CHARACTERS),
  Schema.filter((value) => !/[\r\n]/.test(value), {
    message: () => "A to-do title is one line.",
  }),
);
export type TodoTitle = typeof TodoTitle.Type;

/** Empty notes mean none. */
export const TodoNotes = Schema.String.pipe(Schema.maxLength(TODO_NOTES_MAX_CHARACTERS));
export type TodoNotes = typeof TodoNotes.Type;

/**
 * An exact label, as a Canvas tag is: two tags that differ only in case are
 * two tags, because a list that silently merged them would look like a tag
 * that went missing.
 */
export const TodoTag = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(TODO_TAG_MAX_CHARACTERS));
export type TodoTag = typeof TodoTag.Type;

export const TodoState = Schema.Literal("open", "done", "dropped");
export type TodoState = typeof TodoState.Type;

/**
 * A Project on any of the person's hosts. A pointer only: it grants nothing
 * on that host. The name is the one last seen, so a row still reads while
 * the host is unreachable.
 */
export const TodoProjectLink = Schema.Struct({
  hostId: StableHostId,
  projectId: ProjectId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(TODO_PROJECT_NAME_MAX_CHARACTERS)),
}).annotations(strict);
export type TodoProjectLink = typeof TodoProjectLink.Type;

/** A thread started from the to-do, on the host that owns it. Grants nothing. */
export const TodoThreadLink = Schema.Struct({
  hostId: StableHostId,
  threadId: MentionableThreadId,
  mode: OctantMode,
}).annotations(strict);
export type TodoThreadLink = typeof TodoThreadLink.Type;

export const Todo = Schema.Struct({
  id: TodoId,
  title: TodoTitle,
  notes: TodoNotes,
  projects: Schema.Array(TodoProjectLink).pipe(Schema.maxItems(TODO_MAX_PROJECTS)),
  tags: Schema.Array(TodoTag).pipe(Schema.maxItems(TODO_MAX_TAGS)),
  state: TodoState,
  /** Oldest first. */
  threads: Schema.Array(TodoThreadLink).pipe(Schema.maxItems(TODO_MAX_THREAD_LINKS)),
  /** Lower ranks list first. */
  rank: Schema.Number.pipe(Schema.finite()),
  /** The to-do's aggregate version; an edit names the one it was made on. */
  version: Schema.Int.pipe(Schema.positive()),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type Todo = typeof Todo.Type;

/** The whole list, in rank order. */
export const TodoListView = Schema.Struct({
  kind: Schema.Literal("todo-list"),
  todos: Schema.Array(Todo).pipe(Schema.maxItems(TODO_LIST_MAX)),
}).annotations(strict);
export type TodoListView = typeof TodoListView.Type;

const TodoProjectLinks = Schema.Array(TodoProjectLink).pipe(Schema.maxItems(TODO_MAX_PROJECTS));
const TodoTags = Schema.Array(TodoTag).pipe(Schema.maxItems(TODO_MAX_TAGS));

export const TodoCommand = Schema.Union(
  /**
   * The client names the id, so sending the same draft twice adds it once:
   * a second add of an id the list holds changes nothing.
   */
  Schema.Struct({
    kind: Schema.Literal("add-todo"),
    todoId: TodoId,
    title: TodoTitle,
    notes: Schema.optional(TodoNotes),
    projects: Schema.optional(TodoProjectLinks),
    tags: Schema.optional(TodoTags),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("edit-todo"),
    todoId: TodoId,
    expectedVersion: Schema.Int.pipe(Schema.positive()),
    title: TodoTitle,
    notes: TodoNotes,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-todo-state"),
    todoId: TodoId,
    state: TodoState,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-todo-projects"),
    todoId: TodoId,
    projects: TodoProjectLinks,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-todo-tags"),
    todoId: TodoId,
    tags: TodoTags,
  }).annotations(strict),
  /** Absent `beforeTodoId` moves the to-do to the bottom. */
  Schema.Struct({
    kind: Schema.Literal("move-todo"),
    todoId: TodoId,
    beforeTodoId: Schema.optional(TodoId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("link-todo-thread"),
    todoId: TodoId,
    thread: TodoThreadLink,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("delete-todo"),
    todoId: TodoId,
  }).annotations(strict),
);
export type TodoCommand = typeof TodoCommand.Type;

export const TodoRefusalReason = Schema.Literal(
  "malformed",
  "unauthorized",
  "not-found",
  "changed-elsewhere",
  "list-full",
);
export type TodoRefusalReason = typeof TodoRefusalReason.Type;

export const TodoRefused = Schema.Struct({
  kind: Schema.Literal("todo-refused"),
  reason: TodoRefusalReason,
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type TodoRefused = typeof TodoRefused.Type;

export const TodoResult = Schema.Union(TodoListView, TodoRefused);
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
  rank: Schema.Number.pipe(Schema.finite()),
}).annotations(strict);
export type TodoCreated = typeof TodoCreated.Type;

export const TodoEdited = Schema.Struct({
  todoId: TodoId,
  title: TodoTitle,
  notes: TodoNotes,
}).annotations(strict);
export type TodoEdited = typeof TodoEdited.Type;

export const TodoStateChanged = Schema.Struct({
  todoId: TodoId,
  state: TodoState,
}).annotations(strict);
export type TodoStateChanged = typeof TodoStateChanged.Type;

export const TodoProjectsSet = Schema.Struct({
  todoId: TodoId,
  projects: TodoProjectLinks,
}).annotations(strict);
export type TodoProjectsSet = typeof TodoProjectsSet.Type;

export const TodoTagsSet = Schema.Struct({
  todoId: TodoId,
  tags: TodoTags,
}).annotations(strict);
export type TodoTagsSet = typeof TodoTagsSet.Type;

export const TodoOrderChanged = Schema.Struct({
  todoId: TodoId,
  rank: Schema.Number.pipe(Schema.finite()),
}).annotations(strict);
export type TodoOrderChanged = typeof TodoOrderChanged.Type;

export const TodoThreadLinked = Schema.Struct({
  todoId: TodoId,
  thread: TodoThreadLink,
}).annotations(strict);
export type TodoThreadLinked = typeof TodoThreadLinked.Type;

export const TodoDeleted = Schema.Struct({
  todoId: TodoId,
}).annotations(strict);
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

export const decodeTodoId = Schema.decodeUnknownSync(TodoId);
export const decodeTodoCommand = Schema.decodeUnknownSync(TodoCommand);
export const decodeTodoResult = Schema.decodeUnknownSync(TodoResult);
export const decodeTodoListView = Schema.decodeUnknownSync(TodoListView);

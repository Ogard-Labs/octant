import type { EventActor, EventEnvelope, UtcTimestamp } from "@octant/contracts";
import {
  TODO_AGGREGATE_TYPE,
  TODO_CREATED,
  TODO_DELETED,
  TODO_EDITED,
  TODO_ORDER_CHANGED,
  TODO_PROJECTS_SET,
  TODO_STATE_CHANGED,
  TODO_TAGS_SET,
  TODO_THREAD_LINKED,
  TodoCreated,
  TodoDeleted,
  TodoEdited,
  TodoOrderChanged,
  TodoProjectsSet,
  TodoStateChanged,
  TodoTagsSet,
  TodoThreadLinked,
  decodeTodoResult,
  type TodoCommand,
  type TodoEvent,
  type TodoListView,
  type TodoResult,
} from "@octant/contracts/todos";
import {
  applyTodoEvent,
  decideTodoCommand,
  todosInOrder,
  type TodoRecord,
} from "@octant/domain/todo-policy";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";

const decodeCreated = Schema.decodeUnknownSync(TodoCreated);
const decodeEdited = Schema.decodeUnknownSync(TodoEdited);
const decodeStateChanged = Schema.decodeUnknownSync(TodoStateChanged);
const decodeProjectsSet = Schema.decodeUnknownSync(TodoProjectsSet);
const decodeTagsSet = Schema.decodeUnknownSync(TodoTagsSet);
const decodeOrderChanged = Schema.decodeUnknownSync(TodoOrderChanged);
const decodeThreadLinked = Schema.decodeUnknownSync(TodoThreadLinked);
const decodeDeleted = Schema.decodeUnknownSync(TodoDeleted);

export function registerTodoEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(TODO_CREATED, 1, TodoCreated)
    .register(TODO_EDITED, 1, TodoEdited)
    .register(TODO_STATE_CHANGED, 1, TodoStateChanged)
    .register(TODO_PROJECTS_SET, 1, TodoProjectsSet)
    .register(TODO_TAGS_SET, 1, TodoTagsSet)
    .register(TODO_ORDER_CHANGED, 1, TodoOrderChanged)
    .register(TODO_THREAD_LINKED, 1, TodoThreadLinked)
    .register(TODO_DELETED, 1, TodoDeleted);
}

/** A journaled row read back as the to-do event it holds; undefined for another kind of row. */
function todoEventOf(
  envelope: Pick<EventEnvelope, "eventName" | "payload">,
): TodoEvent | undefined {
  const { eventName, payload } = envelope;
  switch (eventName) {
    case TODO_CREATED:
      return { eventName: TODO_CREATED, payload: decodeCreated(payload) };
    case TODO_EDITED:
      return { eventName: TODO_EDITED, payload: decodeEdited(payload) };
    case TODO_STATE_CHANGED:
      return { eventName: TODO_STATE_CHANGED, payload: decodeStateChanged(payload) };
    case TODO_PROJECTS_SET:
      return { eventName: TODO_PROJECTS_SET, payload: decodeProjectsSet(payload) };
    case TODO_TAGS_SET:
      return { eventName: TODO_TAGS_SET, payload: decodeTagsSet(payload) };
    case TODO_ORDER_CHANGED:
      return { eventName: TODO_ORDER_CHANGED, payload: decodeOrderChanged(payload) };
    case TODO_THREAD_LINKED:
      return { eventName: TODO_THREAD_LINKED, payload: decodeThreadLinked(payload) };
    case TODO_DELETED:
      return { eventName: TODO_DELETED, payload: decodeDeleted(payload) };
    default:
      return undefined;
  }
}

export interface TodoStoreDependencies {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
}

/**
 * The person's to-do list on this host. Every to-do is its own aggregate in
 * the journal, and the list is rebuilt from those events at start; nothing
 * else holds it. Commands run one at a time on the server's single thread, so
 * a decision is made on the list exactly as the journal left it.
 */
export class TodoStore {
  readonly #dependencies: TodoStoreDependencies;
  readonly #todos = new Map<string, TodoRecord>();
  readonly #deleted = new Set<string>();

  constructor(dependencies: TodoStoreDependencies) {
    this.#dependencies = dependencies;
    for (const envelope of replayAggregateTypesInOrder(dependencies.journal, [
      TODO_AGGREGATE_TYPE,
    ])) {
      const event = todoEventOf(envelope);
      if (event === undefined) continue;
      this.#apply(event, {
        version: envelope.aggregateVersion,
        occurredAt: envelope.occurredAt,
      });
    }
  }

  view(): TodoListView {
    return {
      kind: "todo-list",
      todos: todosInOrder([...this.#todos.values()].map((record) => record.todo)),
    };
  }

  change(command: TodoCommand, actor: EventActor): TodoResult {
    const decision = decideTodoCommand({ todos: this.#todos, deleted: this.#deleted }, command);
    if (decision.kind === "refused") {
      return decodeTodoResult({
        kind: "todo-refused",
        reason: decision.reason,
        message: decision.message,
      });
    }
    if (decision.kind === "append") {
      for (const { todoId, expectedVersion, event } of decision.appends) {
        const occurredAt = this.#dependencies.clock();
        const committed = this.#dependencies.journal.append({
          aggregate: { aggregateType: TODO_AGGREGATE_TYPE, aggregateId: String(todoId) },
          expectedVersion,
          events: [
            {
              eventId: this.#dependencies.uuid(),
              eventName: event.eventName,
              eventVersion: 1,
              correlationId: this.#dependencies.uuid(),
              actor,
              occurredAt,
              payload: event.payload,
            },
          ],
        });
        this.#apply(event, { version: committed.aggregateVersion, occurredAt });
      }
    }
    return this.view();
  }

  #apply(
    event: TodoEvent,
    committed: { readonly version: number; readonly occurredAt: UtcTimestamp },
  ): void {
    const id = String(event.payload.todoId);
    const next = applyTodoEvent(this.#todos.get(id), event, committed);
    if (next === undefined) {
      this.#todos.delete(id);
      if (event.eventName === TODO_DELETED) this.#deleted.add(id);
      return;
    }
    this.#todos.set(id, next);
  }
}

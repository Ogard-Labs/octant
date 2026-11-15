import type { EventActor, EventEnvelope, UtcTimestamp } from "@octant/contracts";
import type { StableHostId } from "@octant/contracts/remote-access";
import {
  TODO_AGGREGATE_TYPE,
  TODO_LIST_HOST_AGGREGATE_ID,
  TODO_LIST_HOST_AGGREGATE_TYPE,
  TODO_LIST_HOST_CHOSEN,
  TodoListHostChosen,
  decodeTodoListHostResult,
  type TodoListHostChoice,
  type TodoListHostCommand,
  type TodoListHostResult,
  type TodoListHostView,
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
const decodeListHostChosen = Schema.decodeUnknownSync(TodoListHostChosen);

export function registerTodoEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(TODO_CREATED, 1, TodoCreated)
    .register(TODO_EDITED, 1, TodoEdited)
    .register(TODO_STATE_CHANGED, 1, TodoStateChanged)
    .register(TODO_PROJECTS_SET, 1, TodoProjectsSet)
    .register(TODO_TAGS_SET, 1, TodoTagsSet)
    .register(TODO_ORDER_CHANGED, 1, TodoOrderChanged)
    .register(TODO_THREAD_LINKED, 1, TodoThreadLinked)
    .register(TODO_DELETED, 1, TodoDeleted)
    .register(TODO_LIST_HOST_CHOSEN, 1, TodoListHostChosen);
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
  readonly journal: Pick<Journal, "append" | "replayAggregateType" | "transaction">;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  /** This host's stable id, which names its own Projects in a to-do's links. */
  readonly hostId: () => StableHostId;
  readonly defaultActor: EventActor;
  readonly defaultListHost?: () => Extract<TodoListHostChoice, { kind: "other-host" }> | undefined;
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
  #defaultListHost:
    | (() => Extract<TodoListHostChoice, { kind: "other-host" }> | undefined)
    | undefined;
  #listHost: { readonly choice: TodoListHostChoice; readonly version: number } = {
    choice: { kind: "this-host" },
    version: 0,
  };

  constructor(dependencies: TodoStoreDependencies) {
    this.#dependencies = dependencies;
    this.#defaultListHost = dependencies.defaultListHost;
    for (const envelope of replayAggregateTypesInOrder(dependencies.journal, [
      TODO_AGGREGATE_TYPE,
      TODO_LIST_HOST_AGGREGATE_TYPE,
    ])) {
      if (envelope.eventName === TODO_LIST_HOST_CHOSEN) {
        this.#listHost = {
          choice: decodeListHostChosen(envelope.payload).choice,
          version: envelope.aggregateVersion,
        };
        continue;
      }
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
      hostId: this.#dependencies.hostId(),
      todos: todosInOrder([...this.#todos.values()].map((record) => record.todo)),
    };
  }

  setDefaultListHost(
    read: () => Extract<TodoListHostChoice, { kind: "other-host" }> | undefined,
  ): void {
    this.#defaultListHost = read;
  }

  #effectiveListHost(): TodoListHostChoice {
    if (this.#listHost.version !== 0 || this.#todos.size > 0) return this.#listHost.choice;
    const choice = this.#defaultListHost?.();
    if (choice === undefined) return this.#listHost.choice;
    this.chooseListHost({ kind: "choose-todo-list-host", choice }, this.#dependencies.defaultActor);
    return this.#listHost.choice;
  }

  listHost(): TodoListHostView {
    return {
      kind: "todo-list-host",
      thisHostId: this.#dependencies.hostId(),
      choice: this.#effectiveListHost(),
      ownListEmpty: this.#todos.size === 0,
    };
  }

  /**
   * The list moves to another host only while this one holds none: moving a
   * list's to-dos is later work, and a choice that hid them would read as
   * losing them. Coming back to this host is always allowed.
   */
  chooseListHost(command: TodoListHostCommand, actor: EventActor): TodoListHostResult {
    const { choice } = command;
    if (choice.kind === "other-host") {
      if (String(choice.hostId) === String(this.#dependencies.hostId())) {
        return decodeTodoListHostResult({
          kind: "todo-refused",
          reason: "malformed",
          message: "That is this computer.",
        });
      }
      if (this.#todos.size > 0) {
        return decodeTodoListHostResult({
          kind: "todo-refused",
          reason: "list-not-empty",
          message:
            "This computer already keeps to-dos, so the list stays here. Delete them first to keep the list on another computer.",
        });
      }
    }
    const current = this.#listHost.choice;
    const unchanged =
      current.kind === choice.kind &&
      (choice.kind === "this-host" ||
        (current.kind === "other-host" &&
          String(current.hostId) === String(choice.hostId) &&
          current.name === choice.name));
    if (unchanged && this.#listHost.version !== 0) return this.listHost();
    const appended = this.#dependencies.journal.append({
      aggregate: {
        aggregateType: TODO_LIST_HOST_AGGREGATE_TYPE,
        aggregateId: TODO_LIST_HOST_AGGREGATE_ID,
      },
      expectedVersion: this.#listHost.version,
      events: [
        {
          eventId: this.#dependencies.uuid(),
          eventName: TODO_LIST_HOST_CHOSEN,
          eventVersion: 1,
          correlationId: this.#dependencies.uuid(),
          actor,
          occurredAt: this.#dependencies.clock(),
          payload: { choice },
        },
      ],
    });
    this.#listHost = { choice, version: appended.aggregateVersion };
    return this.listHost();
  }

  change(command: TodoCommand, actor: EventActor): TodoResult {
    // A list kept elsewhere is changed there. A to-do added here, by a stale
    // window or a phone paired with this host, would sit in a list nobody is
    // shown, and would lock the choice that hid it.
    const keptOn = this.#effectiveListHost();
    if (keptOn.kind === "other-host") {
      return decodeTodoResult({
        kind: "todo-refused",
        reason: "kept-elsewhere",
        message: `${keptOn.name} keeps the to-do list, so it is changed there.`,
      });
    }
    const decision = decideTodoCommand({ todos: this.#todos, deleted: this.#deleted }, command);
    if (decision.kind === "refused") {
      return decodeTodoResult({
        kind: "todo-refused",
        reason: decision.reason,
        message: decision.message,
      });
    }
    if (decision.kind === "append") {
      // A renumber touches many to-dos. They commit as one unit, and the list
      // in memory changes only after that unit committed, so a failure partway
      // leaves neither the journal nor the list with half a new order.
      const committed = this.#dependencies.journal.transaction(() =>
        decision.appends.map(({ todoId, expectedVersion, event }) => {
          const occurredAt = this.#dependencies.clock();
          const appended = this.#dependencies.journal.append({
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
          return { event, version: appended.aggregateVersion, occurredAt };
        }),
      );
      for (const { event, version, occurredAt } of committed) {
        this.#apply(event, { version, occurredAt });
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

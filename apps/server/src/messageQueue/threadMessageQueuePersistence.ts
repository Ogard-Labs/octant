import { createHash, randomUUID } from "node:crypto";
import {
  MentionableThreadId,
  MAX_THREAD_MESSAGE_QUEUE_ITEMS,
  AggregateVersion,
  ThreadMessageQueueScope,
  ThreadMessageQueueItem,
  ThreadMessageQueueHoldReason,
  ThreadMessageQueueRequestId,
  ThreadQueueMessageId,
  CodeOperationId,
  THREAD_RETENTION_EVENT_NAMES,
  decodeChatDeleted,
  decodeThreadRetentionThreadPurged,
  decodeThreadMessageQueuePayload,
  decodeThreadMessageQueueSnapshot,
  type ThreadMessageQueueCommand,
  type EventActor,
  type EventEnvelope,
  type ThreadMessageQueueSnapshot,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { ThreadMessageQueueResource } from "./threadMessageQueuePort";

export const THREAD_MESSAGE_QUEUE_CHANGED = "thread.message-queue-changed@1";
const MetadataItem = Schema.Struct({
  ...ThreadMessageQueueItem.omit("payload").fields,
  codeOperationId: Schema.optional(CodeOperationId),
});
const QueueState = Schema.Struct({
  scope: ThreadMessageQueueScope,
  version: AggregateVersion,
  paused: Schema.Boolean,
  holdReason: Schema.optional(ThreadMessageQueueHoldReason),
  items: Schema.Array(MetadataItem).pipe(Schema.maxItems(MAX_THREAD_MESSAGE_QUEUE_ITEMS)),
});
export type QueueState = typeof QueueState.Type;
const Settled = Schema.Struct({
  messageId: ThreadQueueMessageId,
  status: Schema.Literal("removed", "completed", "failed", "cancelled"),
});
export type QueueSettlement = typeof Settled.Type;
const QueueChanged = Schema.Struct({
  threadId: MentionableThreadId,
  state: QueueState,
  requestId: Schema.optional(ThreadMessageQueueRequestId),
  requestFingerprint: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))),
  enqueued: Schema.optional(
    Schema.Struct({
      messageId: ThreadQueueMessageId,
      fingerprint: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
    }),
  ),
  settled: Schema.optional(Settled),
})
  .annotations({ parseOptions: { onExcessProperty: "error" } })
  .pipe(Schema.filter((value) => String(value.threadId) === String(value.state.scope.threadId)));
const decodeState = Schema.decodeUnknownSync(QueueState);
const decodeChanged = Schema.decodeUnknownSync(QueueChanged);
const jsonRow = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }));
export const THREAD_MESSAGE_QUEUE_SQL = `
CREATE TABLE thread_message_queue_projection (
  queue_id TEXT PRIMARY KEY, mode TEXT NOT NULL, thread_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK(json_valid(state_json)), UNIQUE(mode,thread_id)
) STRICT;
CREATE TABLE thread_message_queue_identity (
  message_id TEXT PRIMARY KEY, queue_id TEXT NOT NULL, status TEXT NOT NULL, fingerprint TEXT NOT NULL
) STRICT;
CREATE TABLE thread_message_queue_receipt (
  request_id TEXT PRIMARY KEY, queue_id TEXT NOT NULL, fingerprint TEXT NOT NULL
) STRICT;
CREATE TABLE thread_message_queue_deleted (queue_id TEXT PRIMARY KEY) STRICT;
CREATE TABLE thread_message_queue_content (
  message_id TEXT PRIMARY KEY, queue_id TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)), byte_size INTEGER NOT NULL
) STRICT;
CREATE INDEX thread_message_queue_content_scope ON thread_message_queue_content(queue_id);
`;

export function registerThreadMessageQueueEvents(events: EventRegistry): void {
  events.register(THREAD_MESSAGE_QUEUE_CHANGED, 1, QueueChanged);
}
export function queueId(scope: ThreadMessageQueueScope): string {
  const hash = createHash("sha1")
    .update("octant:thread-message-queue\0")
    .update(scope.mode)
    .update("\0")
    .update(String(scope.threadId))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export class ThreadMessageQueueProjection implements Projection {
  readonly name = "thread-message-queue";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads", "chat", "thread-retention"];
  reset(connection: SqliteConnection): void {
    connection.exec(
      "DELETE FROM thread_message_queue_projection; DELETE FROM thread_message_queue_identity; DELETE FROM thread_message_queue_receipt; DELETE FROM thread_message_queue_deleted;",
    );
  }
  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (
      event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged ||
      event.eventName === "chat.deleted@1"
    ) {
      const p =
        event.eventName === "chat.deleted@1"
          ? { mode: "chat", threadId: decodeChatDeleted(event.payload).threadId }
          : decodeThreadRetentionThreadPurged(event.payload);
      const id = queueId(
        Schema.decodeUnknownSync(ThreadMessageQueueScope)({ mode: p.mode, threadId: p.threadId }),
      );
      connection
        .prepare("INSERT OR IGNORE INTO thread_message_queue_deleted(queue_id) VALUES(?)")
        .run(id);
      connection.prepare("DELETE FROM thread_message_queue_content WHERE queue_id=?").run(id);
      connection.prepare("DELETE FROM thread_message_queue_projection WHERE queue_id=?").run(id);
      connection.prepare("DELETE FROM thread_message_queue_identity WHERE queue_id=?").run(id);
      connection.prepare("DELETE FROM thread_message_queue_receipt WHERE queue_id=?").run(id);
      return;
    }
    if (
      event.eventName !== THREAD_MESSAGE_QUEUE_CHANGED ||
      event.aggregateType !== "thread-message-queue"
    )
      return;
    const payload = decodeChanged(event.payload);
    const { state } = payload;
    const id = queueId(state.scope);
    if (id !== String(event.aggregateId) || state.version !== event.aggregateVersion)
      throw new Error("Queue event identity does not match its aggregate");
    if (isQueuePurged(connection, state.scope)) return;
    for (const item of state.items) {
      connection
        .prepare(`INSERT INTO thread_message_queue_identity(message_id,queue_id,status,fingerprint) VALUES(?,?,?,?)
        ON CONFLICT(message_id) DO UPDATE SET status=excluded.status WHERE queue_id=excluded.queue_id`)
        .run(
          item.messageId,
          id,
          item.status,
          payload.enqueued?.messageId === item.messageId ? payload.enqueued.fingerprint : "",
        );
    }
    if (payload.settled)
      connection
        .prepare(
          "UPDATE thread_message_queue_identity SET status=? WHERE message_id=? AND queue_id=?",
        )
        .run(payload.settled.status, payload.settled.messageId, id);
    if (payload.requestId)
      connection
        .prepare(
          "INSERT OR IGNORE INTO thread_message_queue_receipt(request_id,queue_id,fingerprint) VALUES(?,?,?)",
        )
        .run(payload.requestId, id, payload.requestFingerprint);
    connection
      .prepare(`INSERT INTO thread_message_queue_projection(queue_id,mode,thread_id,state_json) VALUES(?,?,?,?)
      ON CONFLICT(queue_id) DO UPDATE SET state_json=excluded.state_json`)
      .run(id, state.scope.mode, state.scope.threadId, JSON.stringify(state));
  }
}
export function isQueuePurged(
  connection: SqliteConnection,
  scope: ThreadMessageQueueScope,
): boolean {
  return (
    (scope.mode === "chat" &&
      connection
        .prepare("SELECT 1 FROM chat_purge_projection WHERE thread_id=? AND state='completed'")
        .get(scope.threadId) !== undefined) ||
    connection
      .prepare("SELECT 1 FROM thread_message_queue_deleted WHERE queue_id=?")
      .get(queueId(scope)) !== undefined ||
    connection
      .prepare("SELECT 1 FROM thread_purge_tombstone WHERE mode=? AND thread_id=?")
      .get(scope.mode, scope.threadId) !== undefined
  );
}
export interface QueueContent extends ThreadMessageQueueResource {
  readonly binding: string;
}
const Content = Schema.Struct({
  scope: ThreadMessageQueueScope,
  messageId: ThreadQueueMessageId,
  payload: Schema.Unknown,
  binding: Schema.String,
  privateContextJson: Schema.optional(Schema.String),
});
export class ThreadMessageQueuePersistence {
  readonly #connection: SqliteConnection;
  readonly #journal: Journal;
  readonly #actor: EventActor;
  readonly #clock: () => string;
  constructor(input: {
    readonly connection: SqliteConnection;
    readonly journal: Journal;
    readonly actor: EventActor;
    readonly clock: () => string;
  }) {
    this.#connection = input.connection;
    this.#journal = input.journal;
    this.#actor = input.actor;
    this.#clock = input.clock;
  }
  purged(scope: ThreadMessageQueueScope): boolean {
    return isQueuePurged(this.#connection, scope);
  }
  state(scope: ThreadMessageQueueScope): QueueState {
    const row = this.#connection
      .prepare("SELECT state_json AS value FROM thread_message_queue_projection WHERE queue_id=?")
      .get(queueId(scope));
    return row === undefined
      ? decodeState({ scope, version: 0, paused: false, items: [] })
      : decodeState(JSON.parse(jsonRow(row).value));
  }
  scopes(): ReadonlyArray<ThreadMessageQueueScope> {
    return this.#connection
      .prepare(`SELECT queue.state_json AS value FROM thread_message_queue_projection AS queue
        WHERE json_array_length(queue.state_json, '$.items') > 0
           OR EXISTS (SELECT 1 FROM thread_message_queue_content AS content
                      WHERE content.queue_id = queue.queue_id)`)
      .all()
      .map((row) => decodeState(JSON.parse(jsonRow(row).value)).scope);
  }
  identity(
    messageId: string,
  ):
    | { readonly queue_id: string; readonly status: string; readonly fingerprint: string }
    | undefined {
    const row = this.#connection
      .prepare(
        "SELECT queue_id,status,fingerprint FROM thread_message_queue_identity WHERE message_id=?",
      )
      .get(messageId);
    return row === undefined
      ? undefined
      : Schema.decodeUnknownSync(
          Schema.Struct({
            queue_id: Schema.String,
            status: Schema.String,
            fingerprint: Schema.String,
          }),
        )(row);
  }
  receipt(
    requestId: string,
  ): { readonly queue_id: string; readonly fingerprint: string } | undefined {
    const row = this.#connection
      .prepare("SELECT queue_id,fingerprint FROM thread_message_queue_receipt WHERE request_id=?")
      .get(requestId);
    return row === undefined
      ? undefined
      : Schema.decodeUnknownSync(
          Schema.Struct({ queue_id: Schema.String, fingerprint: Schema.String }),
        )(row);
  }
  content(messageId: string): QueueContent | undefined {
    const row = this.#connection
      .prepare("SELECT content_json AS value FROM thread_message_queue_content WHERE message_id=?")
      .get(messageId);
    return row === undefined ? undefined : this.#decodeContent(jsonRow(row).value);
  }
  contents(scope?: ThreadMessageQueueScope): ReadonlyArray<QueueContent> {
    const rows =
      scope === undefined
        ? this.#connection
            .prepare("SELECT content_json AS value FROM thread_message_queue_content")
            .all()
        : this.#connection
            .prepare(
              "SELECT content_json AS value FROM thread_message_queue_content WHERE queue_id=?",
            )
            .all(queueId(scope));
    return rows.map((row) => this.#decodeContent(jsonRow(row).value));
  }
  #decodeContent(value: string): QueueContent {
    const decoded = Schema.decodeUnknownSync(Content)(JSON.parse(value));
    return {
      scope: decoded.scope,
      messageId: decoded.messageId,
      binding: decoded.binding,
      payload: decodeThreadMessageQueuePayload(decoded.payload),
      ...(decoded.privateContextJson === undefined
        ? {}
        : { privateContextJson: decoded.privateContextJson }),
    };
  }
  snapshot(scope: ThreadMessageQueueScope): ThreadMessageQueueSnapshot {
    const state = this.state(scope);
    return decodeThreadMessageQueueSnapshot({
      ...state,
      items: state.items.map((item) => {
        const content = this.content(item.messageId);
        const { codeOperationId: _codeOperationId, ...visible } = item;
        return { ...visible, ...(content === undefined ? {} : { payload: content.payload }) };
      }),
    });
  }
  deleteContent(messageId: string): void {
    this.#connection
      .prepare("DELETE FROM thread_message_queue_content WHERE message_id=?")
      .run(messageId);
  }
  write(
    state: QueueState,
    input: {
      readonly command?: ThreadMessageQueueCommand;
      readonly settled?: QueueSettlement;
      readonly content?: QueueContent;
    } = {},
  ): "applied" | "conflict" | "unavailable" {
    const contentJson = input.content === undefined ? undefined : JSON.stringify(input.content);
    try {
      this.#journal.append(
        {
          aggregate: { aggregateType: "thread-message-queue", aggregateId: queueId(state.scope) },
          expectedVersion: state.version,
          events: [
            {
              eventId: randomUUID(),
              eventName: THREAD_MESSAGE_QUEUE_CHANGED,
              eventVersion: 1,
              correlationId: input.command?.requestId ?? randomUUID(),
              actor: this.#actor,
              occurredAt: this.#clock(),
              payload: {
                threadId: state.scope.threadId,
                state: { ...state, version: state.version + 1 },
                ...(input.command === undefined
                  ? {}
                  : {
                      requestId: input.command.requestId,
                      requestFingerprint: queueFingerprint(input.command),
                    }),
                ...(input.command?.kind !== "enqueue"
                  ? {}
                  : {
                      enqueued: {
                        messageId: input.command.messageId,
                        fingerprint: queueFingerprint({
                          scope: input.command.scope,
                          payload: input.command.payload,
                        }),
                      },
                    }),
                ...(input.settled === undefined ? {} : { settled: input.settled }),
              },
            },
          ],
        },
        {
          beforeEvents: (connection) => {
            // The transaction must roll back private writes if the optimistic append loses.
            if (isQueuePurged(connection, state.scope)) throw new Error("Queue parent was purged");
            if (
              input.command?.kind === "enqueue" &&
              connection
                .prepare("SELECT 1 FROM thread_message_queue_identity WHERE message_id=?")
                .get(input.command.messageId) !== undefined
            )
              throw new Error("Queue message identity already exists");
            if (
              input.command !== undefined &&
              connection
                .prepare("SELECT 1 FROM thread_message_queue_receipt WHERE request_id=?")
                .get(input.command.requestId) !== undefined
            )
              throw new Error("Queue command identity already exists");
            if (input.content !== undefined && contentJson !== undefined)
              connection
                .prepare(`INSERT INTO thread_message_queue_content(message_id,queue_id,content_json,byte_size) VALUES(?,?,?,?)
            ON CONFLICT(message_id) DO UPDATE SET content_json=excluded.content_json,byte_size=excluded.byte_size WHERE queue_id=excluded.queue_id`)
                .run(
                  input.content.messageId,
                  queueId(state.scope),
                  contentJson,
                  Buffer.byteLength(contentJson),
                );
          },
        },
      );
      return "applied";
    } catch (error) {
      return error instanceof ConcurrencyConflict ? "conflict" : "unavailable";
    }
  }
}

export function queueFingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

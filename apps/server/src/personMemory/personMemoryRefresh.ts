import type { OctantMode } from "@octant/contracts";
import type { SqliteConnection } from "../persistence/sqlitePort";

/** The threads a refresh point is read for; the mode says where the journal keeps its turns. */
export interface PersonMemoryCutOffScope {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly createdAt: string;
  readonly providerInstanceId?: string | undefined;
  /**
   * The turn being prepared starts a session that does not resume an earlier
   * one. Its own start is not journaled yet, so the caller says so.
   */
  readonly startsFreshSession?: boolean | undefined;
}

/** How a provider keeps the conversation, as its driver reports it. */
export type ConversationOwnership = "provider" | "host" | "host-resumable" | undefined;

const BATCH = 64;

/**
 * Where a thread's person-memory block is cut: the entries kept up to this
 * moment are in it. It stays the thread's creation time until the model's
 * context is rebuilt, which is when a changed block costs nothing extra: a
 * finished compaction, Octant's own harness compacting, or a new provider
 * session that does not resume an earlier one. A resumed session is not a
 * refresh point. Everything is read from the journal, so it is the same after
 * a restart and for a turn the host starts or a subagent runs through its lead.
 *
 * A new session is read as a changed session id, which the host mints only for
 * a session that does not continue an earlier one (the id is carried whenever a
 * session is resumed). A provider that keeps no session of its own (the host
 * rebuilds the conversation every turn) refreshes at compaction only, so its
 * block does not change on every turn.
 */
export function createPersonMemoryCutOff(input: {
  readonly connection: SqliteConnection;
  readonly ownership: (providerInstanceId: string) => ConversationOwnership;
  readonly clock: () => string;
}): (scope: PersonMemoryCutOffScope) => string {
  const { connection } = input;
  return (scope) => {
    try {
      let cutOff = scope.createdAt;
      const compacted = latestOccurredAt(connection, {
        aggregateType: "context-ledger",
        aggregateId: scope.threadId,
        eventName: "context.compaction-completed@1",
      });
      if (compacted !== undefined && compacted > cutOff) cutOff = compacted;
      const owner =
        scope.providerInstanceId === undefined
          ? undefined
          : input.ownership(scope.providerInstanceId);
      const keepsSessions = owner === "provider" || owner === "host-resumable";
      if (!keepsSessions) return cutOff;
      const session = currentSession(connection, scope);
      if (session !== undefined) {
        if (session.startedAt > cutOff) cutOff = session.startedAt;
        const harnessCompacted = latestOccurredAt(connection, {
          aggregateType: "native-harness-transcript",
          aggregateId: session.sessionId,
          eventName: "native-harness-transcript-compacted@1",
        });
        if (harnessCompacted !== undefined && harnessCompacted > cutOff) cutOff = harnessCompacted;
      }
      if (scope.startsFreshSession === true) {
        const now = input.clock();
        if (now > cutOff) cutOff = now;
      }
      return cutOff;
    } catch {
      // A journal that cannot be read leaves the block as the thread began with
      // it, which is never newer than it should be.
      return scope.createdAt;
    }
  };
}

function latestOccurredAt(
  connection: SqliteConnection,
  key: {
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly eventName: string;
  },
): string | undefined {
  const row = connection
    .prepare(
      `SELECT MAX(occurred_at) AS at FROM event_journal
       WHERE aggregate_type = ? AND aggregate_id = ? AND event_name = ?`,
    )
    .get(key.aggregateType, key.aggregateId, key.eventName) as
    | { readonly at: string | null }
    | undefined;
  return row?.at ?? undefined;
}

interface SessionRow {
  readonly at: string;
  readonly session: string | null;
}

/** The newest session of a thread and when it was first used, newest turn first. */
function currentSession(
  connection: SqliteConnection,
  scope: PersonMemoryCutOffScope,
): { readonly sessionId: string; readonly startedAt: string } | undefined {
  let current: { sessionId: string; startedAt: string } | undefined;
  for (let offset = 0; ; offset += BATCH) {
    const rows = sessionRows(connection, scope, offset);
    for (const row of rows) {
      if (row.session === null) continue;
      if (current === undefined) current = { sessionId: row.session, startedAt: row.at };
      else if (row.session === current.sessionId) current.startedAt = row.at;
      else return current;
    }
    if (rows.length < BATCH) return current;
  }
}

/**
 * The thread's turns, newest first, each with the session it ran on:
 * Chat's first attempt as the turn was created, Work's accepted turn, and Code's
 * `provider-session-ready`. Each reads through an index that starts at the thread.
 */
function sessionRows(
  connection: SqliteConnection,
  scope: PersonMemoryCutOffScope,
  offset: number,
): ReadonlyArray<SessionRow> {
  if (scope.mode === "chat") {
    return connection
      .prepare(
        `SELECT occurred_at AS at,
                json_extract(payload_json, '$.turn.attempts[0].providerSessionId') AS session
         FROM event_journal
         WHERE aggregate_type = 'chat-thread' AND aggregate_id = ?
           AND event_name = 'chat.turn-created@1'
         ORDER BY aggregate_version DESC LIMIT ? OFFSET ?`,
      )
      .all(scope.threadId, BATCH, offset) as ReadonlyArray<SessionRow>;
  }
  if (scope.mode === "work") {
    return connection
      .prepare(
        `SELECT occurred_at AS at, json_extract(payload_json, '$.providerSessionId') AS session
         FROM event_journal
         WHERE aggregate_type = 'work-turn'
           AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
           AND event_name = 'work.turn-accepted@1'
         ORDER BY global_sequence DESC LIMIT ? OFFSET ?`,
      )
      .all(scope.threadId, BATCH, offset) as ReadonlyArray<SessionRow>;
  }
  return connection
    .prepare(
      `SELECT occurred_at AS at, json_extract(payload_json, '$.event.sessionId') AS session
       FROM event_journal
       WHERE aggregate_type = 'code-operation'
         AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
         AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.event.kind') END = 'provider-session-ready'
       ORDER BY global_sequence DESC LIMIT ? OFFSET ?`,
    )
    .all(scope.threadId, BATCH, offset) as ReadonlyArray<SessionRow>;
}

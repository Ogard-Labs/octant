import type { OctantMode } from "@octant/contracts";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { PersonMemoryStore } from "./personMemoryStore";

/** The threads a refresh point is read for; the mode says where the journal keeps its turns. */
export interface PersonMemoryCutOffScope {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly projectId?: string | undefined;
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

/**
 * Where a thread's person-memory block is cut: the entries kept up to this
 * moment are in it. It stays the thread's creation time until the model's
 * context is rebuilt, which is when a changed block costs nothing extra: a
 * finished compaction, Octant's own harness compacting, or a turn that starts a
 * provider session that does not resume an earlier one. A resumed session is not
 * a refresh point. Everything is read from the journal, so it is the same after
 * a restart and for a turn the host starts or a subagent runs through its lead.
 *
 * A turn that starts a session cuts the block at the moment it is built and
 * journals that moment (`store.startBlockCut`), so the turn itself and every
 * turn after it keep the entries up to the same instant, which no journaled
 * turn time could promise: a turn is journaled after its block is built. A
 * provider that keeps no session of its own (the host rebuilds the conversation
 * every turn) refreshes at compaction only, so its block does not change on
 * every turn.
 *
 * Every read is keyed by the thread or the session and takes one row, newest
 * first, so its cost does not grow with the thread: the partial indexes
 * `event_journal_context_compaction` and `event_journal_harness_compaction`
 * hold only compaction rows, and the session's id comes from the thread's own
 * newest turn.
 */
export function createPersonMemoryCutOff(input: {
  readonly connection: SqliteConnection;
  readonly ownership: (providerInstanceId: string) => ConversationOwnership;
  readonly store: Pick<PersonMemoryStore, "blockCut" | "startBlockCut">;
}): (scope: PersonMemoryCutOffScope) => string {
  const { connection, store } = input;
  return (scope) => {
    try {
      let cutOff = scope.createdAt;
      const compacted = latestCompactionAt(connection, "context", scope.threadId);
      if (compacted !== undefined && compacted > cutOff) cutOff = compacted;
      const owner =
        scope.providerInstanceId === undefined
          ? undefined
          : input.ownership(scope.providerInstanceId);
      const keepsSessions = owner === "provider" || owner === "host-resumable";
      if (!keepsSessions) return cutOff;
      const cut = store.blockCut(scope);
      if (cut !== undefined && cut > cutOff) cutOff = cut;
      const sessionId = newestSessionId(connection, scope);
      if (sessionId !== undefined) {
        const harnessCompacted = latestCompactionAt(connection, "harness", sessionId);
        if (harnessCompacted !== undefined && harnessCompacted > cutOff) cutOff = harnessCompacted;
      }
      if (scope.startsFreshSession === true) {
        const started = store.startBlockCut(scope);
        if (started !== undefined && started > cutOff) cutOff = started;
      }
      return cutOff;
    } catch {
      // A journal that cannot be read leaves the block as the thread began with
      // it, which is never newer than it should be.
      return scope.createdAt;
    }
  };
}

/**
 * The newest compaction in an aggregate. The statements spell the aggregate
 * type and event name as literals, because a partial index serves a query only
 * when the query itself says what the index's condition says; the planner,
 * which knows no row counts, prefers the general thread index to them, so the
 * statements name them.
 */
function latestCompactionAt(
  connection: SqliteConnection,
  kind: "context" | "harness",
  aggregateId: string,
): string | undefined {
  const sql =
    kind === "context"
      ? `SELECT occurred_at AS at FROM event_journal INDEXED BY event_journal_context_compaction
         WHERE aggregate_type = 'context-ledger' AND event_name = 'context.compaction-completed@1'
           AND aggregate_id = ?
         ORDER BY global_sequence DESC LIMIT 1`
      : `SELECT occurred_at AS at FROM event_journal INDEXED BY event_journal_harness_compaction
         WHERE aggregate_type = 'native-harness-transcript'
           AND event_name = 'native-harness-transcript-compacted@1'
           AND aggregate_id = ?
         ORDER BY global_sequence DESC LIMIT 1`;
  const row = connection.prepare(sql).get(aggregateId) as { readonly at: string } | undefined;
  return row?.at;
}

/**
 * The session the thread's newest turn runs on: the newest attempt in Chat (a
 * retry that starts a session of its own is the newest), Work's newest accepted
 * turn, Code's newest `provider-session-ready`. One keyed row each.
 */
function newestSessionId(
  connection: SqliteConnection,
  scope: PersonMemoryCutOffScope,
): string | undefined {
  const row =
    scope.mode === "chat"
      ? connection
          .prepare(
            `SELECT COALESCE(json_extract(payload_json, '$.attempt.providerSessionId'),
                             json_extract(payload_json, '$.turn.attempts[0].providerSessionId')) AS session
             FROM event_journal
             WHERE aggregate_type = 'chat-thread' AND aggregate_id = ?
               AND event_name IN ('chat.turn-created@1', 'chat.attempt-updated@1')
             ORDER BY global_sequence DESC LIMIT 1`,
          )
          .get(scope.threadId)
      : scope.mode === "work"
        ? connection
            .prepare(
              `SELECT json_extract(payload_json, '$.providerSessionId') AS session
               FROM event_journal
               WHERE aggregate_type = 'work-turn'
                 AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
                 AND event_name = 'work.turn-accepted@1'
               ORDER BY global_sequence DESC LIMIT 1`,
            )
            .get(scope.threadId)
        : connection
            .prepare(
              `SELECT json_extract(payload_json, '$.event.sessionId') AS session
               FROM event_journal
               WHERE aggregate_type = 'code-operation'
                 AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
                 AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.event.kind') END = 'provider-session-ready'
               ORDER BY global_sequence DESC LIMIT 1`,
            )
            .get(scope.threadId);
  return (row as { readonly session: string | null } | undefined)?.session ?? undefined;
}

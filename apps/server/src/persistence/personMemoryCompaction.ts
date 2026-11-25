import {
  PERSON_MEMORY_BLOCK_CUT,
  PERSON_MEMORY_CUT_AGGREGATE_TYPE,
  PERSON_MEMORY_MAX_TYPED_TURNS_PER_THREAD,
  PERSON_MEMORY_THREAD_AGGREGATE_TYPE,
  PERSON_MEMORY_THREAD_DISTILLED,
  PERSON_MEMORY_TURN_TYPED,
  PERSON_MEMORY_TYPED_AGGREGATE_TYPE,
} from "@octant/contracts/person-memory";
import type { SqliteConnection } from "./sqlitePort";
import { clampCheckpointsToJournalHead } from "./threadPurge";

export interface PersonMemoryCompactionReport {
  readonly aggregatesRemoved: number;
  readonly eventsRemoved: number;
}

/**
 * What a thread keeps: the newest block cut and the newest distilled digest,
 * and its newest typed-turn marks. Each is an aggregate of its own, so what
 * falls beyond is whole aggregates. The newest is the highest journal sequence.
 * Only one event name of each type can leave, so a released
 * `thread-remembered` event, and any aggregate that holds one, is never taken.
 */
const SUPERSEDED = [
  {
    aggregateType: PERSON_MEMORY_CUT_AGGREGATE_TYPE,
    eventName: PERSON_MEMORY_BLOCK_CUT,
    modePath: "$.mode",
    keep: 1,
  },
  {
    aggregateType: PERSON_MEMORY_THREAD_AGGREGATE_TYPE,
    eventName: PERSON_MEMORY_THREAD_DISTILLED,
    modePath: "$.digest.source.mode",
    keep: 1,
  },
  {
    aggregateType: PERSON_MEMORY_TYPED_AGGREGATE_TYPE,
    eventName: PERSON_MEMORY_TURN_TYPED,
    modePath: "$.mode",
    keep: PERSON_MEMORY_MAX_TYPED_TURNS_PER_THREAD,
  },
] as const;

/**
 * Removes the cuts, digests and marks a thread has outlived, whole aggregates
 * with their heads and quarantine rows, in one transaction. A run never erases
 * them, because any deletion from the journal clears the verification
 * watermark (migration 96); only the persistence start calls this, before it
 * records the watermark again at the head that is left. It reads only the three
 * aggregate types, by the type index, so a store without them reads nothing.
 */
export function compactSupersededPersonMemory(
  connection: SqliteConnection,
): PersonMemoryCompactionReport {
  // Off for the deletion like a thread purge: the quarantine rows that name a
  // deleted event leave in the same transaction.
  connection.pragma("foreign_keys = OFF");
  try {
    return connection.transaction((): PersonMemoryCompactionReport => {
      let aggregatesRemoved = 0;
      let eventsRemoved = 0;
      const removeQuarantine = connection.prepare(
        `DELETE FROM event_quarantine WHERE global_sequence IN (
           SELECT global_sequence FROM event_journal WHERE aggregate_type = ? AND aggregate_id = ?)`,
      );
      const removeEvents = connection.prepare(
        `DELETE FROM event_journal WHERE aggregate_type = ? AND aggregate_id = ?`,
      );
      const removeHead = connection.prepare(
        `DELETE FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?`,
      );
      const otherEvent = connection.prepare(
        `SELECT 1 AS other FROM event_journal
         WHERE aggregate_type = ? AND aggregate_id = ? AND event_name != ? LIMIT 1`,
      );
      for (const { aggregateType, eventName, modePath, keep } of SUPERSEDED) {
        const superseded = connection
          .prepare(
            `WITH ranked AS (
               SELECT aggregate_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY json_extract(payload_json, '${modePath}'),
                                json_extract(payload_json, '$.threadId')
                   ORDER BY global_sequence DESC
                 ) AS position
               FROM event_journal WHERE aggregate_type = ? AND event_name = ?
             )
             SELECT aggregate_id FROM ranked GROUP BY aggregate_id HAVING min(position) > ?`,
          )
          .all(aggregateType, eventName, keep) as ReadonlyArray<{
          readonly aggregate_id: string;
        }>;
        for (const { aggregate_id } of superseded) {
          // An aggregate that also holds another event is not whole superseded.
          if (otherEvent.get(aggregateType, aggregate_id, eventName) !== undefined) continue;
          removeQuarantine.run(aggregateType, aggregate_id);
          eventsRemoved += removeEvents.run(aggregateType, aggregate_id).changes;
          removeHead.run(aggregateType, aggregate_id);
          aggregatesRemoved += 1;
        }
      }
      if (aggregatesRemoved > 0) clampCheckpointsToJournalHead(connection);
      return { aggregatesRemoved, eventsRemoved };
    })();
  } finally {
    connection.pragma("foreign_keys = ON");
  }
}

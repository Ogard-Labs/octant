import {
  USAGE_RESUME_CANCELLED,
  USAGE_RESUME_SCHEDULED,
  USAGE_RESUME_SETTLED,
  decodeUsageResumeCancelled,
  decodeUsageResumeRecord,
  decodeUsageResumeScheduled,
  decodeUsageResumeSettled,
  decodeUsageResumeThreadState,
  type EventEnvelope,
  type UsageResumeRecord,
  type UsageResumeThreadState,
} from "@octant/contracts";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

/**
 * The read model behind both the thread's visible recovery state and the host
 * scheduler's pending scan.
 *
 * Usage-resume events journal on the thread's own aggregate, so one row per
 * (aggregate_type, aggregate_id) is the whole state: the record a person opted
 * into plus how it last settled. A cancelled opt-in deletes the row — there is
 * nothing left to report — while a settled one keeps its outcome so a surface
 * can say why a scheduled recovery is gone rather than letting it silently
 * disappear.
 */
export class UsageResumeProjection implements Projection {
  readonly name = "usage-resume";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`DELETE FROM usage_resume_projection;`);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.eventName === USAGE_RESUME_SCHEDULED) {
      const { resume } = decodeUsageResumeScheduled(event.payload);
      connection
        .prepare(
          `INSERT OR REPLACE INTO usage_resume_projection (
            aggregate_type, aggregate_id, resume_json, status, detail, last_sequence
          ) VALUES (?, ?, ?, 'scheduled', NULL, ?)`,
        )
        .run(event.aggregateType, event.aggregateId, JSON.stringify(resume), event.globalSequence);
      return;
    }
    if (event.eventName === USAGE_RESUME_CANCELLED) {
      decodeUsageResumeCancelled(event.payload);
      connection
        .prepare(
          `DELETE FROM usage_resume_projection WHERE aggregate_type = ? AND aggregate_id = ?`,
        )
        .run(event.aggregateType, event.aggregateId);
      return;
    }
    if (event.eventName === USAGE_RESUME_SETTLED) {
      const settled = decodeUsageResumeSettled(event.payload);
      connection
        .prepare(
          `UPDATE usage_resume_projection
           SET status = ?, detail = ?, last_sequence = ?
           WHERE aggregate_type = ? AND aggregate_id = ?`,
        )
        .run(
          settled.outcome,
          settled.detail ?? null,
          event.globalSequence,
          event.aggregateType,
          event.aggregateId,
        );
    }
  }

  createTable(connection: SqliteConnection): void {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS usage_resume_projection (
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        resume_json TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (aggregate_type, aggregate_id)
      )
    `);
  }
}

interface UsageResumeRow {
  readonly resume_json: string;
  readonly status: string;
  readonly detail: string | null;
}

const USAGE_RESUME_STATUSES: ReadonlySet<string> = new Set([
  "scheduled",
  "dispatched",
  "invalidated",
  "failed",
]);

function decodeRow(row: UsageResumeRow): UsageResumeThreadState | undefined {
  if (!USAGE_RESUME_STATUSES.has(row.status)) return undefined;
  return decodeUsageResumeThreadState({
    record: JSON.parse(row.resume_json),
    status: row.status,
    ...(row.detail === null ? {} : { detail: row.detail }),
  });
}

/** The thread's latest recovery state, as surfaces present it; `undefined` when none exists. */
export function readUsageResumeState(
  connection: SqliteConnection,
  aggregateType: string,
  threadId: string,
): UsageResumeThreadState | undefined {
  const row = connection
    .prepare(
      `SELECT resume_json, status, detail FROM usage_resume_projection
       WHERE aggregate_type = ? AND aggregate_id = ?`,
    )
    .get(aggregateType, threadId) as UsageResumeRow | undefined;
  return row === undefined ? undefined : decodeRow(row);
}

export interface PendingUsageResume {
  readonly aggregateType: string;
  readonly threadId: string;
  readonly record: UsageResumeRecord;
}

/**
 * Every scheduled recovery the host still owes a dispatch decision. The boot
 * scan reads this once after projections catch up, then the committed-append
 * subscription keeps each entry armed or dropped as later events land.
 */
export function listPendingUsageResumes(connection: SqliteConnection): Array<PendingUsageResume> {
  const rows = connection
    .prepare(
      `SELECT aggregate_type, aggregate_id, resume_json FROM usage_resume_projection
       WHERE status = 'scheduled'`,
    )
    .all() as ReadonlyArray<{
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly resume_json: string;
  }>;
  const pending: Array<PendingUsageResume> = [];
  for (const row of rows) {
    const record = decodeUsageResumeRecord(JSON.parse(row.resume_json));
    pending.push({
      aggregateType: row.aggregate_type,
      threadId: row.aggregate_id,
      record,
    });
  }
  return pending;
}

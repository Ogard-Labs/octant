import { NATIVE_HARNESS_TRANSCRIPT_AGGREGATE_TYPE } from "@octant/contracts";
import type { SqliteConnection } from "./sqlitePort";
import { deleteJournalEvents } from "./threadPurge";

export type UnrecordedSessionSweepReport =
  | { readonly status: "not-pending" }
  | {
      readonly status: "swept";
      readonly resumeIdentitiesRemoved: number;
      readonly transcriptsRemoved: number;
    };

const CLAUDE_RESUME_IDENTITY_AGGREGATE_TYPE = "claude-resume-identity";
const SWEPT_AGGREGATE_TYPES = new Set<string>([
  CLAUDE_RESUME_IDENTITY_AGGREGATE_TYPE,
  NATIVE_HARNESS_TRANSCRIPT_AGGREGATE_TYPE,
]);
const PENDING_SWEEP = "unrecorded-sessions";
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_PAGE_ROWS = 1_000;

interface SessionData {
  readonly aggregates: Array<{ readonly aggregateType: string; readonly aggregateId: string }>;
  /** Ids that refer to this session: its own and, for Claude, the runtime's. */
  readonly names: Set<string>;
}

/**
 * One-time erasure of what single-use provider sessions left in the journal.
 *
 * A hand-off, a context or compaction summary, a commit or pull-request draft,
 * and an advisor review each ran a provider session under a random id that no
 * thread records. Until those sessions started single-use, Claude journaled a
 * resume identity for each (with the scratch folder it ran in) and Octant
 * Harness journaled its transcript (with the thread content it was sent). A
 * purge follows a thread's own records to its sessions, so it never reaches
 * these.
 *
 * Doubt keeps the data. A session is erased only when its id, and for Claude
 * the runtime's own session id a resume is looked up by, appears in no other
 * journal event and in no child run's session record. That is wider than what
 * a purge follows (a Chat attempt's or Work turn's `providerSessionId`, a Code
 * operation's session events, a child run's session record): any mention at
 * all, a fork's source included, keeps the session, as does an id that is not
 * a UUID, which the text match below cannot be sure of. It runs at startup
 * before any session starts, so no live session can be missing its record.
 */
export function sweepUnrecordedSessionData(
  connection: SqliteConnection,
): UnrecordedSessionSweepReport {
  const pending = connection
    .prepare(`SELECT 1 AS pending FROM pending_session_sweep WHERE sweep = ?`)
    .get(PENDING_SWEEP);
  if (pending === undefined) return { status: "not-pending" };
  connection.pragma("foreign_keys = OFF");
  try {
    // One transaction, so the queued sweep is cleared only with its erasure.
    return connection.transaction((): UnrecordedSessionSweepReport => {
      const unrecorded = unrecordedSessionAggregates(connection);
      if (unrecorded.length > 0) eraseAggregates(connection, unrecorded);
      connection.prepare(`DELETE FROM pending_session_sweep WHERE sweep = ?`).run(PENDING_SWEEP);
      return {
        status: "swept",
        resumeIdentitiesRemoved: unrecorded.filter(
          (aggregate) => aggregate.aggregateType === CLAUDE_RESUME_IDENTITY_AGGREGATE_TYPE,
        ).length,
        transcriptsRemoved: unrecorded.filter(
          (aggregate) => aggregate.aggregateType === NATIVE_HARNESS_TRANSCRIPT_AGGREGATE_TYPE,
        ).length,
      };
    })();
  } finally {
    connection.pragma("foreign_keys = ON");
  }
}

function unrecordedSessionAggregates(
  connection: SqliteConnection,
): ReadonlyArray<{ readonly aggregateType: string; readonly aggregateId: string }> {
  const sessions = new Map<string, SessionData>();
  const rows = connection
    .prepare(
      `SELECT DISTINCT aggregate_type, aggregate_id FROM event_journal
       WHERE aggregate_type IN (?, ?)`,
    )
    .all(
      CLAUDE_RESUME_IDENTITY_AGGREGATE_TYPE,
      NATIVE_HARNESS_TRANSCRIPT_AGGREGATE_TYPE,
    ) as ReadonlyArray<{ readonly aggregate_type: string; readonly aggregate_id: string }>;
  for (const row of rows) {
    if (!UUID_EXACT.test(row.aggregate_id)) continue;
    const key = row.aggregate_id.toLowerCase();
    const session = sessions.get(key) ?? { aggregates: [], names: new Set([key]) };
    session.aggregates.push({ aggregateType: row.aggregate_type, aggregateId: row.aggregate_id });
    sessions.set(key, session);
  }
  if (sessions.size === 0) return [];

  const kept = new Set<string>();
  const runtimeIds = connection
    .prepare(
      `SELECT aggregate_id, json_extract(payload_json, '$.sdkSessionId') AS sdk_session_id
       FROM event_journal WHERE aggregate_type = ?`,
    )
    .all(CLAUDE_RESUME_IDENTITY_AGGREGATE_TYPE) as ReadonlyArray<{
    readonly aggregate_id: string;
    readonly sdk_session_id: unknown;
  }>;
  for (const row of runtimeIds) {
    const key = row.aggregate_id.toLowerCase();
    const session = sessions.get(key);
    if (session === undefined) continue;
    if (typeof row.sdk_session_id === "string" && UUID_EXACT.test(row.sdk_session_id)) {
      session.names.add(row.sdk_session_id.toLowerCase());
    } else {
      kept.add(key);
    }
  }

  const owners = new Map<string, Set<string>>();
  for (const [key, session] of sessions) {
    for (const name of session.names) {
      const named = owners.get(name) ?? new Set<string>();
      named.add(key);
      owners.set(name, named);
    }
  }
  // A session's own aggregates name it; only a mention from anything else
  // keeps it.
  const keepNamed = (text: string, ownSession: string | undefined) => {
    for (const [match] of text.matchAll(UUID_TEXT)) {
      for (const key of owners.get(match.toLowerCase()) ?? []) {
        if (key !== ownSession) kept.add(key);
      }
    }
  };

  const journalPage = connection.prepare(
    `SELECT global_sequence, aggregate_type, aggregate_id, payload_json FROM event_journal
     WHERE global_sequence > ? ORDER BY global_sequence LIMIT ?`,
  );
  for (let after = 0; ;) {
    const page = journalPage.all(after, SCAN_PAGE_ROWS) as ReadonlyArray<{
      readonly global_sequence: number;
      readonly aggregate_type: string;
      readonly aggregate_id: string;
      readonly payload_json: string;
    }>;
    for (const row of page) {
      after = row.global_sequence;
      keepNamed(
        row.payload_json,
        SWEPT_AGGREGATE_TYPES.has(row.aggregate_type) ? row.aggregate_id.toLowerCase() : undefined,
      );
    }
    if (page.length < SCAN_PAGE_ROWS) break;
  }
  // A child run's session is recorded only in its private session record.
  const runContentPage = connection.prepare(
    `SELECT rowid AS row_id, body_text FROM agent_run_content_store
     WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  for (let after = 0; ;) {
    const page = runContentPage.all(after, SCAN_PAGE_ROWS) as ReadonlyArray<{
      readonly row_id: number;
      readonly body_text: string;
    }>;
    for (const row of page) {
      after = row.row_id;
      keepNamed(row.body_text, undefined);
    }
    if (page.length < SCAN_PAGE_ROWS) break;
  }

  return [...sessions]
    .filter(([key]) => !kept.has(key))
    .flatMap(([, session]) => session.aggregates);
}

/**
 * Deletes the aggregates and only what points at them. Startup verifies the
 * store after this, so heads and checkpoints the sweep did not move are left
 * exactly as found: repairing them here would hide corruption the verifier
 * must report.
 */
function eraseAggregates(
  connection: SqliteConnection,
  aggregates: ReadonlyArray<{ readonly aggregateType: string; readonly aggregateId: string }>,
): void {
  const journalHead = () =>
    (
      connection
        .prepare(`SELECT coalesce(max(global_sequence), 0) AS head FROM event_journal`)
        .get() as { readonly head: number }
    ).head;
  const headBefore = journalHead();
  deleteJournalEvents(connection, aggregates);
  const deleteHead = connection.prepare(
    `DELETE FROM aggregate_heads
     WHERE aggregate_type = ? AND aggregate_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM event_journal
         WHERE event_journal.aggregate_type = aggregate_heads.aggregate_type
           AND event_journal.aggregate_id = aggregate_heads.aggregate_id
       )`,
  );
  for (const aggregate of aggregates)
    deleteHead.run(aggregate.aggregateType, aggregate.aggregateId);
  // A projection caught up to the old head has applied every surviving event,
  // so it stays current at the new one.
  const headAfter = journalHead();
  connection
    .prepare(
      `UPDATE projection_checkpoints SET last_sequence = ?
       WHERE last_sequence > ? AND last_sequence <= ?`,
    )
    .run(headAfter, headAfter, headBefore);
}

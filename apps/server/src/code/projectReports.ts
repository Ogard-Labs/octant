import { Schema } from "effect";
import {
  decodeCodeProjectReport,
  GlobalSequence,
  type CodeProjectReportCursor,
  type CodeProjectReportPage,
  type ProjectId,
} from "@octant/contracts";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeReportActivity = Schema.decodeUnknownSync(
  Schema.Struct({
    projectReportCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    projectReportSequence: Schema.NullOr(GlobalSequence),
  }),
);
const pageSize = 25;

// Select one receipt per turn in a single indexed pass. The journal can have
// more than one receipt for the same turn, and a rewind removes its report
// even if the receipt is still in the journal.
const reportSource = `
  WITH requested(projectId) AS (VALUES (?)), receipts AS (
    SELECT aggregate_id AS workerId, json_extract(payload_json, '$.turnId') AS operationId,
      MAX(global_sequence) AS sequence
    FROM event_journal
    WHERE json_extract(payload_json, '$.projectId') = (SELECT projectId FROM requested)
      AND aggregate_type = 'thread-finished-receipt'
      AND event_name = 'thread.finished-receipt-recorded@1'
      AND json_extract(payload_json, '$.mode') = 'code'
    GROUP BY aggregate_id, json_extract(payload_json, '$.turnId')
  )
  SELECT worker.thread_id AS workerId,
    json_extract(worker.thread_json, '$.title') AS title,
    turn.runtime_work_id AS operationId, turn.state, turn.updated_at AS updatedAt,
    max(turn.last_sequence, coalesce(reply.last_sequence, 0), coalesce(rec.sequence, 0)) AS sequence,
    rec.sequence AS receiptSequence, reply.body_text AS replyBody
  FROM code_thread_projection worker
  JOIN code_thread_projection owner
    ON owner.thread_id = json_extract(worker.thread_json, '$.coordinatorThreadId')
    AND owner.project_id = worker.project_id
  JOIN code_runtime_projection turn ON turn.thread_id = worker.thread_id
  LEFT JOIN code_transcript_search_projection reply
    ON reply.thread_id = worker.thread_id AND reply.operation_id = turn.runtime_work_id
    AND reply.content_role = 'assistant'
  LEFT JOIN receipts rec ON rec.workerId = worker.thread_id AND rec.operationId = turn.runtime_work_id
    AND turn.state = 'completed'
  WHERE worker.project_id = (SELECT projectId FROM requested) AND turn.work_kind = 'provider-turn'
    AND turn.state <> 'running' AND COALESCE(reply.rewound, 0) = 0
    AND (turn.state <> 'completed' OR rec.sequence IS NOT NULL OR length(trim(reply.body_text)) > 0)`;

const reportContent = `
  SELECT workerId, title, operationId, state, updatedAt, sequence,
    CASE WHEN receiptSequence IS NOT NULL THEN json_extract(receipt.payload_json, '$.summary')
      WHEN length(trim(replyBody)) > 480
      THEN substr(trim(replyBody), 1, 150) || ' … ' || substr(trim(replyBody), -327)
      ELSE trim(coalesce(replyBody, '')) END AS summary
  FROM page LEFT JOIN event_journal receipt ON receipt.global_sequence = receiptSequence
  ORDER BY sequence DESC, operationId DESC`;

export function projectReportsReader(connection: SqliteConnection) {
  const page = connection.prepare(`WITH page AS MATERIALIZED (
    SELECT * FROM (${reportSource})
    WHERE (sequence, operationId) < (coalesce(?, 9223372036854775807), ?)
    ORDER BY sequence DESC, operationId DESC LIMIT ?
  ) ${reportContent}`);
  const latest = connection.prepare(
    `SELECT COUNT(*) AS projectReportCount, MAX(sequence) AS projectReportSequence FROM (${reportSource})`,
  );
  // Navigation is read-only and can be polled by several windows. Share the
  // last result until SQLite changes. Rebuilds can change projections without
  // advancing the journal, so its head alone is not a sufficient cache key.
  const connectionRevision = connection.prepare("SELECT total_changes() AS revision");
  let cachedRevision: unknown;
  const latestByProject = new Map<ProjectId, ReturnType<typeof decodeReportActivity>>();
  return {
    projectReportPage: (
      projectId: ProjectId,
      before?: CodeProjectReportCursor,
    ): CodeProjectReportPage => {
      const rows = page.all(
        projectId,
        before?.sequence ?? null,
        before?.operationId ?? null,
        pageSize + 1,
      );
      const reports = rows.slice(0, pageSize).map((row) => decodeCodeProjectReport(row));
      const last = rows.length > pageSize ? reports.at(-1) : undefined;
      return {
        kind: "project-report-page",
        reports,
        ...(last === undefined
          ? {}
          : { next: { sequence: last.sequence, operationId: last.operationId } }),
      };
    },
    projectReportActivity: (projectId: ProjectId) => {
      const row = connectionRevision.get();
      const revision =
        typeof row === "object" && row !== null && "revision" in row ? row.revision : undefined;
      if (revision !== cachedRevision) {
        cachedRevision = revision;
        latestByProject.clear();
      }
      const cached = latestByProject.get(projectId);
      if (cached !== undefined) return cached;
      const activity = decodeReportActivity(latest.get(projectId));
      latestByProject.set(projectId, activity);
      return activity;
    },
  };
}

export type ProjectReportReader = ReturnType<typeof projectReportsReader>;

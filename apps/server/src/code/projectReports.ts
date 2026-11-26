import { Schema } from "effect";
import { decodeCodeProjectReport, GlobalSequence, type ProjectId } from "@octant/contracts";
import type { SqliteConnection } from "../persistence/sqlitePort";

const sequence = Schema.decodeUnknownSync(GlobalSequence);

// A settled turn is its report's identity. Replaying that operation replaces
// the same projected row. A running turn changes counts without creating unread.
const reportSource = `
  FROM code_thread_projection worker
  JOIN code_thread_projection owner
    ON owner.thread_id = json_extract(worker.thread_json, '$.coordinatorThreadId')
    AND owner.project_id = worker.project_id
  JOIN code_runtime_projection turn ON turn.thread_id = worker.thread_id
  LEFT JOIN code_transcript_search_projection reply
    ON reply.thread_id = worker.thread_id AND reply.operation_id = turn.runtime_work_id
    AND reply.content_role = 'assistant'
  LEFT JOIN event_journal receipt ON receipt.global_sequence = (
    SELECT recorded.global_sequence FROM event_journal recorded
    WHERE turn.state = 'completed' AND recorded.aggregate_type = 'thread-finished-receipt'
      AND recorded.aggregate_id = worker.thread_id AND recorded.event_name = 'thread.finished-receipt-recorded@1'
      AND json_extract(recorded.payload_json,'$.turnId') = turn.runtime_work_id
      AND json_extract(recorded.payload_json,'$.mode') = 'code'
      AND json_extract(recorded.payload_json,'$.projectId') = worker.project_id
    ORDER BY recorded.global_sequence DESC LIMIT 1)
  WHERE worker.project_id = ? AND turn.work_kind = 'provider-turn'
    AND turn.state <> 'running' AND COALESCE(reply.rewound, 0) = 0
    AND (turn.state <> 'completed' OR receipt.global_sequence IS NOT NULL OR length(trim(reply.body_text)) > 0)`;

const reportSequence =
  "max(turn.last_sequence,coalesce(reply.last_sequence,0),coalesce(receipt.global_sequence,0))";

export function projectReportsReader(connection: SqliteConnection) {
  const reports = connection.prepare(`SELECT worker.thread_id AS workerId,
    json_extract(worker.thread_json,'$.title') AS title, turn.runtime_work_id AS operationId,
    turn.state, turn.updated_at AS updatedAt, ${reportSequence} AS sequence,
    CASE WHEN receipt.global_sequence IS NOT NULL THEN json_extract(receipt.payload_json,'$.summary')
      WHEN length(trim(reply.body_text)) > 480
      THEN substr(trim(reply.body_text),1,150) || ' … ' || substr(trim(reply.body_text),-327)
      ELSE trim(coalesce(reply.body_text,'')) END AS summary
    ${reportSource} ORDER BY sequence DESC`);
  const latest = connection.prepare(`SELECT MAX(${reportSequence}) AS sequence ${reportSource}`);
  return {
    projectReports: (projectId: ProjectId) =>
      reports.all(projectId).map((row) => decodeCodeProjectReport(row)),
    projectReportSequence: (projectId: ProjectId) => {
      const row = latest.get(projectId);
      return typeof row === "object" && row !== null && "sequence" in row && row.sequence !== null
        ? sequence(row.sequence)
        : undefined;
    },
  };
}

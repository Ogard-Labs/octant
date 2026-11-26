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
  WHERE worker.project_id = ? AND turn.work_kind = 'provider-turn'
    AND turn.state <> 'running' AND COALESCE(reply.rewound, 0) = 0
    AND (turn.state <> 'completed' OR length(trim(reply.body_text)) > 0)`;

export function projectReportsReader(connection: SqliteConnection) {
  const reports = connection.prepare(`SELECT worker.thread_id AS workerId,
    json_extract(worker.thread_json,'$.title') AS title, turn.runtime_work_id AS operationId,
    turn.state, turn.updated_at AS updatedAt, max(turn.last_sequence,coalesce(reply.last_sequence,0)) AS sequence,
    substr(trim(coalesce(reply.body_text,'')),1,480) AS summary
    ${reportSource} ORDER BY sequence DESC`);
  const latest = connection.prepare(
    `SELECT MAX(max(turn.last_sequence,coalesce(reply.last_sequence,0))) AS sequence ${reportSource}`,
  );
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

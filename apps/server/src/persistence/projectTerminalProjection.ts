import {
  CodeTerminalId,
  PROJECT_TERMINAL_EVENT_NAMES,
  ProjectId,
  decodeProjectTerminalEnded,
  decodeProjectTerminalStarted,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const decodeTerminalId = Schema.decodeUnknownSync(CodeTerminalId);

/**
 * Which Project terminals the journal records as running.
 *
 * The one question asked of it is what a restart must end: a shell does not
 * survive the host, so every row still `running` when the host starts is a
 * record that has to be closed. Each event writes the whole row, so replay
 * lands on the same state however often it runs.
 */
export class ProjectTerminalProjection implements Projection {
  readonly name = "project-terminal";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`DELETE FROM project_terminal_projection;`);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.eventName === PROJECT_TERMINAL_EVENT_NAMES.started) {
      const started = decodeProjectTerminalStarted(event.payload);
      connection
        .prepare(
          `INSERT OR REPLACE INTO project_terminal_projection (
             terminal_id, project_id, state, last_sequence
           ) VALUES (?, ?, 'running', ?)`,
        )
        .run(String(started.terminalId), String(started.projectId), event.globalSequence);
      return;
    }
    if (event.eventName === PROJECT_TERMINAL_EVENT_NAMES.ended) {
      const ended = decodeProjectTerminalEnded(event.payload);
      connection
        .prepare(
          `INSERT OR REPLACE INTO project_terminal_projection (
             terminal_id, project_id, state, last_sequence
           ) VALUES (?, ?, 'ended', ?)`,
        )
        .run(String(ended.terminalId), String(ended.projectId), event.globalSequence);
    }
  }
}

export function readRunningProjectTerminals(connection: SqliteConnection): ReadonlyArray<{
  readonly projectId: typeof ProjectId.Type;
  readonly terminalId: typeof CodeTerminalId.Type;
}> {
  const rows = connection
    .prepare(
      `SELECT terminal_id, project_id FROM project_terminal_projection
       WHERE state = 'running' ORDER BY last_sequence ASC`,
    )
    .all() as ReadonlyArray<{ readonly terminal_id: string; readonly project_id: string }>;
  return rows.map((row) => ({
    projectId: decodeProjectId(row.project_id),
    terminalId: decodeTerminalId(row.terminal_id),
  }));
}

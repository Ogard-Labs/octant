import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import { sweepUnrecordedSessionData } from "./unrecordedSessionSweep";

const directories: Array<string> = [];
const now = "2026-10-26T12:00:00.000Z";
const providerInstanceId = "c7320000-0000-4000-8000-0000000000a1";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("unrecorded session sweep", () => {
  it("erases what single-use sessions left behind and keeps every session a thread or child run can still resume", () => {
    const connection = openStore();
    const singleUse = sessionData(connection);
    insertHead(connection, "claude-resume-identity", singleUse.sessionId);
    insertHead(connection, "native-harness-transcript", singleUse.sessionId);

    const chat = sessionData(connection);
    insertEvent(connection, "chat-thread", randomUUID(), {
      kind: "turn-created",
      turn: { attempts: [{ providerSessionId: chat.sessionId }] },
    });
    const work = sessionData(connection);
    insertEvent(connection, "work-turn", randomUUID(), {
      kind: "turn-accepted",
      providerSessionId: work.sessionId,
    });
    // A Code turn names its session as it starts, before the runtime reports
    // it ready; a host stopped in between leaves only this record.
    const code = sessionData(connection);
    insertEvent(connection, "code-operation", randomUUID(), {
      event: { kind: "conversation-turn-started", sessionId: code.sessionId },
    });
    const child = sessionData(connection);
    connection
      .prepare(
        `INSERT INTO agent_run_content_store (
          content_id, run_id, subject_type, subject_id, content_kind, body_text, created_at
        ) VALUES (?, ?, 'code-thread', ?, 'managed-session', ?, ?)`,
      )
      .run(
        randomUUID(),
        randomUUID(),
        randomUUID(),
        JSON.stringify({ sessionId: child.sessionId }),
        now,
      );
    // A resume is looked up by the runtime's own session id, so a thread that
    // kept only the resume cursor still owns the identity.
    const cursorOnly = sessionData(connection);
    insertEvent(connection, "chat-thread", randomUUID(), {
      resumeCursor: { driverKind: "claude", value: cursorOnly.sdkSessionId },
    });
    // A fork reads the turns it copied from its source's transcript.
    const fork = sessionData(connection);
    insertEvent(connection, "work-turn", randomUUID(), { providerSessionId: fork.sessionId });
    const source = sessionData(connection);
    insertEvent(
      connection,
      "native-harness-transcript",
      fork.sessionId,
      { sessionId: fork.sessionId, forkedFrom: { sessionId: source.sessionId, turns: 1 } },
      "native-harness-transcript-opened@1",
      2,
    );

    expect(sweepUnrecordedSessionData(connection)).toEqual({
      status: "swept",
      resumeIdentitiesRemoved: 1,
      transcriptsRemoved: 1,
    });

    const kept = [chat, work, code, child, cursorOnly, fork, source].map(
      (session) => session.sessionId,
    );
    expect(sessionsOf(connection, "claude-resume-identity")).toEqual([...kept].sort());
    expect(sessionsOf(connection, "native-harness-transcript")).toEqual([...kept].sort());
    expect(
      connection
        .prepare(`SELECT count(*) AS heads FROM aggregate_heads WHERE aggregate_id = ?`)
        .get(singleUse.sessionId),
    ).toEqual({ heads: 0 });
  });

  it("runs once, so a store already swept is left as it is", () => {
    const connection = openStore();
    insertEvent(connection, "work-turn", randomUUID(), { kind: "turn-accepted" });
    const survivingHead = journalHead(connection);
    sessionData(connection);
    // A projection caught up with the journal stays caught up once the
    // swept events at its head are gone.
    connection
      .prepare(
        `INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at)
         VALUES ('fixture', ?, ?)`,
      )
      .run(journalHead(connection), now);

    expect(sweepUnrecordedSessionData(connection)).toMatchObject({ status: "swept" });
    expect(
      connection
        .prepare(
          `SELECT last_sequence FROM projection_checkpoints WHERE projection_name = 'fixture'`,
        )
        .get(),
    ).toEqual({ last_sequence: survivingHead });

    const later = sessionData(connection);
    expect(sweepUnrecordedSessionData(connection)).toEqual({ status: "not-pending" });
    expect(sessionsOf(connection, "claude-resume-identity")).toEqual([later.sessionId]);
  });
});

function openStore(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-session-sweep-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

/** A provider session's Claude resume identity and Octant Harness transcript. */
function sessionData(connection: SqliteConnection): {
  readonly sessionId: string;
  readonly sdkSessionId: string;
} {
  const sessionId = randomUUID();
  const sdkSessionId = randomUUID();
  insertEvent(
    connection,
    "claude-resume-identity",
    sessionId,
    {
      providerInstanceId,
      octantSessionId: sessionId,
      sdkSessionId,
      identity: { projectRoot: "/tmp/scratch" },
    },
    "claude.resume-identity-recorded@1",
  );
  insertEvent(
    connection,
    "native-harness-transcript",
    sessionId,
    { sessionId, message: { role: "user", text: "Summarize the thread." } },
    "native-harness-transcript-message-appended@1",
  );
  return { sessionId, sdkSessionId };
}

function journalHead(connection: SqliteConnection): number {
  return (
    connection.prepare(`SELECT max(global_sequence) AS head FROM event_journal`).get() as {
      readonly head: number;
    }
  ).head;
}

function sessionsOf(connection: SqliteConnection, aggregateType: string): ReadonlyArray<string> {
  const rows = connection
    .prepare(
      `SELECT DISTINCT aggregate_id FROM event_journal
       WHERE aggregate_type = ? ORDER BY aggregate_id`,
    )
    .all(aggregateType) as ReadonlyArray<{ readonly aggregate_id: string }>;
  return rows.map((row) => row.aggregate_id);
}

function insertEvent(
  connection: SqliteConnection,
  aggregateType: string,
  aggregateId: string,
  payload: unknown,
  eventName = "fixture.planted@1",
  aggregateVersion = 1,
): void {
  connection
    .prepare(
      `INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
        correlation_id, actor_kind, actor_id, occurred_at, payload_json, host_id
      ) VALUES (?, ?, ?, ?, ?, 1, ?, 'system', ?, ?, ?, 'local')`,
    )
    .run(
      randomUUID(),
      aggregateType,
      aggregateId,
      aggregateVersion,
      eventName,
      randomUUID(),
      providerInstanceId,
      now,
      JSON.stringify(payload),
    );
}

function insertHead(connection: SqliteConnection, aggregateType: string, aggregateId: string) {
  connection
    .prepare(
      `INSERT INTO aggregate_heads (aggregate_type, aggregate_id, aggregate_version, last_sequence)
       SELECT aggregate_type, aggregate_id, max(aggregate_version), max(global_sequence)
       FROM event_journal WHERE aggregate_type = ? AND aggregate_id = ?`,
    )
    .run(aggregateType, aggregateId);
}

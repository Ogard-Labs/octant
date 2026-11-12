import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_THREAD_TOOL_STEPS_PER_TURN,
  MAX_TOOL_CALL_RECORD_INPUT_BYTES,
  MAX_TOOL_CALL_RECORD_OUTPUT_BYTES,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { purgeThreadContent } from "./chatProjection";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import {
  listThreadToolCallRecords,
  readThreadToolCallRecords,
  writeThreadToolCallPart,
  type ThreadToolCallPartInput,
} from "./threadToolCallRecordStore";

const directories: Array<string> = [];
const now = "2026-11-12T12:00:00.000Z";
const threadId = "7c000000-0000-4000-8000-000000000001";
const otherThreadId = "7c000000-0000-4000-8000-000000000002";
const turnId = "7c000000-0000-4000-8000-0000000000a1";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function open(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-tool-call-records-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function part(overrides: Partial<ThreadToolCallPartInput> = {}): ThreadToolCallPartInput {
  return {
    mode: "work",
    threadId,
    turnId,
    toolCallId: "call-1",
    toolName: "Bash",
    part: "input",
    text: '{"command":"ls"}',
    recordedAt: now,
    redact: (text) => text,
    namesProtectedPath: () => false,
    ...overrides,
  };
}

const turn = { mode: "work" as const, threadId, turnId };

describe("thread tool-call record store", () => {
  it("keeps what a tool call was given and what it returned, found again by thread, turn and call", () => {
    const connection = open();
    expect(writeThreadToolCallPart(connection, part())).toEqual({ status: "kept" });
    expect(
      writeThreadToolCallPart(connection, part({ part: "output", text: "README.md\nsrc" })),
    ).toEqual({ status: "kept" });

    expect(readThreadToolCallRecords(connection, turn)).toEqual([
      {
        toolCallId: "call-1",
        toolName: "Bash",
        input: { text: '{"command":"ls"}', truncated: false },
        output: { text: "README.md\nsrc", truncated: false },
        recordedAt: now,
      },
    ]);
    expect(readThreadToolCallRecords(connection, { ...turn, mode: "chat" })).toEqual([]);
    expect(readThreadToolCallRecords(connection, { ...turn, threadId: otherThreadId })).toEqual([]);
  });

  it("cuts an input or output past its byte bound and marks it truncated", () => {
    const connection = open();
    writeThreadToolCallPart(
      connection,
      part({ text: "é".repeat(MAX_TOOL_CALL_RECORD_INPUT_BYTES) }),
    );
    writeThreadToolCallPart(
      connection,
      part({ part: "output", text: "x".repeat(MAX_TOOL_CALL_RECORD_OUTPUT_BYTES + 1) }),
    );
    const [record] = readThreadToolCallRecords(connection, turn);
    const bytes = (text: string | undefined) => new TextEncoder().encode(text ?? "").byteLength;
    expect(record?.input?.truncated).toBe(true);
    expect(bytes(record?.input?.text)).toBeLessThanOrEqual(MAX_TOOL_CALL_RECORD_INPUT_BYTES);
    expect(record?.input?.text.endsWith("é")).toBe(true);
    expect(record?.output?.truncated).toBe(true);
    expect(bytes(record?.output?.text)).toBe(MAX_TOOL_CALL_RECORD_OUTPUT_BYTES);
  });

  it("marks text the adapter already cut as truncated", () => {
    const connection = open();
    writeThreadToolCallPart(connection, part({ part: "output", text: "head", truncated: true }));
    expect(readThreadToolCallRecords(connection, turn)[0]?.output).toEqual({
      text: "head",
      truncated: true,
    });
  });

  it("stores only redacted text", () => {
    const connection = open();
    const redact = (text: string) => text.replaceAll("sk-live-secret", "[redacted]");
    writeThreadToolCallPart(connection, part({ text: "curl -H sk-live-secret", redact }));
    writeThreadToolCallPart(
      connection,
      part({ part: "output", text: "token=sk-live-secret", redact }),
    );
    const stored = JSON.stringify(
      connection.prepare("SELECT * FROM thread_tool_call_record_store").all(),
    );
    expect(stored).not.toContain("sk-live-secret");
    expect(stored).toContain("[redacted]");
  });

  it("does not keep what a call returned when its input named a protected secret file", () => {
    const connection = open();
    const namesProtectedPath = (text: string) => text.includes(".ssh/id_ed25519");
    writeThreadToolCallPart(
      connection,
      part({ text: "cat ~/.ssh/id_ed25519", namesProtectedPath }),
    );
    expect(
      writeThreadToolCallPart(
        connection,
        part({ part: "output", text: "PRIVATE KEY BODY", namesProtectedPath }),
      ),
    ).toEqual({ status: "withheld" });
    const stored = JSON.stringify(
      connection.prepare("SELECT * FROM thread_tool_call_record_store").all(),
    );
    expect(stored).not.toContain("PRIVATE KEY BODY");
    expect(readThreadToolCallRecords(connection, turn)).toEqual([
      {
        toolCallId: "call-1",
        toolName: "Bash",
        input: { text: "cat ~/.ssh/id_ed25519", truncated: false },
        outputWithheld: "protected-path",
        recordedAt: now,
      },
    ]);
  });

  it("drops a thread's oldest records to stay inside the thread's total, and leaves another thread's alone", () => {
    const connection = open();
    const limits = { inputBytes: 100, outputBytes: 100, threadBytes: 250 };
    writeThreadToolCallPart(
      connection,
      part({ threadId: otherThreadId, text: "y".repeat(100), limits }),
    );
    for (const toolCallId of ["call-1", "call-2", "call-3"]) {
      writeThreadToolCallPart(connection, part({ toolCallId, text: "x".repeat(100), limits }));
    }
    expect(readThreadToolCallRecords(connection, turn).map((record) => record.toolCallId)).toEqual([
      "call-2",
      "call-3",
    ]);
    expect(
      readThreadToolCallRecords(connection, { ...turn, threadId: otherThreadId }),
    ).toHaveLength(1);
  });

  it("keeps records for no more calls in a turn than the turn keeps tool steps", () => {
    const connection = open();
    for (let index = 0; index < MAX_THREAD_TOOL_STEPS_PER_TURN; index += 1) {
      writeThreadToolCallPart(connection, part({ toolCallId: `call-${index}` }));
    }
    expect(writeThreadToolCallPart(connection, part({ toolCallId: "one-more" }))).toEqual({
      status: "refused",
      reason: "turn-full",
    });
    // A call already kept still takes its output.
    expect(
      writeThreadToolCallPart(connection, part({ toolCallId: "call-0", part: "output" })),
    ).toEqual({ status: "kept" });
    expect(readThreadToolCallRecords(connection, turn)).toHaveLength(
      MAX_THREAD_TOOL_STEPS_PER_TURN,
    );
  });

  it("lists a thread's records oldest first with the turn each belongs to", () => {
    const connection = open();
    writeThreadToolCallPart(connection, part());
    writeThreadToolCallPart(connection, part({ turnId: "turn-2", toolCallId: "call-9" }));
    expect(
      listThreadToolCallRecords(connection, { mode: "work", threadId }).map((record) => [
        record.turnId,
        record.toolCallId,
      ]),
    ).toEqual([
      [turnId, "call-1"],
      ["turn-2", "call-9"],
    ]);
  });

  it("removes a Chat thread's records when the thread is deleted, and keeps none that arrive afterwards", () => {
    const connection = open();
    const chat = { mode: "chat" as const, threadId, turnId };
    writeThreadToolCallPart(connection, part({ mode: "chat" }));
    writeThreadToolCallPart(connection, part({ mode: "chat", threadId: otherThreadId }));
    connection
      .prepare(
        `INSERT INTO chat_thread_projection (
          thread_id, lifecycle, schema_version, thread_json, aggregate_version, updated_at,
          last_sequence
        ) VALUES (?, 'deleting', 1, '{}', 1, ?, 1)`,
      )
      .run(threadId, now);

    purgeThreadContent(connection, threadId);

    expect(readThreadToolCallRecords(connection, chat)).toEqual([]);
    expect(
      readThreadToolCallRecords(connection, { ...chat, threadId: otherThreadId }),
    ).toHaveLength(1);
    expect(writeThreadToolCallPart(connection, part({ mode: "chat", part: "output" }))).toEqual({
      status: "refused",
      reason: "thread-gone",
    });
    expect(readThreadToolCallRecords(connection, chat)).toEqual([]);
  });

  it("keeps no record for a thread a purge already erased", () => {
    const connection = open();
    connection
      .prepare(
        `INSERT INTO thread_purge_tombstone (mode, thread_id, purged_at, last_sequence)
         VALUES ('work', ?, ?, 1)`,
      )
      .run(threadId, now);
    expect(writeThreadToolCallPart(connection, part())).toEqual({
      status: "refused",
      reason: "thread-gone",
    });
    expect(readThreadToolCallRecords(connection, turn)).toEqual([]);
  });
});

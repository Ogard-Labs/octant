import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProviderRuntimeEvent, type ProviderRuntimeEvent } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { readThreadToolCallRecords } from "./persistence/threadToolCallRecordStore";
import { noteIssuedSecret } from "./process/secretRedaction";
import { textNamesProtectedPath, threadToolCallRecorders } from "./threadToolCallRecorder";

const directories: Array<string> = [];
const now = "2026-11-12T12:00:00.000Z";
const turn = {
  mode: "work" as const,
  threadId: "7d000000-0000-4000-8000-000000000001",
  turnId: "7d000000-0000-4000-8000-0000000000a1",
};
/** The turn as its recorder is made for it, under the default tool-step limit. */
const recorded = { ...turn, callLimit: 64 };

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function open(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-tool-call-recorder-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

let sequence = 0;
function event(fields: Record<string, unknown>): ProviderRuntimeEvent {
  sequence += 1;
  return decodeProviderRuntimeEvent({
    instanceId: "7d000000-0000-4000-8000-0000000000b1",
    sessionId: "7d000000-0000-4000-8000-0000000000b2",
    sequence,
    correlationId: "7d000000-0000-4000-8000-0000000000b3",
    occurredAt: now,
    ...fields,
  });
}

function recorders(connection: SqliteConnection, enabled: () => boolean = () => true) {
  return threadToolCallRecorders({
    connection,
    enabled,
    clock: () => now,
    namesProtectedPath: (text) => text.includes("/home/person/.ssh/id_ed25519"),
  });
}

describe("thread tool-call recorder", () => {
  it("keeps what a runtime's own tool was given and returned under the call's step id and name", () => {
    const connection = open();
    const recorder = recorders(connection)(recorded);
    recorder.observe(event({ kind: "tool-start", toolCallId: "call-1", toolName: "Bash" }));
    recorder.observe(
      event({ kind: "tool-call-content", toolCallId: "call-1", part: "input", text: "ls -la" }),
    );
    recorder.observe(
      event({
        kind: "tool-call-content",
        toolCallId: "call-1",
        part: "output",
        text: "README.md",
        truncated: true,
      }),
    );
    expect(readThreadToolCallRecords(connection, turn)).toEqual([
      {
        toolCallId: "call-1",
        toolName: "Bash",
        input: { text: "ls -la", truncated: false },
        output: { text: "README.md", truncated: true },
        recordedAt: now,
      },
    ]);
  });

  it("keeps the input and the result of a tool Octant ran for the turn", () => {
    const connection = open();
    recorders(connection)(recorded).appTool({
      toolCallId: "request-1",
      toolName: "octant_past_threads",
      inputJson: '{"query":"invoices"}',
      resultJson: '{"excerpts":[]}',
    });
    expect(readThreadToolCallRecords(connection, turn)).toEqual([
      {
        toolCallId: "request-1",
        toolName: "octant_past_threads",
        input: { text: '{"query":"invoices"}', truncated: false },
        output: { text: '{"excerpts":[]}', truncated: false },
        recordedAt: now,
      },
    ]);
  });

  it("keeps nothing while the setting is off, and resumes when it is turned back on", () => {
    const connection = open();
    let enabled = false;
    const recorder = recorders(connection, () => enabled)(recorded);
    recorder.appTool({
      toolCallId: "request-1",
      toolName: "web-search",
      inputJson: '{"query":"a"}',
      resultJson: "{}",
    });
    expect(
      connection.prepare("SELECT count(*) AS n FROM thread_tool_call_record_store").get(),
    ).toEqual({ n: 0 });
    enabled = true;
    recorder.appTool({
      toolCallId: "request-2",
      toolName: "web-search",
      inputJson: '{"query":"b"}',
      resultJson: "{}",
    });
    expect(readThreadToolCallRecords(connection, turn).map((record) => record.toolCallId)).toEqual([
      "request-2",
    ]);
  });

  it("keeps no output of a call whose input arrived while the setting was off", () => {
    const connection = open();
    let enabled = false;
    const recorder = recorders(connection, () => enabled)(recorded);
    recorder.observe(event({ kind: "tool-start", toolCallId: "call-1", toolName: "Read" }));
    recorder.observe(
      event({
        kind: "tool-call-content",
        toolCallId: "call-1",
        part: "input",
        text: '{"file_path":"/home/person/.ssh/id_ed25519"}',
      }),
    );
    enabled = true;
    recorder.observe(
      event({
        kind: "tool-call-content",
        toolCallId: "call-1",
        part: "output",
        text: "PRIVATE KEY",
      }),
    );
    expect(readThreadToolCallRecords(connection, turn)).toEqual([]);
  });

  it("stores a known key format and a value the credential broker issued only as the redaction mark", () => {
    const connection = open();
    const issued = "broker-issued-value-7d41c0";
    noteIssuedSecret(issued);
    const key = `sk-ant-api03-${"a".repeat(80)}`;
    recorders(connection)(recorded).appTool({
      toolCallId: "request-1",
      toolName: "shell",
      inputJson: JSON.stringify({ command: `curl -H "x-api-key: ${key}"` }),
      resultJson: JSON.stringify({ stdout: `TOKEN=${issued}` }),
    });
    const stored = JSON.stringify(
      connection.prepare("SELECT * FROM thread_tool_call_record_store").all(),
    );
    expect(stored).not.toContain(key);
    expect(stored).not.toContain(issued);
    expect(readThreadToolCallRecords(connection, turn)).toHaveLength(1);
  });

  it("does not keep the output of a call whose input names a protected secret file", () => {
    const connection = open();
    recorders(connection)(recorded).appTool({
      toolCallId: "request-1",
      toolName: "read-file",
      inputJson: '{"path":"/home/person/.ssh/id_ed25519"}',
      resultJson: '{"error":"protected"}',
    });
    expect(readThreadToolCallRecords(connection, turn)).toEqual([
      {
        toolCallId: "request-1",
        toolName: "read-file",
        input: { text: '{"path":"/home/person/.ssh/id_ed25519"}', truncated: false },
        outputWithheld: "protected-path",
        recordedAt: now,
      },
    ]);
  });

  it("never fails the turn when a record cannot be written", () => {
    const connection = open();
    const recorder = recorders(connection)(recorded);
    connection.close();
    expect(() =>
      recorder.appTool({
        toolCallId: "request-1",
        toolName: "web-search",
        inputJson: "{}",
        resultJson: "{}",
      }),
    ).not.toThrow();
  });
});

describe("textNamesProtectedPath", () => {
  const protectedPath = (path: string) =>
    path === "/home/person/.aws/credentials" || path === "~/.ssh/id_ed25519";

  it("finds a protected file named in a shell command or a JSON input", () => {
    expect(textNamesProtectedPath("cat ~/.ssh/id_ed25519 | head", protectedPath)).toBe(true);
    expect(
      textNamesProtectedPath('{"file_path":"/home/person/.aws/credentials"}', protectedPath),
    ).toBe(true);
    expect(textNamesProtectedPath("scp host:/home/person/.aws/credentials .", protectedPath)).toBe(
      true,
    );
  });

  it("finds a protected file a JSON command names just before a newline or a tab", () => {
    for (const command of [
      "cat ~/.ssh/id_ed25519\nprintf done",
      "cat\t/home/person/.aws/credentials\t| head",
    ]) {
      expect(textNamesProtectedPath(JSON.stringify({ command }), protectedPath)).toBe(true);
    }
  });

  it("finds a protected file whose path contains spaces", () => {
    const spaced = (path: string) =>
      path === "/home/person/private credentials.json" ||
      path === "~/Library/Application Support/Example/Cookies";
    expect(
      textNamesProtectedPath('{"file_path":"/home/person/private credentials.json"}', spaced),
    ).toBe(true);
    expect(
      textNamesProtectedPath(
        JSON.stringify({ path: "~/Library/Application Support/Example/Cookies" }),
        spaced,
      ),
    ).toBe(true);
    for (const command of [
      "cat '/home/person/private credentials.json' | head",
      'cat "~/Library/Application Support/Example/Cookies"',
      "cat /home/person/private\\ credentials.json",
    ]) {
      expect(textNamesProtectedPath(command, spaced)).toBe(true);
      expect(textNamesProtectedPath(JSON.stringify({ command }), spaced)).toBe(true);
    }
  });

  it("answers no for ordinary paths and for text that names no path", () => {
    expect(textNamesProtectedPath("cat /home/person/project/README.md", protectedPath)).toBe(false);
    expect(textNamesProtectedPath('{"query":"aws credentials"}', protectedPath)).toBe(false);
  });
});

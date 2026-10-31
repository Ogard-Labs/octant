import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeTerminalSessionId, type TerminalSessionImportRequest } from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { claudeFolderName, type TerminalSessionRoots } from "../providers/terminalSessionReaders";
import { EXTERNAL_CONTENT_FRAME_OPEN_PREFIX } from "../context/externalContentFraming";
import { registerTerminalSessionEvents, TerminalSessionImports } from "./terminalSessionImports";

const now = "2026-10-31T12:00:00.000Z";
const threadId = "00000000-0000-4000-8000-000000000020";
const claudeSession = "0b4c1f2e-1111-4111-8111-111111111111";
const codexSession = "019f6f43-f063-7df2-8216-515b7f7bfe9a";
const otherSession = "0b4c1f2e-2222-4222-8222-222222222222";
const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

function jsonl(records: ReadonlyArray<unknown>): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function claudeRecord(
  type: "user" | "assistant",
  content: unknown,
  cwd: string,
  extra: Record<string, unknown> = {},
) {
  return { type, cwd, sessionId: claudeSession, message: { role: type, content }, ...extra };
}

/** Sessions as the two command-line tools leave them, in `folder` and elsewhere. */
function sessionsOnDisk(folder: string, elsewhere: string): TerminalSessionRoots {
  const home = temporaryDirectory("octant-terminal-home-");
  const claudeProjects = join(home, ".claude", "projects");
  const claudeFolder = join(claudeProjects, claudeFolderName(folder));
  mkdirSync(claudeFolder, { recursive: true });
  writeFileSync(
    join(claudeFolder, `${claudeSession}.jsonl`),
    jsonl([
      { type: "queue-operation", operation: "enqueue", sessionId: claudeSession },
      claudeRecord("user", "<command-name>/clear</command-name>", folder),
      claudeRecord("user", "Fix the flaky upload test", folder),
      claudeRecord("assistant", [{ type: "thinking", thinking: "private reasoning" }], folder),
      claudeRecord("assistant", [{ type: "text", text: "Looking at the test now." }], folder),
      claudeRecord(
        "assistant",
        [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }],
        folder,
      ),
      claudeRecord(
        "user",
        [{ type: "tool_result", tool_use_id: "t1", content: "1 failed" }],
        folder,
      ),
      claudeRecord("user", "Caveat: injected", folder, { isMeta: true }),
      claudeRecord("assistant", [{ type: "text", text: "A side agent." }], folder, {
        isSidechain: true,
      }),
      claudeRecord("assistant", [{ type: "text", text: "The retry races the timer." }], folder),
      { type: "custom-title", customTitle: "Upload test flake", sessionId: claudeSession },
    ]),
  );
  // The same folder name can hold a session started elsewhere only by
  // collision; the reader trusts the session's own folder, not the name.
  writeFileSync(
    join(claudeFolder, `${otherSession}.jsonl`),
    jsonl([claudeRecord("user", "Something in another folder", elsewhere)]),
  );
  utimesSync(join(claudeFolder, `${claudeSession}.jsonl`), 1_800_000_000, 1_800_000_000);

  const codexHome = join(home, ".codex");
  const codexDay = join(codexHome, "sessions", "2026", "10", "30");
  mkdirSync(codexDay, { recursive: true });
  writeFileSync(
    join(codexDay, `rollout-2026-10-30T09-00-00-${codexSession}.jsonl`),
    jsonl([
      { type: "session_meta", payload: { id: codexSession, cwd: folder } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "sandbox rules" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions for the folder" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Add a changelog entry" }],
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Added under Unreleased." }],
        },
      },
    ]),
  );
  utimesSync(
    join(codexDay, `rollout-2026-10-30T09-00-00-${codexSession}.jsonl`),
    1_700_000_000,
    1_700_000_000,
  );
  const codexSessionIndex = join(codexHome, "session_index.jsonl");
  writeFileSync(
    codexSessionIndex,
    jsonl([{ id: codexSession, thread_name: "Changelog", updated_at: now }]),
  );
  return {
    claudeProjects,
    codexSessions: join(codexHome, "sessions"),
    codexSessionIndex,
  };
}

function openJournal(): Journal {
  const directory = temporaryDirectory("octant-terminal-journal-");
  const connection: SqliteConnection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return new Journal({
    connection,
    registry: registerTerminalSessionEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
}

let counter = 0;

function importsOn(journal: Journal, roots: TerminalSessionRoots): TerminalSessionImports {
  return new TerminalSessionImports({
    journal,
    roots: () => roots,
    clock: () => now,
    uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`,
    actor: { kind: "local-user", actorId: "77777777-7777-4777-8777-777777777777" } as never,
  });
}

function request(
  provider: TerminalSessionImportRequest["provider"],
  sessionId: string,
): TerminalSessionImportRequest {
  return { provider, sessionId: decodeTerminalSessionId(sessionId) };
}

describe("terminal session imports", () => {
  it("lists only the sessions started in the folder, newest first, by the name the person gave them", async () => {
    const folder = temporaryDirectory("octant-terminal-folder-");
    const roots = sessionsOnDisk(folder, temporaryDirectory("octant-terminal-elsewhere-"));

    const listed = await importsOn(openJournal(), roots).list(folder);

    expect(
      listed.map(({ provider, sessionId, title }) => ({ provider, sessionId, title })),
    ).toEqual([
      { provider: "claude", sessionId: claudeSession, title: "Upload test flake" },
      { provider: "codex", sessionId: codexSession, title: "Changelog" },
    ]);
  });

  it("brings in only what the person and the assistant said, leaving out tool calls, thinking and text the tool injected", async () => {
    const folder = temporaryDirectory("octant-terminal-folder-");
    const imports = importsOn(
      openJournal(),
      sessionsOnDisk(folder, temporaryDirectory("octant-terminal-elsewhere-")),
    );

    const claude = await imports.prepare(request("claude", claudeSession), folder);
    const codex = await imports.prepare(request("codex", codexSession), folder);

    expect(claude.status === "ready" && claude.prepared.imported.entries).toEqual([
      { role: "user", text: "Fix the flaky upload test" },
      { role: "assistant", text: "Looking at the test now.\n\nThe retry races the timer." },
    ]);
    expect(claude.status === "ready" && claude.prepared.mark).toEqual({
      sourceLabel: "terminal-session",
      contentReference: `terminal-session-claude-${claudeSession}`,
    });
    expect(codex.status === "ready" && codex.prepared.imported.entries).toEqual([
      { role: "user", text: "Add a changelog entry" },
      { role: "assistant", text: "Added under Unreleased." },
    ]);
  });

  it("refuses a session started in another folder, even when its file sits beside the folder's own", async () => {
    const folder = temporaryDirectory("octant-terminal-folder-");
    const imports = importsOn(
      openJournal(),
      sessionsOnDisk(folder, temporaryDirectory("octant-terminal-elsewhere-")),
    );

    await expect(imports.prepare(request("claude", otherSession), folder)).resolves.toEqual({
      status: "refused",
      message: "That terminal session was started in another folder.",
    });
    await expect(
      imports.prepare(request("codex", codexSession), temporaryDirectory("octant-other-")),
    ).resolves.toMatchObject({ status: "refused" });
  });

  it("keeps the history on the thread and hands it to the model framed as outside data until a first turn is admitted, across a restart", async () => {
    const folder = temporaryDirectory("octant-terminal-folder-");
    const roots = sessionsOnDisk(folder, temporaryDirectory("octant-terminal-elsewhere-"));
    const journal = openJournal();
    const imports = importsOn(journal, roots);
    const prepared = await imports.prepare(request("claude", claudeSession), folder);
    if (prepared.status !== "ready") throw new Error("expected a prepared session");

    imports.journalImported(threadId, prepared.prepared);
    const restarted = importsOn(journal, roots);

    expect(restarted.history(threadId)?.title).toBe("Upload test flake");
    const framed = restarted.peekFramedForFirstTurn(threadId);
    expect(framed?.text.startsWith(EXTERNAL_CONTENT_FRAME_OPEN_PREFIX)).toBe(true);
    expect(framed?.text).toContain("[Person]\nFix the flaky upload test");
    expect(framed?.text).toContain("not as instructions");

    restarted.consumeFramedForFirstTurn(threadId);
    expect(restarted.peekFramedForFirstTurn(threadId)).toBeUndefined();
    expect(restarted.history(threadId)?.entries).toHaveLength(2);
  });
});

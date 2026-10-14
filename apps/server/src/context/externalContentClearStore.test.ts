import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventActor,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  ExternalContentClearStore,
  type ClearExternalContentInput,
} from "./externalContentClearStore";
import { ExternalContentIngestionStore } from "./externalContentIngestionStore";
import { readThreadExternalContentTaint } from "./externalContentTaintProjection";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const directories: Array<string> = [];
const ids = {
  thread: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  childRun: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  system: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  person: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  correlation: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  window: "ffffffff-ffff-4fff-8fff-ffffffffffff",
} as const;

// The references the MCP session manager and the Linear issue context journal.
const mcpResult = `mcp-${"a".repeat(64)}`;
const linearIssue = "linear-issue-12000000-0000-4000-8000-000000000001";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openHost() {
  const directory = mkdtempSync(join(tmpdir(), "octant-taint-clear-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-10-12T09:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  let time = Date.parse("2026-10-12T10:00:00.000Z");
  // Each read of the clock is a minute later, so first and last times differ.
  const clock = () => new Date((time += 60_000)).toISOString();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock,
  });
  let nextEvent = 0;
  const uuid = () => `99999999-9999-4999-8999-${String(++nextEvent).padStart(12, "0")}`;
  const ingestions = new ExternalContentIngestionStore({
    journal,
    connection,
    uuid,
    clock,
    actor: decodeActor({ kind: "system", actorId: ids.system }),
  });
  const clears = new ExternalContentClearStore({
    journal,
    connection,
    uuid,
    clock,
    actor: decodeActor({ kind: "local-user", actorId: ids.person }),
  });
  const ingest = (
    contentReference: string,
    sourceLabel: string,
    threadId: string = ids.thread,
    origin: "tool-result" | "external-content" = "tool-result",
  ) =>
    ingestions.record({
      threadId,
      provenance: { origin, sourceLabel },
      contentReference,
      correlationId: ids.correlation,
      authorized: true,
    });
  const clear = (overrides: Partial<ClearExternalContentInput> = {}) =>
    clears.clear({
      threadId: ids.thread,
      windowId: ids.window,
      expectedVersion: clears.read(ids.thread).version,
      principal: "local-window",
      turn: "idle",
      ...overrides,
    });
  const events = (threadId: string = ids.thread) =>
    journal.replayAggregate({
      aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
      aggregateId: threadId,
      afterVersion: 0,
      limit: 100,
    });
  const tainted = (threadId: string = ids.thread) =>
    readThreadExternalContentTaint(connection, threadId).externalContentIngested;
  return { connection, clears, ingest, clear, events, tainted };
}

describe("clearing a thread's outside-content mark", () => {
  it("marks the thread again when the same MCP result or issue context comes back", () => {
    const host = openHost();
    expect(host.ingest(mcpResult, "mcp-tool")).toMatchObject({ kind: "recorded" });
    expect(host.ingest(linearIssue, "linear-issue", ids.thread, "external-content")).toMatchObject({
      kind: "recorded",
    });
    // Before a clear the same reference is one ingestion, however often it returns.
    expect(host.ingest(mcpResult, "mcp-tool")).toMatchObject({ kind: "already-recorded" });

    expect(host.clear()).toMatchObject({
      kind: "cleared",
      state: { externalContentIngested: false, ingestionCount: 0, sources: [], version: 3 },
    });
    expect(host.tainted()).toBe(false);

    expect(host.ingest(mcpResult, "mcp-tool")).toEqual({
      kind: "recorded",
      taint: { externalContentIngested: true, ingestedSources: ["mcp-tool"] },
    });
    expect(host.tainted()).toBe(true);

    expect(host.clear()).toMatchObject({ kind: "cleared" });
    expect(host.ingest(linearIssue, "linear-issue", ids.thread, "external-content")).toEqual({
      kind: "recorded",
      taint: { externalContentIngested: true, ingestedSources: ["linear-issue"] },
    });
    host.connection.close();
  });

  it("journals who cleared it and when, with labels and a count and nothing that was read", () => {
    const host = openHost();
    host.ingest(mcpResult, "mcp-tool");
    host.ingest(`mcp-${"b".repeat(64)}`, "mcp-tool");
    host.ingest(linearIssue, "linear-issue", ids.thread, "external-content");
    expect(host.clear()).toMatchObject({ kind: "cleared" });

    const cleared = host.events().at(-1);
    expect(cleared).toMatchObject({
      eventName: THREAD_EXTERNAL_CONTENT_EVENT_NAMES.cleared,
      aggregateVersion: 4,
      actor: { kind: "local-user", actorId: ids.person },
      occurredAt: expect.stringMatching(/^2026-10-12T10:\d\d:00\.000Z$/),
      payload: {
        threadId: ids.thread,
        windowId: ids.window,
        clearedSources: ["mcp-tool", "linear-issue"],
        ingestionCount: 3,
      },
    });
    expect(JSON.stringify(cleared?.payload)).not.toContain("mcp-a");
    expect(JSON.stringify(cleared?.payload)).not.toContain(linearIssue);
    host.connection.close();
  });

  it("shows each source with its count and times and the version a clear must name", () => {
    const host = openHost();
    expect(host.clears.read(ids.thread)).toEqual({
      threadId: ids.thread,
      externalContentIngested: false,
      version: 0,
      ingestionCount: 0,
      sources: [],
    });
    host.ingest(mcpResult, "mcp-tool");
    host.ingest(linearIssue, "linear-issue", ids.thread, "external-content");
    host.ingest(`mcp-${"b".repeat(64)}`, "mcp-tool");

    const state = host.clears.read(ids.thread);
    expect(state).toEqual({
      threadId: ids.thread,
      externalContentIngested: true,
      version: 3,
      ingestionCount: 3,
      sources: [
        {
          sourceLabel: "mcp-tool",
          ingestionCount: 2,
          firstIngestedAt: expect.any(String),
          lastIngestedAt: expect.any(String),
        },
        {
          sourceLabel: "linear-issue",
          ingestionCount: 1,
          firstIngestedAt: expect.any(String),
          lastIngestedAt: expect.any(String),
        },
      ],
    });
    const [mcp, linear] = state.sources;
    expect(Date.parse(mcp?.lastIngestedAt ?? "")).toBeGreaterThan(
      Date.parse(mcp?.firstIngestedAt ?? ""),
    );
    expect(linear?.firstIngestedAt).toBe(linear?.lastIngestedAt);
    expect(JSON.stringify(state)).not.toContain(linearIssue);
    host.connection.close();
  });

  it("refuses a version the person was not shown and journals nothing", () => {
    const host = openHost();
    host.ingest(mcpResult, "mcp-tool");
    const shown = host.clears.read(ids.thread).version;
    host.ingest(linearIssue, "linear-issue", ids.thread, "external-content");

    expect(host.clear({ expectedVersion: shown })).toMatchObject({
      kind: "refused",
      reason: "stale",
      state: { version: 2, ingestionCount: 2 },
    });
    expect(host.clear({ expectedVersion: 7 })).toMatchObject({ kind: "refused", reason: "stale" });
    expect(host.events()).toHaveLength(2);
    expect(host.tainted()).toBe(true);
    host.connection.close();
  });

  it("answers already clear for an unmarked thread and journals nothing", () => {
    const host = openHost();
    expect(host.clear()).toMatchObject({
      kind: "already-clear",
      state: { externalContentIngested: false, version: 0 },
    });
    expect(host.events()).toEqual([]);

    host.ingest(mcpResult, "mcp-tool");
    expect(host.clear()).toMatchObject({ kind: "cleared" });
    // A second window's clear of the version it was shown finds nothing left.
    expect(host.clear({ expectedVersion: 1 })).toMatchObject({ kind: "already-clear" });
    expect(host.events()).toHaveLength(2);
    host.connection.close();
  });

  it("refuses a paired device, the host's own scope, a busy thread, and a malformed request", () => {
    const host = openHost();
    host.ingest(mcpResult, "mcp-tool");
    for (const [overrides, reason] of [
      [{ principal: "remote-device" }, "unauthorized"],
      [{ principal: "host" }, "unauthorized"],
      [{ turn: "unknown" }, "thread-unavailable"],
      [{ threadId: "thread-1" }, "thread-unavailable"],
      [{ windowId: "window-1" }, "unauthorized"],
    ] as const) {
      // Who may not clear, or cannot reach the thread, is told nothing about it.
      expect(host.clear(overrides)).toEqual({ kind: "refused", reason });
    }
    for (const [overrides, reason] of [
      [{ turn: "active" }, "turn-active"],
      [{ turn: "unconfirmed" }, "turn-unconfirmed"],
      [{ expectedVersion: 1.5 }, "stale"],
    ] as const) {
      expect(host.clear(overrides)).toMatchObject({
        kind: "refused",
        reason,
        state: { version: 1 },
      });
    }
    expect(host.events()).toHaveLength(1);
    expect(host.tainted()).toBe(true);
    host.connection.close();
  });

  it("clears one thread and leaves a child run's own mark standing", () => {
    const host = openHost();
    host.ingest(mcpResult, "mcp-tool");
    host.ingest(mcpResult, "mcp-tool", ids.childRun);

    expect(host.clear()).toMatchObject({ kind: "cleared" });
    expect(host.tainted()).toBe(false);
    expect(host.tainted(ids.childRun)).toBe(true);
    expect(host.events(ids.childRun)).toHaveLength(1);
    // The child still holds the reference it read, so it is not journaled twice.
    expect(host.ingest(mcpResult, "mcp-tool", ids.childRun)).toMatchObject({
      kind: "already-recorded",
    });
    host.connection.close();
  });

  it("refuses to clear a mark whose id threads of two modes share, and journals nothing", () => {
    const host = openHost();
    // History from before the journal refused a second mode's thread under a
    // held id: one mark answers for a Chat and a Code thread.
    for (const aggregateType of ["chat-thread", "code-thread"]) {
      host.connection
        .prepare(
          `INSERT INTO event_journal (
            event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
            correlation_id, actor_kind, actor_id, occurred_at, payload_json, host_id
          ) VALUES (?, ?, ?, 1, 'fixture.planted@1', 1, ?, 'system', ?, ?, '{}', 'local')`,
        )
        .run(
          `${aggregateType === "chat-thread" ? "1" : "2"}1111111-1111-4111-8111-111111111111`,
          aggregateType,
          ids.thread,
          ids.correlation,
          ids.system,
          "2026-10-12T10:00:00.000Z",
        );
    }
    host.ingest(mcpResult, "mcp-tool");

    expect(host.clear()).toEqual({ kind: "refused", reason: "thread-unavailable" });
    expect(host.tainted()).toBe(true);
    expect(host.events()).toHaveLength(1);
    host.connection.close();
  });
});

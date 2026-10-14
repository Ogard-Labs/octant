import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventActor } from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection, rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ExternalContentClearStore } from "./externalContentClearStore";
import { ExternalContentIngestionStore } from "./externalContentIngestionStore";
import {
  ExternalContentTaintProjection,
  readThreadExternalContentState,
  readThreadExternalContentTaint,
} from "./externalContentTaintProjection";
import {
  markThreadReadByRuntime,
  type RuntimeOutsideContentRead,
} from "./runtimeOutsideContentMark";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const directories: Array<string> = [];
const now = "2026-10-14T09:00:00.000Z";
const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openHost(path: string) {
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  let nextEvent = 0;
  const uuid = () => `99999999-9999-4999-8999-${String(++nextEvent).padStart(12, "0")}`;
  const ingestions = new ExternalContentIngestionStore({
    journal,
    connection,
    uuid,
    clock: () => now,
    actor: decodeActor({ kind: "system", actorId }),
  });
  const clears = new ExternalContentClearStore({
    journal,
    connection,
    uuid,
    clock: () => now,
    actor: decodeActor({ kind: "local-user", actorId }),
  });
  return { connection, runtime, journal, ingestions, clears };
}

function read(overrides: Partial<RuntimeOutsideContentRead> = {}): RuntimeOutsideContentRead {
  return {
    kind: "outside-content-read",
    instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    sequence: 1,
    correlationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    occurredAt: now,
    toolCallId: "tool-1",
    toolName: "webSearch",
    source: "web-search",
    target: "Stavanger weather tomorrow",
    ...overrides,
  } as RuntimeOutsideContentRead;
}

function ingestionRows(host: ReturnType<typeof openHost>) {
  return host.connection
    .prepare(
      `SELECT content_reference, source_label, origin
       FROM thread_external_content_ingestion_projection WHERE thread_id = ?
       ORDER BY last_sequence`,
    )
    .all(threadId);
}

describe("marking a thread whose runtime ran its own web tool", () => {
  it("marks the thread under the tool's label with a path-free reference and no page content", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-runtime-web-"));
    directories.push(directory);
    const host = openHost(join(directory, "octant.sqlite3"));
    const record = (input: Parameters<typeof host.ingestions.record>[0]) =>
      host.ingestions.record(input);

    expect(markThreadReadByRuntime({ record, threadId, event: read() })).toEqual({
      status: "marked",
    });
    expect(
      markThreadReadByRuntime({
        record,
        threadId,
        event: read({
          toolCallId: "tool-2",
          toolName: "WebFetch",
          source: "web-fetch",
          target: `https://example.invalid/a\\b/${"x".repeat(2_000)}`,
        }),
      }),
    ).toEqual({ status: "marked" });

    expect(readThreadExternalContentTaint(host.connection, threadId)).toEqual({
      externalContentIngested: true,
      ingestedSources: ["runtime-web-search", "runtime-web-fetch"],
    });
    const rows = ingestionRows(host) as ReadonlyArray<{ readonly content_reference: string }>;
    expect(rows).toEqual([
      {
        content_reference:
          "webSearch:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:tool-1:Stavanger weather tomorrow",
        source_label: "runtime-web-search",
        origin: "tool-result",
      },
      expect.objectContaining({ source_label: "runtime-web-fetch", origin: "tool-result" }),
    ]);
    const fetched = rows[1]?.content_reference ?? "";
    expect(fetched.startsWith("WebFetch:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:tool-2:https: ")).toBe(
      true,
    );
    expect(fetched).not.toMatch(/[/\\]/);
    expect(Array.from(fetched).length).toBeLessThanOrEqual(256);
    host.connection.close();
  });

  it("redacts credentials and local paths a provider put in the tool's name or call id", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-runtime-web-redact-"));
    directories.push(directory);
    const host = openHost(join(directory, "octant.sqlite3"));
    expect(
      markThreadReadByRuntime({
        record: (input) => host.ingestions.record(input),
        threadId,
        event: read({
          toolName:
            "Fetch https://user:hunter2@example.invalid/docs?api_key=sk-12345678901234567890",
          toolCallId: "call\n/Users/someone/private/notes.txt",
          target: undefined,
        }),
      }),
    ).toEqual({ status: "marked" });

    const [row] = ingestionRows(host) as ReadonlyArray<{ readonly content_reference: string }>;
    expect(row?.content_reference).toContain("example.invalid");
    expect(row?.content_reference).toContain("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    expect(row?.content_reference).not.toMatch(/hunter2|sk-1234|someone|private|[/\\]/);
    host.connection.close();
  });

  it("keeps the mark through a projection rebuild and a restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-runtime-web-replay-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const first = openHost(path);
    markThreadReadByRuntime({
      record: (input) => first.ingestions.record(input),
      threadId,
      event: read(),
    });
    const marked = readThreadExternalContentTaint(first.connection, threadId);
    rebuildProjection({
      connection: first.connection,
      journal: first.journal,
      projection: new ExternalContentTaintProjection(),
      clock: () => now,
    });
    expect(readThreadExternalContentTaint(first.connection, threadId)).toEqual(marked);
    first.connection.close();

    const restarted = openHost(path);
    for (const projection of restarted.runtime.projections.all()) {
      catchUpProjection({
        connection: restarted.connection,
        journal: restarted.journal,
        projection,
        clock: () => now,
      });
    }
    expect(readThreadExternalContentTaint(restarted.connection, threadId)).toEqual({
      externalContentIngested: true,
      ingestedSources: ["runtime-web-search"],
    });
    restarted.connection.close();
  });

  it("is removed by a person's clear and comes back with the next web search", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-runtime-web-clear-"));
    directories.push(directory);
    const host = openHost(join(directory, "octant.sqlite3"));
    const record = (input: Parameters<typeof host.ingestions.record>[0]) =>
      host.ingestions.record(input);
    markThreadReadByRuntime({ record, threadId, event: read() });
    expect(readThreadExternalContentState(host.connection, threadId)).toMatchObject({
      sources: [{ sourceLabel: "runtime-web-search", ingestionCount: 1 }],
    });

    expect(
      host.clears.clear({
        threadId,
        windowId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        expectedVersion: host.clears.read(threadId).version,
        principal: "local-window",
        turn: "idle",
      }),
    ).toMatchObject({ kind: "cleared" });
    expect(readThreadExternalContentTaint(host.connection, threadId).externalContentIngested).toBe(
      false,
    );

    // The same call recorded again after the clear marks the thread again.
    expect(markThreadReadByRuntime({ record, threadId, event: read() })).toEqual({
      status: "marked",
    });
    expect(readThreadExternalContentTaint(host.connection, threadId)).toEqual({
      externalContentIngested: true,
      ingestedSources: ["runtime-web-search"],
    });
    host.connection.close();
  });

  it("refuses when the mark has nowhere to go or cannot be recorded", () => {
    const event = read();
    expect(markThreadReadByRuntime({ record: undefined, threadId, event })).toEqual({
      status: "refused",
    });
    expect(
      markThreadReadByRuntime({
        record: () => ({ kind: "refused", reason: "contended" }),
        threadId,
        event,
      }),
    ).toEqual({ status: "refused" });
    expect(
      markThreadReadByRuntime({
        record: () => {
          throw new Error("journal unavailable");
        },
        threadId,
        event,
      }),
    ).toEqual({ status: "refused" });
  });
});

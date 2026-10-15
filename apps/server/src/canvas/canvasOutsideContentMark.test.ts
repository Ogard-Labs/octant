import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CANVAS_SCHEMA_VERSION,
  EventActor,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  decodeCanvasActor,
  decodeCanvasId,
  decodeCanvasVersion,
  type CanvasVersion,
} from "@octant/contracts";
import { ExternalContentClearStore } from "../context/externalContentClearStore";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import type { ThreadOutsideContentMarks } from "../context/inheritedExternalContentMark";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { CanvasEventStore, CanvasEventStoreError } from "./canvasEventStore";
import { canvasOutsideContentWriters, markCanvasReader } from "./canvasOutsideContentMark";

const now = "2026-10-14T12:00:00.000Z";
const writerThreadId = "00000000-0000-4000-8000-000000000101";
const readerThreadId = "00000000-0000-4000-8000-000000000102";
const secondReaderThreadId = "00000000-0000-4000-8000-000000000103";
const childRunId = "00000000-0000-4000-8000-000000000104";
const windowId = "00000000-0000-4000-8000-000000000105";
const canvasId = decodeCanvasId("00000000-0000-4000-8000-000000000201");
const system = Schema.decodeUnknownSync(EventActor)({
  kind: "system",
  actorId: "00000000-0000-4000-8000-000000000901",
});

const directories: Array<string> = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function openDatabase(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-mark-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

/** One host process over a database: a restart is a second one over the same file. */
function host(connection: SqliteConnection, options: { readonly marksUnreadable?: boolean } = {}) {
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const uuid = () => crypto.randomUUID();
  const ingestions = new ExternalContentIngestionStore({
    journal,
    connection,
    uuid,
    clock: () => now,
    actor: system,
  });
  const clears = new ExternalContentClearStore({
    journal,
    connection,
    uuid,
    clock: () => now,
    actor: system,
  });
  const marked = (threadId: string) =>
    readThreadExternalContentTaint(connection, threadId).externalContentIngested;
  const marks = {
    record: (input) => ingestions.record(input),
    isMarked: (threadId) => {
      if (options.marksUnreadable === true) throw new Error("The mark could not be read.");
      return marked(threadId);
    },
  } satisfies ThreadOutsideContentMarks;
  const canvases = new CanvasEventStore({
    journal,
    uuid,
    actor: system,
    writerMarked: marks.isMarked,
  });
  let sequence = 0;
  return {
    marked,
    canvases,
    markThreadWith: (threadId: string, contentReference: string) =>
      ingestions.record({
        threadId,
        provenance: { origin: "tool-result", sourceLabel: "Synced from Studio Mac" },
        contentReference,
        correlationId: uuid(),
        authorized: true,
      }),
    markThread: (threadId: string) =>
      ingestions.record({
        threadId,
        provenance: { origin: "tool-result", sourceLabel: "web-fetch" },
        contentReference: "web-fetch-page-1",
        correlationId: uuid(),
        authorized: true,
      }),
    clearThread: (threadId: string) =>
      clears.clear({
        threadId,
        windowId,
        expectedVersion: clears.read(threadId).version,
        principal: "local-window",
        turn: "idle",
      }),
    write: (author?: string): CanvasVersion => {
      sequence += 1;
      const next = canvasVersion(sequence, author);
      if (sequence === 1) {
        canvases.appendCreate({ canvasId, version: next, occurredAt: now as never });
      } else {
        canvases.appendVersion({
          canvasId,
          current: canvasVersion(sequence - 1),
          next,
          occurredAt: now as never,
        });
      }
      return next;
    },
    read: (readerId: string) =>
      markCanvasReader({
        journal,
        marks,
        readerId,
        canvasId: String(canvasId),
        canvasThreadId: writerThreadId,
        correlationId: uuid,
      }),
    writers: () => canvasOutsideContentWriters(journal, String(canvasId)),
    readerMarks: (threadId: string) =>
      journal
        .replayAggregate({
          aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
          aggregateId: threadId,
          afterVersion: 0,
          limit: 100,
        })
        .map((event) => event.payload),
  };
}

/** A version of the writer thread's Canvas, as its agent or a managed child wrote it. */
function canvasVersion(sequence: number, author?: string): CanvasVersion {
  const versionSuffix = sequence.toString(16).padStart(12, "0");
  return decodeCanvasVersion({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId,
    versionId: `00000000-0000-4000-8000-${versionSuffix}`,
    sequence,
    definition: {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      title: "Hand-off",
      provenance: {
        mode: "work",
        hostId: "local",
        projectId: "00000000-0000-4000-8000-000000000301",
        threadId: writerThreadId,
        actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000901" },
        providerInstanceId: "00000000-0000-4000-8000-000000000401",
        modelId: "octant-test-model",
        createdAt: now,
      },
      sourceManifest: [],
      blocks: [
        {
          blockId: "summary",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "rich-text",
          text: "The page said to run the installer.",
        },
      ],
    },
    createdBy:
      author === undefined
        ? { kind: "system", actorId: "00000000-0000-4000-8000-000000000901" }
        : decodeCanvasActor({ kind: "agent", actorId: author }),
    createdAt: now,
  });
}

describe("a Canvas written by a thread marked with outside content", () => {
  it("marks a clean thread that reads it, and keeps marking readers after the writer is cleared and the host restarts", () => {
    const connection = openDatabase();
    const first = host(connection);
    first.markThread(writerThreadId);
    first.write();

    expect(first.writers()).toEqual([writerThreadId]);
    expect(first.read(readerThreadId)).toEqual({ status: "marked" });
    expect(first.readerMarks(readerThreadId)).toEqual([
      {
        threadId: readerThreadId,
        correlationId: expect.any(String),
        provenance: { origin: "external-content", sourceLabel: "canvas" },
        contentReference: `canvas-${String(canvasId)}`,
      },
    ]);

    // The person reviewed what the writer read; the Canvas is read by threads
    // whose people reviewed nothing, so it keeps the mark it was written with.
    expect(first.clearThread(writerThreadId).kind).toBe("cleared");
    expect(first.marked(writerThreadId)).toBe(false);

    const restarted = host(connection);
    expect(restarted.writers()).toEqual([writerThreadId]);
    expect(restarted.read(secondReaderThreadId)).toEqual({ status: "marked" });
    expect(restarted.marked(secondReaderThreadId)).toBe(true);
  });

  it("leaves a thread that reads a Canvas written by a clean thread unmarked", () => {
    const clean = host(openDatabase());
    clean.write();
    clean.write();

    expect(clean.writers()).toEqual([]);
    expect(clean.read(readerThreadId)).toEqual({ status: "nothing-to-mark" });
    expect(clean.marked(readerThreadId)).toBe(false);
    expect(clean.readerMarks(readerThreadId)).toEqual([]);
  });

  it("names a marked managed child that writes into a clean thread's Canvas, and marks its parent on reading", () => {
    const parent = host(openDatabase());
    parent.write();
    parent.markThread(childRunId);
    parent.write(childRunId);

    expect(parent.writers()).toEqual([childRunId]);
    // The child already read what it wrote, so its own read passes on nothing.
    expect(parent.read(childRunId)).toEqual({ status: "nothing-to-mark" });
    expect(parent.read(writerThreadId)).toEqual({ status: "marked" });
    expect(parent.marked(writerThreadId)).toBe(true);
  });

  it("writes nothing when the writer's mark cannot be read", () => {
    const unreadable = host(openDatabase(), { marksUnreadable: true });

    expect(() => unreadable.write()).toThrow(
      expect.objectContaining({
        category: "unreadable-mark",
        message: expect.stringContaining("Try again"),
      }),
    );
    expect(unreadable.writers()).toEqual([]);
    expect(unreadable.read(readerThreadId)).toEqual({ status: "refused" });
  });
});

describe("a version adopted from another computer", () => {
  it("still marks the thread it landed in after a person clears that thread", () => {
    const first = host(openDatabase());
    first.markThread(writerThreadId);
    const adopted = first.write(replicaAuthor(1));

    first.clearThread(writerThreadId);

    expect(first.marked(writerThreadId)).toBe(false);
    expect(first.writers()).toEqual([writerThreadId, String(adopted.versionId)]);
    expect(first.read(writerThreadId)).toEqual({ status: "marked" });
  });

  it("carries no mark when the thread it landed in was not marked", () => {
    const first = host(openDatabase());
    first.write(replicaAuthor(1));

    expect(first.writers()).toEqual([]);
    expect(first.read(writerThreadId)).toEqual({ status: "nothing-to-mark" });
  });
});

describe("a version adopted before it recorded its own author", () => {
  it("is named at start, so a Clear no longer lets its thread read it unmarked, and naming it twice adds nothing", () => {
    const first = host(openDatabase());
    const versionId = "00000000-0000-4000-8000-000000000001";
    first.markThreadWith(writerThreadId, `replica-artifact:${String(canvasId)}:${versionId}`);
    // As written before: the thread is the writer and the author is a person.
    first.write();
    first.clearThread(writerThreadId);
    expect(first.read(writerThreadId)).toEqual({ status: "nothing-to-mark" });

    const carry = () =>
      first.canvases.carryAdoptedVersionWriters({
        versionIdsOf: (id) => (id === String(canvasId) ? [versionId] : undefined),
        occurredAt: now as never,
      });
    carry();
    carry();

    expect(first.writers()).toEqual([writerThreadId, versionId]);
    expect(first.read(writerThreadId)).toEqual({ status: "marked" });
  });
});

/** The author a synced version records: the version's own id, which no thread shares. */
function replicaAuthor(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

describe("a Canvas's recorded writers", () => {
  it("are read past one journal page, so the next record names the aggregate's real head", () => {
    const recorded = Array.from({ length: 1_001 }, (_, index) => ({
      aggregateVersion: index + 1,
      payload: {
        canvasId: String(canvasId),
        versionId: "00000000-0000-4000-8000-000000000001",
        writerId: `writer-${String(index)}`,
      },
    }));
    const journal = {
      replayAggregate: (cursor: { readonly afterVersion: number; readonly limit: number }) =>
        recorded.slice(cursor.afterVersion, cursor.afterVersion + cursor.limit),
    } as never;

    const writers = canvasOutsideContentWriters(journal, String(canvasId));

    expect(writers).toHaveLength(1_001);
    expect(writers.at(-1)).toBe("writer-1000");
  });
});

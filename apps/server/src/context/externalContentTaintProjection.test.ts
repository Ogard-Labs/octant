import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventActor,
  EventEnvelope,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyThreadContentTaint,
  projectThreadContentTaint,
} from "@octant/domain/untrusted-content-policy";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection, rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { ExternalContentClearStore } from "./externalContentClearStore";
import { ExternalContentIngestionStore } from "./externalContentIngestionStore";
import {
  ExternalContentTaintProjection,
  applyProvenanceToThreadTaint,
  hasThreadExternalContentReference,
  readApprovalOutsideContent,
  readThreadExternalContentState,
  readThreadExternalContentTaint,
} from "./externalContentTaintProjection";

const decodeEnvelope = Schema.decodeUnknownSync(EventEnvelope);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const directories: Array<string> = [];
const now = "2026-08-21T12:00:00.000Z";
const threadId = "11111111-1111-4111-8111-111111111111";
const otherThreadId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const correlationId = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openMigrated(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-taint-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function envelope(input: {
  readonly threadId: string;
  readonly version: number;
  readonly sequence: number;
  readonly provenance: {
    readonly origin: "tool-result" | "external-content" | "user";
    readonly sourceLabel: string;
  };
  readonly contentReference: string;
  readonly occurredAt?: string;
}) {
  return decodeEnvelope({
    eventId: `00000000-0000-4000-8000-${String(input.version).padStart(12, "0")}`,
    globalSequence: input.sequence,
    aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
    aggregateId: input.threadId,
    aggregateVersion: input.version,
    eventName: THREAD_EXTERNAL_CONTENT_EVENT_NAMES.ingested,
    eventVersion: 1,
    hostId: "local",
    correlationId,
    actor: { kind: "system", actorId },
    occurredAt: input.occurredAt ?? now,
    payload: {
      threadId: input.threadId,
      correlationId,
      provenance: input.provenance,
      contentReference: input.contentReference,
    },
  });
}

function clearedEnvelope(input: {
  readonly threadId: string;
  readonly version: number;
  readonly sequence: number;
}) {
  return decodeEnvelope({
    eventId: `00000000-0000-4000-8000-0000000000c${input.version}`,
    globalSequence: input.sequence,
    aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
    aggregateId: input.threadId,
    aggregateVersion: input.version,
    eventName: THREAD_EXTERNAL_CONTENT_EVENT_NAMES.cleared,
    eventVersion: 1,
    hostId: "local",
    correlationId,
    actor: { kind: "local-user", actorId },
    occurredAt: now,
    payload: {
      threadId: input.threadId,
      windowId: "66666666-6666-4666-8666-666666666666",
      clearedSources: ["mcp-tool"],
      ingestionCount: 1,
    },
  });
}

function projectionRows(connection: SqliteConnection) {
  return {
    taint: connection
      .prepare("SELECT * FROM thread_external_content_taint_projection ORDER BY thread_id")
      .all(),
    ingestions: connection
      .prepare(
        `SELECT * FROM thread_external_content_ingestion_projection
         ORDER BY thread_id, content_reference`,
      )
      .all(),
  };
}

describe("ExternalContentTaintProjection", () => {
  it("projects named sources from ingested events and ignores later session or turn folds", () => {
    const connection = openMigrated();
    try {
      const projection = new ExternalContentTaintProjection();
      projection.apply(
        connection,
        envelope({
          threadId,
          version: 1,
          sequence: 1,
          provenance: { origin: "external-content", sourceLabel: "readme-md" },
          contentReference: "content-ref-1",
        }),
      );
      expect(readThreadExternalContentTaint(connection, threadId)).toEqual({
        externalContentIngested: true,
        ingestedSources: ["readme-md"],
      });

      const afterBoundaries = applyProvenanceToThreadTaint(
        readThreadExternalContentTaint(connection, threadId),
        [{ kind: "session-boundary" }, { kind: "turn-boundary" }],
      );
      expect(afterBoundaries.externalContentIngested).toBe(true);

      projection.apply(
        connection,
        envelope({
          threadId,
          version: 2,
          sequence: 2,
          provenance: { origin: "tool-result", sourceLabel: "mcp-web" },
          contentReference: "content-ref-2",
        }),
      );
      expect(readThreadExternalContentTaint(connection, threadId).ingestedSources).toEqual([
        "readme-md",
        "mcp-web",
      ]);
      expect(
        readThreadExternalContentTaint(connection, otherThreadId).externalContentIngested,
      ).toBe(false);
    } finally {
      connection.close();
    }
  });

  it("rebuilds from provenance events without clearing on boundaries", () => {
    const rebuilt = applyProvenanceToThreadTaint(emptyThreadContentTaint(), [
      { kind: "content-ingested", provenance: { origin: "user", sourceLabel: "prompt" } },
      {
        kind: "content-ingested",
        provenance: { origin: "tool-result", sourceLabel: "file-read" },
      },
      { kind: "session-boundary" },
      { kind: "turn-boundary" },
    ]);
    expect(rebuilt).toEqual({
      externalContentIngested: true,
      ingestedSources: ["file-read"],
    });

    let folded = emptyThreadContentTaint();
    folded = projectThreadContentTaint(folded, {
      kind: "content-ingested",
      provenance: { origin: "tool-result", sourceLabel: "file-read" },
    });
    folded = projectThreadContentTaint(folded, { kind: "session-boundary" });
    expect(folded).toEqual(rebuilt);
  });

  it("treats a repeated content reference as already projected", () => {
    const connection = openMigrated();
    try {
      const projection = new ExternalContentTaintProjection();
      const first = envelope({
        threadId,
        version: 1,
        sequence: 1,
        provenance: { origin: "tool-result", sourceLabel: "browser-observation" },
        contentReference: "browser-observation-1",
      });
      projection.apply(connection, first);
      projection.apply(
        connection,
        envelope({
          threadId,
          version: 2,
          sequence: 2,
          provenance: { origin: "tool-result", sourceLabel: "browser-observation" },
          contentReference: "browser-observation-1",
        }),
      );
      expect(hasThreadExternalContentReference(connection, threadId, "browser-observation-1")).toBe(
        true,
      );
      expect(readThreadExternalContentTaint(connection, threadId).ingestedSources).toEqual([
        "browser-observation",
      ]);
    } finally {
      connection.close();
    }
  });
});

describe("a cleared thread in the taint projection", () => {
  const mcp = { origin: "tool-result", sourceLabel: "mcp-tool" } as const;

  it("forgets the thread's ingestions at the clear and ignores an older event applied again", () => {
    const connection = openMigrated();
    try {
      const projection = new ExternalContentTaintProjection();
      const first = envelope({
        threadId,
        version: 1,
        sequence: 1,
        provenance: mcp,
        contentReference: "mcp-result-1",
      });
      const other = envelope({
        threadId: otherThreadId,
        version: 1,
        sequence: 2,
        provenance: mcp,
        contentReference: "mcp-result-1",
      });
      const cleared = clearedEnvelope({ threadId, version: 2, sequence: 3 });
      projection.apply(connection, first);
      projection.apply(connection, other);
      projection.apply(connection, cleared);

      expect(readThreadExternalContentTaint(connection, threadId)).toEqual(
        emptyThreadContentTaint(),
      );
      expect(hasThreadExternalContentReference(connection, threadId, "mcp-result-1")).toBe(false);
      // The clear covers its own thread only.
      expect(readThreadExternalContentTaint(connection, otherThreadId)).toEqual({
        externalContentIngested: true,
        ingestedSources: ["mcp-tool"],
      });
      expect(hasThreadExternalContentReference(connection, otherThreadId, "mcp-result-1")).toBe(
        true,
      );

      const afterClear = projectionRows(connection);
      projection.apply(connection, first);
      projection.apply(connection, cleared);
      expect(projectionRows(connection)).toEqual(afterClear);

      // The same reference, journaled after the clear, marks the thread again.
      projection.apply(
        connection,
        envelope({
          threadId,
          version: 3,
          sequence: 4,
          provenance: mcp,
          contentReference: "mcp-result-1",
        }),
      );
      expect(readThreadExternalContentTaint(connection, threadId)).toEqual({
        externalContentIngested: true,
        ingestedSources: ["mcp-tool"],
      });
    } finally {
      connection.close();
    }
  });

  it("rebuilds and restarts into the same cleared-then-marked rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-taint-clear-replay-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const open = () => {
      const connection = openSqlite(path);
      applyMigrations(connection, MIGRATIONS, () => now);
      const runtime = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: runtime.events,
        projections: runtime.projections,
        clock: () => now,
      });
      return { connection, runtime, journal };
    };
    const first = open();
    let nextEvent = 0;
    const uuid = () => `77777777-7777-4777-8777-${String(++nextEvent).padStart(12, "0")}`;
    const ingestions = new ExternalContentIngestionStore({
      journal: first.journal,
      connection: first.connection,
      uuid,
      clock: () => now,
      actor: decodeActor({ kind: "system", actorId }),
    });
    const clears = new ExternalContentClearStore({
      journal: first.journal,
      connection: first.connection,
      uuid,
      clock: () => now,
      actor: decodeActor({ kind: "local-user", actorId }),
    });
    const ingest = (thread: string, sourceLabel: string, contentReference: string) =>
      ingestions.record({
        threadId: thread,
        provenance: { origin: "tool-result", sourceLabel },
        contentReference,
        correlationId,
        authorized: true,
      });
    ingest(threadId, "mcp-tool", "mcp-result-1");
    ingest(threadId, "web-fetch", "page-1");
    ingest(otherThreadId, "mcp-tool", "mcp-result-1");

    // A journal that holds no clear projects the rows it always did.
    expect(
      first.connection
        .prepare(
          `SELECT thread_id, external_content_ingested, ingested_sources_json,
                  aggregate_version, last_sequence
           FROM thread_external_content_taint_projection ORDER BY thread_id`,
        )
        .all(),
    ).toEqual([
      {
        thread_id: threadId,
        external_content_ingested: 1,
        ingested_sources_json: '["mcp-tool","web-fetch"]',
        aggregate_version: 2,
        last_sequence: 2,
      },
      {
        thread_id: otherThreadId,
        external_content_ingested: 1,
        ingested_sources_json: '["mcp-tool"]',
        aggregate_version: 1,
        last_sequence: 3,
      },
    ]);
    const withoutClear = projectionRows(first.connection);
    rebuildProjection({
      connection: first.connection,
      journal: first.journal,
      projection: new ExternalContentTaintProjection(),
      clock: () => now,
    });
    expect(projectionRows(first.connection)).toEqual(withoutClear);

    expect(
      clears.clear({
        threadId,
        windowId: "66666666-6666-4666-8666-666666666666",
        expectedVersion: 2,
        principal: "local-window",
        turn: "idle",
      }),
    ).toMatchObject({ kind: "cleared" });
    expect(ingest(threadId, "mcp-tool", "mcp-result-1")).toMatchObject({ kind: "recorded" });

    const live = projectionRows(first.connection);
    expect(readThreadExternalContentTaint(first.connection, threadId)).toEqual({
      externalContentIngested: true,
      ingestedSources: ["mcp-tool"],
    });
    expect(readThreadExternalContentState(first.connection, threadId)).toMatchObject({
      version: 4,
      ingestionCount: 1,
    });
    for (let replay = 0; replay < 2; replay += 1) {
      rebuildProjection({
        connection: first.connection,
        journal: first.journal,
        projection: new ExternalContentTaintProjection(),
        clock: () => now,
      });
      expect(projectionRows(first.connection)).toEqual(live);
    }
    first.connection.close();

    const restarted = open();
    for (const projection of restarted.runtime.projections.all()) {
      catchUpProjection({
        connection: restarted.connection,
        journal: restarted.journal,
        projection,
        clock: () => now,
      });
    }
    expect(projectionRows(restarted.connection)).toEqual(live);
    restarted.connection.close();
  });
});

describe("the outside content an approval names", () => {
  it("names nothing for an unmarked thread, and nothing a person has cleared", () => {
    const connection = openMigrated();
    try {
      const projection = new ExternalContentTaintProjection();
      expect(readApprovalOutsideContent(connection, threadId)).toBeUndefined();
      // Content a person typed is recorded but does not mark the thread.
      projection.apply(
        connection,
        envelope({
          threadId,
          version: 1,
          sequence: 1,
          provenance: { origin: "user", sourceLabel: "composer" },
          contentReference: "typed-1",
        }),
      );
      expect(readApprovalOutsideContent(connection, threadId)).toBeUndefined();
      projection.apply(
        connection,
        envelope({
          threadId,
          version: 2,
          sequence: 2,
          provenance: { origin: "tool-result", sourceLabel: "mcp-tool" },
          contentReference: "mcp-result-1",
        }),
      );
      expect(readApprovalOutsideContent(connection, threadId)?.sourceCount).toBe(1);
      projection.apply(connection, clearedEnvelope({ threadId, version: 3, sequence: 3 }));
      expect(readApprovalOutsideContent(connection, threadId)).toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("names the marking sources most recently read first, with counts and times", () => {
    const connection = openMigrated();
    try {
      const projection = new ExternalContentTaintProjection();
      const read = (
        version: number,
        sourceLabel: string,
        occurredAt: string,
        origin: "tool-result" | "external-content" | "user" = "external-content",
      ) =>
        projection.apply(
          connection,
          envelope({
            threadId,
            version,
            sequence: version,
            provenance: { origin, sourceLabel },
            contentReference: `ref-${version}`,
            occurredAt,
          }),
        );
      read(1, "web-fetch", "2026-10-15T08:00:00.000Z");
      read(2, "github-issue", "2026-10-15T08:30:00.000Z");
      read(3, "web-fetch", "2026-10-15T09:00:00.000Z");
      read(4, "composer", "2026-10-15T09:30:00.000Z", "user");

      expect(readApprovalOutsideContent(connection, threadId)).toEqual({
        sources: [
          {
            sourceLabel: "web-fetch",
            ingestionCount: 2,
            firstIngestedAt: "2026-10-15T08:00:00.000Z",
            lastIngestedAt: "2026-10-15T09:00:00.000Z",
          },
          {
            sourceLabel: "github-issue",
            ingestionCount: 1,
            firstIngestedAt: "2026-10-15T08:30:00.000Z",
            lastIngestedAt: "2026-10-15T08:30:00.000Z",
          },
        ],
        sourceCount: 2,
      });
      // Another thread's mark is never named here.
      expect(readApprovalOutsideContent(connection, otherThreadId)).toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("names at most eight sources and counts the rest", () => {
    const connection = openMigrated();
    try {
      const projection = new ExternalContentTaintProjection();
      for (let version = 1; version <= 11; version += 1) {
        projection.apply(
          connection,
          envelope({
            threadId,
            version,
            sequence: version,
            provenance: { origin: "tool-result", sourceLabel: `source-${version}` },
            contentReference: `ref-${version}`,
          }),
        );
      }
      const named = readApprovalOutsideContent(connection, threadId);
      expect(named?.sourceCount).toBe(11);
      expect(named?.sources.map((source) => source.sourceLabel)).toEqual([
        "source-11",
        "source-10",
        "source-9",
        "source-8",
        "source-7",
        "source-6",
        "source-5",
        "source-4",
      ]);
    } finally {
      connection.close();
    }
  });
});

describe("external-content taint restart", () => {
  it("replays the same thread-lifetime taint after the store is reopened", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-taint-restart-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");
    const first = openSqlite(path);
    applyMigrations(first, MIGRATIONS, () => now);
    const firstRuntime = createPhase1RuntimeRegistries();
    const firstJournal = new Journal({
      connection: first,
      registry: firstRuntime.events,
      projections: firstRuntime.projections,
      clock: () => now,
    });
    const store = new ExternalContentIngestionStore({
      journal: firstJournal,
      connection: first,
      uuid: () => "55555555-5555-4555-8555-555555555555",
      clock: () => now,
      actor: decodeActor({ kind: "system", actorId }),
    });
    expect(
      store.record({
        threadId,
        provenance: { origin: "tool-result", sourceLabel: "browser-observation" },
        contentReference: "browser-observation-1",
        correlationId,
        authorized: true,
      }),
    ).toMatchObject({
      kind: "recorded",
      taint: { externalContentIngested: true, ingestedSources: ["browser-observation"] },
    });
    first.close();

    const reopened = openSqlite(path);
    applyMigrations(reopened, MIGRATIONS, () => now);
    const restartedRuntime = createPhase1RuntimeRegistries();
    const restartedJournal = new Journal({
      connection: reopened,
      registry: restartedRuntime.events,
      projections: restartedRuntime.projections,
      clock: () => now,
    });
    for (const projection of restartedRuntime.projections.all()) {
      catchUpProjection({
        connection: reopened,
        journal: restartedJournal,
        projection,
        clock: () => now,
      });
    }

    expect(readThreadExternalContentTaint(reopened, threadId)).toEqual({
      externalContentIngested: true,
      ingestedSources: ["browser-observation"],
    });
    reopened.close();
  });
});

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
import { catchUpProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { ExternalContentIngestionStore } from "./externalContentIngestionStore";
import {
  ExternalContentTaintProjection,
  applyProvenanceToThreadTaint,
  hasThreadExternalContentReference,
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
}) {
  return decodeEnvelope({
    eventId: `00000000-0000-4000-8000-00000000000${input.version}`,
    globalSequence: input.sequence,
    aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
    aggregateId: input.threadId,
    aggregateVersion: input.version,
    eventName: THREAD_EXTERNAL_CONTENT_EVENT_NAMES.ingested,
    eventVersion: 1,
    hostId: "local",
    correlationId,
    actor: { kind: "system", actorId },
    occurredAt: now,
    payload: {
      threadId: input.threadId,
      correlationId,
      provenance: input.provenance,
      contentReference: input.contentReference,
    },
  });
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

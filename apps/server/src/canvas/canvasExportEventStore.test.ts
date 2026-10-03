import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeCanvasExportRecorded,
  type CanvasExportRecorded,
} from "@octant/contracts/canvas-export";
import { EventActor, decodeUtcTimestamp } from "@octant/contracts";
import { Schema } from "effect";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { CanvasExportEventStore, registerCanvasExportEvents } from "./canvasExportEventStore";

const directories: string[] = [];
const now = "2026-08-01T21:00:00.000Z";

function openConnection(path: string): SqliteConnection {
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function record(): CanvasExportRecorded {
  return decodeCanvasExportRecorded({
    schemaVersion: 1,
    kind: "canvas-export",
    exportId: "33333333-3333-4333-8333-333333333333",
    canvasId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    targetId: "reading-copy",
    destinationLabel: "Reading copy",
    format: "markdown",
    payloadDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    approvalId: "44444444-4444-4444-8444-444444444444",
    outcome: { kind: "receipt", receipt: { kind: "remote-id", remoteId: "copy-1" } },
  });
}

function store(connection: SqliteConnection, uuid: () => string): CanvasExportEventStore {
  const registry = registerCanvasExportEvents(new EventRegistry());
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({
    connection,
    registry,
    projections,
    clock: () => now,
  });
  return new CanvasExportEventStore({
    journal,
    uuid,
    actor: Schema.decodeUnknownSync(EventActor)({
      kind: "local-user",
      actorId: "99999999-9999-4999-8999-999999999999",
    }),
  });
}

describe("canvas export journal", () => {
  it("replays an export after the journal is reopened", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-canvas-export-"));
    directories.push(directory);
    const path = join(directory, "events.sqlite3");
    const first = openConnection(path);
    let n = 0;
    store(first, () => {
      n += 1;
      return `55555555-5555-4555-8555-${n.toString(16).padStart(12, "0")}`;
    }).append({ record: record(), occurredAt: decodeUtcTimestamp(now) });
    first.close();

    const reopened = openConnection(path);
    const replayed = store(reopened, () => "66666666-6666-4666-8666-666666666666").replay();
    reopened.close();

    expect(replayed).toEqual([record()]);
  });
});

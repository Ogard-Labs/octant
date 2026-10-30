import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasId,
  decodeCanvasVersion,
  decodeUtcTimestamp,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { CanvasTagService, registerCanvasTagEvents } from "./canvasTagService";
import { CanvasProjection } from "./canvasProjection";

const directories: Array<string> = [];
const now = decodeUtcTimestamp("2026-08-01T21:00:00.000Z");

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  project: "66666666-6666-4666-8666-666666666666",
  thread: "77777777-7777-4777-8777-777777777777",
  provider: "88888888-8888-4888-8888-888888888888",
  actor: "99999999-9999-4999-8999-999999999999",
} as const;

const canvasId = decodeCanvasId(ids.canvas);
const actor = { kind: "local-user", actorId: ids.actor } as const;
const eventActor = Schema.decodeUnknownSync(EventActor)(actor);

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-tags-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function fixture(options: { readonly projectId: string | null; readonly threadHolds?: boolean }) {
  const projection = new CanvasProjection();
  projection.applyCreated({
    canvasId,
    version: decodeCanvasVersion({
      schemaVersion: CANVAS_SCHEMA_VERSION,
      canvasId: ids.canvas,
      versionId: ids.version,
      sequence: 1,
      definition: {
        schemaVersion: CANVAS_SCHEMA_VERSION,
        title: "Board under review",
        provenance: {
          mode: "chat",
          hostId: "local",
          projectId: options.projectId,
          threadId: ids.thread,
          actor,
          providerInstanceId: ids.provider,
          modelId: "octant-test-model",
          createdAt: now,
        },
        sourceManifest: [],
        blocks: [
          {
            blockId: "block-1",
            schemaVersion: CANVAS_SCHEMA_VERSION,
            kind: "heading",
            level: 1,
            text: "A bounded Canvas",
          },
        ],
      },
      createdBy: actor,
      createdAt: now,
    }),
  });
  const journal = new Journal({
    connection: openConnection(),
    registry: registerCanvasTagEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  let counter = 0;
  const uuid = () => `bbbbbbbb-bbbb-4bbb-8bbb-${(++counter).toString(16).padStart(12, "0")}`;
  const service = () =>
    new CanvasTagService(
      { journal, projection, uuid, actor: eventActor, clock: () => now },
      { threadHoldsCanvas: () => options.threadHolds ?? true },
    );
  return { journal, projection, uuid, service };
}

function add(tag: string) {
  return { kind: "canvas-tag-add", canvasId: ids.canvas, tag, issuedAt: now };
}

function remove(tag: string) {
  return { kind: "canvas-tag-remove", canvasId: ids.canvas, tag, issuedAt: now };
}

describe("CanvasTagService", () => {
  it("accepts a tag from a local window, and answers with the tags it holds", () => {
    const { service } = fixture({ projectId: ids.project });

    const result = service().change(add("Launch"), "local-window");

    expect(result).toEqual({
      kind: "accepted",
      canvasId,
      sequence: 1,
      tags: ["Launch"],
    });
    expect(service().tags(canvasId)).toEqual(["Launch"]);
  });

  it("refuses a tag change from anywhere but a window on this host", () => {
    const { service } = fixture({ projectId: ids.project });

    const result = service().change(add("Launch"), "remote-device");

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.denialCode).toBe("unauthorized");
    expect(service().tags(canvasId)).toEqual([]);
  });

  it("refuses a duplicate tag and an unknown removal by name", () => {
    const { service } = fixture({ projectId: ids.project });
    const tags = service();
    tags.change(add("Launch"), "local-window");

    const again = tags.change(add("Launch"), "local-window");
    expect(again.kind).toBe("denied");
    if (again.kind === "denied") expect(again.denialCode).toBe("duplicate-tag");

    const unknown = tags.change(remove("Absent"), "local-window");
    expect(unknown.kind).toBe("denied");
    if (unknown.kind === "denied") expect(unknown.denialCode).toBe("unknown-tag");
  });

  it("bounds a Canvas to twelve tags and refuses a malformed command", () => {
    const { service } = fixture({ projectId: ids.project });
    const tags = service();
    for (let index = 0; index < 12; index += 1) {
      tags.change(add(`tag-${index}`), "local-window");
    }

    const over = tags.change(add("thirteenth"), "local-window");
    expect(over.kind).toBe("denied");
    if (over.kind === "denied") expect(over.denialCode).toBe("tag-budget-exceeded");

    const malformed = tags.change({ kind: "canvas-tag-add" }, "local-window");
    expect(malformed.kind).toBe("denied");
    if (malformed.kind === "denied") expect(malformed.denialCode).toBe("malformed-request");
  });

  it("removes a tag it holds, and the removal is a journaled fact", () => {
    const { service } = fixture({ projectId: ids.project });
    const tags = service();
    tags.change(add("Launch"), "local-window");

    const removed = tags.change(remove("Launch"), "local-window");

    expect(removed).toEqual({ kind: "accepted", canvasId, sequence: 2, tags: [] });
  });

  it("refuses a Canvas the host does not hold, and names it unavailable", () => {
    const { service } = fixture({ projectId: ids.project });

    const result = service().change(
      { ...add("Launch"), canvasId: "12121212-1212-4121-8121-121212121212" },
      "local-window",
    );

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.denialCode).toBe("unavailable");
      expect(result.message).toContain("unavailable");
    }
  });

  it("refuses a tag on a thread-owned Canvas whose thread no longer holds it", () => {
    const { service } = fixture({ projectId: null, threadHolds: false });

    const result = service().change(add("Launch"), "local-window");

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.denialCode).toBe("unavailable");
  });

  it("accepts a tag on a thread-owned Canvas while its thread holds it", () => {
    const { service } = fixture({ projectId: null, threadHolds: true });

    const result = service().change(add("Launch"), "local-window");

    expect(result.kind).toBe("accepted");
  });

  it("rebuilds a Canvas's tags from the journal alone", () => {
    const { journal, uuid, service } = fixture({ projectId: ids.project });
    const first = service();
    first.change(add("Launch"), "local-window");
    first.change(add("Q4"), "local-window");

    // A second service, as after a restart: same journal, fresh process state.
    const replayed = new CanvasTagService(
      { journal, projection: new CanvasProjection(), uuid, actor: eventActor, clock: () => now },
      { threadHoldsCanvas: () => true },
    );
    expect(replayed.tags(canvasId)).toEqual(["Launch", "Q4"]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { CANVAS_SCHEMA_VERSION, decodeCanvasId, decodeCanvasVersion } from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { CanvasCommentService, registerCanvasCommentEvents } from "./canvasCommentService";
import { CanvasProjection } from "./canvasProjection";

const directories: Array<string> = [];
const now = "2026-08-01T21:00:00.000Z";

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
  comment: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  reply: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
} as const;

const canvasId = decodeCanvasId(ids.canvas);
const actor = { kind: "local-user", actorId: ids.actor } as const;
const eventActor = Schema.decodeUnknownSync(EventActor)(actor);
const context = { mode: "chat", projectId: ids.project } as const;
const project = { id: ids.project, type: "chat", lifecycle: "active" } as const;

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-comments-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function fixture(authorize: () => boolean = () => true) {
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
          projectId: ids.project,
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
    registry: registerCanvasCommentEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  let counter = 0;
  const uuid = () => `bbbbbbbb-bbbb-4bbb-8bbb-${(++counter).toString(16).padStart(12, "0")}`;
  const service = () =>
    new CanvasCommentService({ journal, projection, uuid, actor: eventActor }, { authorize });
  return { journal, projection, uuid, service };
}

function add(expectedSequence: number, body = "Rename the API box") {
  return {
    kind: "canvas-comment-add",
    canvasId: ids.canvas,
    commentId: ids.comment,
    anchor: { kind: "block", blockId: "block-1" },
    author: actor,
    body,
    expectedSequence,
    issuedAt: now,
  };
}

describe("CanvasCommentService", () => {
  it("journals a comment, its reply, and its resolution, and rebuilds them after a restart", () => {
    const { service } = fixture();
    const first = service();
    expect(first.comment(add(0), context, project, { kind: "host" })).toEqual({
      kind: "accepted",
      canvasId,
      sequence: 1,
    });
    expect(
      first.comment(
        {
          kind: "canvas-comment-reply",
          canvasId: ids.canvas,
          commentId: ids.comment,
          replyId: ids.reply,
          author: actor,
          body: "Agreed",
          expectedSequence: 1,
          issuedAt: now,
        },
        context,
        project,
        { kind: "remote-device", deviceId: "phone-1" },
      ),
    ).toMatchObject({ kind: "accepted", sequence: 2 });
    expect(
      first.comment(
        {
          kind: "canvas-comment-resolve",
          canvasId: ids.canvas,
          commentId: ids.comment,
          resolvedBy: actor,
          expectedSequence: 2,
          issuedAt: now,
        },
        context,
        project,
        { kind: "host" },
      ),
    ).toMatchObject({ kind: "accepted", sequence: 3 });

    const restarted = service();
    const outcome = restarted.comments(canvasId, context, project);
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.sequence).toBe(3);
    expect(outcome.threads).toHaveLength(1);
    expect(outcome.threads[0]?.comment).toMatchObject({
      body: "Rename the API box",
      author: actor,
      origin: { kind: "host" },
      resolvedBy: actor,
    });
    expect(outcome.threads[0]?.replies[0]).toMatchObject({
      body: "Agreed",
      origin: { kind: "remote-device", deviceId: "phone-1" },
    });
  });

  it("refuses the second of two comments written against the same sequence", () => {
    const { service } = fixture();
    const a = service();
    const b = service();
    expect(a.comment(add(0), context, project, { kind: "host" }).kind).toBe("accepted");
    const late = b.comment(
      { ...add(0, "Also this"), commentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3" },
      context,
      project,
      { kind: "host" },
    );
    expect(late).toMatchObject({ kind: "denied", denialCode: "stale-version" });
    const reread = service().comments(canvasId, context, project);
    expect(reread.kind === "ready" ? reread.threads.length : undefined).toBe(1);
  });

  it("gives an unauthorized workspace no comment bodies and accepts no comments from it", () => {
    const { service } = fixture(() => false);
    const denied = service();
    expect(denied.comments(canvasId, context, project)).toEqual({
      kind: "unauthorized",
      canvasId,
    });
    expect(denied.comment(add(0), context, project, { kind: "host" })).toMatchObject({
      kind: "denied",
      denialCode: "unauthorized",
    });
  });

  it("deletes a comment with its replies and keeps the sequence moving", () => {
    const { service } = fixture();
    const live = service();
    live.comment(add(0), context, project, { kind: "host" });
    live.comment(
      {
        kind: "canvas-comment-reply",
        canvasId: ids.canvas,
        commentId: ids.comment,
        replyId: ids.reply,
        author: actor,
        body: "Agreed",
        expectedSequence: 1,
        issuedAt: now,
      },
      context,
      project,
      { kind: "host" },
    );
    expect(
      live.comment(
        {
          kind: "canvas-comment-delete",
          canvasId: ids.canvas,
          commentId: ids.comment,
          deletedBy: actor,
          expectedSequence: 2,
          issuedAt: now,
        },
        context,
        project,
        { kind: "host" },
      ),
    ).toMatchObject({ kind: "accepted", sequence: 3 });
    const outcome = service().comments(canvasId, context, project);
    expect(outcome).toMatchObject({ kind: "ready", sequence: 3, threads: [] });
  });
});

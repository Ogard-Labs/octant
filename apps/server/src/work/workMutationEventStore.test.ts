import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { WorkMutationEventStore } from "./workMutationEventStore";
import {
  decodeWorkArtifactId,
  decodeWorkArtifactMutationFrame,
  decodeWorkArtifactVersionId,
  decodeWorkMutationRequestId,
  type WorkArtifactMutationFrame,
} from "@octant/contracts/work-artifacts";
import { EventActor } from "@octant/contracts/events";
import { decodeProjectId } from "@octant/contracts/projects";

const directories: Array<string> = [];
const now = "2026-07-22T08:00:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-work-event-store-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  artifact: decodeWorkArtifactId("11111111-1111-4111-8111-111111111111"),
  version: decodeWorkArtifactVersionId("22222222-2222-4222-8222-222222222222"),
  request: decodeWorkMutationRequestId("33333333-3333-4333-8333-333333333333"),
  project: decodeProjectId("44444444-4444-4444-8444-444444444444"),
  actor: "55555555-5555-4555-8555-555555555555",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });
const occurredAt = "2026-07-22T08:00:00.000Z";
const sha256 = "0000000000000000000000000000000000000000000000000000000000000000";

function createdFrame(sequence: number): WorkArtifactMutationFrame {
  return decodeWorkArtifactMutationFrame({
    requestId: ids.request,
    projectId: ids.project,
    sequence,
    occurredAt,
    outcome: {
      kind: "created",
      artifact: {
        artifactId: ids.artifact,
        projectId: ids.project,
        format: "markdown",
        artifactRef: "opaque-token-1",
        displayName: "notes.md",
        createdAt: occurredAt,
      },
      version: {
        versionId: ids.version,
        artifactId: ids.artifact,
        projectId: ids.project,
        format: "markdown",
        sourceVersion: { contentSha256: sha256, byteSize: 12, observedAt: occurredAt },
        createdBy: { kind: "local-user", actorId: ids.actor },
        createdAt: occurredAt,
        sequence,
      },
      previewTarget: {
        targetId: "66666666-6666-4666-8666-666666666666",
        projectId: ids.project,
        hostId: "77777777-7777-4777-8777-777777777777",
        kind: "artifact-version",
        opaqueRef: "opaque-token-1",
        displayName: "notes.md",
      },
    },
  });
}

function createStore(): WorkMutationEventStore {
  const connection = openConnection();
  const registry = new EventRegistry().register(
    "work.artifact-mutation-recorded@1",
    1,
    Schema.Unknown,
  );
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({
    connection,
    registry,
    projections,
    clock: () => occurredAt,
  });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
  };
  return new WorkMutationEventStore({
    journal,
    uuid,
    clock: () => occurredAt,
    actor,
  });
}

describe("WorkMutationEventStore", () => {
  it("appends a mutation frame and returns the committed frame with the next sequence", () => {
    const store = createStore();
    const frame = store.append({
      artifactId: ids.artifact,
      expectedSequence: 0,
      frame: createdFrame(1),
    });
    expect(frame.outcome.kind).toBe("created");
    expect(frame.sequence).toBe(1);
  });

  it("rejects an append whose expected sequence does not match the current head (optimistic concurrency)", () => {
    const store = createStore();
    store.append({ artifactId: ids.artifact, expectedSequence: 0, frame: createdFrame(1) });
    expect(() =>
      store.append({ artifactId: ids.artifact, expectedSequence: 0, frame: createdFrame(2) }),
    ).toThrow();
  });

  it("appends a second frame when the expected sequence matches the current head", () => {
    const store = createStore();
    store.append({ artifactId: ids.artifact, expectedSequence: 0, frame: createdFrame(1) });
    const base = createdFrame(2);
    const createdOutcome = base.outcome;
    if (createdOutcome.kind !== "created") throw new Error("expected created outcome");
    const second = store.append({
      artifactId: ids.artifact,
      expectedSequence: 1,
      frame: decodeWorkArtifactMutationFrame({
        ...base,
        outcome: {
          kind: "revised" as const,
          artifact: createdOutcome.artifact,
          version: { ...createdOutcome.version, sequence: 2 },
          previewTarget: createdOutcome.previewTarget,
        },
      }),
    });
    expect(second.sequence).toBe(2);
  });

  it("replays frames for an artifact in sequence order", () => {
    const store = createStore();
    store.append({ artifactId: ids.artifact, expectedSequence: 0, frame: createdFrame(1) });
    const base = createdFrame(2);
    const createdOutcome = base.outcome;
    if (createdOutcome.kind !== "created") throw new Error("expected created outcome");
    store.append({
      artifactId: ids.artifact,
      expectedSequence: 1,
      frame: decodeWorkArtifactMutationFrame({
        ...base,
        outcome: {
          kind: "revised" as const,
          artifact: createdOutcome.artifact,
          version: { ...createdOutcome.version, sequence: 2 },
          previewTarget: createdOutcome.previewTarget,
        },
      }),
    });
    const replay = store.replay({ artifactId: ids.artifact, afterSequence: 0, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames).toHaveLength(2);
    expect(replay.frames[0]?.sequence).toBe(1);
    expect(replay.frames[1]?.sequence).toBe(2);
    expect(replay.nextCursor).toBe(2);
  });

  it("replays no frames for an unknown artifact", () => {
    const store = createStore();
    const replay = store.replay({ artifactId: ids.artifact, afterSequence: 0, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames).toHaveLength(0);
    expect(replay.nextCursor).toBe(0);
  });

  it("rejects an invalid replay limit", () => {
    const store = createStore();
    expect(() => store.replay({ artifactId: ids.artifact, afterSequence: 0, limit: 0 })).toThrow();
  });
});

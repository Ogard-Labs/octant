import { describe, expect, it } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasId,
  decodeCanvasVersion,
  type CanvasVersion,
  type EventEnvelope,
} from "@octant/contracts";
import { CanvasProjection } from "./canvasProjection";
import { CANVAS_CREATED, CANVAS_VERSION_APPENDED } from "./canvasEventStore";

const now = "2026-08-01T21:00:00.000Z";
const later = "2026-08-01T21:01:00.000Z";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  canvasB: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  version: "22222222-2222-4222-8222-222222222222",
  version2: "33333333-3333-4333-8333-333333333333",
  version3: "44444444-4444-4444-8444-444444444444",
  versionB2: "55555555-5555-4555-8555-555555555555",
  source: "66666666-6666-4666-8666-666666666666",
  project: "77777777-7777-4777-8777-777777777777",
  projectB: "88888888-8888-4888-8888-888888888888",
  thread: "99999999-9999-4999-8999-999999999999",
  provider: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  actor: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

const canvasId = decodeCanvasId(ids.canvas);
const canvasIdB = decodeCanvasId(ids.canvasB);

const provenance = {
  mode: "chat",
  hostId: "local",
  projectId: ids.project,
  threadId: ids.thread,
  actor: { kind: "local-user", actorId: ids.actor },
  providerInstanceId: ids.provider,
  modelId: "octant-test-model",
  createdAt: now,
} as const;

const source = {
  sourceId: ids.source,
  kind: "attachment",
  hostId: "local",
  projectId: ids.project,
  opaqueRef: "source-token-1",
  displayName: "notes.md",
} as const;

const definition = {
  schemaVersion: CANVAS_SCHEMA_VERSION,
  title: "Canvas projection fixture",
  provenance,
  sourceManifest: [source],
  blocks: [
    {
      blockId: "block-1",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "heading",
      level: 1,
      text: "A bounded Canvas",
    },
  ],
} as const;

function version(overrides: Record<string, unknown> = {}): CanvasVersion {
  return decodeCanvasVersion({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId: ids.canvas,
    versionId: ids.version,
    sequence: 1,
    definition,
    createdBy: provenance.actor,
    createdAt: now,
    ...overrides,
  });
}

function envelope(
  eventName: string,
  aggregateVersion: number,
  payload: unknown,
  occurredAt = now,
): EventEnvelope {
  return {
    eventId: `event-${aggregateVersion}-${eventName}` as never,
    globalSequence: aggregateVersion as never,
    aggregateType: "canvas" as never,
    aggregateId: ids.canvas as never,
    aggregateVersion: aggregateVersion as never,
    eventName: eventName as never,
    eventVersion: 1 as never,
    hostId: "local" as never,
    correlationId: "corr-1" as never,
    actor: { kind: "local-user", actorId: ids.actor as never },
    occurredAt: occurredAt as never,
    payload,
  };
}

describe("CanvasProjection", () => {
  it("projects a created Canvas as the current version with provenance indexes", () => {
    const projection = new CanvasProjection();
    const v1 = version();
    projection.applyCreated({ canvasId, version: v1 });
    const entry = projection.getById(canvasId);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.currentVersion.sequence).toBe(1);
    expect(entry.versionCount).toBe(1);
    expect(projection.byProject(ids.project as never)).toHaveLength(1);
    expect(
      projection.byThread({
        projectId: ids.project as never,
        threadId: ids.thread,
        mode: "chat",
      }),
    ).toHaveLength(1);
  });

  it("advances current state when a later version is appended", () => {
    const projection = new CanvasProjection();
    const v1 = version();
    projection.applyCreated({ canvasId, version: v1 });
    const v2 = version({ versionId: ids.version2, sequence: 2, createdAt: later });
    projection.applyVersionAppended({ canvasId, version: v2 });
    const entry = projection.getById(canvasId);
    if (entry === undefined) return;
    expect(entry.currentVersion.sequence).toBe(2);
    expect(entry.currentVersion.versionId).toBe(ids.version2);
    expect(entry.versionCount).toBe(2);
    expect(entry.versions).toHaveLength(2);
    expect(entry.updatedAt).toBe(later);
  });

  it("retains immutable version history for restore and compare", () => {
    const projection = new CanvasProjection();
    const v1 = version();
    const v2 = version({ versionId: ids.version2, sequence: 2, createdAt: later });
    projection.applyCreated({ canvasId, version: v1 });
    projection.applyVersionAppended({ canvasId, version: v2 });
    expect(projection.getVersion(canvasId, ids.version2 as never)?.sequence).toBe(2);
    expect(projection.getVersion(canvasId, ids.version as never)?.sequence).toBe(1);
  });

  it("is idempotent when the same create is applied twice", () => {
    const projection = new CanvasProjection();
    const v1 = version();
    projection.applyCreated({ canvasId, version: v1 });
    projection.applyCreated({ canvasId, version: v1 });
    const entry = projection.getById(canvasId);
    if (entry === undefined) return;
    expect(entry.versionCount).toBe(1);
    expect(entry.currentVersion.sequence).toBe(1);
  });

  it("is idempotent when an older version is replayed out of order", () => {
    const projection = new CanvasProjection();
    const v1 = version();
    const v2 = version({ versionId: ids.version2, sequence: 2, createdAt: later });
    projection.applyCreated({ canvasId, version: v1 });
    projection.applyVersionAppended({ canvasId, version: v2 });
    // Re-apply the older create; state must not roll back.
    projection.applyCreated({ canvasId, version: v1 });
    const entry = projection.getById(canvasId);
    if (entry === undefined) return;
    expect(entry.currentVersion.sequence).toBe(2);
    expect(entry.versionCount).toBe(2);
  });

  it("ignores a version append for an unknown canvas (no create observed)", () => {
    const projection = new CanvasProjection();
    const v2 = version({ versionId: ids.version2, sequence: 2 });
    projection.applyVersionAppended({ canvasId, version: v2 });
    expect(projection.getById(canvasId)).toBeUndefined();
  });

  it("rebuilds identically from a replayed event batch after a reset", () => {
    const projection = new CanvasProjection();
    const v1 = version();
    const v2 = version({ versionId: ids.version2, sequence: 2, createdAt: later });
    const v3 = version({ versionId: ids.version3, sequence: 3, createdAt: later });
    const events = [
      envelope(CANVAS_CREATED, 1, { canvasId: ids.canvas, version: v1 }),
      envelope(CANVAS_VERSION_APPENDED, 2, { canvasId: ids.canvas, version: v2 }, later),
      envelope(CANVAS_VERSION_APPENDED, 3, { canvasId: ids.canvas, version: v3 }, later),
    ];
    for (const event of events) projection.apply({} as never, event);
    const before = projection.getById(canvasId);
    expect(before?.currentVersion.sequence).toBe(3);

    projection.reset({} as never);
    expect(projection.getById(canvasId)).toBeUndefined();
    for (const event of events) projection.apply({} as never, event);
    const after = projection.getById(canvasId);
    expect(after).toEqual(before);
  });

  it("applies events through the Projection interface from an EventEnvelope", () => {
    const projection = new CanvasProjection();
    const v1 = version();
    projection.apply(
      {} as never,
      envelope(CANVAS_CREATED, 1, { canvasId: ids.canvas, version: v1 }),
    );
    expect(projection.getById(canvasId)?.currentVersion.sequence).toBe(1);
  });

  it("ignores events with an unsupported event version", () => {
    const projection = new CanvasProjection();
    const event = envelope(CANVAS_CREATED, 1, { canvasId: ids.canvas, version: version() });
    const unsupported = { ...event, eventVersion: 2 as never };
    projection.apply({} as never, unsupported);
    expect(projection.getById(canvasId)).toBeUndefined();
  });

  it("separates canvases by Project and thread provenance", () => {
    const projection = new CanvasProjection();
    projection.applyCreated({ canvasId, version: version() });
    const definitionB = {
      ...definition,
      provenance: { ...provenance, projectId: ids.projectB },
      title: "Canvas B",
    } as const;
    const versionB = version({
      canvasId: ids.canvasB,
      versionId: ids.versionB2,
      definition: decodeCanvasVersion({
        schemaVersion: CANVAS_SCHEMA_VERSION,
        canvasId: ids.canvasB,
        versionId: ids.versionB2,
        sequence: 1,
        definition: definitionB,
        createdBy: provenance.actor,
        createdAt: now,
      }).definition,
    });
    projection.applyCreated({ canvasId: canvasIdB, version: versionB });
    expect(projection.byProject(ids.project as never)).toHaveLength(1);
    expect(projection.byProject(ids.projectB as never)).toHaveLength(1);
    expect(
      projection.byThread({
        projectId: ids.project as never,
        threadId: ids.thread,
        mode: "chat",
      }),
    ).toHaveLength(1);
  });

  it("exposes a snapshot that does not mutate internal state", () => {
    const projection = new CanvasProjection();
    projection.applyCreated({ canvasId, version: version() });
    const snapshot = projection.snapshot();
    projection.clear();
    expect(snapshot.get(canvasId)?.currentVersion.sequence).toBe(1);
    expect(projection.getById(canvasId)).toBeUndefined();
  });
});

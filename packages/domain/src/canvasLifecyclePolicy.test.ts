import { describe, expect, it } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasId,
  decodeCanvasVersion,
  type CanvasVersion,
} from "@octant/contracts";
import {
  assertCanvasCreate,
  assertCanvasVersionAppend,
  CanvasLifecyclePolicyRejected,
} from "./canvasLifecyclePolicy";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  otherCanvas: "99999999-9999-4999-8999-999999999999",
  version: "22222222-2222-4222-8222-222222222222",
  version2: "33333333-3333-4333-8333-333333333333",
  project: "55555555-5555-4555-8555-555555555555",
  thread: "66666666-6666-4666-8666-666666666666",
  provider: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
} as const;

const canvasId = decodeCanvasId(ids.canvas);

const provenance = {
  mode: "chat",
  hostId: "local",
  projectId: ids.project,
  threadId: ids.thread,
  actor: { kind: "local-user", actorId: ids.actor },
  providerInstanceId: ids.provider,
  modelId: "octant-test-model",
  createdAt: "2026-08-01T21:00:00.000Z",
} as const;

const definition = {
  schemaVersion: CANVAS_SCHEMA_VERSION,
  title: "Canvas lifecycle fixture",
  provenance,
  sourceManifest: [
    {
      sourceId: ids.version,
      kind: "attachment",
      hostId: "local",
      projectId: ids.project,
      opaqueRef: "source-token-1",
      displayName: "notes.md",
    },
  ],
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
    createdAt: "2026-08-01T21:00:01.000Z",
    ...overrides,
  });
}

describe("Canvas lifecycle policy", () => {
  it("accepts a create whose first version is sequence 1 and matches the canvas id", () => {
    expect(() => assertCanvasCreate(canvasId, version())).not.toThrow();
  });

  it("rejects a create whose first version is not sequence 1", () => {
    expect(() => assertCanvasCreate(canvasId, version({ sequence: 2 }))).toThrowError(
      CanvasLifecyclePolicyRejected,
    );
  });

  it("rejects a create whose version canvasId does not match the event canvasId", () => {
    expect(() => assertCanvasCreate(canvasId, version({ canvasId: ids.otherCanvas }))).toThrowError(
      CanvasLifecyclePolicyRejected,
    );
  });

  it("accepts a version append that increments sequence by exactly one and matches identity", () => {
    const current = version();
    const next = version({
      versionId: ids.version2,
      sequence: 2,
      createdAt: "2026-08-01T21:00:02.000Z",
    });
    expect(() => assertCanvasVersionAppend(canvasId, current, next)).not.toThrow();
  });

  it("rejects a version append that does not increment sequence by one", () => {
    const current = version();
    expect(() =>
      assertCanvasVersionAppend(
        canvasId,
        current,
        version({ versionId: ids.version2, sequence: 3 }),
      ),
    ).toThrowError(CanvasLifecyclePolicyRejected);
    expect(() =>
      assertCanvasVersionAppend(
        canvasId,
        current,
        version({ versionId: ids.version2, sequence: 1 }),
      ),
    ).toThrowError(CanvasLifecyclePolicyRejected);
  });

  it("rejects a version append whose canvasId does not match the current canvas", () => {
    const current = version();
    const next = version({
      canvasId: ids.otherCanvas,
      versionId: ids.version2,
      sequence: 2,
    });
    expect(() => assertCanvasVersionAppend(canvasId, current, next)).toThrowError(
      CanvasLifecyclePolicyRejected,
    );
  });

  it("rejects a version append whose schema version differs from the current version", () => {
    const current = version();
    const next = version({ versionId: ids.version2, sequence: 2 });
    // Tamper with the schema version after decode to simulate a future envelope.
    const incompatible = { ...next, schemaVersion: 2 as unknown as typeof next.schemaVersion };
    expect(() => assertCanvasVersionAppend(canvasId, current, incompatible)).toThrow();
  });

  it("rejects a version append that reuses the same versionId as the current version", () => {
    const current = version();
    expect(() =>
      assertCanvasVersionAppend(canvasId, current, version({ sequence: 2 })),
    ).toThrowError(CanvasLifecyclePolicyRejected);
  });
});

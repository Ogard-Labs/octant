import { describe, expect, it } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasId,
  decodeCanvasVersion,
} from "@octant/contracts/canvas";
import {
  admitCanvasRevise,
  applyPromptRefinement,
  buildRevisionVersion,
  canvasReviseDenialReason,
  clampRevisionProvenance,
  CanvasRevisionPolicyRejected,
  listCanvasVersionHistory,
  projectVersionHistoryEntry,
} from "./canvasRevisionPolicy";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  version2: "33333333-3333-4333-8333-333333333333",
  request: "44444444-4444-4444-8444-444444444444",
  receipt: "55555555-5555-4555-8555-555555555555",
  thread: "66666666-6666-4666-8666-666666666666",
  provider: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
  source: "99999999-9999-4999-8999-999999999999",
  project: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;

const now = "2026-08-01T21:00:00.000Z";
const later = "2026-08-01T21:01:00.000Z";
const canvasId = decodeCanvasId(ids.canvas);

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

const definition = {
  schemaVersion: CANVAS_SCHEMA_VERSION,
  title: "Quarterly summary",
  provenance,
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
} as const;

function version(overrides: Record<string, unknown> = {}) {
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

function reviseRequest(expectedSequence = 1) {
  return {
    schemaVersion: 1,
    kind: "canvas-revise",
    requestId: ids.request,
    canvasId: ids.canvas,
    expectedSequence,
    prompt: "Add a summary section",
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: null },
    originThreadId: ids.thread,
    actor: provenance.actor,
    providerInstanceId: ids.provider,
    modelId: "octant-revise-model",
    requestedAuthority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
  } as const;
}

describe("canvasRevisionPolicy", () => {
  it("admits a revise request and builds the next immutable version", () => {
    const current = version();
    const result = admitCanvasRevise({
      request: reviseRequest(),
      current,
      receiptId: ids.receipt,
      nextVersionId: ids.version2,
      now: later as never,
    });
    expect(result.next.sequence).toBe(2);
    expect(result.next.versionId).toBe(ids.version2);
    expect(result.receipt.outcome).toBe("ready");
    expect(result.next.definition.blocks.some((block) => block.kind === "callout")).toBe(true);
  });

  it("rejects implicit authority widening before admission", () => {
    expect(
      canvasReviseDenialReason({
        ...reviseRequest(),
        requestedAuthority: {
          ...reviseRequest().requestedAuthority,
          filesystem: true,
        },
      }),
    ).toBe("chat-implicit-authority");
  });

  it("rejects stale expected sequence during admission", () => {
    const current = version();
    try {
      admitCanvasRevise({
        request: reviseRequest(2),
        current,
        receiptId: ids.receipt,
        nextVersionId: ids.version2,
        now: later as never,
      });
      expect.fail("expected stale-version rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasRevisionPolicyRejected);
      if (error instanceof CanvasRevisionPolicyRejected) {
        expect(error.denialCode).toBe("stale-version");
      }
    }
  });

  it("clamps provenance to the owning thread while recording revision metadata", () => {
    const current = version();
    const clamped = clampRevisionProvenance({
      current: current.definition,
      actor: current.createdBy,
      providerInstanceId: current.definition.provenance.providerInstanceId,
      modelId: "octant-revise-model" as never,
      createdAt: later as never,
    });
    expect(clamped.provenance.threadId).toBe(ids.thread);
    expect(clamped.provenance.modelId).toBe("octant-revise-model");
    expect(clamped.provenance.createdAt).toBe(later);
  });

  it("applies deterministic prompt refinement as a bounded callout block", () => {
    const refined = applyPromptRefinement(version().definition, "Add a summary section");
    const callout = refined.blocks.find((block) => block.kind === "callout");
    expect(callout).toMatchObject({
      kind: "callout",
      title: "Revision",
      text: "Add a summary section",
    });
  });

  it("lists opaque version history without definition bodies", () => {
    const v1 = version();
    const v2 = buildRevisionVersion({
      canvasId,
      current: v1,
      nextVersionId: ids.version2 as never,
      prompt: "Add a summary section",
      actor: v1.createdBy,
      providerInstanceId: v1.definition.provenance.providerInstanceId,
      modelId: "octant-revise-model" as never,
      createdAt: later as never,
    });
    const history = listCanvasVersionHistory(
      canvasId,
      [v1, v2],
      new Map([[ids.version2, "Add a summary section"]]),
    );
    expect(history.entries).toHaveLength(2);
    expect(history.currentVersionId).toBe(ids.version2);
    expect(history.entries[1]?.promptSummary).toBe("Add a summary section");
    expect(projectVersionHistoryEntry(v2, "prompt")).toMatchObject({
      sequence: 2,
      title: "Quarterly summary",
    });
  });
});

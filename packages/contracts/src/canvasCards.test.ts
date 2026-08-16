import { describe, expect, it } from "vitest";
import {
  CANVAS_CARD_SCHEMA_VERSION,
  decodeCanvasCreateResult,
  decodeCanvasCreateReceipt,
  decodeCanvasCreateRequest,
  decodeCanvasThreadReferenceCard,
  type CanvasCardStatus,
} from "./canvasCards";

const uuids = {
  request: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  receipt: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  canvas: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  version: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  card: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
  project: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
  thread: "ffffffff-ffff-4fff-8fff-fffffffffff1",
  actor: "11111111-1111-4111-8111-111111111111",
  provider: "22222222-2222-4222-8222-222222222222",
  root: "33333333-3333-4333-8333-333333333333",
} as const;

const authority = {
  filesystem: false,
  shell: false,
  git: false,
  network: true,
  tools: true,
  subagents: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
} as const;

const scope = {
  hostId: "local",
  mode: "chat",
  workspace: { kind: "chat-virtual", projectId: uuids.project },
} as const;

const createRequest = {
  schemaVersion: CANVAS_CARD_SCHEMA_VERSION,
  kind: "canvas-create",
  requestId: uuids.request,
  intent: "prompt",
  hostId: "local",
  mode: "chat",
  workspace: { kind: "chat-virtual", projectId: uuids.project },
  originThreadId: uuids.thread,
  title: "Release overview",
  prompt: "Summarize the release in a bordered dashboard for the team.",
  sourceManifest: [],
  requestedAuthority: authority,
} as const;

const createReceipt = {
  schemaVersion: CANVAS_CARD_SCHEMA_VERSION,
  kind: "canvas-create-receipt",
  receiptId: uuids.receipt,
  requestId: uuids.request,
  canvasId: uuids.canvas,
  versionId: uuids.version,
  intent: "prompt",
  originThreadId: uuids.thread,
  scope,
  title: "Release overview",
  effectiveAuthority: authority,
  outcome: "ready" as CanvasCardStatus,
  createdAt: "2026-08-01T21:00:00.000Z",
} as const;

const referenceCard = {
  schemaVersion: CANVAS_CARD_SCHEMA_VERSION,
  kind: "canvas-reference-card",
  cardId: uuids.card,
  canvasId: uuids.canvas,
  versionId: uuids.version,
  title: "Release overview",
  scope,
  originThreadId: uuids.thread,
  status: "ready" as CanvasCardStatus,
  authority,
  actorId: uuids.actor,
  providerInstanceId: uuids.provider,
  modelId: "octant-test-model",
  createdAt: "2026-08-01T21:00:00.000Z",
  summary: "Release health at a glance.",
  actionCount: 0,
} as const;

describe("Canvas create request", () => {
  it("round-trips a prompt create request", () => {
    expect(decodeCanvasCreateRequest(createRequest)).toEqual(createRequest);
  });

  it("rejects an excess property", () => {
    expect(() => decodeCanvasCreateRequest({ ...createRequest, extra: true })).toThrow();
  });

  it("rejects a prompt intent without a prompt", () => {
    expect(() => decodeCanvasCreateRequest({ ...createRequest, prompt: undefined })).toThrow();
  });

  it("rejects a prompt present on a non-prompt intent", () => {
    expect(() => decodeCanvasCreateRequest({ ...createRequest, intent: "blank" })).toThrow();
  });

  it("rejects a template intent missing its template ID", () => {
    expect(() => decodeCanvasCreateRequest({ ...createRequest, intent: "template" })).toThrow();
  });

  it("rejects a mode that does not match its workspace kind", () => {
    expect(() =>
      decodeCanvasCreateRequest({
        ...createRequest,
        mode: "code",
        workspace: { kind: "chat-virtual", projectId: uuids.project },
      }),
    ).toThrow();
  });
});

describe("Canvas create receipt", () => {
  it("round-trips a create receipt", () => {
    expect(decodeCanvasCreateReceipt(createReceipt)).toEqual(createReceipt);
  });

  it("rejects an excess property", () => {
    expect(() => decodeCanvasCreateReceipt({ ...createReceipt, extra: true })).toThrow();
  });
});

describe("Canvas thread reference card", () => {
  it("round-trips a durable reference card", () => {
    expect(decodeCanvasThreadReferenceCard(referenceCard)).toEqual(referenceCard);
  });

  it("rejects an excess property", () => {
    expect(() => decodeCanvasThreadReferenceCard({ ...referenceCard, extra: true })).toThrow();
  });

  it("rejects a negative action count", () => {
    expect(() => decodeCanvasThreadReferenceCard({ ...referenceCard, actionCount: -1 })).toThrow();
  });
});

describe("Canvas create result", () => {
  it("round-trips an accepted receipt with its durable card", () => {
    expect(
      decodeCanvasCreateResult({
        kind: "accepted",
        receipt: createReceipt,
        card: referenceCard,
      }),
    ).toMatchObject({ kind: "accepted", card: { canvasId: uuids.canvas } });
  });

  it("accepts server authorization denials", () => {
    expect(
      decodeCanvasCreateResult({
        kind: "denied",
        denialCode: "unauthorized",
        message: "Canvas create is not authorized.",
      }),
    ).toMatchObject({ kind: "denied", denialCode: "unauthorized" });
  });
});

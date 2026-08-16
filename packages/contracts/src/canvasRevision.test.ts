import { describe, expect, it } from "vitest";
import {
  CANVAS_MAX_VERSION_HISTORY,
  CANVAS_REVISION_PROMPT_MAX_CHARS,
  decodeCanvasHistoryOutcome,
  decodeCanvasReviseReceipt,
  decodeCanvasReviseRequest,
  decodeCanvasReviseResult,
  decodeCanvasVersionHistory,
  decodeCanvasVersionHistoryEntry,
} from "./canvasRevision";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  version2: "33333333-3333-4333-8333-333333333333",
  request: "44444444-4444-4444-8444-444444444444",
  receipt: "55555555-5555-4555-8555-555555555555",
  thread: "66666666-6666-4666-8666-666666666666",
  provider: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
} as const;

const reviseRequest = {
  schemaVersion: 1,
  kind: "canvas-revise",
  requestId: ids.request,
  canvasId: ids.canvas,
  expectedSequence: 1,
  prompt: "Add a summary section",
  hostId: "local",
  mode: "chat",
  workspace: { kind: "chat-virtual", projectId: null },
  originThreadId: ids.thread,
  actor: { kind: "local-user", actorId: ids.actor },
  providerInstanceId: ids.provider,
  modelId: "octant-test-model",
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

const historyEntry = {
  versionId: ids.version,
  sequence: 1,
  schemaVersion: 1,
  title: "Quarterly summary",
  createdAt: "2026-08-01T21:00:00.000Z",
  createdBy: { kind: "local-user", actorId: ids.actor },
  providerInstanceId: ids.provider,
  modelId: "octant-test-model",
  promptSummary: "Initial prompt",
} as const;

describe("Canvas revision contracts", () => {
  it("round-trips a revise request with bounded prompt and provenance", () => {
    expect(decodeCanvasReviseRequest(reviseRequest)).toEqual(reviseRequest);
  });

  it("rejects excess fields and empty prompts on revise requests", () => {
    expect(() => decodeCanvasReviseRequest({ ...reviseRequest, secret: "x" })).toThrow();
    expect(() => decodeCanvasReviseRequest({ ...reviseRequest, prompt: "" })).toThrow();
    expect(() =>
      decodeCanvasReviseRequest({
        ...reviseRequest,
        prompt: "x".repeat(CANVAS_REVISION_PROMPT_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  it("round-trips revise receipts and discriminated results", () => {
    const receipt = {
      schemaVersion: 1,
      kind: "canvas-revise-receipt",
      receiptId: ids.receipt,
      requestId: ids.request,
      canvasId: ids.canvas,
      versionId: ids.version2,
      sequence: 2,
      outcome: "ready",
      createdAt: "2026-08-01T21:01:00.000Z",
    } as const;
    expect(decodeCanvasReviseReceipt(receipt)).toEqual(receipt);
    expect(decodeCanvasReviseResult({ kind: "accepted", receipt })).toEqual({
      kind: "accepted",
      receipt,
    });
    expect(
      decodeCanvasReviseResult({
        kind: "denied",
        denialCode: "stale-version",
        message: "Canvas head version changed.",
      }),
    ).toMatchObject({ kind: "denied", denialCode: "stale-version" });
  });

  it("round-trips opaque version history rows without definition bodies", () => {
    expect(decodeCanvasVersionHistoryEntry(historyEntry)).toEqual(historyEntry);
    const history = {
      canvasId: ids.canvas,
      currentVersionId: ids.version,
      entries: [historyEntry],
    } as const;
    expect(decodeCanvasVersionHistory(history)).toEqual(history);
    expect(decodeCanvasHistoryOutcome({ kind: "ready", history })).toMatchObject({ kind: "ready" });
    expect(
      decodeCanvasHistoryOutcome({
        kind: "unauthorized",
        canvasId: ids.canvas,
      }).kind,
    ).toBe("unauthorized");
  });

  it("keeps version history bounded at the contract boundary", () => {
    expect(() =>
      decodeCanvasVersionHistory({
        canvasId: ids.canvas,
        currentVersionId: ids.version,
        entries: Array.from({ length: CANVAS_MAX_VERSION_HISTORY + 1 }, (_, index) => ({
          ...historyEntry,
          versionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        })),
      }),
    ).toThrow();
  });

  it("rejects secret fields on history and receipt payloads", () => {
    expect(() =>
      decodeCanvasVersionHistoryEntry({ ...historyEntry, credential: "secret" }),
    ).toThrow();
    expect(() =>
      decodeCanvasReviseReceipt({
        schemaVersion: 1,
        kind: "canvas-revise-receipt",
        receiptId: ids.receipt,
        requestId: ids.request,
        canvasId: ids.canvas,
        versionId: ids.version2,
        sequence: 2,
        outcome: "ready",
        createdAt: "2026-08-01T21:01:00.000Z",
        password: "secret",
      }),
    ).toThrow();
  });
});

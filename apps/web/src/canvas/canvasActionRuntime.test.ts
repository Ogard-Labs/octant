import type {
  CanvasActionCancelRequest,
  CanvasActionRequest,
  CanvasActionRequestId,
  CanvasActionResult,
} from "@octant/contracts/canvas-actions";
import { decodeCanvasActionRequest } from "@octant/contracts/canvas-actions";
import { describe, expect, it, vi } from "vitest";
import {
  buildCanvasActionRequest,
  createCanvasActionRuntime,
  type CanvasActionRequestContext,
} from "./canvasActionRuntime";
import { openSourceActionFixture, proposeThreadActionFixture } from "./test-fixtures";

const ids = {
  canvas: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  request: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  thread: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  provider: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  project: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  actor: "ffffffff-ffff-4fff-8fff-ffffffffffff",
} as const;

function context(overrides: Partial<CanvasActionRequestContext> = {}): CanvasActionRequestContext {
  return {
    canvasId: ids.canvas as CanvasActionRequestContext["canvasId"],
    expectedSequence: 3,
    hostId: "local" as CanvasActionRequestContext["hostId"],
    mode: "chat",
    workspace: {
      kind: "chat-virtual",
      projectId: ids.project,
    } as unknown as CanvasActionRequestContext["workspace"],
    originThreadId: ids.thread as unknown as CanvasActionRequestContext["originThreadId"],
    actor: {
      kind: "local-user",
      actorId: ids.actor,
    } as unknown as CanvasActionRequestContext["actor"],
    providerInstanceId: ids.provider as unknown as CanvasActionRequestContext["providerInstanceId"],
    modelId: "octant-test-model" as unknown as CanvasActionRequestContext["modelId"],
    requestedAuthority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: false,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    } as unknown as CanvasActionRequestContext["requestedAuthority"],
    newRequestId: () => ids.request as CanvasActionRequestId,
    ...overrides,
  };
}

describe("buildCanvasActionRequest", () => {
  it("produces a contract-valid request for a read command", () => {
    const request = buildCanvasActionRequest(openSourceActionFixture, context());
    expect(() => decodeCanvasActionRequest(request)).not.toThrow();
    expect(request.approval.kind).toBe("not-required");
    expect(String(request.requestId)).toBe(ids.request);
  });

  it("defaults a thread proposal approval to pending, never approved", () => {
    const request = buildCanvasActionRequest(proposeThreadActionFixture, context());
    expect(request.approval.kind).toBe("pending");
  });
});

describe("createCanvasActionRuntime", () => {
  it("offers actions and dispatches through the client executeAction", async () => {
    const executeAction = vi.fn((_request: CanvasActionRequest) =>
      Promise.resolve({
        kind: "denied",
        denialCode: "unavailable",
        message: "x",
      } as CanvasActionResult),
    );
    const runtime = createCanvasActionRuntime({ executeAction }, context());
    expect(runtime.availability(openSourceActionFixture).state).toBe("available");
    await runtime.onExecute(openSourceActionFixture);
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it("fails closed to unavailable when the transport cannot execute actions", () => {
    const runtime = createCanvasActionRuntime({}, context());
    expect(runtime.availability(openSourceActionFixture).state).toBe("unavailable");
    expect(runtime.onCancel).toBeUndefined();
  });

  it("cancels with the request id from the matching execute", async () => {
    const executeAction = vi.fn((_request: CanvasActionRequest) =>
      Promise.resolve({
        kind: "denied",
        denialCode: "cancelled",
        message: "x",
      } as CanvasActionResult),
    );
    const cancelAction = vi.fn((_request: CanvasActionCancelRequest) =>
      Promise.resolve({
        kind: "denied",
        denialCode: "cancelled",
        message: "x",
      } as CanvasActionResult),
    );
    const runtime = createCanvasActionRuntime({ executeAction, cancelAction }, context());
    await runtime.onExecute(openSourceActionFixture);
    await runtime.onCancel?.(openSourceActionFixture);
    expect(cancelAction).toHaveBeenCalledTimes(1);
    const cancelRequest = cancelAction.mock.calls[0]![0];
    expect(String(cancelRequest.requestId)).toBe(ids.request);
    expect(String(cancelRequest.blockId)).toBe(String(openSourceActionFixture.blockId));
  });
});

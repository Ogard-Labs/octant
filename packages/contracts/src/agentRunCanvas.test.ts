import { describe, expect, it } from "vitest";
import {
  decodeAgentRunCanvasSnapshotRequest,
  decodeAgentRunCanvasSnapshotResult,
} from "./agentRunCanvas";

const parentThreadId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("AgentRunCanvasSnapshot", () => {
  it("accepts a parent-thread snapshot request", () => {
    expect(decodeAgentRunCanvasSnapshotRequest({ parentThreadId })).toEqual({ parentThreadId });
  });

  it("rejects extra snapshot request fields", () => {
    expect(() => decodeAgentRunCanvasSnapshotRequest({ parentThreadId, extra: true })).toThrow();
  });

  it("accepts an accepted snapshot with a Project to open", () => {
    const accepted = {
      kind: "accepted",
      canvasId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      title: "Design chat agent graph",
      originThreadId: parentThreadId,
      mode: "chat",
      projectId: "77777777-7777-4777-8777-777777777777",
    };
    expect(decodeAgentRunCanvasSnapshotResult(accepted)).toEqual(accepted);
  });

  it("accepts a denied snapshot with a reason", () => {
    const denied = { kind: "denied", message: "This thread has no agent runs to save." };
    expect(decodeAgentRunCanvasSnapshotResult(denied)).toEqual(denied);
  });
});

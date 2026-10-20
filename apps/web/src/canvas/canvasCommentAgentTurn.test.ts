import { describe, expect, it, vi } from "vitest";
import type { CanvasCommentThread } from "@octant/contracts/canvas-board";
import type { ThreadMessageQueueSnapshot } from "@octant/contracts";
import {
  canvasCommentAgentPrompt,
  canvasCommentAgentState,
  enqueueCanvasCommentTurn,
} from "./canvasCommentAgentTurn";
import { canvasFixture } from "./test-fixtures";

const author = {
  kind: "local-user" as const,
  actorId: "88888888-8888-4888-8888-888888888888" as never,
};
const thread: CanvasCommentThread = {
  comment: {
    commentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" as never,
    anchor: { kind: "node", blockId: "diagram-1" as never, nodeId: "b" as never },
    author,
    body: "Should Report be a queue?",
    createdAt: "2026-08-01T21:00:00.000Z" as never,
  },
  replies: [
    {
      replyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as never,
      commentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" as never,
      author,
      body: "Yes, a queue.",
      createdAt: "2026-08-01T21:05:00.000Z" as never,
    },
  ],
};
const canvasId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";

function version(sequence: number, by: "agent" | "local-user") {
  return {
    versionId: `${String(sequence).padStart(8, "0")}-0000-4000-8000-000000000000` as never,
    sequence,
    schemaVersion: 1 as never,
    title: "Board",
    createdAt: "2026-08-01T21:00:00.000Z" as never,
    createdBy: { kind: by, actorId: author.actorId },
    providerInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as never,
    modelId: "octant-test-model" as never,
  };
}

describe("canvasCommentAgentPrompt", () => {
  it("names the anchored node, its block, the comment, and its replies, and asks to change nothing else", () => {
    const prompt = canvasCommentAgentPrompt({
      definition: canvasFixture,
      canvasId,
      sequence: 3,
      thread,
      anchorLabel: "Board · Report",
    });
    expect(prompt).toContain(`canvasId ${canvasId}, version 3`);
    expect(prompt).toContain('Change only node "b" in the diagram block "diagram-1".');
    expect(prompt).toContain("Keep every other block identical, including block ids and order.");
    expect(prompt).toContain("Comment on Board · Report: Should Report be a queue?");
    expect(prompt).toContain("Reply: Yes, a queue.");
  });

  it("says when the anchored block has left the canvas rather than inventing its kind", () => {
    const prompt = canvasCommentAgentPrompt({
      definition: { ...canvasFixture, blocks: [] },
      canvasId,
      sequence: 1,
      thread,
      anchorLabel: "No longer on the canvas",
    });
    expect(prompt).toContain('block "diagram-1" (no longer on the canvas)');
  });
});

describe("canvasCommentAgentState", () => {
  it("is sent until an agent version lands after the one it was sent against", () => {
    const sent = {
      sentToAgent: { canvasSequence: 2, sentAt: "2026-08-01T21:00:00.000Z" as never },
    };
    expect(canvasCommentAgentState({}, [version(3, "agent")])).toEqual({ kind: "unsent" });
    expect(canvasCommentAgentState(sent, [version(2, "agent")])).toEqual({ kind: "sent" });
    // A person's own drag after the send does not answer the request.
    expect(canvasCommentAgentState(sent, [version(3, "local-user")])).toEqual({ kind: "sent" });
    expect(
      canvasCommentAgentState(sent, [
        version(3, "local-user"),
        version(5, "agent"),
        version(4, "agent"),
      ]),
    ).toEqual({ kind: "addressed", sequence: 4 });
  });
});

describe("enqueueCanvasCommentTurn", () => {
  const selection = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as never,
    canvasId: canvasId as never,
    versionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as never,
    sequence: 3,
    displayName: "Board",
    scope: "whole-canvas" as const,
  };
  const snapshot = (mode: "chat" | "work"): ThreadMessageQueueSnapshot => ({
    scope: { mode, threadId: threadId as never },
    version: 4 as never,
    paused: false,
    items: [],
  });

  it("queues the prompt with the Canvas attached on the thread's own queue and asks for no authority", async () => {
    const execute = vi.fn(async (command) => ({
      status: "applied" as const,
      requestId: command.requestId,
      snapshot: snapshot("chat"),
    }));
    const ids = ["f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1", "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2"];
    const outcome = await enqueueCanvasCommentTurn(
      { read: async () => snapshot("chat"), execute },
      { mode: "chat", threadId, prompt: "Change only node b", canvasSelection: selection },
      () => ids.shift() ?? "",
    );
    expect(outcome).toEqual({ status: "sent" });
    expect(execute).toHaveBeenCalledWith({
      kind: "enqueue",
      scope: { mode: "chat", threadId },
      expectedVersion: 4,
      requestId: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
      messageId: "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2",
      payload: { mode: "chat", prompt: "Change only node b", canvasSelections: [selection] },
    });
  });

  it("names the Canvas in the prompt alone for a Work thread, whose turn carries no Canvas selection", async () => {
    const execute = vi.fn(async (command) => ({
      status: "applied" as const,
      requestId: command.requestId,
      snapshot: snapshot("work"),
    }));
    await enqueueCanvasCommentTurn(
      { read: async () => snapshot("work"), execute },
      { mode: "work", threadId, prompt: "Change only node b", canvasSelection: selection },
    );
    expect(execute.mock.calls[0]?.[0].payload).toEqual({
      mode: "work",
      prompt: "Change only node b",
    });
  });

  it("reports a refused or unreachable queue instead of claiming the comment was sent", async () => {
    const refused = await enqueueCanvasCommentTurn(
      {
        read: async () => snapshot("chat"),
        execute: async (command) => ({
          status: "refused" as const,
          requestId: command.requestId,
          reason: "thread-unavailable" as const,
        }),
      },
      { mode: "chat", threadId, prompt: "Change", canvasSelection: selection },
    );
    expect(refused).toEqual({
      status: "refused",
      message: "The host refused the message: thread unavailable.",
    });
    const unreachable = await enqueueCanvasCommentTurn(
      {
        read: async () => {
          throw new Error("offline");
        },
        execute: vi.fn(),
      },
      { mode: "chat", threadId, prompt: "Change", canvasSelection: selection },
    );
    expect(unreachable.status).toBe("refused");
  });
});

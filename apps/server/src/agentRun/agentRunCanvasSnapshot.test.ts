import { describe, expect, it, vi } from "vitest";
import { decodeCanvasBlock } from "@octant/contracts/canvas";
import { createAgentRunForestCanvasSnapshot } from "./agentRunCanvasSnapshot";
import type { CanvasWorkspaceScope } from "@octant/contracts";

const ids = {
  thread: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  project: "77777777-7777-4777-8777-777777777777",
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  request: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

const diagram = [
  decodeCanvasBlock({
    blockId: "agent-run-forest",
    schemaVersion: 2,
    kind: "diagram",
    nodes: [{ nodeId: "thread-1", label: "Design chat", role: "thread" }],
    edges: [],
    flow: "down",
    layout: "auto",
  }),
];

const chatWorkspace: CanvasWorkspaceScope = { kind: "chat-virtual", projectId: null };
const workWorkspace: CanvasWorkspaceScope = {
  kind: "work-root",
  projectId: ids.project as never,
  rootId: "88888888-8888-4888-8888-888888888888" as never,
};

describe("createAgentRunForestCanvasSnapshot", () => {
  it("creates a Chat Canvas from the resolver workspace and the thread Project", () => {
    const createCanvas = vi.fn(() => ({
      kind: "accepted" as const,
      card: {
        canvasId: ids.canvas,
        versionId: ids.version,
        title: "Design chat agent graph",
        originThreadId: ids.thread,
        scope: { mode: "chat" as const, workspace: chatWorkspace },
      },
    }));
    const result = createAgentRunForestCanvasSnapshot({
      mode: "chat",
      parentThreadId: ids.thread,
      title: "Design chat agent graph",
      blocks: diagram,
      uuid: () => ids.request,
      resolveWorkspace: () => chatWorkspace,
      readProject: () => ({ id: ids.project, type: "chat", lifecycle: "active" }),
      readChatProjectId: () => ids.project,
      createCanvas,
    });
    expect(result).toEqual({
      kind: "accepted",
      canvasId: ids.canvas,
      versionId: ids.version,
      title: "Design chat agent graph",
      originThreadId: ids.thread,
      mode: "chat",
      projectId: ids.project,
    });
    expect(createCanvas).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: chatWorkspace }),
      expect.anything(),
      expect.anything(),
      diagram,
    );
  });

  it("does not invent a Work root and uses the resolver workspace", () => {
    const createCanvas = vi.fn(() => ({
      kind: "accepted" as const,
      card: {
        canvasId: ids.canvas,
        versionId: ids.version,
        title: "Implement auth agent graph",
        originThreadId: ids.thread,
        scope: { mode: "work" as const, workspace: workWorkspace },
      },
    }));
    const result = createAgentRunForestCanvasSnapshot({
      mode: "work",
      parentThreadId: ids.thread,
      title: "Implement auth agent graph",
      blocks: diagram,
      uuid: () => ids.request,
      resolveWorkspace: () => workWorkspace,
      readProject: () => ({ id: ids.project, type: "work", lifecycle: "active" }),
      readChatProjectId: () => {
        throw new Error("Chat project lookup is not used for Work");
      },
      createCanvas,
    });
    expect(result.kind).toBe("accepted");
    expect(createCanvas).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: workWorkspace }),
      expect.anything(),
      expect.anything(),
      diagram,
    );
  });

  it("denies a Chat thread that has no Project", () => {
    const createCanvas = vi.fn();
    const result = createAgentRunForestCanvasSnapshot({
      mode: "chat",
      parentThreadId: ids.thread,
      title: "Design chat agent graph",
      blocks: diagram,
      uuid: () => ids.request,
      resolveWorkspace: () => chatWorkspace,
      readProject: () => undefined,
      readChatProjectId: () => undefined,
      createCanvas,
    });
    expect(result).toEqual({
      kind: "denied",
      message: "The thread's Project is unavailable.",
    });
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it("denies when the workspace resolver cannot bind the thread", () => {
    const result = createAgentRunForestCanvasSnapshot({
      mode: "code",
      parentThreadId: ids.thread,
      title: "Implement auth agent graph",
      blocks: diagram,
      uuid: () => ids.request,
      resolveWorkspace: () => undefined,
      readProject: () => ({ id: ids.project, type: "code", lifecycle: "active" }),
      readChatProjectId: () => undefined,
      createCanvas: vi.fn(),
    });
    expect(result).toEqual({
      kind: "denied",
      message: "The thread's workspace is unavailable.",
    });
  });
});

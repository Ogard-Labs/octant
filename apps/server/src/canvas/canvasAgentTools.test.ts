import { describe, expect, it, vi } from "vitest";
import { CANVAS_TOOL_NAME, createCanvasAgentTools } from "./canvasAgentTools";

const windowId = "11111111-1111-4111-8111-111111111111" as never;
const projectId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const thread = {
  id: threadId,
  projectId,
  providerInstanceId: "44444444-4444-4444-8444-444444444444",
  modelId: "octant-test-model",
} as never;

const diagram = {
  blockId: "authored-diagram",
  schemaVersion: 1,
  kind: "diagram",
  nodes: [
    { nodeId: "renderer", label: "Renderer" },
    { nodeId: "server", label: "Server" },
  ],
  edges: [{ edgeId: "commands", source: "renderer", target: "server" }],
  groups: [{ groupId: "host", label: "Host", nodeIds: ["server"] }],
};

function tools(overrides: Record<string, unknown> = {}) {
  const create = vi.fn((..._args: ReadonlyArray<unknown>) => ({
    kind: "accepted" as const,
    card: { canvasId: "canvas-1", versionId: "version-1" },
  }));
  const revise = vi.fn((..._args: ReadonlyArray<unknown>) => ({
    kind: "accepted" as const,
    receipt: { versionId: "version-2", sequence: 2 },
  }));
  const port = {
    activeContext: vi.fn(() => ({ mode: "chat", projectId })),
    project: vi.fn(async () => ({ id: projectId, type: "chat", lifecycle: "active" })),
    canvas: { create, revise },
    uuid: vi.fn(() => "55555555-5555-4555-8555-555555555555"),
    hostId: "66666666-6666-4666-8666-666666666666",
    ...overrides,
  } as never;
  return { create, revise, port, set: createCanvasAgentTools({ windowId, thread, port }) };
}

describe("createCanvasAgentTools", () => {
  it("offers one tool for authoring a Canvas", () => {
    expect(tools().set.definitions.map((definition) => definition.name)).toEqual([
      CANVAS_TOOL_NAME,
    ]);
  });

  it("writes an authored document into a Canvas the host opens for the thread", async () => {
    const { create, set } = tools();

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        title: "How the host is put together",
        prompt: "Draw how the host is put together.",
        blocks: [diagram],
      }),
    });

    expect(outcome.isError).toBeUndefined();
    const call = create.mock.calls[0];
    const request = call?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      kind: "canvas-create",
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId },
      originThreadId: threadId,
      title: "How the host is put together",
    });
    // A drawing reads nothing and runs nothing, so it asks for nothing.
    expect(request["requestedAuthority"]).toMatchObject({
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: false,
      subagents: false,
    });
    expect(call?.[3]).toHaveLength(1);
  });

  it("refuses a block the closed catalog does not contain, naming which one", async () => {
    const { create, set } = tools();

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        blocks: [diagram, { blockId: "x", schemaVersion: 1, kind: "raw-html", html: "<script>" }],
      }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(JSON.stringify(outcome.result)).toContain("Block 2");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to author into a window with no Chat Project to hold the Canvas", async () => {
    const { create, set } = tools({
      activeContext: vi.fn(() => ({ mode: "chat", projectId: null })),
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", blocks: [diagram] }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to author into a Project that is not this window's own mode", async () => {
    const { create, set } = tools({
      project: vi.fn(async () => ({ id: projectId, type: "code", lifecycle: "active" })),
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", blocks: [diagram] }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("revises the version the author says it read, not whatever is current", async () => {
    const { revise, set } = tools();

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "revise",
        canvasId: "77777777-7777-4777-8777-777777777777",
        expectedSequence: 1,
        blocks: [diagram],
      }),
    });

    expect(outcome.isError).toBeUndefined();
    const call = revise.mock.calls[0];
    expect(call?.[0]).toMatchObject({ kind: "canvas-revise", expectedSequence: 1 });
    expect(call?.[3]).toHaveLength(1);
  });

  it("refuses a revision that does not say which version it read", async () => {
    const { revise, set } = tools();

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "revise",
        canvasId: "77777777-7777-4777-8777-777777777777",
        blocks: [diagram],
      }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(revise).not.toHaveBeenCalled();
  });

  it("reports a refusal from the Canvas service rather than a silent success", async () => {
    const { set } = tools({
      canvas: {
        create: vi.fn(() => ({
          kind: "denied" as const,
          denialCode: "unauthorized",
          message: "Canvas create is not authorized in this workspace.",
        })),
        revise: vi.fn(),
      },
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", blocks: [diagram] }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(JSON.stringify(outcome.result)).toContain("not authorized");
  });

  it("refuses an authoring call carrying no blocks at all", async () => {
    const { create, set } = tools();

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", blocks: [] }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(create).not.toHaveBeenCalled();
  });
});

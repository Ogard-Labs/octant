import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeCanvasBlock } from "@octant/contracts";
import { createManagedMcpTools } from "../providers/managedMcpTools";
import { CANVAS_TOOL_NAME, createCanvasAgentTools } from "./canvasAgentTools";

const windowId = "11111111-1111-4111-8111-111111111111" as never;
const projectId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const providerInstanceId = "44444444-4444-4444-8444-444444444444" as never;
const modelId = "octant-test-model" as never;
const canvasId = "77777777-7777-4777-8777-777777777777";

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

const readCanvasStub = {
  title: "Report",
  sequence: 2,
  blocks: [
    {
      blockId: "summary",
      schemaVersion: 1,
      kind: "rich-text",
      text: "The report goes here.",
    },
  ],
  mode: "chat",
  projectId,
};

function tools(
  overrides: {
    readonly port?: Record<string, unknown>;
    readonly options?: Record<string, unknown>;
  } = {},
) {
  const create = vi.fn((..._args: ReadonlyArray<unknown>) => ({
    kind: "accepted" as const,
    card: { canvasId: "canvas-1", versionId: "version-1" },
  }));
  const revise = vi.fn((..._args: ReadonlyArray<unknown>) => ({
    kind: "accepted" as const,
    receipt: { versionId: "version-2", sequence: 2 },
  }));
  const openSurface = vi.fn(() => ({ kind: "opened" as const }));
  const port = {
    workspace: vi.fn(() => ({ kind: "chat-virtual", projectId })),
    project: vi.fn(async () => ({ id: projectId, type: "chat", lifecycle: "active" })),
    listCanvases: vi.fn(() => [{ canvasId, title: "Report", sequence: 2 }]),
    readCanvas: vi.fn(() => readCanvasStub),
    openSurface,
    canvas: { create, revise },
    uuid: vi.fn(() => "55555555-5555-4555-8555-555555555555"),
    hostId: "66666666-6666-4666-8666-666666666666",
    ...overrides.port,
  } as never;
  const set = createCanvasAgentTools({
    windowId,
    mode: "chat",
    threadId: threadId as never,
    providerInstanceId,
    modelId,
    allowOpen: true,
    port,
    ...overrides.options,
  });
  return { create, revise, openSurface, port, set };
}

describe("createCanvasAgentTools", () => {
  it("offers one tool for authoring a Canvas", () => {
    expect(tools().set.definitions.map((definition) => definition.name)).toEqual([
      CANVAS_TOOL_NAME,
    ]);
  });

  it("lets an MCP agent discover the Canvas workflow and author the supplied example", async () => {
    const { create, set } = tools();
    const server = createManagedMcpTools(set.definitions, async (name, inputJson) => {
      const answer = await set.execute({ name, inputJson });
      return { resultJson: JSON.stringify(answer.result), isError: answer.isError === true };
    });
    if (server.kind !== "ready") throw new Error("Canvas tools must form a valid catalogue.");
    const client = new Client({ name: "canvas-agent", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const catalogue = await client.listTools();
      expect(catalogue.tools).toEqual(set.definitions);
      expect(catalogue.tools[0]?.description).toContain("describe");
      expect(catalogue.tools.map((tool) => tool.name)).not.toContain("octant_browser");
      const described = await client.callTool({
        name: CANVAS_TOOL_NAME,
        arguments: { operation: "describe" },
      });
      const content = described.content;
      if (!Array.isArray(content) || content[0]?.type !== "text")
        throw new Error("Expected JSON tool documentation.");
      const guidance = JSON.parse(content[0].text);
      const block = decodeCanvasBlock(guidance.example.blocks[0]);
      expect(block.kind).toBe("rich-text");
      const created = await client.callTool({
        name: CANVAS_TOOL_NAME,
        arguments: guidance.example,
      });
      expect(created.isError).toBe(false);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Report" }),
        expect.anything(),
        expect.anything(),
        [block],
      );
    } finally {
      await client.close();
      await server.server.close();
    }
  });

  it("explains the operations a Canvas supports, including plans and reviews", async () => {
    const { create, revise, set } = tools({
      port: {
        workspace: () => {
          throw new Error("Schema discovery must not read thread state.");
        },
      },
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe" }),
    });

    expect(outcome.isError).not.toBe(true);
    expect(outcome.result).toMatchObject({
      operations: ["describe", "list", "read", "create", "revise", "open"],
      blockKinds: expect.arrayContaining(["rich-text", "diagram", "table", "chart"]),
      example: {
        operation: "create",
        blocks: [{ blockId: "summary", kind: "rich-text", text: "The report goes here." }],
      },
    });
    const description = set.definitions[0]?.description ?? "";
    expect(description).toContain("plan");
    expect(description).toContain("review");
    expect(description).toContain("open");
    expect(create).not.toHaveBeenCalled();
    expect(revise).not.toHaveBeenCalled();
  });

  it("discloses only the requested block schemas, including the fields needed to draw a diagram", async () => {
    const { create, set } = tools();
    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["diagram"] }),
    });

    expect(outcome.isError).not.toBe(true);
    expect(outcome.result).toMatchObject({
      blockSchema: {
        type: "object",
        properties: {
          kind: { enum: ["diagram"] },
          nodes: { type: "array" },
          edges: { type: "array" },
        },
        required: expect.arrayContaining(["blockId", "schemaVersion", "kind", "nodes", "edges"]),
      },
    });
    expect(JSON.stringify(outcome.result)).not.toContain("chartType");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { blockKinds: [] },
    { blockKinds: ["raw-html"] },
    { blockKinds: [42] },
    { blockKinds: "diagram" },
    { blockKinds: ["diagram", "table", "chart", "heading"] },
  ])(
    "refuses invalid block schema requests without authoring a document: $blockKinds",
    async ({ blockKinds }) => {
      const { create, revise, set } = tools();
      const outcome = await set.execute({
        name: CANVAS_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "describe", blockKinds }),
      });
      expect(outcome.isError).toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(revise).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    {
      mode: "work" as const,
      workspace: {
        kind: "work-root" as const,
        projectId,
        rootId: "88888888-8888-4888-8888-888888888888",
      },
    },
    {
      mode: "code" as const,
      workspace: {
        kind: "code-worktree" as const,
        projectId,
        repositoryId: "repo_123",
        bindingRevisionId: "88888888-8888-4888-8888-888888888888",
        checkoutId: "99999999-9999-4999-9999-999999999999",
        verified: true,
      },
    },
  ])("binds a $mode thread's Canvas to its own scoped workspace", async ({ mode, workspace }) => {
    const { create, set } = tools({
      options: { mode },
      port: {
        workspace: vi.fn(() => workspace),
        project: vi.fn(async () => ({ id: projectId, type: mode, lifecycle: "active" })),
      },
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Plan", blocks: [diagram] }),
    });

    expect(outcome.isError).toBeUndefined();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      kind: "canvas-create",
      mode,
      workspace,
      originThreadId: threadId,
    });
  });

  it("refuses to author when the thread has no bounded workspace", async () => {
    const { create, set } = tools({
      port: { workspace: vi.fn(() => undefined) },
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", blocks: [diagram] }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to author into a Project that is not this thread's own mode", async () => {
    const { create, set } = tools({
      port: {
        project: vi.fn(async () => ({ id: projectId, type: "code", lifecycle: "active" })),
      },
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", blocks: [diagram] }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("lists the Canvases already inside the thread's Project with their sequences", async () => {
    const { set } = tools();

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "list" }),
    });

    expect(outcome.isError).toBeUndefined();
    expect(outcome.result).toMatchObject({
      canvases: [{ canvasId, title: "Report", sequence: 2 }],
    });
  });

  it("reads a Canvas's current blocks and sequence before revising it", async () => {
    const { set } = tools();

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read", canvasId }),
    });

    expect(outcome.isError).toBeUndefined();
    expect(outcome.result).toMatchObject({ canvasId, title: "Report", sequence: 2 });
  });

  it("refuses to read a Canvas outside the thread's workspace", async () => {
    const { set } = tools({
      port: { readCanvas: vi.fn(() => ({ ...readCanvasStub, projectId: "other-project" })) },
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read", canvasId }),
    });

    expect(outcome).toMatchObject({ isError: true });
  });

  it("opens an in-scope Canvas through the window's surface operation", async () => {
    const { openSurface, set } = tools();

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "open", canvasId }),
    });

    expect(outcome.isError).toBeUndefined();
    expect(outcome.result).toMatchObject({ canvasId, opened: true });
    expect(openSurface).toHaveBeenCalledWith(
      expect.objectContaining({ windowId, mode: "chat", canvasId, projectId }),
    );
  });

  it("refuses to open a Canvas that belongs to another workspace", async () => {
    const { openSurface, set } = tools({
      port: { readCanvas: vi.fn(() => ({ ...readCanvasStub, mode: "work" })) },
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "open", canvasId }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(openSurface).not.toHaveBeenCalled();
  });

  it("a delegated run cannot open a surface it does not own", async () => {
    const { openSurface, set } = tools({
      options: { windowId: undefined, allowOpen: false },
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "open", canvasId }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(openSurface).not.toHaveBeenCalled();
  });

  it("revises the version the author says it read, not whatever is current", async () => {
    const { revise, set } = tools();

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "revise",
        canvasId,
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
        canvasId,
        blocks: [diagram],
      }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(revise).not.toHaveBeenCalled();
  });

  it("refuses to revise a Canvas outside the thread's workspace", async () => {
    const { revise, set } = tools({
      port: { readCanvas: vi.fn(() => ({ ...readCanvasStub, mode: "code" })) },
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "revise",
        canvasId,
        expectedSequence: 1,
        blocks: [diagram],
      }),
    });

    expect(outcome).toMatchObject({ isError: true });
    expect(revise).not.toHaveBeenCalled();
  });

  it("reports a refusal from the Canvas service rather than a silent success", async () => {
    const { set } = tools({
      port: {
        canvas: {
          create: vi.fn(() => ({
            kind: "denied" as const,
            denialCode: "unauthorized",
            message: "Canvas create is not authorized in this workspace.",
          })),
          revise: vi.fn(),
        },
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

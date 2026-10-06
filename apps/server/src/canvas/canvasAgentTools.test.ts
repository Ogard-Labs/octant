import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeCanvasBlock } from "@octant/contracts";
import { createManagedMcpTools } from "../providers/managedMcpTools";
import {
  CANVAS_TOOL_NAME,
  createCanvasAgentTools,
  createChildCanvasAgentTools,
} from "./canvasAgentTools";
import { inTreeCanvasDocumentRecipes } from "./canvasDocumentRecipes";

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

  it("explains how to create and present a Canvas without reading a Project or creating a document", async () => {
    const { create, revise, set } = tools({
      activeContext: () => {
        throw new Error("Schema discovery must not read window state.");
      },
    });

    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe" }),
    });

    expect(outcome.isError).not.toBe(true);
    expect(outcome.result).toMatchObject({
      blockKinds: expect.arrayContaining(["rich-text", "diagram", "table", "chart"]),
      example: {
        operation: "create",
        blocks: [{ blockId: "summary", kind: "rich-text", text: "The report goes here." }],
      },
    });
    expect(set.definitions[0]?.description).toContain("Open Canvas");
    expect(create).not.toHaveBeenCalled();
    expect(revise).not.toHaveBeenCalled();
  });

  it("lists document recipes and maps common requests to one", async () => {
    const { create, set } = tools({
      activeContext: () => {
        throw new Error("Recipe listing must not read window state.");
      },
    });
    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe" }),
    });

    expect(outcome.isError).not.toBe(true);
    expect(outcome.result).toMatchObject({
      recipes: inTreeCanvasDocumentRecipes().map((recipe) => ({
        id: String(recipe.id),
        title: recipe.title,
        whenToUse: recipe.whenToUse,
        skeleton: recipe.skeleton.map((block) => ({ kind: block.kind, role: block.role })),
      })),
    });
    const description = set.definitions[0]?.description ?? "";
    expect(description).toContain('"write a plan" uses implementation-plan');
    expect(description).toContain('"review this PR" uses code-review');
    expect(description).toContain('"summarise research" uses research-brief');
    const recipes = (
      outcome.result as {
        recipes: ReadonlyArray<{ skeleton: ReadonlyArray<{ kind: string }> }>;
      }
    ).recipes;
    expect(recipes.some((recipe) => recipe.skeleton.some((block) => block.kind === "mockup"))).toBe(
      false,
    );
    expect(create).not.toHaveBeenCalled();
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

  it("discloses the plan block's phases, tasks, and statuses to an agent that asks for it", async () => {
    const { set } = tools();
    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["plan"] }),
    });

    expect(outcome.isError).not.toBe(true);
    expect(outcome.result).toMatchObject({
      blockSchema: {
        properties: {
          kind: { enum: ["plan"] },
          phases: { type: "array" },
          tasks: { type: "array" },
        },
      },
    });
    expect(JSON.stringify(outcome.result)).toContain("blocked");
  });

  it("lets an agent create a login sequence and an order state machine from the examples describe returns", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["sequence", "state"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
    };
    const examples = result.examples ?? [];
    expect(examples.map((example) => example.kind)).toEqual(["sequence", "state"]);
    const blocks = examples.map((example) => decodeCanvasBlock(example));
    expect(blocks[0]).toMatchObject({
      kind: "sequence",
      participants: expect.arrayContaining([expect.objectContaining({ label: "Person" })]),
      messages: expect.arrayContaining([expect.objectContaining({ label: "Submit credentials" })]),
    });
    expect(blocks[1]).toMatchObject({
      kind: "state",
      states: expect.arrayContaining([
        expect.objectContaining({ label: "Paid" }),
        expect.objectContaining({ label: "Closed", role: "final" }),
        expect.objectContaining({ label: "Authorized", parentId: "paid" }),
      ]),
      transitions: expect.arrayContaining([expect.objectContaining({ label: "pay" })]),
    });

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        title: "Checkout",
        blocks: examples,
      }),
    });

    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Checkout" }),
      expect.anything(),
      expect.anything(),
      blocks,
    );
  });

  it("lets an agent create a pie, a donut, stacked and grouped bars, and a bar and line chart from the examples describe returns", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["chart"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
      blockSchema?: { properties?: { chartType?: { enum?: ReadonlyArray<string> } } };
    };
    const examples = result.examples ?? [];
    expect(examples.map((example) => example.chartType)).toEqual([
      "pie",
      "donut",
      "stacked-bar",
      "grouped-bar",
      "bar-line",
    ]);
    expect(result.blockSchema?.properties?.chartType?.enum).toEqual(
      expect.arrayContaining(["pie", "donut", "stacked-bar", "grouped-bar", "bar-line"]),
    );
    expect(JSON.stringify(described.result)).not.toContain("heatmap");
    expect(JSON.stringify(described.result)).not.toContain("sankey");
    const blocks = examples.map((example) => decodeCanvasBlock(example));
    expect(blocks.every((block) => block.kind === "chart")).toBe(true);

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        title: "Quarterly mix",
        blocks: examples,
      }),
    });

    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Quarterly mix" }),
      expect.anything(),
      expect.anything(),
      blocks,
    );

    const refused = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        title: "Broken pie",
        blocks: [
          {
            blockId: "two-pies",
            schemaVersion: 1,
            kind: "chart",
            chartType: "pie",
            series: [
              { seriesId: "a", label: "A", points: [{ x: "Product", y: 1 }] },
              { seriesId: "b", label: "B", points: [{ x: "Services", y: 1 }] },
            ],
          },
        ],
      }),
    });
    expect(refused.isError).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("lets an agent create a repository map from the treemap example describe returns", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["treemap"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
      blockSchema?: {
        properties?: { colorScale?: { anyOf?: ReadonlyArray<{ const?: string }> } };
      };
    };
    const examples = result.examples ?? [];
    expect(examples.map((example) => example.blockId)).toContain("repository-map");
    const blocks = examples.map((example) => decodeCanvasBlock(example));
    expect(blocks.every((block) => block.kind === "treemap")).toBe(true);

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        title: "Repository map",
        blocks: examples,
      }),
    });

    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Repository map" }),
      expect.anything(),
      expect.anything(),
      blocks,
    );

    const repositoryMap = examples.find((example) => example.blockId === "repository-map");
    expect(repositoryMap).toMatchObject({
      kind: "treemap",
      sizeBy: "loc",
      colorBy: "edits60",
      colorScale: "sequential",
    });
  });

  it("lets an agent create and then revise a settings screen mockup from the example describe returns", async () => {
    const { create, revise, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["mockup"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
    };
    const example = result.examples?.[0];
    expect(example).toMatchObject({
      kind: "mockup",
      device: "desktop",
      title: "Settings",
    });
    const block = decodeCanvasBlock(example);
    expect(block.kind).toBe("mockup");
    if (block.kind !== "mockup") throw new Error("Settings example is not a mockup.");

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        title: "Settings",
        blocks: [example],
      }),
    });
    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Settings" }),
      expect.anything(),
      expect.anything(),
      [block],
    );

    const revisedBlock = {
      ...example,
      device: "phone",
      nodes: [
        ...block.nodes,
        {
          nodeId: "portrait",
          component: "image-placeholder",
          label: "Avatar",
          parentId: "profile",
        },
      ],
    };
    const revised = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "revise",
        canvasId: "canvas-1",
        expectedSequence: 1,
        title: "Settings",
        blocks: [revisedBlock],
      }),
    });
    expect(revised.isError).not.toBe(true);
    expect(revise).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId: "canvas-1", expectedSequence: 1 }),
      expect.anything(),
      expect.anything(),
      [expect.objectContaining({ kind: "mockup", device: "phone" })],
    );
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

  describe("in a Work or Code thread", () => {
    const workspaces = {
      work: { kind: "work-root", projectId, rootId: "77777777-7777-4777-8777-777777777777" },
      code: {
        kind: "code-worktree",
        projectId,
        repositoryId: "88888888-8888-4888-8888-888888888888",
        worktreeId: "99999999-9999-4999-8999-999999999999",
      },
    } as const;

    function boundTools(mode: "work" | "code", overrides: Record<string, unknown> = {}) {
      const create = vi.fn((..._args: ReadonlyArray<unknown>) => ({
        kind: "accepted" as const,
        card: { canvasId: "canvas-1", versionId: "version-1" },
      }));
      const revise = vi.fn((..._args: ReadonlyArray<unknown>) => ({
        kind: "accepted" as const,
        receipt: { versionId: "version-2", sequence: 2 },
      }));
      const resolveWorkspace = vi.fn(() => workspaces[mode]);
      const port = {
        activeContext: vi.fn(() => {
          throw new Error("A Work or Code Canvas must not follow the window's active mode.");
        }),
        project: vi.fn(async () => ({ id: projectId, type: mode, lifecycle: "active" })),
        canvas: { create, revise },
        uuid: vi.fn(() => "55555555-5555-4555-8555-555555555555"),
        hostId: "66666666-6666-4666-8666-666666666666",
        resolveWorkspace,
        ...overrides,
      } as never;
      return {
        create,
        revise,
        resolveWorkspace,
        set: createCanvasAgentTools({ windowId, mode, thread, port }),
      };
    }

    for (const mode of ["work", "code"] as const) {
      it(`creates a ${mode} Canvas bound to the workspace the host resolves for the thread`, async () => {
        const { create, resolveWorkspace, set } = boundTools(mode);
        const outcome = await set.execute({
          name: CANVAS_TOOL_NAME,
          inputJson: JSON.stringify({ operation: "create", title: "Plan", blocks: [diagram] }),
        });

        expect(outcome.isError).not.toBe(true);
        expect(resolveWorkspace).toHaveBeenCalledWith({ mode, threadId });
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({ mode, workspace: workspaces[mode], originThreadId: threadId }),
          { mode, projectId, workspace: workspaces[mode], originThreadId: threadId },
          { id: projectId, type: mode, lifecycle: "active" },
          [expect.objectContaining({ kind: "diagram" })],
        );
      });

      it(`revises a ${mode} Canvas within the same resolved workspace`, async () => {
        const { revise, set } = boundTools(mode);
        const outcome = await set.execute({
          name: CANVAS_TOOL_NAME,
          inputJson: JSON.stringify({
            operation: "revise",
            canvasId: "canvas-1",
            expectedSequence: 1,
            blocks: [diagram],
          }),
        });

        expect(outcome.isError).not.toBe(true);
        expect(revise).toHaveBeenCalledWith(
          expect.objectContaining({ mode, workspace: workspaces[mode], originThreadId: threadId }),
          expect.objectContaining({ mode, workspace: workspaces[mode] }),
          expect.objectContaining({ type: mode }),
          expect.anything(),
        );
      });
    }

    it("refuses a Code thread whose checkout the host cannot resolve", async () => {
      const { create, set } = boundTools("code", { resolveWorkspace: vi.fn(() => undefined) });
      const outcome = await set.execute({
        name: CANVAS_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "create", blocks: [diagram] }),
      });

      expect(outcome.isError).toBe(true);
      expect(outcome.result).toEqual({
        error: "This Code thread's workspace is unavailable, so no Canvas can be bound to it.",
      });
      expect(create).not.toHaveBeenCalled();
    });

    it("refuses a workspace that belongs to another Project than the thread", async () => {
      const { create, set } = boundTools("work", {
        resolveWorkspace: vi.fn(() => ({
          ...workspaces.work,
          projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        })),
      });
      const outcome = await set.execute({
        name: CANVAS_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "create", blocks: [diagram] }),
      });

      expect(outcome.isError).toBe(true);
      expect(create).not.toHaveBeenCalled();
    });

    it("refuses a thread whose Project is not of the thread's own mode", async () => {
      const { create, set } = boundTools("work", {
        project: vi.fn(async () => ({ id: projectId, type: "code", lifecycle: "active" })),
      });
      const outcome = await set.execute({
        name: CANVAS_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "create", blocks: [diagram] }),
      });

      expect(outcome.isError).toBe(true);
      expect(outcome.result).toEqual({ error: "The Canvas Project is unavailable." });
      expect(create).not.toHaveBeenCalled();
    });

    it("tells the agent to deliver substantial work as a Canvas bound to the thread's checkout", () => {
      const description = boundTools("code").set.definitions[0]?.description ?? "";
      expect(description).toContain("deliver it as a Canvas rather than as a long reply");
      expect(description).toContain("design or mockup, diagram, report, review, audit");
      expect(description).toContain("Keep short answers");
      expect(description).toContain("Text renders as plain text, not Markdown");
      expect(description).toContain(
        "revise the thread's existing Canvas instead of creating another",
      );
      expect(description).toContain("this Code thread's checkout");
      expect(description).toContain("grants no file, shell, Git, or network access");
    });

    it("lists the thread's Canvases with the sequence a revision must name", async () => {
      const threadReferenceCards = vi.fn(() => [{ canvasId: "canvas-1", title: "Plan" }]);
      const get = vi.fn(() => ({
        kind: "ready" as const,
        version: { sequence: 3, definition: { title: "Plan", blocks: [diagram] } },
      }));
      const { set } = boundTools("work", {
        canvas: { create: vi.fn(), revise: vi.fn(), threadReferenceCards, get },
      });
      const outcome = await set.execute({
        name: CANVAS_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "list" }),
      });

      expect(outcome.isError).not.toBe(true);
      expect(outcome.result).toEqual({
        canvases: [{ canvasId: "canvas-1", title: "Plan", sequence: 3 }],
      });
      expect(threadReferenceCards).toHaveBeenCalledWith({ mode: "work", threadId, projectId });
      expect(get).toHaveBeenCalledWith(
        "canvas-1",
        expect.objectContaining({ mode: "work", workspace: workspaces.work }),
        expect.objectContaining({ type: "work" }),
      );
    });

    it("reads a Canvas's current blocks so a follow-up can revise it in place", async () => {
      const get = vi.fn(() => ({
        kind: "ready" as const,
        version: { sequence: 2, definition: { title: "Plan", blocks: [diagram] } },
      }));
      const { set } = boundTools("code", {
        canvas: { create: vi.fn(), revise: vi.fn(), threadReferenceCards: vi.fn(), get },
      });
      const canvasId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const outcome = await set.execute({
        name: CANVAS_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "read", canvasId }),
      });

      expect(outcome.result).toEqual({ canvasId, title: "Plan", sequence: 2, blocks: [diagram] });
    });

    it("refuses to read a Canvas the thread's scope does not authorize", async () => {
      const get = vi.fn(() => ({ kind: "unauthorized" as const, canvasId: "x" }));
      const { set } = boundTools("code", {
        canvas: { create: vi.fn(), revise: vi.fn(), threadReferenceCards: vi.fn(), get },
      });
      const outcome = await set.execute({
        name: CANVAS_TOOL_NAME,
        inputJson: JSON.stringify({
          operation: "read",
          canvasId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      });

      expect(outcome.isError).toBe(true);
      expect(outcome.result).toEqual({ error: "That Canvas is unavailable." });
    });
  });
});

describe("a managed child's Canvas tool", () => {
  const runId = "12121212-1212-4121-8121-121212121212";
  const parentThreadId = threadId;
  const workspace = {
    kind: "work-root" as const,
    projectId,
    rootId: "77777777-7777-4777-8777-777777777777",
  };

  function childTools(
    resolution: {
      readonly status: "ready" | "refused";
      readonly reason?: "unresolved" | "foreign-project";
      readonly binding?: {
        readonly mode: "work";
        readonly projectId: string;
        readonly workspace: typeof workspace;
        readonly project: {
          readonly id: string;
          readonly type: "work";
          readonly lifecycle: "active";
        };
      };
    } = {
      status: "ready",
      binding: {
        mode: "work",
        projectId,
        workspace,
        project: { id: projectId, type: "work", lifecycle: "active" },
      },
    },
  ) {
    const create = vi.fn((..._args: ReadonlyArray<unknown>) => ({
      kind: "accepted" as const,
      card: { canvasId: "canvas-1", versionId: "version-1" },
    }));
    const revise = vi.fn((..._args: ReadonlyArray<unknown>) => ({
      kind: "accepted" as const,
      receipt: { versionId: "version-2", sequence: 2 },
    }));
    const resolveChildWorkspace = vi.fn(() => resolution);
    const port = {
      activeContext: vi.fn(() => {
        throw new Error("A child Canvas must not follow the window.");
      }),
      project: vi.fn(async () => {
        throw new Error("A child Canvas must not ask the window for a Project.");
      }),
      canvas: { create, revise, threadReferenceCards: vi.fn(() => []), get: vi.fn() },
      uuid: vi.fn(() => "55555555-5555-4555-8555-555555555555"),
      hostId: "66666666-6666-4666-8666-666666666666",
      resolveChildWorkspace,
    } as never;
    return {
      create,
      revise,
      resolveChildWorkspace,
      set: createChildCanvasAgentTools({
        port,
        run: {
          id: runId,
          parentThreadId,
          mode: "work",
          projectId,
          providerInstanceId: "44444444-4444-4444-8444-444444444444" as never,
          modelId: "octant-test-model" as never,
        },
      }),
    };
  }

  it("lists the Canvas tool for a child", () => {
    expect(childTools().set.definitions.map((definition) => definition.name)).toEqual([
      CANVAS_TOOL_NAME,
    ]);
  });

  it("creates and revises inside the child's host-resolved workspace and records the child as author", async () => {
    const { create, revise, resolveChildWorkspace, set } = childTools();
    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Plan", blocks: [diagram] }),
    });
    expect(created.isError).not.toBe(true);
    expect(resolveChildWorkspace).toHaveBeenCalledWith({ runId });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "work",
        workspace,
        originThreadId: parentThreadId,
      }),
      expect.objectContaining({ mode: "work", projectId, workspace }),
      expect.objectContaining({ id: projectId, type: "work" }),
      [expect.objectContaining({ kind: "diagram" })],
      expect.objectContaining({ kind: "agent", actorId: runId }),
    );

    const revised = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "revise",
        canvasId: "77777777-7777-4777-8777-777777777777",
        expectedSequence: 1,
        blocks: [diagram],
      }),
    });
    expect(revised.isError).not.toBe(true);
    expect(revise).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace,
        originThreadId: parentThreadId,
        actor: expect.objectContaining({ kind: "agent", actorId: runId }),
      }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("refuses a write when the child's checkout cannot be resolved", async () => {
    const { create, set } = childTools({ status: "refused", reason: "unresolved" });
    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", blocks: [diagram] }),
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toEqual({
      error: "This run's workspace is unavailable, so no Canvas can be bound to it.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a write aimed at another Project", async () => {
    const { create, set } = childTools({ status: "refused", reason: "foreign-project" });
    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", blocks: [diagram] }),
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toEqual({ error: "The Canvas Project is unavailable." });
    expect(create).not.toHaveBeenCalled();
  });
});

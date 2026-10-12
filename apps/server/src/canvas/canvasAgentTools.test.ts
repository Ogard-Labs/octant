import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts";
import { validateCanvasDefinition } from "@octant/domain/canvas-policy";
import { createManagedMcpTools } from "../providers/managedMcpTools";
import {
  CANVAS_TOOL_NAME,
  createCanvasAgentTools,
  createChildCanvasAgentTools,
} from "./canvasAgentTools";
import { inTreeCanvasDocumentRecipes } from "./canvasDocumentRecipes";
import { createCanvasPreviewService } from "./canvasPreviewService";

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
    canvas: { create, revise, get: vi.fn(() => ({ kind: "unavailable" })) },
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
    const recipeGuide = (outcome.result as { recipeGuide: string }).recipeGuide;
    expect(recipeGuide).toContain('"write a plan" uses implementation-plan');
    expect(recipeGuide).toContain('"review this PR" uses code-review');
    expect(recipeGuide).toContain('"summarise research" uses research-brief');
    expect(set.definitions[0]?.description).toContain("document recipe");
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

  it("keeps the always-visible definition small in every mode and for a managed child", () => {
    const port = {
      activeContext: vi.fn(),
      project: vi.fn(),
      canvas: {},
      resolveChildWorkspace: vi.fn(),
    } as never;
    const sets = [
      createCanvasAgentTools({ windowId, thread, port }),
      createCanvasAgentTools({ windowId, mode: "work", thread, port }),
      createCanvasAgentTools({ windowId, mode: "code", thread, port }),
      ...(["chat", "work", "code"] as const).map((mode) =>
        createChildCanvasAgentTools({
          port,
          run: {
            id: "run-1",
            parentThreadId: threadId,
            mode,
            providerInstanceId: "44444444-4444-4444-8444-444444444444" as never,
            modelId: "octant-test-model" as never,
          },
        }),
      ),
    ];
    for (const set of sets) {
      const [definition] = set.definitions;
      if (definition === undefined) throw new Error("Expected the Canvas definition.");
      // Every definition serialized to about 15,250 bytes while it carried each
      // block kind's guidance. That guidance is answered by describe now; the
      // budget catches it growing back into every turn's tool prefix.
      expect(JSON.stringify(definition).length).toBeLessThanOrEqual(6_000);
    }
  });

  it.each([
    ["plan", "dependsOn"],
    ["sequence", "activations"],
    ["state", "initial and a final state"],
    ["er", "cardinality"],
    ["swimlane", "lanes"],
    ["mindmap", "one root topic"],
    ["diagram", "nodes and edges"],
    ["chart", "sankey"],
    ["mockup", "variantId"],
    ["treemap", "never to a group"],
    ["heatmap", "calendar"],
    ["design", "Frames run no JavaScript"],
    ["bar-list", "Show all"],
    ["comparison-matrix", "recommendedOptionId"],
    ["math", "\\newcommand"],
    ["table", "{ id, cells }"],
    ["metric", "goodDirection"],
    ["dashboard", "blockId"],
    ["tabs", "may hold a dashboard"],
    ["columns", "2 to 4 tracks"],
    ["plan", "view to gantt"],
    ["diagram", "terminator (a pill)"],
    ["code-excerpt", "language mermaid"],
  ])(
    "answers the %s guidance from describe instead of every turn's description",
    async (kind, phrase) => {
      const { create, set } = tools();
      const outcome = await set.execute({
        name: CANVAS_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "describe", blockKinds: [kind] }),
      });

      expect(outcome.isError).not.toBe(true);
      const { guidance } = outcome.result as { guidance: Readonly<Record<string, string>> };
      expect(guidance[kind]).toContain(phrase);
      expect(set.definitions[0]?.description).not.toContain(guidance[kind]);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("teaches the three tiers and the new recipes when describe names no kinds", async () => {
    const { set } = tools();
    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe" }),
    });

    const result = outcome.result as {
      tierGuide: string;
      recipeGuide: string;
      previewGuide: string;
      blockKinds: ReadonlyArray<string>;
      recipes: ReadonlyArray<{
        id: string;
        skeleton: ReadonlyArray<{ kind: string; size?: string }>;
      }>;
    };
    expect(result.tierGuide).toContain("lowest tier");
    expect(result.tierGuide).toContain("Typed blocks");
    expect(result.tierGuide).toContain("static design frame");
    expect(result.tierGuide).toContain("running design frame");
    for (const kind of ["tabs", "columns", "design"]) expect(result.blockKinds).toContain(kind);
    const ids = result.recipes.map((recipe) => recipe.id);
    for (const id of ["article", "design-brief", "design-system", "clickable-prototype"]) {
      expect(ids).toContain(id);
    }
    // An agent reads which size a design slot is drawn at.
    expect(result.recipes.find((recipe) => recipe.id === "article")?.skeleton[0]).toMatchObject({
      kind: "design",
      size: "document",
    });
    expect(result.recipeGuide).toContain('"write an article" uses article');
    expect(result.recipeGuide).toContain("clickable-prototype");
    expect(result.previewGuide).toContain("script error");
  });

  it("returns a finished running prototype with the design examples and states the bridge's limits", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["design"] }),
    });

    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
      guidance?: Record<string, string>;
    };
    const prototype = (result.examples ?? []).find((example) => example.runsScript === true);
    expect(prototype).toMatchObject({ kind: "design", runsScript: true });
    expect(result.guidance?.design).toContain("oct-article");
    expect(result.guidance?.design).toContain("octant-asset:");
    expect(result.guidance?.design).toContain("heartbeat");

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Cart", blocks: [prototype] }),
    });
    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("says which block kind fits each need when describe names no kinds", async () => {
    const { set } = tools();
    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe" }),
    });

    const { blockGuide, blockKinds } = outcome.result as {
      blockGuide: Readonly<Record<string, string>>;
      blockKinds: ReadonlyArray<string>;
    };
    expect(blockGuide).toMatchObject({
      sequence: expect.stringContaining("login"),
      "comparison-matrix": expect.stringContaining("criteria"),
      design: expect.stringContaining("slide deck"),
    });
    for (const kind of Object.keys(blockGuide)) expect(blockKinds).toContain(kind);
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

  it("shows an agent a short tabbed document whose tabs name blocks it also holds", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["tabs", "columns"] }),
    });
    expect(described.isError).not.toBe(true);
    const result = described.result as {
      blockSchema: unknown;
      examples?: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
    };
    expect(JSON.stringify(result.blockSchema)).toContain("panes");
    expect(JSON.stringify(result.blockSchema)).toContain("tracks");
    const example = result.examples?.[0] ?? [];
    expect(example[0]).toMatchObject({ kind: "tabs" });
    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Overview", blocks: example }),
    });
    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("shows an agent a styled flowchart, a toned zone map, and a Gantt plan that the policy admits", async () => {
    const { set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["diagram", "plan"] }),
    });
    expect(described.isError).not.toBe(true);
    const result = described.result as { examples?: ReadonlyArray<Record<string, unknown>> };
    const examples = result.examples ?? [];
    expect(examples.map((example) => example.blockId)).toEqual(["loop", "zones", "launch-plan"]);
    expect(JSON.stringify(examples)).toContain('"role":"decision"');
    expect(JSON.stringify(examples)).toContain('"tone":"danger"');
    expect(examples[2]).toMatchObject({ view: "gantt" });
    for (const example of examples) expect(() => decodeCanvasBlock(example)).not.toThrow();
  });

  it("imports a Mermaid flowchart as a typed diagram and keeps an unsupported one as code", async () => {
    const { create, set } = tools();
    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        title: "Flows",
        blocks: [
          {
            blockId: "loop",
            schemaVersion: CANVAS_SCHEMA_VERSION,
            kind: "code-excerpt",
            language: "mermaid",
            code: "flowchart TD\n  a([Start]) --> b{Ready?}\n  b -->|yes| c[Ship]",
          },
          {
            blockId: "styled",
            schemaVersion: CANVAS_SCHEMA_VERSION,
            kind: "code-excerpt",
            language: "mermaid",
            code: 'flowchart TD\n  a --> b\n  click a href "https://example.com"',
          },
        ],
      }),
    });
    expect(created.isError).not.toBe(true);
    expect(created.result).toMatchObject({
      mermaid: [
        { blockId: "loop", status: "imported", kind: "diagram" },
        { blockId: "styled", status: "kept-as-code", reason: "unsupported-construct", line: 3 },
      ],
    });
    const blocks = create.mock.calls[0]?.[3] as ReadonlyArray<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({
      blockId: "loop",
      kind: "diagram",
      nodes: [
        { nodeId: "a", role: "terminator" },
        { nodeId: "b", role: "decision" },
        { nodeId: "c", role: "process" },
      ],
    });
    expect(blocks[1]).toMatchObject({
      blockId: "styled",
      kind: "code-excerpt",
      language: "mermaid",
    });
  });

  it("lets an agent create an entity-relationship, a swimlane, and a mind map from the examples describe returns", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "describe",
        blockKinds: ["er", "swimlane", "mindmap"],
      }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
    };
    const examples = result.examples ?? [];
    expect(examples.map((example) => example.kind)).toEqual(["er", "swimlane", "mindmap"]);
    const blocks = examples.map((example) => decodeCanvasBlock(example));
    expect(blocks[0]).toMatchObject({
      kind: "er",
      entities: expect.arrayContaining([expect.objectContaining({ label: "Person" })]),
      relationships: expect.arrayContaining([
        expect.objectContaining({ label: "places", sourceCardinality: "one" }),
      ]),
    });
    expect(blocks[1]).toMatchObject({
      kind: "swimlane",
      lanes: expect.arrayContaining([expect.objectContaining({ label: "Support", kind: "team" })]),
      steps: expect.arrayContaining([expect.objectContaining({ label: "Is it a defect?" })]),
    });
    expect(blocks[2]).toMatchObject({
      kind: "mindmap",
      nodes: expect.arrayContaining([
        expect.objectContaining({ nodeId: "tests", parentId: "release" }),
      ]),
    });

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        title: "Order flow",
        blocks: examples,
      }),
    });

    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Order flow" }),
      expect.anything(),
      expect.anything(),
      blocks,
    );
  });

  it("lets an agent create a pie, a donut, stacked and grouped bars, a bar and line chart, a funnel, a radar, and a sankey from the examples describe returns", async () => {
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
      "funnel",
      "radar",
      "sankey",
    ]);
    expect(result.blockSchema?.properties?.chartType?.enum).toEqual(
      expect.arrayContaining([
        "pie",
        "donut",
        "stacked-bar",
        "grouped-bar",
        "bar-line",
        "funnel",
        "radar",
        "sankey",
      ]),
    );
    expect(JSON.stringify(described.result)).not.toContain("heatmap");
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

  it("lets an agent create a matrix and a calendar from the heatmap examples describe returns", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["heatmap"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
    };
    const examples = result.examples ?? [];
    expect(examples.map((example) => example.blockId)).toEqual([
      "commits-by-hour",
      "test-failures-calendar",
    ]);
    const blocks = examples.map((example) => decodeCanvasBlock(example));
    expect(blocks.every((block) => block.kind === "heatmap")).toBe(true);

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        title: "Activity grid",
        blocks: examples,
      }),
    });

    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Activity grid" }),
      expect.anything(),
      expect.anything(),
      blocks,
    );
    expect(examples[0]).toMatchObject({ kind: "heatmap", layout: "matrix", scale: "sequential" });
    expect(examples[1]).toMatchObject({
      kind: "heatmap",
      layout: "calendar",
      scale: "diverging",
    });
  });

  it("lets an agent create a phone flow, a deck, and a themed spec document from the design examples describe returns", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["design"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
      blockSchema?: unknown;
    };
    const examples = result.examples ?? [];
    expect(examples.map((example) => example.size)).toEqual([
      "phone",
      "slide",
      "document",
      "phone",
    ]);
    // The schema an agent reads names the document size and the theme field.
    expect(JSON.stringify(result.blockSchema)).toContain('"document"');
    expect(JSON.stringify(result.blockSchema)).toContain('"workspace"');
    const blocks = examples.map((example) => decodeCanvasBlock(example));

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Designs", blocks: examples }),
    });

    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Designs" }),
      expect.anything(),
      expect.anything(),
      blocks,
    );
  });

  it("lets an agent create a hottest-files list from the bar-list example describe returns", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["bar-list"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
    };
    const examples = result.examples ?? [];
    expect(examples.map((example) => example.blockId)).toContain("hottest-files");
    const blocks = examples.map((example) => decodeCanvasBlock(example));
    expect(blocks.every((block) => block.kind === "bar-list")).toBe(true);

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Hot files", blocks: examples }),
    });

    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Hot files" }),
      expect.anything(),
      expect.anything(),
      blocks,
    );
    expect(examples[0]).toMatchObject({ kind: "bar-list", scale: "sequential" });
  });

  it("lets an agent create a decision matrix from the comparison-matrix examples describe returns", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["comparison-matrix"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
    };
    const examples = result.examples ?? [];
    expect(examples.map((example) => example.blockId)).toEqual([
      "state-store-decision",
      "editor-features",
    ]);
    const blocks = examples.map((example) => decodeCanvasBlock(example));
    expect(blocks.every((block) => block.kind === "comparison-matrix")).toBe(true);

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "State store", blocks: examples }),
    });

    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "State store" }),
      expect.anything(),
      expect.anything(),
      blocks,
    );
    expect(examples[0]).toMatchObject({ recommendedOptionId: "sqlite" });
  });

  it("lets an agent create display and inline math from the examples describe returns", async () => {
    const { create, set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["math"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
    };
    const examples = result.examples ?? [];
    expect(examples.map((example) => [example.blockId, example.layout])).toEqual([
      ["bayes-theorem", "display"],
      ["queue-length", "display"],
      ["amdahl-limit", "inline"],
    ]);
    const blocks = examples.map((example) => decodeCanvasBlock(example));

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Formulas", blocks: examples }),
    });

    expect(created.isError).not.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Formulas" }),
      expect.anything(),
      expect.anything(),
      blocks,
    );
  });

  it("lets an agent create a repo-stats tile row from the metric examples describe returns", async () => {
    const { set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["metric"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
    };
    const examples = result.examples ?? [];
    expect(examples.map((example) => example.blockId)).toEqual([
      "repo-file-count",
      "repo-lines",
      "repo-coverage",
    ]);
    const blocks = examples.map((example) => decodeCanvasBlock(example));
    expect(blocks.every((block) => block.kind === "metric")).toBe(true);
    expect(examples[1]).toMatchObject({ kind: "metric", goodDirection: "up", format: "compact" });
  });

  it("describes a dashboard with an ops dashboard and a release health board that validate as written", async () => {
    const { set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["dashboard"] }),
    });

    expect(described.isError).not.toBe(true);
    const result = described.result as {
      examples?: ReadonlyArray<Record<string, unknown>>;
    };
    const examples = result.examples ?? [];
    const dashboards = examples.filter((example) => example.kind === "dashboard");
    expect(dashboards.map((example) => example.title)).toEqual([
      "Service health",
      "Release 4.2 health",
    ]);
    // Each dashboard arrives with the blocks it places, so the examples
    // validate as one document an agent can copy.
    const blocks = examples.map((example) => decodeCanvasBlock(example));
    expect(() =>
      validateCanvasDefinition({
        schemaVersion: CANVAS_SCHEMA_VERSION,
        title: "Dashboards",
        provenance: {
          mode: "chat",
          hostId: "local",
          projectId: "22222222-2222-4222-8222-222222222222",
          threadId: "33333333-3333-4333-8333-333333333333",
          actor: { kind: "local-user", actorId: "55555555-5555-4555-8555-555555555555" },
          providerInstanceId: "44444444-4444-4444-8444-444444444444",
          modelId: "octant-test-model",
          createdAt: "2026-08-01T21:00:00.000Z",
        },
        sourceManifest: [],
        blocks,
      }),
    ).not.toThrow();
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

    // The person asks for a styled phone version with a callout on the new
    // control: the agent revises the same block with catalog fields.
    const revisedBlock = {
      ...example,
      device: "phone",
      fidelity: "styled",
      nodes: [
        ...block.nodes,
        {
          nodeId: "two-factor",
          component: "checkbox",
          label: "Require two-factor sign-in",
          on: true,
          parentId: "profile",
        },
      ],
      annotations: [
        ...(block.annotations ?? []),
        { nodeId: "two-factor", note: "Admins can enforce this for the workspace." },
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
      [
        expect.objectContaining({
          kind: "mockup",
          device: "phone",
          fidelity: "styled",
          annotations: expect.arrayContaining([expect.objectContaining({ nodeId: "two-factor" })]),
        }),
      ],
    );

    // A component outside the closed catalog never reaches the Canvas.
    revise.mockClear();
    const refused = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "revise",
        canvasId: "canvas-1",
        expectedSequence: 2,
        title: "Settings",
        blocks: [
          {
            ...revisedBlock,
            nodes: [...revisedBlock.nodes, { nodeId: "embed", component: "iframe", label: "Map" }],
          },
        ],
      }),
    });
    expect(refused.isError).toBe(true);
    expect(revise).not.toHaveBeenCalled();
  });

  it("describes mockup with a wireframe settings screen and a styled set of states", async () => {
    const { set } = tools();
    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["mockup"] }),
    });
    const examples = (described.result as { examples?: ReadonlyArray<Record<string, unknown>> })
      .examples;
    expect(examples).toEqual([
      expect.objectContaining({ blockId: "settings-screen", fidelity: "wireframe" }),
      expect.objectContaining({
        blockId: "notification-states",
        fidelity: "styled",
        variants: [
          expect.objectContaining({ label: "Loaded" }),
          expect.objectContaining({ label: "Empty" }),
          expect.objectContaining({ label: "Error" }),
        ],
      }),
    ]);
    expect(examples?.every((example) => decodeCanvasBlock(example).kind === "mockup")).toBe(true);
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
        canvas: { create, revise, get: vi.fn(() => ({ kind: "unavailable" })) },
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

    const designGuidance = async (set: ReturnType<typeof tools>["set"]): Promise<string> => {
      const described = await set.execute({
        name: CANVAS_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "describe", blockKinds: ["design"] }),
      });
      return (described.result as { guidance?: Record<string, string> }).guidance?.design ?? "";
    };

    it("teaches a Work or Code agent to show a Project file in a design, and a Chat agent only generated images", async () => {
      for (const mode of ["work", "code"] as const) {
        const guidance = await designGuidance(boundTools(mode).set);
        expect(guidance).toContain("octant-asset:home-shot");
        expect(guidance).toContain('"kind": "project-file"');
        expect(guidance).toContain('"kind": "generated-image"');
        expect(guidance).toContain("3 MB each and 5 MB per design");
      }
      const chat = await designGuidance(tools().set);
      expect(chat).toContain('"kind": "generated-image"');
      expect(chat).not.toContain('"kind": "project-file"');
      expect(chat).toContain("a file path is refused");
    });

    it("teaches every agent how to declare a running prototype, what stays refused, and that it has no network", async () => {
      for (const mode of ["chat", "work", "code"] as const) {
        const guidance = await designGuidance((mode === "chat" ? tools() : boundTools(mode)).set);
        expect(guidance).toContain('"runsScript": true');
        expect(guidance).toContain("<script src>");
        expect(guidance).toContain("It has no network at all");
      }
    });

    it("tells the agent to deliver substantial work as a Canvas bound to the thread's checkout", () => {
      const description = boundTools("code").set.definitions[0]?.description ?? "";
      expect(description).toContain("deliver it as a Canvas rather than as a long reply");
      expect(description).toContain("design or mockup, diagram, report, review, audit");
      expect(description).toContain("Keep short answers");
      expect(description).toContain("Text renders as plain text, not Markdown");
      expect(description).toContain("call describe");
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
      canvas: {
        create,
        revise,
        threadReferenceCards: vi.fn(() => []),
        get: vi.fn(() => ({ kind: "unavailable" })),
      },
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

describe("Canvas preview through the tool", () => {
  const previewCanvasId = "77777777-7777-4777-8777-777777777777";

  function previewPort(
    imagesInToolResults: (input: unknown) => boolean,
    preview: (request: { readonly imagesInToolResults: boolean }) => unknown,
  ) {
    return tools({
      imagesInToolResults: vi.fn(imagesInToolResults),
      preview: { preview: vi.fn(async (request: unknown) => preview(request as never)) },
    }).set;
  }

  it("reports the warnings and the reason a model that cannot take images got no picture", async () => {
    const set = previewPort(
      () => false,
      (request) => ({
        kind: "preview",
        canvasId: previewCanvasId,
        sequence: 1,
        width: 380,
        height: 360,
        warnings: [{ kind: "empty-series", blockId: "revenue" }],
        ...(request.imagesInToolResults
          ? {}
          : { imageOmitted: "provider-cannot-take-images" as const }),
      }),
    );
    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "preview",
        canvasId: previewCanvasId,
        width: "inline",
      }),
    });
    expect(outcome.isError).not.toBe(true);
    expect(outcome.images).toBeUndefined();
    expect(outcome.result).toMatchObject({
      canvasId: previewCanvasId,
      warnings: [{ kind: "empty-series", blockId: "revenue" }],
      imagesInToolResults: false,
      imageIncluded: false,
      imageOmitted: "provider-cannot-take-images",
    });
  });

  it("attaches the picture to a model that takes images in a tool result", async () => {
    const set = previewPort(
      () => true,
      () => ({
        kind: "preview",
        canvasId: previewCanvasId,
        sequence: 1,
        width: 720,
        height: 360,
        warnings: [],
        image: { mimeType: "image/png" as const, data: "AAAA" },
      }),
    );
    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "preview", canvasId: previewCanvasId }),
    });
    expect(outcome.isError).not.toBe(true);
    expect(outcome.images).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(outcome.result).toMatchObject({
      imagesInToolResults: true,
      imageIncluded: true,
    });
  });

  it("carries a prototype from describe to create to a preview that returns the error it threw", async () => {
    // What the preview browser read from this prototype, recorded from the
    // real-browser smoke: the bridge's report of the uncaught error.
    const recorded = {
      blockId: "cart-prototype",
      measured: true,
      scriptErrors: ["Uncaught ReferenceError: missingFunction is not defined"],
      overflow: [],
      contrast: [],
    };
    let written: ReadonlyArray<unknown> = [];
    const render = vi.fn(async () => ({
      kind: "rendered" as const,
      png: new Uint8Array([1]),
      height: 400,
      designs: [recorded],
    }));
    const { create, set } = tools({
      imagesInToolResults: vi.fn(() => true),
      preview: createCanvasPreviewService({
        canvas: {
          get: () => ({
            kind: "ready" as const,
            version: {
              canvasId: previewCanvasId,
              versionId: "version-1",
              sequence: 1,
              definition: { blocks: written, provenance: {} },
            },
          }),
          history: () => ({ kind: "ready" as const, history: { entries: [] } }),
        } as never,
        renderer: { available: async () => true, render },
      }),
    });

    const overview = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe" }),
    });
    const { recipes, tierGuide } = overview.result as {
      tierGuide: string;
      recipes: ReadonlyArray<{ id: string; skeleton: ReadonlyArray<{ kind: string }> }>;
    };
    expect(tierGuide).toContain("running design frame");
    const recipe = recipes.find((entry) => entry.id === "clickable-prototype");
    expect(recipe?.skeleton[0]?.kind).toBe("design");

    const described = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "describe", blockKinds: ["design"] }),
    });
    const example = (
      described.result as { examples: ReadonlyArray<Record<string, unknown>> }
    ).examples.find((entry) => entry.runsScript === true);
    if (example === undefined) throw new Error("Describe returned no running prototype.");
    const frames = example.frames as ReadonlyArray<{ html: string }>;
    const prototype = {
      ...example,
      frames: frames.map((frame) => ({
        ...frame,
        html: `${frame.html}<script>missingFunction()</script>`,
      })),
    };

    const created = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Cart", blocks: [prototype] }),
    });
    expect(created.isError).not.toBe(true);
    written = create.mock.calls[0]?.[3] as ReadonlyArray<unknown>;

    const looked = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "preview", canvasId: previewCanvasId }),
    });
    expect(looked.isError).not.toBe(true);
    // The preview ran the page a reader's frame is served, with its bridge.
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        designPages: [
          {
            blockId: "cart-prototype",
            html: expect.stringContaining("<script>missingFunction()</script>"),
          },
        ],
      }),
    );
    expect(looked.result).toMatchObject({
      imageIncluded: true,
      warnings: [
        {
          kind: "design-script-error",
          blockId: "cart-prototype",
          message: "Uncaught ReferenceError: missingFunction is not defined",
        },
      ],
    });
  });

  it("refuses a preview that names no Canvas", async () => {
    const set = previewPort(
      () => true,
      () => ({ kind: "unavailable", message: "unused" }),
    );
    const outcome = await set.execute({
      name: CANVAS_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "preview" }),
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toEqual({
      error: "A preview needs the canvasId of the Canvas to look at.",
    });
  });
});

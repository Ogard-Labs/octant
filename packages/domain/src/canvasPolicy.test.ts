import { describe, expect, it } from "vitest";
import {
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_DIAGRAM_EDGES,
  CANVAS_MAX_DIAGRAM_NODES,
  CANVAS_MAX_IMAGES,
  CANVAS_MAX_MOCKUP_DEPTH,
  CANVAS_MAX_MOCKUP_NODES,
  CANVAS_MAX_MOCKUP_TEXT_LENGTH,
  CANVAS_MAX_SERIES,
  CANVAS_MAX_TABLE_ROWS,
  CANVAS_MAX_TEXT_BYTES,
  CANVAS_MAX_TREEMAP_DEPTH,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasDefinition,
  type CanvasDefinition,
} from "@octant/contracts/canvas";
import { loginSequenceExample, orderStateExample } from "./canvasDiagramExamples";
import {
  CanvasPolicyRejected,
  measureCanvasBudget,
  validateCanvasDefinition,
  validateCanvasVersion,
} from "./canvasPolicy";

const ids = {
  source: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  thread: "33333333-3333-4333-8333-333333333333",
  provider: "44444444-4444-4444-8444-444444444444",
  actor: "55555555-5555-4555-8555-555555555555",
} as const;

const provenance = {
  mode: "chat",
  hostId: "local",
  projectId: ids.project,
  threadId: ids.thread,
  actor: { kind: "local-user", actorId: ids.actor },
  providerInstanceId: ids.provider,
  modelId: "octant-test-model",
  createdAt: "2026-08-01T21:00:00.000Z",
} as const;

const source = {
  sourceId: ids.source,
  kind: "attachment",
  hostId: "local",
  projectId: ids.project,
  opaqueRef: "opaque-source",
  displayName: "notes.md",
} as const;

const baseDefinition: CanvasDefinition = decodeCanvasDefinition({
  schemaVersion: CANVAS_SCHEMA_VERSION,
  title: "Policy fixture",
  provenance,
  sourceManifest: [source],
  blocks: [
    {
      blockId: "heading",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "heading",
      level: 1,
      text: "Safe Canvas",
    },
  ],
});

function withBlocks(blocks: ReadonlyArray<unknown>): unknown {
  return { ...baseDefinition, blocks };
}

function planTask(taskId: string, overrides: Record<string, unknown> = {}) {
  return { taskId, phaseId: "build", title: `Task ${taskId}`, status: "todo", ...overrides };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    blockId: "plan",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "plan" as const,
    title: "Launch plan",
    phases: [{ phaseId: "build", title: "Build" }],
    tasks: [
      planTask("api", {
        status: "doing",
        owner: { kind: "agent", label: "Codex" },
        sourceIds: [ids.source],
      }),
      planTask("docs", { dependsOn: ["api"] }),
    ],
    ...overrides,
  };
}

function divider(blockId: string) {
  return { blockId, schemaVersion: CANVAS_SCHEMA_VERSION, kind: "divider" as const };
}

function richText(blockId: string, text: string) {
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "rich-text" as const,
    text,
  };
}

function table(blockId: string, rows: ReadonlyArray<ReadonlyArray<string>>) {
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "table" as const,
    columns: [{ id: "value", label: "Value", type: "text" as const }],
    rows,
  };
}

function chart(blockId: string, series: ReadonlyArray<{ seriesId: string }>) {
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "chart" as const,
    chartType: "line" as const,
    series: series.map(({ seriesId }) => ({
      seriesId,
      label: seriesId,
      points: [{ x: 1, y: 1 }],
    })),
  };
}

function diagram(blockId: string, nodeCount: number, edgeCount: number) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    nodeId: `node-${blockId}-${index}`,
    label: "node",
  }));
  const firstNode = nodes[0]?.nodeId ?? "node-missing";
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "diagram" as const,
    nodes,
    edges: Array.from({ length: edgeCount }, (_, index) => ({
      edgeId: `edge-${blockId}-${index}`,
      source: firstNode,
      target: firstNode,
    })),
  };
}

function image(blockId: string) {
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "image" as const,
    sourceId: ids.source,
    alt: "image",
  };
}

function sequenceParticipants(blockId: string, count: number) {
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "sequence" as const,
    participants: Array.from({ length: count }, (_, index) => ({
      participantId: `p-${blockId}-${index}`,
      label: "Person",
    })),
    messages: [],
  };
}

function expectPolicyCode(action: () => unknown, code: CanvasPolicyRejected["code"]) {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CanvasPolicyRejected);
    expect((error as CanvasPolicyRejected).code).toBe(code);
  }
}

describe("Canvas validation policy", () => {
  it("accepts a valid definition and reports bounded usage", () => {
    const validated = validateCanvasDefinition(baseDefinition);
    expect(validated).toEqual(baseDefinition);
    expect(measureCanvasBudget(validated)).toMatchObject({
      blockCount: 1,
      imageCount: 0,
      tableRows: 0,
      chartSeries: 0,
      diagramNodes: 0,
      diagramEdges: 0,
    });
  });

  it("fails closed for unknown schema versions", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition({ ...baseDefinition, schemaVersion: CANVAS_SCHEMA_VERSION + 1 }),
      "unsupported-schema-version",
    );
    expectPolicyCode(
      () => validateCanvasDefinition({ ...baseDefinition, schemaVersion: "1" }),
      "invalid-schema",
    );
  });

  it("refuses a mockup block inside a document declaring an older schema version", () => {
    const mockup = {
      blockId: "mockup-1",
      schemaVersion: 2,
      kind: "mockup",
      device: "desktop",
      title: "Settings",
      nodes: [{ nodeId: "screen", component: "window", label: "Settings" }],
    } as const;
    expectPolicyCode(
      () => validateCanvasDefinition({ ...baseDefinition, schemaVersion: 2, blocks: [mockup] }),
      "unsupported-schema-version",
    );
    expectPolicyCode(
      () => validateCanvasDefinition({ ...baseDefinition, schemaVersion: 1, blocks: [mockup] }),
      "unsupported-schema-version",
    );
    expectPolicyCode(
      () =>
        validateCanvasVersion({
          schemaVersion: 2,
          canvasId: "99999999-9999-4999-8999-999999999999",
          versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sequence: 1,
          definition: { ...baseDefinition, schemaVersion: 2, blocks: [mockup] },
          createdBy: { kind: "local-user", actorId: ids.actor },
          createdAt: "2026-08-01T21:00:01.000Z",
        }),
      "unsupported-schema-version",
    );
  });

  it("rejects duplicate blocks and dangling source references", () => {
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([divider("same"), divider("same")])),
      "duplicate-block-id",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              blockId: "missing-source",
              schemaVersion: CANVAS_SCHEMA_VERSION,
              kind: "source-reference",
              sourceId: "99999999-9999-4999-8999-999999999999",
              label: "missing",
            },
          ]),
        ),
      "missing-source",
    );
  });

  it("rejects duplicate sources and malformed table rows", () => {
    expectPolicyCode(
      () => validateCanvasDefinition({ ...baseDefinition, sourceManifest: [source, source] }),
      "duplicate-source-id",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([table("bad-table", [["one", "two"]])])),
      "table-row-shape",
    );
  });

  it("refuses a diagram that groups a node it does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...diagram("grouped-diagram", 2, 1),
              groups: [{ groupId: "backend", label: "Backend", nodeIds: ["missing"] }],
            },
          ]),
        ),
      "dangling-group-member",
    );
  });

  it("refuses a diagram that puts one node inside two boundaries", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...diagram("grouped-diagram", 2, 1),
              groups: [
                { groupId: "one", label: "One", nodeIds: ["node-grouped-diagram-0"] },
                { groupId: "two", label: "Two", nodeIds: ["node-grouped-diagram-0"] },
              ],
            },
          ]),
        ),
      "overlapping-groups",
    );
  });

  it("accepts a plan whose tasks, phases, dependencies, and sources all resolve", () => {
    expect(() => validateCanvasDefinition(withBlocks([plan()]))).not.toThrow();
  });

  it("refuses a plan task in a missing phase, a dangling or circular dependency, or a missing source", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([plan({ tasks: [planTask("api", { phaseId: "later" })] })]),
        ),
      "unknown-plan-phase",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([plan({ tasks: [planTask("api", { dependsOn: ["ghost"] })] })]),
        ),
      "dangling-plan-dependency",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            plan({
              tasks: [
                planTask("api", { dependsOn: ["docs"] }),
                planTask("docs", { dependsOn: ["api"] }),
              ],
            }),
          ]),
        ),
      "plan-dependency-cycle",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(withBlocks([plan({ tasks: [planTask("api"), planTask("api")] })])),
      "duplicate-plan-task-id",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            plan({
              tasks: [planTask("api", { sourceIds: ["00000000-0000-4000-8000-0000000000ff"] })],
            }),
          ]),
        ),
      "missing-source",
    );
  });

  it("refuses a diagram with two groups of the same identity", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...diagram("grouped-diagram", 2, 1),
              groups: [
                { groupId: "one", label: "One", nodeIds: ["node-grouped-diagram-0"] },
                { groupId: "one", label: "Again", nodeIds: ["node-grouped-diagram-1"] },
              ],
            },
          ]),
        ),
      "duplicate-group-id",
    );
  });

  it("accepts a diagram whose groups each hold nodes of their own", () => {
    expect(() =>
      validateCanvasDefinition(
        withBlocks([
          {
            ...diagram("grouped-diagram", 2, 1),
            groups: [
              { groupId: "one", label: "One", nodeIds: ["node-grouped-diagram-0"] },
              { groupId: "two", label: "Two", nodeIds: ["node-grouped-diagram-1"] },
            ],
          },
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects dangling diagram edges and duplicate chart series", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...diagram("bad-diagram", 1, 1),
              edges: [{ edgeId: "edge", source: "node-bad-diagram-0", target: "missing" }],
            },
          ]),
        ),
      "dangling-edge",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([chart("bad-chart", [{ seriesId: "same" }, { seriesId: "same" }])]),
        ),
      "duplicate-series-id",
    );
  });

  it("enforces the block, row, series, node, edge, and image budgets", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks(
            Array.from({ length: CANVAS_MAX_BLOCKS + 1 }, (_, i) => divider(`block-${i}`)),
          ),
        ),
      "block-budget-exceeded",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            table(
              "rows-a",
              Array.from({ length: CANVAS_MAX_TABLE_ROWS }, () => ["row"]),
            ),
            table(
              "rows-b",
              Array.from({ length: CANVAS_MAX_TABLE_ROWS }, () => ["row"]),
            ),
          ]),
        ),
      "rows-budget-exceeded",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            chart(
              "series-a",
              Array.from({ length: CANVAS_MAX_SERIES }, (_, i) => ({ seriesId: `a-${i}` })),
            ),
            chart(
              "series-b",
              Array.from({ length: CANVAS_MAX_SERIES }, (_, i) => ({ seriesId: `b-${i}` })),
            ),
          ]),
        ),
      "series-budget-exceeded",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([diagram("nodes", CANVAS_MAX_DIAGRAM_NODES, 0), diagram("nodes-2", 1, 0)]),
        ),
      "node-budget-exceeded",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([diagram("edges", 1, CANVAS_MAX_DIAGRAM_EDGES), diagram("edges-2", 1, 1)]),
        ),
      "edge-budget-exceeded",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks(Array.from({ length: CANVAS_MAX_IMAGES + 1 }, (_, i) => image(`image-${i}`))),
        ),
      "image-budget-exceeded",
    );
  });

  it("enforces the aggregate text budget", () => {
    const text = "x".repeat(Math.ceil(CANVAS_MAX_TEXT_BYTES / 4));
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            richText("text-a", text),
            richText("text-b", text),
            richText("text-c", text),
            richText("text-d", text),
          ]),
        ),
      "text-budget-exceeded",
    );
  });

  it("rejects cyclic, accessor-backed, and deeply nested hostile payloads", () => {
    const cyclic: Record<string, unknown> = { ...baseDefinition };
    cyclic.self = cyclic;
    expectPolicyCode(() => validateCanvasDefinition(cyclic), "unsafe-payload");

    const accessor = { ...baseDefinition } as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", { get: () => "leak" });
    expectPolicyCode(() => validateCanvasDefinition(accessor), "unsafe-payload");

    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let index = 0; index < 12; index += 1) {
      nested.next = {};
      nested = nested.next as Record<string, unknown>;
    }
    expectPolicyCode(
      () => validateCanvasDefinition({ ...baseDefinition, hostile: root }),
      "depth-budget-exceeded",
    );
  });

  it("rejects malformed payloads instead of silently rewriting them", () => {
    expectPolicyCode(
      () => validateCanvasDefinition({ ...baseDefinition, blocks: [{ kind: "unknown" }] }),
      "invalid-schema",
    );
    expectPolicyCode(
      () => validateCanvasDefinition({ ...baseDefinition, payload: "<script>" }),
      "invalid-schema",
    );
  });
});

describe("sequence and state diagram validation", () => {
  it("accepts a login sequence and an order state machine and counts them as diagram nodes and edges", () => {
    const validated = validateCanvasDefinition(
      withBlocks([loginSequenceExample, orderStateExample]),
    );
    expect(measureCanvasBudget(validated)).toMatchObject({
      diagramNodes: loginSequenceExample.participants.length + orderStateExample.states.length,
      diagramEdges: loginSequenceExample.messages.length + orderStateExample.transitions.length,
    });
  });

  it("refuses a message to a participant the sequence does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...loginSequenceExample,
              messages: [{ messageId: "submit", from: "person", to: "missing", label: "Sign in" }],
            },
          ]),
        ),
      "dangling-edge",
    );
  });

  it("refuses a state nested inside itself", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              blockId: "loop",
              schemaVersion: CANVAS_SCHEMA_VERSION,
              kind: "state",
              states: [{ stateId: "paid", label: "Paid", parentId: "paid" }],
              transitions: [],
            },
          ]),
        ),
      "state-nesting-cycle",
    );
  });

  it("counts sequence participants toward the same node budget as a board", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            sequenceParticipants("people-a", CANVAS_MAX_DIAGRAM_NODES),
            sequenceParticipants("people-b", 1),
          ]),
        ),
      "node-budget-exceeded",
    );
  });
});

function mockupNode(nodeId: string, parentId?: string, label = "Row") {
  return {
    nodeId,
    component: "text" as const,
    label,
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function mockup(blockId: string, nodes: ReadonlyArray<ReturnType<typeof mockupNode>>) {
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "mockup" as const,
    device: "phone" as const,
    title: "Settings",
    nodes,
  };
}

describe("mockup limits", () => {
  it("accepts a settings screen within the depth, node, and text limits", () => {
    expect(() =>
      validateCanvasDefinition(
        withBlocks([
          mockup("settings", [
            mockupNode("window"),
            mockupNode("header", "window", "Settings"),
            mockupNode("row", "header", "Display name"),
          ]),
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects a mockup nested deeper than the depth limit", () => {
    const nodes = [mockupNode("n0")];
    for (let index = 1; index <= CANVAS_MAX_MOCKUP_DEPTH; index += 1) {
      nodes.push(mockupNode(`n${String(index)}`, `n${String(index - 1)}`));
    }
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([mockup("deep", nodes)])),
      "mockup-depth-exceeded",
    );
  });

  it("rejects a mockup with more nodes than the node limit", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            mockup(
              "wide",
              Array.from({ length: CANVAS_MAX_MOCKUP_NODES + 1 }, (_, index) =>
                mockupNode(`n${String(index)}`),
              ),
            ),
          ]),
        ),
      "mockup-node-budget-exceeded",
    );
  });

  it("rejects a mockup label longer than the text limit", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            mockup("long", [
              mockupNode("name", undefined, "x".repeat(CANVAS_MAX_MOCKUP_TEXT_LENGTH + 1)),
            ]),
          ]),
        ),
      "mockup-text-budget-exceeded",
    );
  });
});

function treemap(overrides: Record<string, unknown> = {}) {
  return {
    blockId: "repository-map",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "treemap" as const,
    measures: [
      { measureId: "loc", label: "Lines of code" },
      { measureId: "edits", label: "Edits" },
    ],
    sizeBy: "loc",
    colorBy: "edits",
    colorScale: "sequential" as const,
    nodes: [
      { nodeId: "root", label: "Repository" },
      { nodeId: "web", label: "web", parentId: "root", values: { loc: 210, edits: 12 } },
      { nodeId: "server", label: "server", parentId: "root", values: { loc: 96, edits: 7 } },
    ],
    ...overrides,
  };
}

describe("treemap validation", () => {
  it("accepts a hierarchy whose leaves carry every measure", () => {
    expect(() => validateCanvasDefinition(withBlocks([treemap()]))).not.toThrow();
  });

  it("rejects a hierarchy with more than one root", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            treemap({
              nodes: [
                { nodeId: "root", label: "Repository" },
                { nodeId: "web", label: "web", parentId: "root", values: { loc: 1, edits: 1 } },
                { nodeId: "orphan", label: "orphan", values: { loc: 1, edits: 1 } },
              ],
            }),
          ]),
        ),
      "treemap-roots",
    );
  });

  it("rejects a hierarchy that nests a node inside itself", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            treemap({
              nodes: [
                { nodeId: "root", label: "Repository" },
                { nodeId: "web", label: "web", parentId: "root" },
                { nodeId: "left", label: "left", parentId: "right", values: { loc: 1, edits: 1 } },
                { nodeId: "right", label: "right", parentId: "left", values: { loc: 1, edits: 1 } },
              ],
            }),
          ]),
        ),
      "treemap-nesting-cycle",
    );
  });

  it("rejects a node whose parent the hierarchy does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            treemap({
              nodes: [
                { nodeId: "root", label: "Repository" },
                { nodeId: "web", label: "web", parentId: "missing", values: { loc: 1, edits: 1 } },
              ],
            }),
          ]),
        ),
      "dangling-treemap-parent",
    );
  });

  it("rejects a hierarchy nested deeper than the depth limit", () => {
    const nodes: Array<Record<string, unknown>> = [{ nodeId: "n0", label: "n0" }];
    for (let index = 1; index <= CANVAS_MAX_TREEMAP_DEPTH; index += 1) {
      const id = `n${String(index)}`;
      const parent = `n${String(index - 1)}`;
      nodes.push(
        index === CANVAS_MAX_TREEMAP_DEPTH
          ? { nodeId: id, label: id, parentId: parent, values: { loc: 1, edits: 1 } }
          : { nodeId: id, label: id, parentId: parent },
      );
    }
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([treemap({ nodes })])),
      "depth-budget-exceeded",
    );
  });

  it("rejects two measures that share an id", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            treemap({
              measures: [
                { measureId: "loc", label: "Lines" },
                { measureId: "loc", label: "Other" },
              ],
            }),
          ]),
        ),
      "duplicate-measure-id",
    );
  });

  it("rejects sizing by a measure the hierarchy does not declare", () => {
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([treemap({ sizeBy: "missing" })])),
      "unknown-treemap-measure",
    );
  });

  it("rejects a value placed on a group that sums its children", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            treemap({
              nodes: [
                { nodeId: "root", label: "Repository", values: { loc: 5, edits: 1 } },
                { nodeId: "web", label: "web", parentId: "root", values: { loc: 1, edits: 1 } },
                {
                  nodeId: "server",
                  label: "server",
                  parentId: "root",
                  values: { loc: 1, edits: 1 },
                },
              ],
            }),
          ]),
        ),
      "treemap-value-placement",
    );
  });

  it("rejects a leaf that carries no value", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            treemap({
              nodes: [
                { nodeId: "root", label: "Repository" },
                { nodeId: "web", label: "web", parentId: "root" },
                {
                  nodeId: "server",
                  label: "server",
                  parentId: "root",
                  values: { loc: 1, edits: 1 },
                },
              ],
            }),
          ]),
        ),
      "treemap-value-placement",
    );
  });

  it("rejects a value that is negative", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            treemap({
              nodes: [
                { nodeId: "root", label: "Repository" },
                { nodeId: "web", label: "web", parentId: "root", values: { loc: -1, edits: 1 } },
                {
                  nodeId: "server",
                  label: "server",
                  parentId: "root",
                  values: { loc: 1, edits: 1 },
                },
              ],
            }),
          ]),
        ),
      "treemap-negative-value",
    );
  });

  it("rejects a leaf that names a file the manifest does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            treemap({
              nodes: [
                { nodeId: "root", label: "Repository" },
                {
                  nodeId: "web",
                  label: "web",
                  parentId: "root",
                  sourceId: "99999999-9999-4999-8999-999999999999",
                  values: { loc: 1, edits: 1 },
                },
                {
                  nodeId: "server",
                  label: "server",
                  parentId: "root",
                  values: { loc: 1, edits: 1 },
                },
              ],
            }),
          ]),
        ),
      "missing-source",
    );
  });
});

function heatmapMatrix(overrides: Record<string, unknown> = {}) {
  return {
    blockId: "commits-by-hour",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "heatmap" as const,
    layout: "matrix" as const,
    valueLabel: "Commits",
    scale: "sequential" as const,
    rows: [
      { rowId: "mon", label: "Mon" },
      { rowId: "tue", label: "Tue" },
    ],
    columns: [
      { columnId: "h09", label: "09" },
      { columnId: "h10", label: "10" },
    ],
    cells: [
      { rowId: "mon", columnId: "h09", value: 3 },
      { rowId: "tue", columnId: "h10", value: 6, note: "After the review" },
    ],
    ...overrides,
  };
}

function heatmapCalendar(overrides: Record<string, unknown> = {}) {
  return {
    blockId: "test-failures",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "heatmap" as const,
    layout: "calendar" as const,
    valueLabel: "Test failures",
    scale: "diverging" as const,
    days: [
      { date: "2026-09-01", value: 0 },
      { date: "2026-09-02", value: 3 },
    ],
    ...overrides,
  };
}

describe("heatmap validation", () => {
  it("accepts a matrix whose cells name rows and columns it holds", () => {
    expect(() => validateCanvasDefinition(withBlocks([heatmapMatrix()]))).not.toThrow();
  });

  it("accepts a calendar with one reading per date", () => {
    expect(() => validateCanvasDefinition(withBlocks([heatmapCalendar()]))).not.toThrow();
  });

  it("refuses a heatmap block inside a document declaring an older schema version", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: 4,
          blocks: [heatmapMatrix()],
        }),
      "unsupported-schema-version",
    );
  });

  it("rejects a matrix that lists one row id twice", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            heatmapMatrix({
              rows: [
                { rowId: "mon", label: "Mon" },
                { rowId: "mon", label: "Monday" },
              ],
            }),
          ]),
        ),
      "duplicate-heatmap-row-id",
    );
  });

  it("rejects a cell on a row the matrix does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            heatmapMatrix({
              cells: [{ rowId: "wed", columnId: "h09", value: 1 }],
            }),
          ]),
        ),
      "unknown-heatmap-row",
    );
  });

  it("rejects a cell on a column the matrix does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            heatmapMatrix({
              cells: [{ rowId: "mon", columnId: "h23", value: 1 }],
            }),
          ]),
        ),
      "unknown-heatmap-column",
    );
  });

  it("rejects one coordinate listed more than once", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            heatmapMatrix({
              cells: [
                { rowId: "mon", columnId: "h09", value: 1 },
                { rowId: "mon", columnId: "h09", value: 2 },
              ],
            }),
          ]),
        ),
      "duplicate-heatmap-cell",
    );
  });

  it("rejects a calendar that repeats a date and one that is not a real day", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            heatmapCalendar({
              days: [
                { date: "2026-09-01", value: 1 },
                { date: "2026-09-01", value: 2 },
              ],
            }),
          ]),
        ),
      "duplicate-heatmap-date",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([heatmapCalendar({ days: [{ date: "2026-02-30", value: 1 }] })]),
        ),
      "invalid-schema",
    );
  });

  it("rejects a calendar that spans more days than the budget", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            heatmapCalendar({
              days: [
                { date: "2026-01-01", value: 1 },
                { date: "2031-01-01", value: 2 },
              ],
            }),
          ]),
        ),
      "heatmap-days-budget-exceeded",
    );
  });
});

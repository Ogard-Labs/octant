import { describe, expect, it } from "vitest";
import {
  CANVAS_FLOW_SCHEMA_VERSION,
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_DASHBOARD_CELLS,
  CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH,
  CANVAS_MAX_FUNNEL_STAGES,
  CANVAS_MAX_RADAR_AXES,
  CANVAS_MAX_SANKEY_LINKS,
  CANVAS_MAX_SANKEY_NODES,
  CANVAS_MIN_RADAR_AXES,
  CANVAS_MAX_BAR_LIST_ROWS,
  CANVAS_MAX_DIAGRAM_EDGES,
  CANVAS_MAX_DESIGN_MARKUP_LENGTH,
  CANVAS_MAX_DIAGRAM_NODES,
  CANVAS_MAX_ER_ATTRIBUTES_PER_ENTITY,
  CANVAS_MAX_IMAGES,
  CANVAS_MAX_MATRIX_CELLS,
  CANVAS_MAX_MATRIX_CRITERIA,
  CANVAS_MAX_MATRIX_OPTIONS,
  CANVAS_MAX_MATH_PARAGRAPH_LENGTH,
  CANVAS_MAX_MATH_RUNS,
  CANVAS_MAX_MATH_SOURCE_LENGTH,
  CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION,
  CANVAS_MAX_METRIC_SPARKLINE_POINTS,
  CANVAS_MAX_MINDMAP_NOTE_LENGTH,
  CANVAS_MAX_MOCKUP_DEPTH,
  CANVAS_MAX_MOCKUP_NOTE_LENGTH,
  CANVAS_MOCKUP_LEGACY_MAX_DEPTH,
  CANVAS_MAX_MOCKUP_NODES,
  CANVAS_MAX_MOCKUP_TEXT_LENGTH,
  CANVAS_MAX_SERIES,
  CANVAS_MAX_SWIMLANE_LANES,
  CANVAS_MAX_TABLE_ROWS,
  CANVAS_MAX_TEXT_BYTES,
  CANVAS_MAX_TREEMAP_DEPTH,
  CANVAS_DESIGN_SCHEMA_VERSION,
  CANVAS_HEATMAP_SCHEMA_VERSION,
  CANVAS_PRESENTATION_SCHEMA_VERSION,
  CANVAS_SCHEMA_VERSION,
  CANVAS_THREAD_OWNED_SCHEMA_VERSION,
  CANVAS_TREEMAP_SCHEMA_VERSION,
  decodeCanvasDefinition,
  type CanvasDefinition,
} from "@octant/contracts/canvas";
import {
  appWindowPrototypeExample,
  launchDeckExample,
  onboardingFlowExample,
  searchSpecExample,
} from "./canvasDesignExamples";
import { designBriefExample, launchGanttExample } from "./canvasLayoutExamples";
import { opsDashboardExample, releaseHealthBoardExample } from "./canvasDashboardExamples";
import { mathExamples } from "./canvasMathExamples";
import { mockupExamples } from "./canvasMockupExamples";
import {
  loginSequenceExample,
  orderSchemaExample,
  orderStateExample,
  releaseMindmapExample,
  supportFlowExample,
} from "./canvasDiagramExamples";
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

  it("refuses a Canvas owned by its thread inside a document declaring an older schema version", () => {
    const threadOwned = {
      ...baseDefinition,
      provenance: { ...provenance, projectId: null },
      sourceManifest: [],
    };
    expect(validateCanvasDefinition(threadOwned).provenance.projectId).toBeNull();
    const older = CANVAS_THREAD_OWNED_SCHEMA_VERSION - 1;
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...threadOwned,
          schemaVersion: older,
          blocks: baseDefinition.blocks.map((block) => ({ ...block, schemaVersion: older })),
        }),
      "unsupported-schema-version",
    );
  });

  it("refuses a thread presentation inside a document declaring an older schema version", () => {
    // A rolled-back runtime that reads a newer document must refuse it as a
    // future version, not report the Canvas corrupt.
    expectPolicyCode(
      () =>
        validateCanvasDefinition({ ...baseDefinition, schemaVersion: 3, presentation: "inline" }),
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

  it("refuses two rows of one table with the same id, and a row id under an older version", () => {
    const keyed = (rows: ReadonlyArray<unknown>) => ({ ...table("keyed", []), rows });
    expect(() =>
      validateCanvasDefinition(
        withBlocks([
          keyed([
            { id: "acme", cells: ["Acme"] },
            ["Globex"],
            { id: "initech", cells: ["Initech"] },
          ]),
        ]),
      ),
    ).not.toThrow();
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            keyed([
              { id: "acme", cells: ["Acme"] },
              { id: "acme", cells: ["Again"] },
            ]),
          ]),
        ),
      "duplicate-table-row-id",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([keyed([{ id: "acme", cells: ["Acme", "x"] }])])),
      "table-row-shape",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: 12,
          blocks: [{ ...keyed([{ id: "acme", cells: ["Acme"] }]), schemaVersion: 12 }],
        }),
      "unsupported-schema-version",
    );
    expect(() =>
      validateCanvasDefinition({
        ...baseDefinition,
        schemaVersion: 12,
        blocks: [{ ...table("older", [["Acme"]]), schemaVersion: 12 }],
      }),
    ).not.toThrow();
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

describe("mockup catalog", () => {
  const screen = (overrides: Record<string, unknown> = {}, nodes?: ReadonlyArray<unknown>) => ({
    ...mockup("catalog", []),
    nodes: nodes ?? [
      { nodeId: "page", component: "stack", label: "Settings" },
      { nodeId: "plan", component: "select", label: "Plan", value: "Team", parentId: "page" },
      { nodeId: "save", component: "button", label: "Save", tone: "accent", parentId: "page" },
    ],
    ...overrides,
  });

  it("accepts the examples describe hands an agent", () => {
    expect(mockupExamples.length).toBeGreaterThanOrEqual(2);
    expect(() => validateCanvasDefinition(withBlocks(mockupExamples))).not.toThrow();
  });

  it("refuses the catalog inside a document declaring an older schema version", () => {
    const [example] = mockupExamples;
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: 11,
          blocks: [{ ...example, schemaVersion: 11 }],
        }),
      "unsupported-schema-version",
    );
  });

  it("keeps the version-3 depth for a document declaring an older version", () => {
    const nodes = [mockupNode("n0")];
    for (let index = 1; index < CANVAS_MOCKUP_LEGACY_MAX_DEPTH + 1; index += 1) {
      nodes.push(mockupNode(`n${String(index)}`, `n${String(index - 1)}`));
    }
    const deep = { ...mockup("deep", nodes), schemaVersion: 11 };
    expectPolicyCode(
      () => validateCanvasDefinition({ ...baseDefinition, schemaVersion: 11, blocks: [deep] }),
      "mockup-depth-exceeded",
    );
    expect(() =>
      validateCanvasDefinition(withBlocks([{ ...deep, schemaVersion: CANVAS_SCHEMA_VERSION }])),
    ).not.toThrow();
  });

  it("refuses a field on a component that does not draw it, naming both", () => {
    expect(
      refusalOf(
        screen({}, [{ nodeId: "title", component: "heading", label: "Settings", on: true }]),
      ),
    ).toBe(
      "mockup-field-refused: Canvas mockup catalog gives heading title the on field; only toggle, checkbox, list-row draw it.",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            screen({}, [{ nodeId: "t", component: "text", label: "Hi", columns: ["A"] }]),
          ]),
        ),
      "mockup-field-refused",
    );
  });

  it("keeps reading a version-3 screen that carries on beside a component that does not draw it", () => {
    const legacy = {
      ...mockup("legacy", []),
      schemaVersion: 3,
      nodes: [{ nodeId: "save", component: "button", label: "Save", on: false }],
    };
    expect(() =>
      validateCanvasDefinition({ ...baseDefinition, schemaVersion: 11, blocks: [legacy] }),
    ).not.toThrow();
  });

  it("refuses a table whose rows do not match its columns, or a table with no columns", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            screen({}, [
              {
                nodeId: "t",
                component: "table",
                label: "People",
                columns: ["Name", "Role"],
                rows: [["Ada"]],
              },
            ]),
          ]),
        ),
      "mockup-table-shape",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([screen({}, [{ nodeId: "t", component: "table", label: "People" }])]),
        ),
      "mockup-table-shape",
    );
  });

  it("refuses a custom device without a size, and a size on a preset", () => {
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([screen({ device: "custom" })])),
      "mockup-size-mismatch",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([screen({ device: "phone", size: { width: 400, height: 800 } })]),
        ),
      "mockup-size-mismatch",
    );
    expect(() =>
      validateCanvasDefinition(
        withBlocks([screen({ device: "custom", size: { width: 400, height: 800 } })]),
      ),
    ).not.toThrow();
  });

  it("refuses a root outside the declared variants, a nested variant, and a repeated variant", () => {
    const variants = [
      { variantId: "empty", label: "Empty" },
      { variantId: "error", label: "Error" },
    ];
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            screen({ variants }, [{ nodeId: "a", component: "stack", label: "Somewhere" }]),
          ]),
        ),
      "unknown-mockup-variant",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            screen({}, [{ nodeId: "a", component: "stack", label: "A", variantId: "empty" }]),
          ]),
        ),
      "unknown-mockup-variant",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            screen({ variants }, [
              { nodeId: "a", component: "stack", label: "A", variantId: "empty" },
              { nodeId: "b", component: "text", label: "B", parentId: "a", variantId: "error" },
            ]),
          ]),
        ),
      "mockup-field-refused",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            screen({ variants: [variants[0], variants[0]] }, [
              { nodeId: "a", component: "stack", label: "A", variantId: "empty" },
            ]),
          ]),
        ),
      "duplicate-mockup-variant",
    );
  });

  it("refuses a callout on a node the mockup lacks, or two callouts on one node", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([screen({ annotations: [{ nodeId: "missing", note: "Why" }] })]),
        ),
      "dangling-mockup-annotation",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            screen({
              annotations: [
                { nodeId: "save", note: "One" },
                { nodeId: "save", note: "Two" },
              ],
            }),
          ]),
        ),
      "duplicate-mockup-annotation",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            screen({
              annotations: [
                { nodeId: "save", note: "x".repeat(CANVAS_MAX_MOCKUP_NOTE_LENGTH + 1) },
              ],
            }),
          ]),
        ),
      "mockup-text-budget-exceeded",
    );
  });
});

function design(frames: ReadonlyArray<{ frameId: string; html: string }>, styles?: string) {
  return {
    blockId: "design",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "design" as const,
    title: "Checkout",
    size: "phone" as const,
    ...(styles === undefined ? {} : { styles }),
    frames: frames.map((frame) => ({ ...frame, title: frame.frameId })),
  };
}

function refusalOf(block: unknown): string {
  try {
    validateCanvasDefinition(withBlocks([block]));
  } catch (error) {
    if (error instanceof CanvasPolicyRejected) return `${error.code}: ${error.message}`;
    throw error;
  }
  return "accepted";
}

describe("design frames", () => {
  it("accepts the examples an agent is taught from", () => {
    expect(() =>
      validateCanvasDefinition(
        withBlocks([onboardingFlowExample, launchDeckExample, searchSpecExample]),
      ),
    ).not.toThrow();
  });

  it("accepts the running app window example and a full 64 KiB screen with its script", () => {
    expect(() => validateCanvasDefinition(withBlocks([appWindowPrototypeExample]))).not.toThrow();
    const html = `<div>${"<p>Row</p>".repeat(6_000)}</div><script>var rows = 6000;</script>`;
    const large = {
      ...appWindowPrototypeExample,
      styles: "p { margin: 0; }".repeat(4_000),
      frames: [
        { frameId: "app", title: "App", html: html.padEnd(CANVAS_MAX_DESIGN_MARKUP_LENGTH) },
      ],
    };
    const started = performance.now();
    expect(refusalOf(large)).toBe("accepted");
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("still bounds a design by the Canvas text budget when every frame is full", () => {
    const frame = (frameId: string) => ({
      frameId,
      title: frameId,
      html: "<p>x</p>".padEnd(CANVAS_MAX_DESIGN_MARKUP_LENGTH),
    });
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...appWindowPrototypeExample,
              frames: [frame("a"), frame("b"), frame("c"), frame("d"), frame("e")],
            },
          ]),
        ),
      "text-budget-exceeded",
    );
  });

  it("refuses a design document or theme inside a document declaring version 15", () => {
    // An older runtime must read these as a newer document, not draw an
    // article as a phone screen or a themed screen without its theme.
    for (const block of [
      searchSpecExample,
      { ...onboardingFlowExample, theme: "workspace" },
      { ...onboardingFlowExample, theme: "none" },
    ]) {
      expectPolicyCode(
        () =>
          validateCanvasDefinition({
            ...baseDefinition,
            schemaVersion: 15,
            blocks: [{ ...block, schemaVersion: 15 }],
          }),
        "unsupported-schema-version",
      );
    }
    expect(() =>
      validateCanvasDefinition({
        ...baseDefinition,
        schemaVersion: 15,
        blocks: [{ ...onboardingFlowExample, schemaVersion: 15 }],
      }),
    ).not.toThrow();
  });

  it("keeps refusing script and outside links in a themed document", () => {
    const frame = searchSpecExample.frames[0];
    for (const html of [
      `${frame?.html ?? ""}<script>parent.document.title = "x"</script>`,
      '<img src="x" onerror="parent.location = \'https://example.test\'">',
      '<a href="https://example.test">Docs</a>',
      '<meta http-equiv="refresh" content="0;url=https://example.test">',
      '<base href="https://example.test/">',
      '<iframe srcdoc="<p>x</p>"></iframe>',
      '<p style="background: url(https://example.test/a.png)">x</p>',
    ]) {
      expectPolicyCode(
        () =>
          validateCanvasDefinition(
            withBlocks([
              { ...searchSpecExample, frames: [{ frameId: "spec", title: "Spec", html }] },
            ]),
          ),
        "design-markup-refused",
      );
    }
  });

  it("refuses a design block inside a document declaring an older schema version", () => {
    // A design arrived at version 9, after every earlier block kind and hint.
    for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(() =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion,
          blocks: [onboardingFlowExample],
        }),
      ).toThrow(expect.objectContaining({ code: "unsupported-schema-version" }));
    }
  });

  it("refuses markup that would need a script, naming the frame", () => {
    expect(
      refusalOf(design([{ frameId: "pay", html: "<p>Hi</p><script>alert(1)</script>" }])),
    ).toBe(
      "design-markup-refused: Canvas design design frame pay uses a <script> element; design frames run no script and load no other document.",
    );
    expect(
      refusalOf(design([{ frameId: "pay", html: '<button onclick="go()">Pay</button>' }])),
    ).toContain("has an onclick handler");
    expect(
      refusalOf(
        design([
          {
            frameId: "pay",
            html: '<svg><a href="#x"><set attributeName="href" to="https://x.test"/></a></svg>',
          },
        ]),
      ),
    ).toContain("uses a <set> element");
  });

  it("refuses every link that would leave the design, however it is spelled", () => {
    for (const html of [
      '<a href="https://example.test">Shop</a>',
      "<a href=//example.test>Shop</a>",
      '<a HREF="&#104;ttps://example.test">Shop</a>',
      '<a href="javascript:void(0)">Shop</a>',
      '<a href="https://example.test>Shop</a>',
      '<svg><a xlink:href="https://example.test"><text>Shop</text></a></svg>',
      // A quote inside an attribute name is still an attribute to a browser, so
      // the link after it is real. An empty or quote-led address resolves
      // against Octant's own page and would load it into the frame.
      '<a x"y href="">Shop</a>',
      '<a x"y href>Shop</a>',
      '<a x"y href=>Shop</a>',
      `<a x"y href="'//example.test/a">Shop</a>`,
      // An empty fragment clears the shown frame, so Play falls back to the
      // first screen instead of the top of this one.
      '<a href="#">Top</a>',
    ]) {
      expect(refusalOf(design([{ frameId: "home", html }]))).toMatch(
        /^design-markup-refused: .*(links to|leaves the design)/,
      );
    }
  });

  it("reads a frame full of unclosed tags in about the time it takes to read it once", () => {
    const started = performance.now();
    expect(refusalOf(design([{ frameId: "home", html: "<a ".repeat(10_000) }]))).toBe("accepted");
    // A pattern that paired quotes across the whole frame took over a second
    // here, and every renderer validates a Canvas when it draws one.
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("still reads the markup after a quote that opens inside text a browser never reads as a tag", () => {
    // A browser reads a textarea, an xmp, or a CDATA section as text, so the
    // quote in each opens no value and the element after it is drawn.
    for (const html of [
      '<textarea><x a="</textarea><svg><style><meta http-equiv=refresh content=0;url=https://x.test/></style></svg>',
      '<textarea><x a="</textarea><svg><a><set attributeName=href to=https://x.test/ /><text>Go</text></a></svg>',
      "<xmp><x a='</xmp><script>alert(1)</script>",
      '<svg><![CDATA[<x a="]]></svg><meta http-equiv=refresh content=0;url=https://x.test/>',
    ]) {
      expect(refusalOf(design([{ frameId: "home", html }]))).toMatch(
        /^design-markup-refused: .*uses a <(meta|set|script)> element/,
      );
    }
    const started = performance.now();
    expect(refusalOf(design([{ frameId: "home", html: `<a x="${"<b y='".repeat(10_000)}` }]))).toBe(
      "accepted",
    );
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("keeps links between frames and sections, and the attributes that only look like them", () => {
    expect(
      refusalOf(
        design([
          {
            frameId: "home",
            html: '<a href="#pay">Pay</a><details open><summary>More</summary></details><div data-href="x"></div>',
          },
          { frameId: "pay", html: '<a href="#home">Back</a>' },
        ]),
      ),
    ).toBe("accepted");
  });

  it("refuses a remote stylesheet or image however its CSS escapes spell it", () => {
    const home = [{ frameId: "home", html: "<p>Hi</p>" }];
    for (const styles of [
      String.raw`@\69mport "https://fonts.test/a.css";`,
      String.raw`@\49 MPORT url(https://fonts.test/a.css);`,
      String.raw`@i\mport "https://fonts.test/a.css";`,
    ]) {
      expect(refusalOf(design(home, styles))).toContain("stylesheet imports a stylesheet");
    }
    for (const styles of [
      String.raw`.hero { background: u\72l(https://x.test/a.png); }`,
      String.raw`.hero { background: \75 \72 \6c (https://x.test/a.png); }`,
      String.raw`.hero { background: url("\68ttps://x.test/a.png"); }`,
    ]) {
      expect(refusalOf(design(home, styles))).toContain("loads a file with url()");
    }
    expect(
      refusalOf(
        design([
          {
            frameId: "home",
            html: String.raw`<div style="background:u\72l(https://x.test/a.png)"></div>`,
          },
        ]),
      ),
    ).toContain("loads a file with url()");
    // An escaped character that is not a load stays as written.
    expect(refusalOf(design(home, String.raw`.a::before { content: "\2014"; }`))).toBe("accepted");
  });

  it("reads a long run of CSS escapes in about the time it takes to read it once", () => {
    const started = performance.now();
    expect(
      refusalOf(
        design([{ frameId: "home", html: "<p>Hi</p>" }], `.a{content:"${"\\41 ".repeat(5_000)}"}`),
      ),
    ).toBe("accepted");
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("refuses a remote load in markup however its character references spell it", () => {
    // A browser resolves character references in an attribute value, and in an
    // SVG style element, before it reads the CSS inside.
    for (const html of [
      '<div style="background:ur&#108;(https://x.test/a.png)"></div>',
      '<div style="background:ur&#108(https://x.test/a.png)"></div>',
      '<div style="background:u&#x72;l(https://x.test/a.png)"></div>',
      '<div style="background:url&lpar;https://x.test/a.png)"></div>',
      '<div style="background:u&bsol;72l(https://x.test/a.png)"></div>',
    ]) {
      expect(refusalOf(design([{ frameId: "home", html }]))).toContain("loads a file with url()");
    }
    expect(
      refusalOf(
        design([
          {
            frameId: "home",
            html: '<svg><style>&commat;import "https://fonts.test/a.css";</style></svg>',
          },
        ]),
      ),
    ).toContain("imports a stylesheet");
    expect(
      refusalOf(
        design([
          {
            frameId: "home",
            html: '<p style="background:url(&quot;data:image/png;base64,AAAA&quot;)">Tom &amp; Jerry</p>',
          },
        ]),
      ),
    ).toBe("accepted");
  });

  it("refuses a remote image-set candidate, quoted or not, and keeps inline ones", () => {
    const home = [{ frameId: "home", html: "<p>Hi</p>" }];
    for (const styles of [
      '.hero { background-image: image-set("https://x.test/a.png" 1x); }',
      ".hero { background-image: -webkit-image-set('https://x.test/a.png' 1x); }",
      '.hero { background-image: image-set("data:image/png;base64,AA" 1x, "https://x.test/b.png" 2x); }',
      String.raw`.hero { background-image: image-set("\68ttps://x.test/a.png" 1x); }`,
      // A quote in a comment or an escaped one in a string starts no string.
      `/* don't */ .hero { background-image: image-set("https://x.test/a.png" 1x); }`,
      String.raw`.a::before { content: "a\"b"; } .hero { background-image: image-set("https://x.test/a.png" 1x); }`,
    ]) {
      expect(refusalOf(design(home, styles))).toContain("loads a file with image-set()");
    }
    // A quote in the prose around a style element is not CSS, and a browser
    // resolves a legacy `&quot` without its semicolon in an attribute.
    for (const html of [
      `<p>Don't wait</p><style>.hero{background-image:image-set("https://x.test/a.png" 1x)}</style>`,
      `<p>A 5" screen</p><style>.hero{background-image:image-set("https://x.test/a.png" 1x)}</style>`,
      '<div style="background-image:image-set(&quot https://x.test/a.png&quot 1x)"></div>',
    ]) {
      expect(refusalOf(design([{ frameId: "home", html }]))).toContain(
        "loads a file with image-set()",
      );
    }
    expect(
      refusalOf(
        design([
          {
            frameId: "home",
            html: '<div style="background-image:IMAGE-SET(&quot;https://x.test/a.png&quot; 1x)"></div>',
          },
        ]),
      ),
    ).toContain("loads a file with image-set()");
    // A type() hint and a family list hold strings that are not addresses.
    expect(
      refusalOf(
        design(
          home,
          '.hero { font-family: "Inter", "Helvetica"; background-image: image-set("data:image/png;base64,AA" 1x type("image/png"), linear-gradient(red, blue) 2x); }',
        ),
      ),
    ).toBe("accepted");
  });

  it("reads a long run of character references or open image-sets in about the time it takes to read it once", () => {
    const started = performance.now();
    expect(refusalOf(design([{ frameId: "home", html: `<p>${"&#108;".repeat(5_000)}</p>` }]))).toBe(
      "accepted",
    );
    expect(
      refusalOf(design([{ frameId: "home", html: "<p>Hi</p>" }], "image-set(".repeat(3_000))),
    ).toBe("accepted");
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("refuses remote images and stylesheets but keeps inline ones", () => {
    expect(
      refusalOf(
        design([{ frameId: "home", html: '<img src="https://example.test/a.png" alt="">' }]),
      ),
    ).toContain("images must be data:image URLs");
    // A browser may pick any candidate of a srcset, so every one must be inline.
    expect(
      refusalOf(
        design([
          {
            frameId: "home",
            html: '<img srcset="data:image/png;base64,AA,BB 1x, https://example.test/a.png 2x" alt="">',
          },
        ]),
      ),
    ).toContain("images must be data:image URLs");
    expect(
      refusalOf(
        design([
          {
            frameId: "home",
            html: '<img srcset="data:image/png;base64,AA,BB 1x,data:image/png;base64,CC 2x" alt="">',
          },
        ]),
      ),
    ).toBe("accepted");
    expect(
      refusalOf(
        design([{ frameId: "home", html: "<p>Hi</p>" }], "@import url(https://fonts.test/a.css);"),
      ),
    ).toContain("stylesheet imports a stylesheet");
    expect(
      refusalOf(
        design([
          { frameId: "home", html: '<div style="background:url(https://x.test/a.png)"></div>' },
        ]),
      ),
    ).toContain("loads a file with url()");
    expect(
      refusalOf(design([{ frameId: "home", html: "<p>Hi</p>" }], "</style><p>out</p>")),
    ).toContain("closes its own style element");
    expect(
      refusalOf(
        design(
          [{ frameId: "home", html: '<img src="data:image/png;base64,AAAA" alt="">' }],
          ".hero { background: url(data:image/png;base64,AAAA); }",
        ),
      ),
    ).toBe("accepted");
  });

  it("draws a declared asset from src, srcset, url(), and image-set(), and refuses an undeclared one", () => {
    const hero = { assetId: "hero", source: { kind: "generated-image", imageId: ids.source } };
    const withAssets = (
      frames: ReadonlyArray<{ frameId: string; html: string }>,
      styles?: string,
    ) => ({ ...design(frames, styles), assets: [hero] });
    expect(
      refusalOf(
        withAssets(
          [
            {
              frameId: "home",
              html: [
                '<img src="octant-asset:hero" alt="">',
                '<img srcset="octant-asset:hero 1x, data:image/png;base64,AA 2x" alt="">',
                '<div style="background:url(octant-asset:hero)"></div>',
                '<div style="background-image:image-set(&quot;octant-asset:hero&quot; 1x)"></div>',
                '<style>.a{background:url("octant-asset:hero")}</style>',
              ].join(""),
            },
          ],
          ".hero { background: url('octant-asset:hero'); } .b { background-image: image-set(\"octant-asset:hero\" 2x); }",
        ),
      ),
    ).toBe("accepted");
    for (const html of [
      '<img src="octant-asset:other" alt="">',
      '<img srcset="octant-asset:hero 1x, octant-asset:other 2x" alt="">',
      '<div style="background:url(octant-asset:other)"></div>',
      '<style>.a{background-image:image-set("octant-asset:other" 1x)}</style>',
    ]) {
      expect(refusalOf(withAssets([{ frameId: "home", html }]))).toMatch(
        /^design-markup-refused: .*"other", which the design does not declare/,
      );
    }
    // A design that declares nothing names no asset.
    expect(
      refusalOf(design([{ frameId: "home", html: '<img src="octant-asset:hero" alt="">' }])),
    ).toContain("does not declare");
    expect(
      refusalOf(
        withAssets(
          [{ frameId: "home", html: "<p>Hi</p>" }],
          ".a{background:url(octant-asset:other)}",
        ),
      ),
    ).toContain("stylesheet uses the asset");
  });

  it("refuses an asset reference spelled through a character reference or CSS escape", () => {
    const hero = { assetId: "hero", source: { kind: "generated-image", imageId: ids.source } };
    const withAssets = (html: string, styles?: string) => ({
      ...design([{ frameId: "home", html }], styles),
      assets: [hero],
    });
    for (const html of [
      // The renderer replaces only the literal spelling; a browser would try to
      // load any other, which the frame policy blocks but the author would not see.
      '<div style="background:url(octant&#45;asset:hero)"></div>',
      '<div style="background:url(octant-asset&colon;hero)"></div>',
      '<div style="background:url(&#111;ctant-asset:hero)"></div>',
      String.raw`<div style="background:url(octant\2d asset:hero)"></div>`,
      String.raw`<style>.a{background-image:image-set("\6f ctant-asset:hero" 1x)}</style>`,
      String.raw`<style>.a{background:u\72l(octant-asset\3a hero)}</style>`,
    ]) {
      expect(refusalOf(withAssets(html))).toContain("spells an octant-asset: reference");
    }
    for (const styles of [
      String.raw`.a { background: url(octant\-asset:hero); }`,
      String.raw`.a { background-image: image-set("octant-asset\3a hero" 1x); }`,
    ]) {
      expect(refusalOf(withAssets("<p>Hi</p>", styles))).toContain(
        "spells an octant-asset: reference",
      );
    }
    // An attribute is read as written, so a reference in a source attribute
    // must be literal too.
    for (const html of [
      '<img src="octant-asset&#58;hero" alt="">',
      '<img src="OCTANT-ASSET:hero" alt="">',
    ]) {
      expect(refusalOf(withAssets(html))).toMatch(/^design-markup-refused: /);
    }
    expect(
      refusalOf(withAssets("<p>Hi</p>", ".a { background: url(OCTANT-ASSET:hero); }")),
    ).toContain("loads a file with url()");
  });

  it("keeps refusing every remote load in a design that declares assets", () => {
    const withAssets = (html: string, styles?: string) => ({
      ...design([{ frameId: "home", html }], styles),
      assets: [{ assetId: "hero", source: { kind: "generated-image", imageId: ids.source } }],
    });
    for (const html of [
      '<img src="https://x.test/hero.png" alt="">',
      '<img srcset="octant-asset:hero 1x, https://x.test/a.png 2x" alt="">',
      '<div style="background:url(https://x.test/a.png)"></div>',
      '<div style="background:ur&#108;(https://x.test/a.png)"></div>',
      '<style>.a{background-image:image-set("https://x.test/a.png" 1x)}</style>',
      '<img src="octant-asset:https://x.test/a.png" alt="">',
    ]) {
      expect(refusalOf(withAssets(html))).toMatch(/^design-markup-refused: /);
    }
    expect(refusalOf(withAssets("<p>Hi</p>", "@import url(octant-asset:hero);"))).toContain(
      "imports a stylesheet",
    );
  });

  it("refuses a Project file asset in a Chat Canvas, a path that leaves the folder, and a repeated id", () => {
    const work = (assets: ReadonlyArray<unknown>, mode: "chat" | "work" | "code" = "work") => {
      try {
        validateCanvasDefinition({
          ...baseDefinition,
          provenance: { ...baseDefinition.provenance, mode },
          blocks: [
            {
              ...design([{ frameId: "home", html: '<img src="octant-asset:shot" alt="">' }]),
              assets,
            },
          ],
        });
      } catch (error) {
        if (error instanceof CanvasPolicyRejected) return `${error.code}: ${error.message}`;
        throw error;
      }
      return "accepted";
    };
    const file = (path: string) => [{ assetId: "shot", source: { kind: "project-file", path } }];
    expect(work(file("screens/home.png"))).toBe("accepted");
    expect(work(file("screens/home.png"), "code")).toBe("accepted");
    expect(work(file("screens/home.png"), "chat")).toMatch(
      /^design-asset-refused: .*a Chat Project has no folder/,
    );
    for (const path of ["../secrets.png", "screens/../../x.png", "/etc/hosts", "a\\b.png"]) {
      expect(work(file(path))).toMatch(/^design-asset-refused: .*stay inside it/);
    }
    expect(
      work([
        ...file("a.png"),
        { assetId: "shot", source: { kind: "generated-image", imageId: ids.source } },
      ]),
    ).toMatch(/^design-asset-refused: .*declares the asset shot twice/);
    // A generated image is the one source a Chat Project has.
    expect(
      work([{ assetId: "shot", source: { kind: "generated-image", imageId: ids.source } }], "chat"),
    ).toBe("accepted");
  });

  it("refuses design assets inside a document declaring version 16", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: 16,
          blocks: [
            {
              ...design([{ frameId: "home", html: '<img src="octant-asset:hero" alt="">' }]),
              schemaVersion: 16,
              assets: [
                { assetId: "hero", source: { kind: "generated-image", imageId: ids.source } },
              ],
            },
          ],
        }),
      "unsupported-schema-version",
    );
    expect(() =>
      validateCanvasDefinition({
        ...baseDefinition,
        schemaVersion: 16,
        blocks: [{ ...design([{ frameId: "home", html: "<p>Hi</p>" }]), schemaVersion: 15 }],
      }),
    ).not.toThrow();
  });

  it("admits inline script and event handlers only in a design that declares it runs script", () => {
    const html = [
      "<p id=count>0</p>",
      '<button onclick="add()">Add</button>',
      "<script>let n = 0; function add() { n += 1; count.textContent = String(n); }",
      "const url = new URL(location.href); if (n<1) { console.log(url) }</script>",
    ].join("");
    const running = { ...design([{ frameId: "cart", html }]), runsScript: true };
    expect(refusalOf(running)).toBe("accepted");
    // The same markup in a static design still runs nothing.
    expect(refusalOf(design([{ frameId: "cart", html }]))).toMatch(
      /^design-markup-refused: .*(onclick handler|<script> element)/,
    );
  });

  it("keeps refusing every remote load, page policy, embedded document, and outside link in a running design", () => {
    const run = (html: string, styles?: string) =>
      refusalOf({ ...design([{ frameId: "cart", html }], styles), runsScript: true });
    for (const html of [
      '<script src="https://cdn.test/app.js"></script>',
      "<script src=data:text/javascript,alert(1)></script>",
      '<meta http-equiv="refresh" content="0;url=https://example.test">',
      '<base href="https://example.test/">',
      '<link rel="stylesheet" href="https://example.test/a.css">',
      '<iframe srcdoc="<p>hi</p>"></iframe>',
      '<object data="x.pdf"></object>',
      '<embed src="x.swf">',
      '<a href="https://example.test">Out</a>',
      '<a href="javascript:alert(1)">Run</a>',
      '<img src="https://example.test/pixel.png" alt="">',
      '<div style="background:url(https://example.test/a.png)"></div>',
      '<form action="https://example.test"><button>Go</button></form>',
      "<script>1</script><style>@import url(https://example.test/a.css);</style>",
      // A script opener the browser never reads as one hides nothing after it.
      '<!-- <script> --><img src="https://example.test/x.png" alt="">',
      '<?x <script><img src="https://example.test/x.png" alt="">',
      '<p title="<script>"></p><img src="https://example.test/x.png" alt="">',
      '<scripts></scripts><img src="https://example.test/x.png" alt="">',
      '<style>/* <script> */</style><img src="https://example.test/x.png" alt="">',
      '<textarea><script></textarea><img src="https://example.test/x.png" alt="">',
    ]) {
      expect(run(html)).toMatch(/^design-markup-refused: /);
    }
    expect(run("<p>Hi</p>", ".a { background: url(https://example.test/a.png); }")).toMatch(
      /^design-markup-refused: .*stylesheet/,
    );
  });

  it("refuses a running design drawn in the workspace theme, which only the reader can write", () => {
    expect(
      refusalOf({
        ...design([{ frameId: "cart", html: "<p>Hi</p>" }]),
        runsScript: true,
        theme: "workspace",
      }),
    ).toMatch(/^design-run-refused: /);
  });

  it("refuses a chart callout inside a document declaring version 21 as a future version", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: 21,
          blocks: [
            {
              blockId: "growth",
              schemaVersion: 21,
              kind: "chart",
              chartType: "bar",
              series: [
                {
                  seriesId: "net",
                  label: "Net new",
                  points: [{ x: "Sep", y: 210, note: "+210", emphasis: true }],
                },
              ],
            },
          ],
        }),
      "unsupported-schema-version",
    );
  });

  it("refuses a running design inside a document declaring version 17", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: 17,
          blocks: [
            {
              ...design([{ frameId: "cart", html: "<p>Hi</p>" }]),
              schemaVersion: 17,
              runsScript: true,
            },
          ],
        }),
      "unsupported-schema-version",
    );
  });

  it("refuses two frames with one id, since a link could only reach the first", () => {
    expect(
      refusalOf(
        design([
          { frameId: "home", html: "<p>A</p>" },
          { frameId: "home", html: "<p>B</p>" },
        ]),
      ),
    ).toMatch(/^duplicate-design-frame-id:/);
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

  it("refuses a treemap inside a document declaring an older schema version", () => {
    // A treemap arrived at version 5: a v4 document that carries one is a
    // rolled-back runtime's future-version failure, not a corrupt document.
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: CANVAS_PRESENTATION_SCHEMA_VERSION,
          blocks: [treemap()],
        }),
      "unsupported-schema-version",
    );
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
    // A heatmap arrived at version 6: a presentation-era v4 document and a
    // treemap-era v5 document that carry one fail closed as declared future
    // versions.
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: CANVAS_PRESENTATION_SCHEMA_VERSION,
          blocks: [heatmapMatrix()],
        }),
      "unsupported-schema-version",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: CANVAS_TREEMAP_SCHEMA_VERSION,
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

function barList(overrides: Record<string, unknown> = {}) {
  return {
    blockId: "hottest-files",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "bar-list" as const,
    valueLabel: "Edits",
    format: "number" as const,
    scale: "sequential" as const,
    rows: [
      { label: "apps/web", value: 41, secondaryValue: 1189 },
      { label: "packages/domain", value: 33, secondaryValue: 1255 },
    ],
    ...overrides,
  };
}

describe("bar list validation", () => {
  it("accepts a ranked list of unique labels with magnitudes", () => {
    expect(() => validateCanvasDefinition(withBlocks([barList()]))).not.toThrow();
  });

  it("refuses a bar list inside a document declaring an older schema version", () => {
    // A bar list arrived at version 7: a treemap-era v5 document and a
    // heatmap-era v6 document that carry one fail closed as declared future
    // versions, not as corrupt documents.
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: CANVAS_TREEMAP_SCHEMA_VERSION,
          blocks: [barList()],
        }),
      "unsupported-schema-version",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: CANVAS_HEATMAP_SCHEMA_VERSION,
          blocks: [barList()],
        }),
      "unsupported-schema-version",
    );
  });

  it("rejects a list that names one label twice", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            barList({
              rows: [
                { label: "apps/web", value: 1 },
                { label: "apps/web", value: 2 },
              ],
            }),
          ]),
        ),
      "duplicate-bar-list-label",
    );
  });

  it("rejects a value or a second value that is negative", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(withBlocks([barList({ rows: [{ label: "app", value: -1 }] })])),
      "bar-list-negative-value",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([barList({ rows: [{ label: "app", value: 1, secondaryValue: -2 }] })]),
        ),
      "bar-list-negative-value",
    );
  });

  it("rejects a list past the row budget", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            barList({
              rows: Array.from({ length: CANVAS_MAX_BAR_LIST_ROWS + 1 }, (_value, index) => ({
                label: `row-${String(index)}`,
                value: index,
              })),
            }),
          ]),
        ),
      "bar-list-rows-budget-exceeded",
    );
  });

  it("rejects a row that names a file the manifest does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            barList({
              rows: [
                {
                  label: "apps/web",
                  value: 1,
                  sourceId: "99999999-9999-4999-8999-999999999999",
                },
              ],
            }),
          ]),
        ),
      "missing-source",
    );
  });
});

function comparisonMatrix(overrides: Record<string, unknown> = {}) {
  return {
    blockId: "state-store",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "comparison-matrix" as const,
    options: [
      { optionId: "sqlite", label: "SQLite" },
      { optionId: "postgres", label: "Postgres" },
    ],
    criteria: [
      { criterionId: "durability", label: "Crash safety", weight: 3 },
      { criterionId: "offline", label: "Works offline" },
    ],
    cells: [
      { criterionId: "durability", optionId: "sqlite", score: 5 },
      { criterionId: "durability", optionId: "postgres", score: 4 },
      { criterionId: "offline", optionId: "sqlite", glyph: "yes" },
    ],
    scoreRange: { min: 1, max: 5 },
    recommendedOptionId: "sqlite",
    ...overrides,
  };
}

describe("comparison matrix validation", () => {
  it("accepts options and criteria whose cells all resolve", () => {
    expect(() => validateCanvasDefinition(withBlocks([comparisonMatrix()]))).not.toThrow();
  });

  it("refuses a comparison matrix inside a document declaring an older schema version", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: CANVAS_DESIGN_SCHEMA_VERSION,
          blocks: [comparisonMatrix()],
        }),
      "unsupported-schema-version",
    );
    // The bump keeps the previous version readable: a design-era document
    // without a matrix still validates.
    expect(() =>
      validateCanvasDefinition({
        ...baseDefinition,
        schemaVersion: CANVAS_DESIGN_SCHEMA_VERSION,
        blocks: [{ ...onboardingFlowExample, schemaVersion: CANVAS_DESIGN_SCHEMA_VERSION }],
      }),
    ).not.toThrow();
  });

  it("refuses an id used twice, including an option and a criterion sharing one", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            comparisonMatrix({
              options: [
                { optionId: "sqlite", label: "SQLite" },
                { optionId: "sqlite", label: "SQLite again" },
              ],
            }),
          ]),
        ),
      "duplicate-matrix-id",
    );
    // Rows and columns share the node anchor a comment lands on, so one id
    // naming both would leave the comment's place ambiguous.
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            comparisonMatrix({
              criteria: [{ criterionId: "sqlite", label: "Is it SQLite" }],
              cells: [],
            }),
          ]),
        ),
      "duplicate-matrix-id",
    );
  });

  it("refuses a cell or a recommendation that names an option or criterion the matrix lacks", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            comparisonMatrix({
              cells: [{ criterionId: "durability", optionId: "mysql", score: 3 }],
            }),
          ]),
        ),
      "unknown-matrix-option",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            comparisonMatrix({
              cells: [{ criterionId: "price", optionId: "sqlite", score: 3 }],
            }),
          ]),
        ),
      "unknown-matrix-criterion",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(withBlocks([comparisonMatrix({ recommendedOptionId: "mysql" })])),
      "unknown-matrix-option",
    );
  });

  it("refuses a coordinate listed twice", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            comparisonMatrix({
              cells: [
                { criterionId: "durability", optionId: "sqlite", score: 5 },
                { criterionId: "durability", optionId: "sqlite", text: "five" },
              ],
            }),
          ]),
        ),
      "duplicate-matrix-cell",
    );
  });

  it("refuses a score outside the declared range", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            comparisonMatrix({
              cells: [{ criterionId: "durability", optionId: "sqlite", score: 7 }],
            }),
          ]),
        ),
      "matrix-score-out-of-range",
    );
  });

  it("names the budget an oversized matrix exceeds", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            comparisonMatrix({
              options: Array.from({ length: CANVAS_MAX_MATRIX_OPTIONS + 1 }, (_value, index) => ({
                optionId: `option-${String(index)}`,
                label: `Option ${String(index)}`,
              })),
            }),
          ]),
        ),
      "matrix-options-budget-exceeded",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            comparisonMatrix({
              criteria: Array.from({ length: CANVAS_MAX_MATRIX_CRITERIA + 1 }, (_value, index) => ({
                criterionId: `criterion-${String(index)}`,
                label: `Criterion ${String(index)}`,
              })),
            }),
          ]),
        ),
      "matrix-criteria-budget-exceeded",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            comparisonMatrix({
              cells: Array.from({ length: CANVAS_MAX_MATRIX_CELLS + 1 }, () => ({
                criterionId: "durability",
                optionId: "sqlite",
                score: 1,
              })),
            }),
          ]),
        ),
      "matrix-cells-budget-exceeded",
    );
  });
});

describe("metric validation", () => {
  function metric(overrides: Record<string, unknown> = {}) {
    return {
      blockId: "repo-lines",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "metric" as const,
      label: "Lines of code",
      value: 1_360_000,
      format: "compact" as const,
      delta: 12_400,
      goodDirection: "up" as const,
      sparkline: [1, 2, 3],
      caption: "since last release",
      ...overrides,
    };
  }

  it("accepts a metric with a direction, a sparkline, and a caption", () => {
    expect(() => validateCanvasDefinition(withBlocks([metric()]))).not.toThrow();
  });

  it("refuses the new metric fields inside a document declaring an older schema version", () => {
    // A sparkline, a direction, and a caption arrived at version 7; a v6
    // document carrying one fails closed as a declared future version.
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: CANVAS_HEATMAP_SCHEMA_VERSION,
          blocks: [metric({ schemaVersion: CANVAS_HEATMAP_SCHEMA_VERSION })],
        }),
      "unsupported-schema-version",
    );
  });

  it("rejects a sparkline longer than the budget", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            metric({
              sparkline: Array.from(
                { length: CANVAS_MAX_METRIC_SPARKLINE_POINTS + 1 },
                (_value, index) => index,
              ),
            }),
          ]),
        ),
      "metric-sparkline-budget-exceeded",
    );
  });
});

describe("entity-relationship, swimlane, and mind map validation", () => {
  it("accepts the entity-relationship, swimlane, and mind map examples", () => {
    for (const block of [orderSchemaExample, supportFlowExample, releaseMindmapExample]) {
      expect(() => validateCanvasDefinition(withBlocks([block]))).not.toThrow();
    }
  });

  it("rejects an entity-relationship that names an entity it does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...orderSchemaExample,
              relationships: [{ ...orderSchemaExample.relationships[0], target: "missing" }],
            },
          ]),
        ),
      "dangling-edge",
    );
  });

  it("rejects an entity-relationship with more attributes than an entity may carry", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...orderSchemaExample,
              entities: [
                {
                  ...orderSchemaExample.entities[0],
                  attributes: Array.from(
                    { length: CANVAS_MAX_ER_ATTRIBUTES_PER_ENTITY + 1 },
                    (_value, index) => ({
                      attributeId: `a-${String(index)}`,
                      name: `field_${String(index)}`,
                      type: "text",
                    }),
                  ),
                },
              ],
            },
          ]),
        ),
      "er-attribute-budget-exceeded",
    );
  });

  it("rejects a swimlane step placed in a lane the block does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...supportFlowExample,
              steps: [{ stepId: "orphan", laneId: "nowhere", label: "Lost" }],
            },
          ]),
        ),
      "unknown-swimlane-lane",
    );
  });

  it("rejects a swimlane connection to a step the block does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...supportFlowExample,
              connections: [{ connectionId: "gap", source: "report", target: "missing" }],
            },
          ]),
        ),
      "dangling-edge",
    );
  });

  it("rejects a swimlane with more lanes than the lane budget", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...supportFlowExample,
              lanes: Array.from({ length: CANVAS_MAX_SWIMLANE_LANES + 1 }, (_value, index) => ({
                laneId: `lane-${String(index)}`,
                label: `Lane ${String(index)}`,
              })),
              steps: [],
              connections: [],
            },
          ]),
        ),
      "swimlane-lanes-budget-exceeded",
    );
  });

  it("rejects a mind map that nests a topic inside itself", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...releaseMindmapExample,
              nodes: [
                { nodeId: "root", label: "Root" },
                { nodeId: "a", label: "A", parentId: "b" },
                { nodeId: "b", label: "B", parentId: "a" },
              ],
            },
          ]),
        ),
      "mindmap-nesting-cycle",
    );
  });

  it("rejects a mind map with more than one root topic", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...releaseMindmapExample,
              nodes: [
                { nodeId: "one", label: "One" },
                { nodeId: "two", label: "Two" },
              ],
            },
          ]),
        ),
      "mindmap-roots",
    );
  });

  it("rejects a mind map topic that names a parent it does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...releaseMindmapExample,
              nodes: [
                { nodeId: "root", label: "Root" },
                { nodeId: "leaf", label: "Leaf", parentId: "ghost" },
              ],
            },
          ]),
        ),
      "dangling-mindmap-parent",
    );
  });

  it("rejects a mind map note past its length", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...releaseMindmapExample,
              nodes: [
                { nodeId: "root", label: "Root" },
                {
                  nodeId: "leaf",
                  label: "Leaf",
                  parentId: "root",
                  note: "x".repeat(CANVAS_MAX_MINDMAP_NOTE_LENGTH + 1),
                },
              ],
            },
          ]),
        ),
      "mindmap-note-budget-exceeded",
    );
  });
});

describe("math validation", () => {
  const display = {
    blockId: "bayes",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "math" as const,
    layout: "display" as const,
    source: "P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}",
  };
  const inline = {
    blockId: "area",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "math" as const,
    layout: "inline" as const,
  };

  it("accepts the described examples", () => {
    expect(() => validateCanvasDefinition(withBlocks([...mathExamples]))).not.toThrow();
  });

  it("refuses math inside a document declaring an older schema version", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION,
          blocks: [display],
        }),
      "unsupported-schema-version",
    );
    // The bump keeps the previous version readable: a matrix-era document
    // without math still validates.
    expect(() =>
      validateCanvasDefinition({
        ...baseDefinition,
        schemaVersion: CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION,
        blocks: [comparisonMatrix({ schemaVersion: CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION })],
      }),
    ).not.toThrow();
  });

  it("refuses a formula that defines a macro, links out, embeds, or picks its own colour", () => {
    for (const source of [
      "\\def\\x{1} \\x",
      "\\newcommand{\\R}{\\mathbb{R}} \\R",
      "\\href{https://example.com}{x}",
      "\\includegraphics{a.png}",
      "\\htmlClass{c}{x}",
      "\\textcolor{red}{x}",
      "\\makeatletter\\@ifnextchar",
    ]) {
      expectPolicyCode(
        () => validateCanvasDefinition(withBlocks([{ ...display, source }])),
        "math-command-refused",
      );
    }
    // The same commands inside a paragraph's formula run are refused too.
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([{ ...inline, runs: [{ text: "Let " }, { math: "\\gdef\\y{2}" }] }]),
        ),
      "math-command-refused",
    );
  });

  it("reads a line break before letters as a line break, not as a command", () => {
    expect(() =>
      validateCanvasDefinition(
        withBlocks([{ ...display, source: "\\begin{aligned} a &= 1 \\\\def &= 2 \\end{aligned}" }]),
      ),
    ).not.toThrow();
  });

  it("refuses an oversized formula, too many runs, and a paragraph past its shared budget", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([{ ...display, source: "x".repeat(CANVAS_MAX_MATH_SOURCE_LENGTH + 1) }]),
        ),
      "math-source-budget-exceeded",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...inline,
              runs: Array.from({ length: CANVAS_MAX_MATH_RUNS + 1 }, () => ({ math: "x" })),
            },
          ]),
        ),
      "math-runs-budget-exceeded",
    );
    const half = "word ".repeat(CANVAS_MAX_MATH_PARAGRAPH_LENGTH / 10 + 1);
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([{ ...inline, runs: [{ text: half }, { math: "x" }, { text: half }] }]),
        ),
      "math-paragraph-budget-exceeded",
    );
  });
});

describe("funnel, radar, and sankey chart policy", () => {
  const funnel = (values: ReadonlyArray<number>) => ({
    blockId: "funnel",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "chart",
    chartType: "funnel",
    series: [
      {
        seriesId: "visitors",
        label: "Visitors",
        points: values.map((y, index) => ({ x: `Stage ${String(index)}`, y })),
      },
    ],
  });
  const radar = (axes: number, value = 3) => ({
    blockId: "radar",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "chart",
    chartType: "radar",
    series: [
      {
        seriesId: "api",
        label: "API",
        points: Array.from({ length: axes }, (_value, index) => ({
          x: `Axis ${String(index)}`,
          y: value,
        })),
      },
    ],
  });
  const sankey = (links: ReadonlyArray<readonly [string, string, number]>) => ({
    blockId: "sankey",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "chart",
    chartType: "sankey",
    series: [],
    links: links.map(([source, target, value]) => ({ source, target, value })),
  });

  it("accepts a narrowing funnel, a radar, and an acyclic sankey", () => {
    expect(() =>
      validateCanvasDefinition(
        withBlocks([
          funnel([100, 40, 40, 8]),
          radar(5),
          sankey([
            ["Search", "Landing", 6],
            ["Ads", "Landing", 4],
            ["Landing", "Signup", 3],
            ["Search", "Signup", 1],
          ]),
        ]),
      ),
    ).not.toThrow();
  });

  it("refuses a sankey whose flows return to a node they left", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            sankey([
              ["A", "B", 1],
              ["B", "C", 1],
              ["C", "A", 1],
            ]),
          ]),
        ),
      "sankey-cycle",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([sankey([["A", "A", 1]])])),
      "sankey-cycle",
    );
  });

  it("refuses a sankey flow that is negative or zero, and a flow listed twice", () => {
    for (const value of [-1, 0]) {
      expectPolicyCode(
        () => validateCanvasDefinition(withBlocks([sankey([["A", "B", value]])])),
        "sankey-flow-not-positive",
      );
    }
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            sankey([
              ["A", "B", 1],
              ["A", "B", 2],
            ]),
          ]),
        ),
      "duplicate-sankey-link",
    );
  });

  it("names the budget a sankey exceeds", () => {
    const hub = Array.from(
      { length: CANVAS_MAX_SANKEY_NODES },
      (_value, index) => ["Hub", `n${String(index)}`, 1] as const,
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([sankey(hub)])),
      "sankey-nodes-budget-exceeded",
    );
    const many = Array.from(
      { length: CANVAS_MAX_SANKEY_LINKS + 1 },
      (_value, index) => [`s${String(index % 8)}`, `t${String(index % 40)}`, 1] as const,
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([sankey(many)])),
      "sankey-links-budget-exceeded",
    );
  });

  it("refuses a funnel that widens, a negative stage, and too many stages", () => {
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([funnel([100, 40, 60])])),
      "funnel-not-narrowing",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([funnel([100, -4])])),
      "funnel-negative-value",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            funnel(Array.from({ length: CANVAS_MAX_FUNNEL_STAGES + 1 }, (_v, index) => 99 - index)),
          ]),
        ),
      "funnel-stages-budget-exceeded",
    );
  });

  it("refuses a radar outside its axis bounds and a negative reading", () => {
    for (const axes of [CANVAS_MIN_RADAR_AXES - 1, CANVAS_MAX_RADAR_AXES + 1]) {
      expectPolicyCode(
        () => validateCanvasDefinition(withBlocks([radar(axes)])),
        "radar-axis-count",
      );
    }
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([radar(4, -1)])),
      "radar-negative-value",
    );
  });

  it("names a stage, axis, or node label past its length budget", () => {
    const long = "x".repeat(CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH + 1);
    const longFunnel = funnel([10, 5]);
    const stages = longFunnel.series[0]?.points ?? [];
    const relabeled = {
      ...longFunnel,
      series: [{ ...longFunnel.series[0], points: [{ ...stages[0], x: long }, stages[1]] }],
    };
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([relabeled])),
      "chart-label-budget-exceeded",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([sankey([[long, "B", 1]])])),
      "chart-label-budget-exceeded",
    );
  });

  it("refuses a flow chart in a document that declares an earlier version as a future version", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: 13,
          blocks: [{ ...funnel([10, 5]), schemaVersion: 13 }],
        }),
      "unsupported-schema-version",
    );
  });
});

describe("dashboard policy", () => {
  const tile = (blockId: string) => ({
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "status",
    label: blockId,
    value: "Healthy",
    tone: "success",
  });
  const dashboard = (cells: ReadonlyArray<unknown>, overrides: Record<string, unknown> = {}) => ({
    blockId: "board",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "dashboard",
    title: "Board",
    cells,
    ...overrides,
  });

  it("accepts the ops dashboard and the release health board", () => {
    expect(() => validateCanvasDefinition(withBlocks(opsDashboardExample))).not.toThrow();
    expect(() => validateCanvasDefinition(withBlocks(releaseHealthBoardExample))).not.toThrow();
    expect(() =>
      validateCanvasDefinition(withBlocks([...opsDashboardExample, ...releaseHealthBoardExample])),
    ).not.toThrow();
  });

  it("refuses a cell that names a block the document does not hold", () => {
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([dashboard([{ blockId: "missing" }])])),
      "dangling-dashboard-cell",
    );
  });

  it("refuses a grid inside a grid and a block kind a dashboard does not place", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            dashboard([{ blockId: "inner" }]),
            dashboard([{ blockId: "a" }], { blockId: "inner" }),
            tile("a"),
          ]),
        ),
      "dashboard-cell-kind-refused",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([dashboard([{ blockId: "heading" }]), ...baseDefinition.blocks]),
        ),
      "dashboard-cell-kind-refused",
    );
  });

  it("refuses a block placed twice, in one dashboard or across two", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([dashboard([{ blockId: "a" }, { blockId: "a" }]), tile("a")]),
        ),
      "duplicate-dashboard-cell",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            dashboard([{ blockId: "a" }]),
            dashboard([{ blockId: "a" }], { blockId: "board-2" }),
            tile("a"),
          ]),
        ),
      "duplicate-dashboard-cell",
    );
  });

  it("refuses a span wider than the grid", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([dashboard([{ blockId: "a", span: 3 }], { columns: 2 }), tile("a")]),
        ),
      "dashboard-span-exceeds-columns",
    );
  });

  it("names the cell budget when a dashboard places too many blocks", () => {
    const tiles = Array.from({ length: CANVAS_MAX_DASHBOARD_CELLS + 1 }, (_value, index) =>
      tile(`t${String(index)}`),
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([dashboard(tiles.map((block) => ({ blockId: block.blockId }))), ...tiles]),
        ),
      "dashboard-cells-budget-exceeded",
    );
  });

  it("refuses a dashboard in a document that declares an earlier version", () => {
    const older = (block: Record<string, unknown>) => ({ ...block, schemaVersion: 14 });
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: 14,
          blocks: [older(dashboard([{ blockId: "a" }])), older(tile("a"))],
        }),
      "unsupported-schema-version",
    );
  });
});

describe("tabs and columns layout groups", () => {
  const text = (blockId: string) => ({
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "rich-text",
    text: `Body of ${blockId}`,
  });
  const tabs = (panes: ReadonlyArray<{ label: string; blockIds: ReadonlyArray<string> }>) => ({
    blockId: "brief",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "tabs",
    panes,
  });
  const columns = (tracks: ReadonlyArray<ReadonlyArray<string>>, blockId = "row") => ({
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "columns",
    tracks: tracks.map((blockIds) => ({ blockIds })),
  });

  it("admits tabs and columns that each name blocks the document holds", () => {
    const definition = validateCanvasDefinition(
      withBlocks([
        tabs([
          { label: "Metrics", blockIds: ["a"] },
          { label: "Loop", blockIds: ["b", "c"] },
        ]),
        columns([["d"], ["e"], ["f"]]),
        ...["a", "b", "c", "d", "e", "f"].map(text),
      ]),
    );
    expect(definition.blocks.map((block) => block.kind).slice(0, 2)).toEqual(["tabs", "columns"]);
  });

  it("admits the eight-tab design brief an agent is shown", () => {
    const definition = validateCanvasDefinition(withBlocks(designBriefExample));
    const brief = definition.blocks[0];
    expect(brief?.kind === "tabs" ? brief.panes.length : 0).toBe(8);
  });

  it("refuses a group that names a block the document does not hold", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            tabs([
              { label: "One", blockIds: ["a"] },
              { label: "Two", blockIds: ["missing"] },
            ]),
            text("a"),
          ]),
        ),
      "dangling-layout-child",
    );
  });

  it("refuses a block placed twice, within one group or across two", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            tabs([
              { label: "One", blockIds: ["a"] },
              { label: "Two", blockIds: ["a"] },
            ]),
            text("a"),
          ]),
        ),
      "repeated-layout-child",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            tabs([
              { label: "One", blockIds: ["a"] },
              { label: "Two", blockIds: ["b"] },
            ]),
            columns([["a"], ["c"]]),
            text("a"),
            text("b"),
            text("c"),
          ]),
        ),
      "repeated-layout-child",
    );
  });

  it("refuses a group inside a group, including a group naming itself", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            tabs([
              { label: "One", blockIds: ["row"] },
              { label: "Two", blockIds: ["c"] },
            ]),
            columns([["a"], ["b"]]),
            text("a"),
            text("b"),
            text("c"),
          ]),
        ),
      "nested-layout-group",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([columns([["row"], ["a"]]), text("a")])),
      "nested-layout-group",
    );
  });

  it("refuses a pane without a label and a columns block outside two to four tracks", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            tabs([
              { label: " ", blockIds: ["a"] },
              { label: "Two", blockIds: ["b"] },
            ]),
            text("a"),
            text("b"),
          ]),
        ),
      "invalid-schema",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([columns([["a"]]), text("a")])),
      "invalid-schema",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            columns([["a"], ["b"], ["c"], ["d"], ["e"]]),
            ...["a", "b", "c", "d", "e"].map(text),
          ]),
        ),
      "invalid-schema",
    );
  });

  it("counts groups against the document's block budget", () => {
    const children = Array.from({ length: CANVAS_MAX_BLOCKS - 1 }, (_value, index) =>
      text(`t${String(index)}`),
    );
    const full = columns([
      children.slice(0, 60).map((block) => block.blockId),
      children.slice(60).map((block) => block.blockId),
    ]);
    expect(() => validateCanvasDefinition(withBlocks([full, ...children]))).not.toThrow();
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([full, ...children, text("extra")])),
      "block-budget-exceeded",
    );
  });

  it("refuses tabs in a document that declares an earlier version as a future version", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: 18,
          blocks: [
            {
              ...tabs([
                { label: "One", blockIds: ["a"] },
                { label: "Two", blockIds: ["b"] },
              ]),
              schemaVersion: 18,
            },
            { ...text("a"), schemaVersion: 18 },
            { ...text("b"), schemaVersion: 18 },
          ],
        }),
      "unsupported-schema-version",
    );
  });

  describe("beside dashboards", () => {
    const tile = (blockId: string) => ({
      blockId,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "metric",
      label: blockId,
      value: 1,
    });
    const board = (cells: ReadonlyArray<string>, blockId = "board") => ({
      blockId,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "dashboard",
      title: "Metrics",
      cells: cells.map((cellId) => ({ blockId: cellId })),
    });

    it("admits a tab and a column that each hold a dashboard", () => {
      const definition = validateCanvasDefinition(
        withBlocks([
          tabs([
            { label: "Metrics", blockIds: ["board"] },
            { label: "Notes", blockIds: ["a"] },
          ]),
          columns([["side-board"], ["b"]]),
          board(["m1", "m2"]),
          board(["m3"], "side-board"),
          ...["m1", "m2", "m3"].map(tile),
          text("a"),
          text("b"),
        ]),
      );
      expect(definition.blocks.map((block) => block.kind).slice(0, 4)).toEqual([
        "tabs",
        "columns",
        "dashboard",
        "dashboard",
      ]);
    });

    it("refuses a dashboard that places tabs or columns", () => {
      expectPolicyCode(
        () =>
          validateCanvasDefinition(
            withBlocks([
              board(["brief", "m1"]),
              tabs([
                { label: "One", blockIds: ["a"] },
                { label: "Two", blockIds: ["b"] },
              ]),
              tile("m1"),
              text("a"),
              text("b"),
            ]),
          ),
        "nested-layout-group",
      );
      expectPolicyCode(
        () =>
          validateCanvasDefinition(
            withBlocks([board(["row"]), columns([["a"], ["b"]]), text("a"), text("b")]),
          ),
        "nested-layout-group",
      );
    });

    it("refuses a block placed by both a dashboard and a tab, naming the block and both placers", () => {
      let refusal: unknown;
      try {
        validateCanvasDefinition(
          withBlocks([
            tabs([
              { label: "Metrics", blockIds: ["board"] },
              { label: "Headline", blockIds: ["m1"] },
            ]),
            board(["m1", "m2"]),
            tile("m1"),
            tile("m2"),
          ]),
        );
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(CanvasPolicyRejected);
      const rejected = refusal as CanvasPolicyRejected;
      expect(rejected.code).toBe("block-placed-twice");
      expect(rejected.message).toContain("m1");
      expect(rejected.message).toContain("tabs brief");
      expect(rejected.message).toContain("dashboard board");
    });
  });
});

describe("diagram styles and the plan's Gantt view", () => {
  const styled = (schemaVersion: number, role: string) => ({
    blockId: "flow",
    schemaVersion,
    kind: "diagram",
    nodes: [
      { nodeId: "a", label: "Start", role },
      { nodeId: "b", label: "Check?", role: "decision" },
    ],
    edges: [{ edgeId: "ab", source: "a", target: "b" }],
  });

  it("admits the closed roles, edge styles and tones, and group tones", () => {
    expect(() =>
      validateCanvasDefinition(
        withBlocks([
          {
            ...styled(CANVAS_SCHEMA_VERSION, "terminator"),
            edges: [{ edgeId: "ab", source: "a", target: "b", style: "dashed", tone: "warning" }],
            groups: [{ groupId: "g", label: "Zone", nodeIds: ["a"], tone: "accent" }],
          },
        ]),
      ),
    ).not.toThrow();
  });

  it("refuses a role outside the closed set in a block written at the styles version", () => {
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([styled(CANVAS_SCHEMA_VERSION, "service")])),
      "unknown-diagram-role",
    );
  });

  it("still loads an older block's free-form role, so nothing already saved breaks", () => {
    for (const declared of [2, 14]) {
      const definition = validateCanvasDefinition({
        ...baseDefinition,
        schemaVersion: declared,
        blocks: [styled(declared, "service")],
      });
      expect(definition.blocks[0]).toMatchObject({ kind: "diagram" });
    }
    // An older block keeps its role inside a current document, as a revision
    // that copies it forward would carry it.
    expect(() => validateCanvasDefinition(withBlocks([styled(14, "service")]))).not.toThrow();
  });

  it("refuses a styled edge, a toned group, or a Gantt view in an older document as a future version", () => {
    const older = { ...baseDefinition, schemaVersion: 14 };
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...older,
          blocks: [
            {
              ...styled(14, "process"),
              edges: [{ edgeId: "ab", source: "a", target: "b", style: "arrow" }],
            },
          ],
        }),
      "unsupported-schema-version",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...older,
          blocks: [
            {
              ...styled(14, "process"),
              groups: [{ groupId: "g", label: "Zone", nodeIds: ["a"], tone: "danger" }],
            },
          ],
        }),
      "unsupported-schema-version",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...older,
          blocks: [{ ...plan({ view: "gantt" }), schemaVersion: 14 }],
        }),
      "unsupported-schema-version",
    );
  });

  it("refuses a Gantt plan with a repeated task id or circular dependencies, as any plan", () => {
    expect(() => validateCanvasDefinition(withBlocks([launchGanttExample]))).not.toThrow();
    const [first, second, ...rest] = launchGanttExample.tasks;
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            { ...launchGanttExample, tasks: [first, { ...second, taskId: "design" }, ...rest] },
          ]),
        ),
      "duplicate-plan-task-id",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...launchGanttExample,
              tasks: [{ ...first, dependsOn: ["beta"] }, second, ...rest],
            },
          ]),
        ),
      "plan-dependency-cycle",
    );
  });

  it("refuses an unknown edge style or tone", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...styled(CANVAS_SCHEMA_VERSION, "process"),
              edges: [{ edgeId: "ab", source: "a", target: "b", style: "zigzag" }],
            },
          ]),
        ),
      "invalid-schema",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...styled(CANVAS_SCHEMA_VERSION, "process"),
              groups: [{ groupId: "g", label: "Zone", nodeIds: ["a"], tone: "#ff0000" }],
            },
          ]),
        ),
      "invalid-schema",
    );
  });
});

describe("design fields and nested diagram groups", () => {
  const nested = (
    groups: ReadonlyArray<unknown>,
    schemaVersion: number = CANVAS_SCHEMA_VERSION,
  ) => ({
    blockId: "arch",
    schemaVersion,
    kind: "diagram",
    nodes: [
      { nodeId: "web", label: "Web app", icon: "browser", detail: "React" },
      { nodeId: "db", label: "Orders", icon: "database" },
    ],
    edges: [{ edgeId: "e1", source: "web", target: "db" }],
    groups,
  });
  const group = (groupId: string, parentGroupId?: string, nodeIds: ReadonlyArray<string> = []) => ({
    groupId,
    label: groupId,
    nodeIds,
    ...(parentGroupId === undefined ? {} : { parentGroupId }),
  });
  const branded = (overrides: Record<string, unknown> = {}) => ({
    ...onboardingFlowExample,
    theme: "brand",
    brand: { "color-primary": "#1a73e8", "font-heading": "Georgia, serif", "radius-card": "8px" },
    ...overrides,
  });
  const codeOrChat = (block: unknown, mode: "chat" | "work" | "code") =>
    ({
      ...baseDefinition,
      provenance: { ...baseDefinition.provenance, mode },
      blocks: [block],
    }) as unknown;

  it("admits icons, details, and groups nested up to three levels", () => {
    expect(() =>
      validateCanvasDefinition(
        withBlocks([nested([group("a"), group("b", "a"), group("c", "b", ["db"])])]),
      ),
    ).not.toThrow();
  });

  it("refuses a parent group the diagram does not hold, a cycle, and nesting past three levels", () => {
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([nested([group("a", "ghost")])])),
      "unknown-diagram-parent-group",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([nested([group("a", "a")])])),
      "diagram-group-nesting-cycle",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([nested([group("a", "b"), group("b", "a")])])),
      "diagram-group-nesting-cycle",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([nested([group("a"), group("b", "a"), group("c", "b"), group("d", "c")])]),
        ),
      "diagram-group-depth-exceeded",
    );
  });

  it("refuses the new diagram and design fields in a document that declares version 20", () => {
    const older = { ...baseDefinition, schemaVersion: 20 };
    for (const block of [
      { ...nested([group("a")], 20) },
      {
        ...onboardingFlowExample,
        schemaVersion: 20,
        frames: [{ ...onboardingFlowExample.frames[0], notes: "Say hello." }],
      },
      { ...branded(), schemaVersion: 20 },
    ]) {
      expectPolicyCode(
        () => validateCanvasDefinition({ ...older, blocks: [block] }),
        "unsupported-schema-version",
      );
    }
  });

  it("keeps a version 20 document without the new fields valid", () => {
    expect(() =>
      validateCanvasDefinition({
        ...baseDefinition,
        schemaVersion: 20,
        blocks: [{ ...onboardingFlowExample, schemaVersion: 20 }],
      }),
    ).not.toThrow();
  });

  it("admits a brand of safe colours, fonts, and lengths and notes on a frame", () => {
    const frames = [{ ...onboardingFlowExample.frames[0], notes: "Open with the demo." }];
    expect(() => validateCanvasDefinition(withBlocks([branded({ frames })]))).not.toThrow();
  });

  it("refuses a brand value that could end a declaration, load something, or name an unlisted font", () => {
    for (const brand of [
      { "color-primary": "red; } body { display: none" },
      { "color-primary": "url(https://example.test/a.png)" },
      { "color-primary": "javascript" },
      { "font-heading": "Georgia, 'Comic Sans MS'" },
      { "font-heading": "Courier New}" },
      { "radius-card": "calc(1px + 2px)" },
      { "space-gutter": "-4px" },
    ]) {
      expectPolicyCode(
        () => validateCanvasDefinition(withBlocks([branded({ brand })])),
        "design-brand-refused",
      );
    }
  });

  it("refuses a brand without the brand theme, the brand theme without a brand, and a running brand", () => {
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([branded({ theme: "none" })])),
      "design-brand-refused",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([{ ...onboardingFlowExample, theme: "brand" }])),
      "design-brand-refused",
    );
    expectPolicyCode(
      () => validateCanvasDefinition(withBlocks([branded({ runsScript: true })])),
      "design-run-refused",
    );
  });

  it("refuses a captured page as a design asset in Chat and admits it in Work and Code", () => {
    const capture = {
      ...onboardingFlowExample,
      frames: [{ frameId: "home", title: "Home", html: '<img src="octant-asset:shot" alt="">' }],
      assets: [
        {
          assetId: "shot",
          source: { kind: "browser-capture", captureId: "66666666-6666-4666-8666-666666666666" },
        },
      ],
    };
    expectPolicyCode(
      () => validateCanvasDefinition(codeOrChat(capture, "chat")),
      "design-asset-refused",
    );
    for (const mode of ["work", "code"] as const) {
      expect(() => validateCanvasDefinition(codeOrChat(capture, mode))).not.toThrow();
    }
  });
});

describe("flow screens and transitions", () => {
  const flowMockup = (
    blockId: string,
    variants?: ReadonlyArray<{ variantId: string; label: string }>,
  ) => ({
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "mockup" as const,
    device: "phone" as const,
    title: blockId,
    ...(variants === undefined ? {} : { variants }),
    nodes: [
      {
        nodeId: "window",
        component: "window",
        label: blockId,
        ...(variants === undefined ? {} : { variantId: variants[0]?.variantId }),
      },
      { nodeId: "search-button", parentId: "window", component: "button", label: "Search" },
      { nodeId: "note", parentId: "window", component: "text", label: "A caption" },
    ],
  });

  const flowDesign = {
    blockId: "site",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "design" as const,
    title: "Site",
    size: "desktop" as const,
    frames: [
      { frameId: "home", title: "Home", html: "<h1>Home</h1>" },
      { frameId: "results", title: "Results", html: "<h1>Results</h1>" },
    ],
  };

  const flow = (screens: ReadonlyArray<unknown>, edges: ReadonlyArray<unknown> = []) => ({
    blockId: "app-flow",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "flow" as const,
    title: "Search flow",
    screens,
    edges,
  });

  it("places mockup and design screens and names each transition's hotspot", () => {
    expect(() =>
      validateCanvasDefinition(
        withBlocks([
          flowMockup("search"),
          flowDesign,
          flow(
            [
              { screenId: "s1", blockId: "search" },
              { screenId: "s2", blockId: "site", frameId: "results" },
            ],
            [
              {
                edgeId: "run",
                fromScreenId: "s1",
                toScreenId: "s2",
                fromNodeId: "search-button",
                label: "Run search",
              },
            ],
          ),
        ]),
      ),
    ).not.toThrow();
  });

  it("refuses a screen the document lacks, one of the wrong kind, and a repeated screen", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([flowMockup("search"), flow([{ screenId: "s1", blockId: "missing" }])]),
        ),
      "dangling-flow-screen",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              blockId: "note",
              schemaVersion: CANVAS_SCHEMA_VERSION,
              kind: "rich-text",
              text: "Hi",
            },
            flow([{ screenId: "s1", blockId: "note" }]),
          ]),
        ),
      "flow-screen-kind-refused",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            flowMockup("search"),
            flow([
              { screenId: "s1", blockId: "search" },
              { screenId: "s1", blockId: "search" },
            ]),
          ]),
        ),
      "duplicate-flow-screen",
    );
  });

  it("refuses a design screen without its frame, a missing variant, and a design that runs script", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([flowDesign, flow([{ screenId: "s1", blockId: "site" }])]),
        ),
      "flow-screen-frame-missing",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            flowMockup("search"),
            flow([{ screenId: "s1", blockId: "search", variantId: "empty" }]),
          ]),
        ),
      "flow-screen-variant-missing",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            {
              ...flowDesign,
              blockId: "runner",
              runsScript: true,
              frames: [{ frameId: "app", title: "App", html: "<button>Go</button>" }],
            },
            flow([{ screenId: "s1", blockId: "runner", frameId: "app" }]),
          ]),
        ),
      "flow-screen-design-refused",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            flowMockup("search", [
              { variantId: "loaded", label: "Loaded" },
              { variantId: "empty", label: "Empty" },
            ]),
            // A mockup that declares variants must be placed at one of them.
            flow([{ screenId: "s1", blockId: "search" }]),
          ]),
        ),
      "flow-screen-variant-missing",
    );
  });

  it("refuses edges that dangle, loop, repeat, or name a hotspot the screen's mockup does not offer", () => {
    const blocks = (edges: ReadonlyArray<unknown>) => [
      flowMockup("search"),
      flow(
        [
          { screenId: "s1", blockId: "search" },
          { screenId: "s2", blockId: "search" },
        ],
        edges,
      ),
    ];
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks(blocks([{ edgeId: "e", fromScreenId: "s1", toScreenId: "s9" }])),
        ),
      "dangling-flow-edge",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks(blocks([{ edgeId: "e", fromScreenId: "s1", toScreenId: "s1" }])),
        ),
      "flow-edge-self",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks(
            blocks([
              { edgeId: "e", fromScreenId: "s1", toScreenId: "s2" },
              { edgeId: "e", fromScreenId: "s2", toScreenId: "s1" },
            ]),
          ),
        ),
      "duplicate-flow-edge",
    );
    // A text node is not a control a person taps.
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks(
            blocks([{ edgeId: "e", fromScreenId: "s1", toScreenId: "s2", fromNodeId: "note" }]),
          ),
        ),
      "flow-hotspot-refused",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks(
            blocks([{ edgeId: "e", fromScreenId: "s1", toScreenId: "s2", fromNodeId: "gone" }]),
          ),
        ),
      "flow-hotspot-refused",
    );
  });

  it("refuses a screen placed by both a flow and a tab, naming both placers", () => {
    const brief = {
      blockId: "brief",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "tabs" as const,
      panes: [
        { label: "Screens", blockIds: ["search"] },
        { label: "Other", blockIds: ["note"] },
      ],
    };
    let refusal: unknown;
    try {
      validateCanvasDefinition(
        withBlocks([
          flowMockup("search"),
          brief,
          { blockId: "note", schemaVersion: CANVAS_SCHEMA_VERSION, kind: "rich-text", text: "Hi" },
          flow([{ screenId: "s1", blockId: "search" }]),
        ]),
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CanvasPolicyRejected);
    const rejected = refusal as CanvasPolicyRejected;
    expect(rejected.code).toBe("block-placed-twice");
    expect(rejected.message).toContain("search");
    expect(rejected.message).toContain("flow app-flow");
    expect(rejected.message).toContain("tabs brief");
  });

  it("refuses a flow in a document that declares the version before it", () => {
    const earlier = CANVAS_FLOW_SCHEMA_VERSION - 1;
    const gated = flow([{ screenId: "s1", blockId: "search" }]);
    expectPolicyCode(
      () =>
        validateCanvasDefinition({
          ...baseDefinition,
          schemaVersion: earlier,
          blocks: [
            { ...flowMockup("search"), schemaVersion: earlier },
            { ...gated, schemaVersion: earlier },
          ],
        }),
      "unsupported-schema-version",
    );
  });
});

describe("mockup library", () => {
  const libraryMockup = (overrides: Record<string, unknown> = {}) => ({
    blockId: "screen",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "mockup" as const,
    device: "phone" as const,
    title: "Search",
    nodes: [
      { nodeId: "window", component: "window", label: "Search" },
      { nodeId: "bar", parentId: "window", component: "progress", label: "Loading", progress: 40 },
    ],
    ...overrides,
  });

  it("accepts the library components with their own fields", () => {
    expect(() => validateCanvasDefinition(withBlocks([libraryMockup()]))).not.toThrow();
  });

  it("refuses a field on the component that does not read it", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            libraryMockup({
              nodes: [
                { nodeId: "window", component: "window", label: "S" },
                { nodeId: "t", parentId: "window", component: "text", label: "Hi", progress: 3 },
              ],
            }),
          ]),
        ),
      "mockup-field-refused",
    );
  });

  it("refuses an image on a non-image component, an undeclared asset, and a Chat Project file", () => {
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            libraryMockup({
              nodes: [{ nodeId: "window", component: "window", label: "S", assetId: "shot" }],
            }),
          ]),
        ),
      "mockup-field-refused",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            libraryMockup({
              nodes: [
                { nodeId: "window", component: "window", label: "S" },
                {
                  nodeId: "m",
                  parentId: "window",
                  component: "media",
                  label: "Photo",
                  assetId: "shot",
                },
              ],
            }),
          ]),
        ),
      "design-asset-refused",
    );
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            libraryMockup({
              assets: [{ assetId: "shot", source: { kind: "project-file", path: "a.png" } }],
              nodes: [
                { nodeId: "window", component: "window", label: "S" },
                {
                  nodeId: "m",
                  parentId: "window",
                  component: "media",
                  label: "Photo",
                  assetId: "shot",
                },
              ],
            }),
          ]),
        ),
      "design-asset-refused",
    );
  });

  it("pins a callout to a library component and to an instance, and refuses one naming a node only a definition holds", () => {
    // A callout on an instance names a node the screen holds: the marker draws
    // on every placement, and the comment it anchors stays on that instance.
    expect(() =>
      validateCanvasDefinition(
        withBlocks([
          libraryMockup({
            definitions: [
              {
                defId: "row",
                label: "Row",
                nodes: [{ nodeId: "r1", component: "list-row", label: "One" }],
              },
            ],
            nodes: [
              { nodeId: "window", component: "window", label: "S" },
              { nodeId: "go", parentId: "window", component: "search", label: "Search" },
              {
                nodeId: "i1",
                parentId: "window",
                component: "instance",
                label: "Row",
                defId: "row",
              },
            ],
            annotations: [
              { nodeId: "go", note: "Search as you type." },
              { nodeId: "i1", note: "One placed row." },
            ],
          }),
        ]),
      ),
    ).not.toThrow();
    // A definition's own node is not on the screen, so a callout cannot pin
    // to it: the callout would have no one place to draw.
    expectPolicyCode(
      () =>
        validateCanvasDefinition(
          withBlocks([
            libraryMockup({
              definitions: [
                {
                  defId: "row",
                  label: "Row",
                  nodes: [{ nodeId: "r1", component: "list-row", label: "One" }],
                },
              ],
              nodes: [{ nodeId: "window", component: "window", label: "S" }],
              annotations: [{ nodeId: "r1", note: "Inside the definition." }],
            }),
          ]),
        ),
      "dangling-mockup-annotation",
    );
  });

  it("places a reusable component by instance, and refuses a dangling, repeated, or nesting one", () => {
    const withInstances = (overrides: Record<string, unknown>) =>
      validateCanvasDefinition(withBlocks([libraryMockup(overrides)]));
    expect(() =>
      withInstances({
        definitions: [
          {
            defId: "row",
            label: "Row",
            nodes: [{ nodeId: "r1", component: "list-row", label: "One" }],
          },
        ],
        nodes: [
          { nodeId: "window", component: "window", label: "S" },
          { nodeId: "i1", parentId: "window", component: "instance", label: "Row", defId: "row" },
        ],
      }),
    ).not.toThrow();
    expectPolicyCode(
      () =>
        withInstances({
          nodes: [
            { nodeId: "window", component: "window", label: "S" },
            {
              nodeId: "i1",
              parentId: "window",
              component: "instance",
              label: "Row",
              defId: "gone" as never,
            },
          ],
        }),
      "dangling-mockup-definition",
    );
    expectPolicyCode(
      () =>
        withInstances({
          definitions: [
            {
              defId: "row",
              label: "Row",
              nodes: [{ nodeId: "r1", component: "list-row", label: "One" }],
            },
            {
              defId: "row",
              label: "Row",
              nodes: [{ nodeId: "r2", component: "list-row", label: "Two" }],
            },
          ],
        }),
      "duplicate-mockup-definition",
    );
    expectPolicyCode(
      () =>
        withInstances({
          definitions: [
            {
              defId: "row",
              label: "Row",
              nodes: [{ nodeId: "r1", component: "instance", label: "Nested", defId: "row" }],
            },
          ],
        }),
      "mockup-definition-nested",
    );
  });
});

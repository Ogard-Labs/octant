import { describe, expect, it } from "vitest";
import {
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_DIAGRAM_EDGES,
  CANVAS_MAX_DIAGRAM_NODES,
  CANVAS_MAX_IMAGES,
  CANVAS_MAX_SERIES,
  CANVAS_MAX_TABLE_ROWS,
  CANVAS_MAX_TEXT_BYTES,
  CANVAS_SCHEMA_VERSION,
  decodeCanvasDefinition,
  type CanvasDefinition,
} from "@octant/contracts/canvas";
import {
  CanvasPolicyRejected,
  measureCanvasBudget,
  validateCanvasDefinition,
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
      () => validateCanvasDefinition({ ...baseDefinition, schemaVersion: 2 }),
      "unsupported-schema-version",
    );
    expectPolicyCode(
      () => validateCanvasDefinition({ ...baseDefinition, schemaVersion: "1" }),
      "invalid-schema",
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

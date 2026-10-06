import { describe, expect, it } from "vitest";
import {
  CANVAS_AGGREGATE_TYPE,
  CANVAS_CREATED,
  CANVAS_EVENT_NAMES,
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_DIAGRAM_EDGES,
  CANVAS_MAX_DIAGRAM_NODES,
  CANVAS_MAX_IMAGES,
  CANVAS_MAX_TABLE_ROWS,
  CANVAS_SCHEMA_VERSION,
  CANVAS_VERSION_APPENDED,
  CanvasCreated,
  CanvasDefinition,
  CanvasVersion,
  CanvasVersionAppended,
  decodeCanvasBlock,
  decodeCanvasCreated,
  decodeCanvasDefinition,
  decodeCanvasSourceManifestEntry,
  decodeCanvasVersion,
  decodeCanvasVersionAppended,
} from "./canvas";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  block: "33333333-3333-4333-8333-333333333333",
  source: "44444444-4444-4444-8444-444444444444",
  project: "55555555-5555-4555-8555-555555555555",
  thread: "66666666-6666-4666-8666-666666666666",
  provider: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
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
  opaqueRef: "source-token-1",
  displayName: "notes.md",
} as const;

const heading = {
  blockId: ids.block,
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "heading",
  level: 1,
  text: "A bounded Canvas",
} as const;

const definition = {
  schemaVersion: CANVAS_SCHEMA_VERSION,
  title: "Canvas contract fixture",
  provenance,
  sourceManifest: [source],
  blocks: [heading],
} as const;

describe("Canvas contracts", () => {
  it("round-trips a versioned definition with provenance and opaque sources", () => {
    expect(decodeCanvasDefinition(definition)).toEqual(definition);
  });

  it("round-trips an immutable Canvas version envelope", () => {
    const version = {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      canvasId: ids.canvas,
      versionId: ids.version,
      sequence: 1,
      definition,
      createdBy: provenance.actor,
      createdAt: "2026-08-01T21:00:01.000Z",
    } as const;
    expect(decodeCanvasVersion(version)).toEqual(version);
  });

  it("rejects unknown or malformed schema versions", () => {
    expect(() =>
      decodeCanvasDefinition({ ...definition, schemaVersion: CANVAS_SCHEMA_VERSION + 1 }),
    ).toThrow();
    expect(() => decodeCanvasDefinition({ ...definition, schemaVersion: "1" })).toThrow();
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        blocks: [{ ...heading, schemaVersion: CANVAS_SCHEMA_VERSION + 1 }],
      }),
    ).toThrow();
  });

  it("admits mockup blocks only under the version that declared them", () => {
    const mockup = {
      blockId: "mockup-1",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "mockup",
      device: "phone",
      title: "Settings",
      nodes: [{ nodeId: "screen", component: "window", label: "Settings" }],
    } as const;
    // A mockup carried by a document that declares an older version is a
    // rolled-back runtime's failure mode: the decode refuses it outright.
    expect(() =>
      decodeCanvasDefinition({ ...definition, schemaVersion: 2, blocks: [mockup] }),
    ).toThrow();
    expect(() =>
      decodeCanvasDefinition({ ...definition, schemaVersion: 1, blocks: [mockup] }),
    ).toThrow();
    expect(decodeCanvasDefinition({ ...definition, blocks: [mockup] })).toMatchObject({
      blocks: [mockup],
    });
  });

  it("rejects unknown blocks and executable or renderer-owned fields", () => {
    expect(() => decodeCanvasBlock({ ...heading, kind: "html" })).toThrow();
    expect(() => decodeCanvasBlock({ ...heading, html: "<script>alert(1)</script>" })).toThrow();
    expect(() => decodeCanvasBlock({ ...heading, css: "color: red" })).toThrow();
    expect(() => decodeCanvasBlock({ ...heading, onClick: "alert(1)" })).toThrow();
  });

  it("accepts the bounded first-party block catalog", () => {
    const blocks = [
      { ...heading },
      {
        blockId: "heading-2",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "rich-text",
        text: "A paragraph",
      },
      {
        blockId: "callout-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "callout",
        tone: "info",
        text: "Context",
      },
      {
        blockId: "link-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "link",
        label: "Octant",
        href: "https://octant.example/reports",
      },
      { blockId: "divider-1", schemaVersion: CANVAS_SCHEMA_VERSION, kind: "divider" },
      {
        blockId: "citation-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "citation",
        sourceId: ids.source,
        label: "Source",
        quote: "Bounded evidence",
      },
      {
        blockId: "metric-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "metric",
        label: "Requests",
        value: 42,
        unit: "count",
      },
      {
        blockId: "progress-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "progress",
        label: "Complete",
        value: 0.75,
      },
      {
        blockId: "status-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "status",
        label: "State",
        value: "Ready",
        tone: "success",
      },
      {
        blockId: "values-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "key-value",
        entries: [{ key: "Mode", value: "Chat" }],
      },
      {
        blockId: "table-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "table",
        columns: [{ id: "name", label: "Name", type: "text" }],
        rows: [["Octant"]],
      },
      {
        blockId: "chart-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "chart",
        chartType: "line",
        series: [{ seriesId: "requests", label: "Requests", points: [{ x: 1, y: 42 }] }],
      },
      {
        blockId: "timeline-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "timeline",
        items: [
          {
            itemId: "event-1",
            title: "Created",
            startAt: "2026-08-01T21:00:00.000Z",
          },
        ],
      },
      {
        blockId: "plan-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "plan",
        title: "Launch plan",
        view: "kanban",
        phases: [{ phaseId: "build", title: "Build" }],
        tasks: [
          {
            taskId: "api",
            phaseId: "build",
            title: "Ship the API",
            status: "doing",
            owner: { kind: "agent", label: "Codex" },
            estimate: "2d",
            notes: "Done when the contract tests pass.",
            dueAt: "2026-08-03T21:00:00.000Z",
          },
          {
            taskId: "docs",
            phaseId: "build",
            title: "Write the docs",
            status: "todo",
            dependsOn: ["api"],
          },
        ],
      },
      {
        blockId: "diagram-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "diagram",
        nodes: [
          { nodeId: "a", label: "A" },
          { nodeId: "b", label: "B" },
        ],
        edges: [{ edgeId: "a-b", source: "a", target: "b" }],
      },
      {
        blockId: "sequence-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "sequence",
        participants: [
          { participantId: "person", label: "Person" },
          { participantId: "auth", label: "Auth" },
        ],
        messages: [{ messageId: "submit", from: "person", to: "auth", label: "Sign in" }],
        activations: [
          {
            activationId: "auth-active",
            participantId: "auth",
            startMessageId: "submit",
            endMessageId: "submit",
          },
        ],
        notes: [{ noteId: "keep", text: "Credentials stay in the request" }],
      },
      {
        blockId: "state-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "state",
        states: [
          { stateId: "start", label: "Start", role: "initial" },
          { stateId: "paid", label: "Paid" },
          { stateId: "captured", label: "Captured", parentId: "paid" },
          { stateId: "closed", label: "Closed", role: "final" },
        ],
        transitions: [{ transitionId: "pay", source: "start", target: "paid", label: "pay" }],
      },
      {
        blockId: "code-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "code-excerpt",
        language: "typescript",
        code: "const safe = true;",
        sourceId: ids.source,
        startLine: 1,
        endLine: 1,
      },
      {
        blockId: "pseudo-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "pseudocode",
        code: "validate before render",
      },
      {
        blockId: "diff-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "diff",
        sourceId: ids.source,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            lines: [{ kind: "context", text: "safe" }],
          },
        ],
      },
      {
        blockId: "source-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "source-reference",
        sourceId: ids.source,
        label: "Notes",
      },
      {
        blockId: "summary-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "summary",
        summaryKind: "test",
        title: "Checks",
        items: [{ label: "Contracts", value: "pass", status: "success" }],
      },
      {
        blockId: "artifact-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "artifact-reference",
        sourceId: ids.source,
        label: "Artifact",
      },
      {
        blockId: "file-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "file-reference",
        sourceId: ids.source,
        label: "File",
      },
      {
        blockId: "preview-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "preview-reference",
        sourceId: ids.source,
        label: "Preview",
      },
      {
        blockId: "browser-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "browser-reference",
        sourceId: ids.source,
        label: "Browser",
      },
      {
        blockId: "evidence-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "evidence-reference",
        sourceId: ids.source,
        label: "Evidence",
      },
      {
        blockId: "image-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "image",
        sourceId: ids.source,
        alt: "A bounded image",
      },
      {
        blockId: "mockup-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "mockup",
        device: "phone",
        title: "Settings",
        nodes: [
          { nodeId: "screen", component: "window", label: "Settings" },
          { nodeId: "save", component: "button", label: "Save", parentId: "screen" },
        ],
      },
    ] as const;
    expect(decodeCanvasDefinition({ ...definition, blocks })).toMatchObject({ blocks });
  });

  it("rejects unsafe links and host paths in source entries", () => {
    expect(() =>
      decodeCanvasBlock({
        ...heading,
        kind: "link",
        label: "unsafe",
        href: "data:text/html,<script>alert(1)</script>",
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasSourceManifestEntry({ ...source, opaqueRef: "/Users/example/secret.txt" }),
    ).toThrow();
    expect(() =>
      decodeCanvasSourceManifestEntry({ ...source, displayName: "folder/secret.txt" }),
    ).toThrow();
  });

  it("keeps structural arrays bounded at the contract boundary", () => {
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        blocks: Array.from({ length: CANVAS_MAX_BLOCKS + 1 }, (_, index) => ({
          blockId: `divider-${index}`,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "divider",
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        blockId: "rows",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "table",
        columns: [{ id: "c", label: "C", type: "text" }],
        rows: Array.from({ length: CANVAS_MAX_TABLE_ROWS + 1 }, () => ["row"]),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        blockId: "diagram",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "diagram",
        nodes: Array.from({ length: CANVAS_MAX_DIAGRAM_NODES + 1 }, (_, index) => ({
          nodeId: `node-${index}`,
          label: "node",
        })),
        edges: [],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        blockId: "edges",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "diagram",
        nodes: [{ nodeId: "a", label: "A" }],
        edges: Array.from({ length: CANVAS_MAX_DIAGRAM_EDGES + 1 }, (_, index) => ({
          edgeId: `edge-${index}`,
          source: "a",
          target: "a",
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        blocks: Array.from({ length: CANVAS_MAX_IMAGES + 1 }, (_, index) => ({
          blockId: `image-${index}`,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "image",
          sourceId: ids.source,
          alt: "image",
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        blockId: "sequence",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "sequence",
        participants: Array.from({ length: CANVAS_MAX_DIAGRAM_NODES + 1 }, (_, index) => ({
          participantId: `person-${index}`,
          label: "Person",
        })),
        messages: [],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        blockId: "state",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "state",
        states: [{ stateId: "start", label: "Start" }],
        transitions: Array.from({ length: CANVAS_MAX_DIAGRAM_EDGES + 1 }, (_, index) => ({
          transitionId: `step-${index}`,
          source: "start",
          target: "start",
          label: "again",
        })),
      }),
    ).toThrow();
  });

  it("does not accept extra version or provenance fields", () => {
    expect(() => decodeCanvasDefinition({ ...definition, futureVersion: 2 })).toThrow();
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        provenance: { ...provenance, credential: "secret" },
      }),
    ).toThrow();
  });

  it("exports the schema as an Effect Schema for consumer composition", () => {
    expect(CanvasDefinition).toBeDefined();
    expect(CanvasVersion).toBeDefined();
  });
});

const versionFixture = (overrides: Record<string, unknown> = {}): CanvasVersion => {
  const version = {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId: ids.canvas,
    versionId: ids.version,
    sequence: 1,
    definition,
    createdBy: provenance.actor,
    createdAt: "2026-08-01T21:00:01.000Z",
  } as const;
  return decodeCanvasVersion({ ...version, ...overrides });
};

describe("Canvas lifecycle event contracts", () => {
  it("round-trips a CanvasCreated event carrying the first immutable version", () => {
    const event = { canvasId: ids.canvas, version: versionFixture() };
    expect(decodeCanvasCreated(event)).toEqual(event);
  });

  it("round-trips a CanvasVersionAppended event carrying a later immutable version", () => {
    const appended = versionFixture({
      versionId: "33333333-3333-4333-8333-333333333333",
      sequence: 2,
      createdAt: "2026-08-01T21:00:02.000Z",
    });
    const event = { canvasId: ids.canvas, version: appended };
    expect(decodeCanvasVersionAppended(event)).toEqual(event);
  });

  it("rejects excess fields on lifecycle event payloads", () => {
    expect(() =>
      decodeCanvasCreated({ canvasId: ids.canvas, version: versionFixture(), secret: "x" }),
    ).toThrow();
    expect(() =>
      decodeCanvasVersionAppended({ canvasId: ids.canvas, version: versionFixture(), extra: 1 }),
    ).toThrow();
  });

  it("decodes a lifecycle event whose canvasId differs from the version envelope (cross-field validation is a domain concern)", () => {
    const mismatched = versionFixture({
      canvasId: "99999999-9999-4999-8999-999999999999",
    });
    expect(decodeCanvasCreated({ canvasId: ids.canvas, version: mismatched }).canvasId).toBe(
      ids.canvas,
    );
    expect(
      decodeCanvasVersionAppended({ canvasId: ids.canvas, version: mismatched }).canvasId,
    ).toBe(ids.canvas);
  });

  it("exports the Canvas aggregate type and ordered event names", () => {
    expect(CANVAS_AGGREGATE_TYPE).toBe("canvas");
    expect(CANVAS_EVENT_NAMES).toEqual([CANVAS_CREATED, CANVAS_VERSION_APPENDED]);
    expect(CanvasCreated).toBeDefined();
    expect(CanvasVersionAppended).toBeDefined();
  });
});

function chartBlock(
  chartType: string,
  series: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    blockId: "chart-shape",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "chart",
    chartType,
    series,
  };
}

const quarters = (id: string, values: ReadonlyArray<number>, mark?: "bar" | "line") => ({
  seriesId: id,
  label: id,
  points: [
    { x: "Q1", y: values[0] ?? 0 },
    { x: "Q2", y: values[1] ?? 0 },
    { x: "Q3", y: values[2] ?? 0 },
  ],
  ...(mark === undefined ? {} : { mark }),
});

describe("chart series shape", () => {
  it("accepts a pie, a donut, stacked and grouped bars, and a bar and line chart", () => {
    expect(
      decodeCanvasBlock(
        chartBlock("pie", [
          {
            seriesId: "share",
            label: "Share",
            points: [
              { x: "Product", y: 42 },
              { x: "Services", y: 28 },
            ],
          },
        ]),
      ).kind,
    ).toBe("chart");
    expect(
      decodeCanvasBlock(
        chartBlock("donut", [
          {
            seriesId: "cost",
            label: "Cost",
            points: [
              { x: "Compute", y: 12 },
              { x: "Storage", y: 4 },
            ],
          },
        ]),
      ),
    ).toMatchObject({ chartType: "donut" });
    expect(
      decodeCanvasBlock(
        chartBlock("stacked-bar", [
          quarters("product", [10, 14, 12]),
          quarters("services", [6, 8, 9]),
        ]),
      ),
    ).toMatchObject({ chartType: "stacked-bar" });
    expect(
      decodeCanvasBlock(
        chartBlock("grouped-bar", [
          quarters("product", [10, 14, 12]),
          quarters("services", [6, 8, 9]),
        ]),
      ),
    ).toMatchObject({ chartType: "grouped-bar" });
    expect(
      decodeCanvasBlock(
        chartBlock("bar-line", [
          quarters("revenue", [40, 52, 48], "bar"),
          quarters("margin", [12, 15, 11], "line"),
        ]),
      ),
    ).toMatchObject({
      chartType: "bar-line",
      series: [expect.objectContaining({ mark: "bar" }), expect.objectContaining({ mark: "line" })],
    });
  });

  it("rejects a pie or donut whose series are not one list of labeled non-negative slices", () => {
    expect(() =>
      decodeCanvasBlock(
        chartBlock("pie", [
          { seriesId: "a", label: "A", points: [{ x: "Product", y: 1 }] },
          { seriesId: "b", label: "B", points: [{ x: "Services", y: 1 }] },
        ]),
      ),
    ).toThrow(/Chart series do not match/);
    expect(() =>
      decodeCanvasBlock(
        chartBlock("donut", [{ seriesId: "a", label: "A", points: [{ x: 1, y: 4 }] }]),
      ),
    ).toThrow(/Chart series do not match/);
    expect(() =>
      decodeCanvasBlock(
        chartBlock("pie", [{ seriesId: "a", label: "A", points: [{ x: "Product", y: -1 }] }]),
      ),
    ).toThrow(/Chart series do not match/);
    expect(() =>
      decodeCanvasBlock(
        chartBlock("pie", [
          {
            seriesId: "a",
            label: "A",
            points: [
              { x: "Product", y: 1 },
              { x: "Product", y: 2 },
            ],
          },
        ]),
      ),
    ).toThrow(/Chart series do not match/);
  });

  it("rejects stacked or grouped bars whose series do not share categories", () => {
    expect(() =>
      decodeCanvasBlock(chartBlock("stacked-bar", [quarters("only", [1, 2, 3])])),
    ).toThrow(/Chart series do not match/);
    expect(() =>
      decodeCanvasBlock(
        chartBlock("grouped-bar", [
          quarters("product", [1, 2, 3]),
          {
            seriesId: "services",
            label: "services",
            points: [
              { x: "Q2", y: 1 },
              { x: "Q1", y: 2 },
              { x: "Q3", y: 3 },
            ],
          },
        ]),
      ),
    ).toThrow(/Chart series do not match/);
    expect(() =>
      decodeCanvasBlock(
        chartBlock("stacked-bar", [
          quarters("product", [1, 2, 3]),
          quarters("services", [1, -2, 3]),
        ]),
      ),
    ).toThrow(/Chart series do not match/);
  });

  it("rejects a bar and line chart that does not name both marks on shared categories", () => {
    expect(() =>
      decodeCanvasBlock(
        chartBlock("bar-line", [quarters("revenue", [1, 2, 3]), quarters("margin", [1, 2, 3])]),
      ),
    ).toThrow(/Chart series do not match/);
    expect(() =>
      decodeCanvasBlock(
        chartBlock("bar-line", [
          quarters("revenue", [1, 2, 3], "bar"),
          quarters("orders", [1, 2, 3], "bar"),
        ]),
      ),
    ).toThrow(/Chart series do not match/);
    expect(() =>
      decodeCanvasBlock(chartBlock("line", [quarters("requests", [1, 2, 3], "line")])),
    ).toThrow(/Chart series do not match/);
  });
});

describe("canvas number formats", () => {
  it("accepts an optional number format on a chart, a metric, and a table column", () => {
    const chart = decodeCanvasBlock({
      blockId: "chart-format",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "chart",
      chartType: "line",
      format: "compact",
      series: [quarters("requests", [1, 2, 3])],
    });
    expect(chart).toMatchObject({ format: "compact" });

    const metric = decodeCanvasBlock({
      blockId: "metric-format",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "metric",
      label: "Requests",
      value: 1_360_000,
      format: "compact",
    });
    expect(metric).toMatchObject({ format: "compact" });

    const table = decodeCanvasBlock({
      blockId: "table-format",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "table",
      columns: [{ id: "size", label: "Size", type: "number", format: "bytes" }],
      rows: [[1536]],
    });
    expect(table).toMatchObject({ columns: [{ format: "bytes" }] });
  });

  it("leaves the format absent when an author does not name one", () => {
    const chart = decodeCanvasBlock({
      blockId: "chart-plain",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "chart",
      chartType: "line",
      series: [quarters("requests", [1, 2, 3])],
    });
    expect(chart).not.toHaveProperty("format");
  });

  it("rejects a number format outside the closed set", () => {
    expect(() =>
      decodeCanvasBlock({
        blockId: "bad-format",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "metric",
        label: "Requests",
        value: 1,
        format: "currency",
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        blockId: "bad-column-format",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "table",
        columns: [{ id: "size", label: "Size", type: "number", format: "USD" }],
        rows: [[1]],
      }),
    ).toThrow();
  });
});

describe("treemap blocks", () => {
  const treemap = {
    blockId: "repository-map",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "treemap",
    measures: [
      { measureId: "loc", label: "Lines of code", format: "compact" },
      { measureId: "edits60", label: "Edits (60 days)" },
    ],
    sizeBy: "loc",
    colorBy: "edits60",
    colorScale: "sequential",
    startNodeId: "packages",
    nodes: [
      { nodeId: "octant", label: "octant" },
      { nodeId: "packages", label: "packages", parentId: "octant" },
      {
        nodeId: "domain",
        label: "domain",
        parentId: "packages",
        sourceId: ids.source,
        values: { loc: 52_100, edits60: 61 },
      },
    ],
  };

  it("decodes a hierarchy with measures, a size, a colour, and a start node", () => {
    const block = decodeCanvasBlock(treemap);

    expect(block).toMatchObject({
      kind: "treemap",
      sizeBy: "loc",
      colorBy: "edits60",
      colorScale: "sequential",
      startNodeId: "packages",
    });
  });

  it("admits a treemap only under the version that declared it", () => {
    expect(() =>
      decodeCanvasDefinition({ ...definition, schemaVersion: 3, blocks: [treemap] }),
    ).toThrow();
    expect(decodeCanvasDefinition({ ...definition, blocks: [treemap] })).toMatchObject({
      blocks: [treemap],
    });
  });

  it("rejects a long label, an unknown scale, and executable fields", () => {
    expect(() =>
      decodeCanvasBlock({ ...treemap, nodes: [{ nodeId: "root", label: "x".repeat(121) }] }),
    ).toThrow();
    expect(() => decodeCanvasBlock({ ...treemap, colorScale: "rainbow" })).toThrow();
    expect(() => decodeCanvasBlock({ ...treemap, onClick: "alert(1)" })).toThrow();
  });
});

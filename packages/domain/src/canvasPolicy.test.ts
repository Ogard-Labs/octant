import { describe, expect, it } from "vitest";
import {
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_BAR_LIST_ROWS,
  CANVAS_MAX_DIAGRAM_EDGES,
  CANVAS_MAX_DIAGRAM_NODES,
  CANVAS_MAX_ER_ATTRIBUTES_PER_ENTITY,
  CANVAS_MAX_IMAGES,
  CANVAS_MAX_METRIC_SPARKLINE_POINTS,
  CANVAS_MAX_MINDMAP_NOTE_LENGTH,
  CANVAS_MAX_MOCKUP_DEPTH,
  CANVAS_MAX_MOCKUP_NODES,
  CANVAS_MAX_MOCKUP_TEXT_LENGTH,
  CANVAS_MAX_SERIES,
  CANVAS_MAX_SWIMLANE_LANES,
  CANVAS_MAX_TABLE_ROWS,
  CANVAS_MAX_TEXT_BYTES,
  CANVAS_MAX_TREEMAP_DEPTH,
  CANVAS_HEATMAP_SCHEMA_VERSION,
  CANVAS_PRESENTATION_SCHEMA_VERSION,
  CANVAS_SCHEMA_VERSION,
  CANVAS_TREEMAP_SCHEMA_VERSION,
  decodeCanvasDefinition,
  type CanvasDefinition,
} from "@octant/contracts/canvas";
import { launchDeckExample, onboardingFlowExample } from "./canvasDesignExamples";
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
      validateCanvasDefinition(withBlocks([onboardingFlowExample, launchDeckExample])),
    ).not.toThrow();
  });

  it("refuses a design block inside a document declaring an older schema version", () => {
    // A design arrived at version 7, after the treemap's 5 and the heatmap's 6.
    for (const schemaVersion of [4, 5, 6]) {
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

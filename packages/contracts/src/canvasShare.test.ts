import type { SchemaAST } from "effect";
import { describe, expect, it } from "vitest";
import { CanvasBlock } from "./canvas";
import {
  CanvasStaticExportBlock,
  decodeCanvasStaticExportDocument,
  decodeCanvasStaticExportReceipt,
  decodeCanvasStaticExportRequest,
} from "./canvasShare";

/**
 * Every field path each block kind admits, such as `columns[].display` for a
 * table, read from the schema itself so a kind or field added to one union
 * and not the other shows up without anyone listing it.
 */
function fieldPathsByKind(union: SchemaAST.AST): ReadonlyMap<string, ReadonlySet<string>> {
  const byKind = new Map<string, Set<string>>();
  const members = union._tag === "Union" ? union.types : [union];
  for (const member of members) {
    const kind = blockKind(member);
    const paths = byKind.get(kind) ?? new Set<string>();
    collectFieldPaths(member, "", paths);
    byKind.set(kind, paths);
  }
  return byKind;
}

function blockKind(ast: SchemaAST.AST): string {
  if (ast._tag === "Refinement") return blockKind(ast.from);
  if (ast._tag !== "TypeLiteral") throw new Error(`A block schema is a struct, not ${ast._tag}.`);
  const kind = ast.propertySignatures.find((signature) => signature.name === "kind");
  if (kind === undefined || kind.type._tag !== "Literal") {
    throw new Error("A block schema names its kind as a literal.");
  }
  return String(kind.type.literal);
}

function collectFieldPaths(ast: SchemaAST.AST, prefix: string, paths: Set<string>): void {
  switch (ast._tag) {
    case "Refinement":
      return collectFieldPaths(ast.from, prefix, paths);
    case "Transformation":
      return collectFieldPaths(ast.to, prefix, paths);
    case "Union":
      for (const member of ast.types) collectFieldPaths(member, prefix, paths);
      return;
    case "TupleType":
      for (const element of [...ast.elements, ...ast.rest]) {
        collectFieldPaths(element.type, `${prefix}[]`, paths);
      }
      return;
    case "TypeLiteral":
      for (const signature of ast.propertySignatures) {
        const path = prefix === "" ? String(signature.name) : `${prefix}.${String(signature.name)}`;
        paths.add(path);
        collectFieldPaths(signature.type, path, paths);
      }
      for (const index of ast.indexSignatures) collectFieldPaths(index.type, `${prefix}{}`, paths);
      return;
    default:
      return;
  }
}

const ids = {
  exportId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  project: "33333333-3333-4333-8333-333333333333",
  thread: "44444444-4444-4444-8444-444444444444",
  actor: "66666666-6666-4666-8666-666666666666",
  source: "77777777-7777-4777-8777-777777777777",
} as const;

const request = {
  schemaVersion: 1,
  kind: "canvas-static-export",
  exportId: ids.exportId,
  canvasId: ids.canvas,
  versionId: ids.version,
  expectedSequence: 1,
  hostId: "local",
  projectId: ids.project,
  channel: "static-export",
  consent: {
    acknowledgedOfflineSnapshot: true,
    acknowledgedNoCredentials: true,
    acknowledgedAt: "2026-08-04T12:00:00.000Z",
    acknowledgedBy: { kind: "local-user", actorId: ids.actor },
  },
  note: "Offline board pack for review",
} as const;

const document = {
  schemaVersion: 1,
  kind: "canvas-static-export-document",
  exportId: ids.exportId,
  canvasId: ids.canvas,
  versionId: ids.version,
  sequence: 1,
  exportedAt: "2026-08-04T12:00:01.000Z",
  title: "Weekly plan",
  channel: "static-export",
  sharingEnabled: true,
  provenance: {
    hostId: "local",
    projectId: ids.project,
    mode: "chat",
    threadId: ids.thread,
    createdAt: "2026-08-04T11:00:00.000Z",
    providerLabel: "provider",
    modelLabel: "model",
    actorKind: "local-user",
  },
  sourceManifest: [
    {
      sourceId: ids.source,
      kind: "artifact",
      displayName: "Artifact",
      opaqueRef: "artifact:one",
    },
  ],
  blocks: [
    {
      blockId: "heading-1",
      schemaVersion: 1,
      kind: "heading",
      level: 1,
      text: "Weekly plan",
    },
  ],
  threatModelId: "canvas-share-static-export-v1",
} as const;

describe("Canvas share contracts", () => {
  it("round-trips an explicit-consent static export request", () => {
    expect(decodeCanvasStaticExportRequest(request)).toEqual(request);
  });

  it("rejects missing consent acknowledgements", () => {
    expect(() =>
      decodeCanvasStaticExportRequest({
        ...request,
        consent: {
          ...request.consent,
          acknowledgedOfflineSnapshot: false,
        },
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportRequest({
        ...request,
        consent: {
          acknowledgedOfflineSnapshot: true,
          acknowledgedAt: request.consent.acknowledgedAt,
          acknowledgedBy: request.consent.acknowledgedBy,
        },
      }),
    ).toThrow();
  });

  it("rejects system actors as consent principals", () => {
    expect(() =>
      decodeCanvasStaticExportRequest({
        ...request,
        consent: {
          ...request.consent,
          acknowledgedBy: { kind: "system", actorId: ids.actor },
        },
      }),
    ).toThrow();
  });

  it("rejects export documents with unknown or source-bound block payloads", () => {
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "mystery-1",
            schemaVersion: 1,
            kind: "executable-plugin",
            payload: { token: "sk-1234567890abcdef" },
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "source-1",
            schemaVersion: 1,
            kind: "source-reference",
            label: "Artifact",
            sourceId: ids.source,
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects non-static channels and public-link shapes", () => {
    expect(() =>
      decodeCanvasStaticExportRequest({
        ...request,
        channel: "authenticated-snapshot",
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportRequest({
        ...request,
        publicUrl: "https://example.com/share",
      }),
    ).toThrow();
  });

  it("round-trips a sanitized static export document and receipt", () => {
    expect(decodeCanvasStaticExportDocument(document)).toEqual(document);
    const receipt = {
      schemaVersion: 1,
      kind: "canvas-static-export-receipt",
      exportId: ids.exportId,
      canvasId: ids.canvas,
      versionId: ids.version,
      sequence: 1,
      exportedAt: document.exportedAt,
      channel: "static-export",
      document,
      consent: request.consent,
      note: "Offline board pack for review",
    } as const;
    expect(decodeCanvasStaticExportReceipt(receipt)).toEqual(receipt);
  });

  it("round-trips sequence, state, and mockup blocks in a static export document", () => {
    const blocks = [
      {
        blockId: "login",
        schemaVersion: 1,
        kind: "sequence",
        participants: [
          { participantId: "person", label: "Person" },
          { participantId: "auth", label: "Auth" },
        ],
        messages: [{ messageId: "submit", from: "person", to: "auth", label: "Submit" }],
      },
      {
        blockId: "order",
        schemaVersion: 1,
        kind: "state",
        states: [
          { stateId: "start", label: "Start", role: "initial" },
          { stateId: "placed", label: "Placed" },
        ],
        transitions: [{ transitionId: "place", source: "start", target: "placed", label: "place" }],
      },
      {
        blockId: "settings",
        schemaVersion: 1,
        kind: "mockup",
        device: "phone",
        title: "Settings",
        nodes: [
          { nodeId: "window", component: "window", label: "Settings" },
          { nodeId: "wifi", component: "toggle", label: "Wi-Fi", parentId: "window", on: true },
        ],
      },
    ];
    const exported = { ...document, schemaVersion: 2, blocks };
    expect(decodeCanvasStaticExportDocument(exported)).toEqual(exported);
    // A v1 share document carrying a mockup is a rolled-back runtime's failure
    // mode: the decode refuses it instead of dropping the block.
    expect(() => decodeCanvasStaticExportDocument({ ...document, blocks })).toThrow();
  });

  it("round-trips a catalog mockup only under the share version that declared it", () => {
    const mockup = {
      blockId: "settings",
      schemaVersion: 12,
      kind: "mockup",
      device: "dock-panel",
      fidelity: "styled",
      title: "Settings",
      variants: [
        { variantId: "a", label: "A" },
        { variantId: "b", label: "B" },
      ],
      nodes: [
        { nodeId: "a-root", component: "stack", label: "Option A", variantId: "a" },
        { nodeId: "save", component: "button", label: "Save", tone: "accent", parentId: "a-root" },
        { nodeId: "b-root", component: "stack", label: "Option B", variantId: "b" },
        {
          nodeId: "people",
          component: "table",
          label: "People",
          columns: ["Name"],
          rows: [["Ada"]],
          parentId: "b-root",
        },
      ],
      annotations: [{ nodeId: "save", note: "Saves every section at once." }],
    };
    const exported = { ...document, schemaVersion: 6, blocks: [mockup] };
    expect(decodeCanvasStaticExportDocument(exported)).toEqual(exported);
    expect(() =>
      decodeCanvasStaticExportDocument({ ...document, schemaVersion: 5, blocks: [mockup] }),
    ).toThrow();
  });

  it("round-trips entity-relationship, swimlane, and mind map blocks in a static export document", () => {
    const blocks = [
      {
        blockId: "order-schema",
        schemaVersion: 8,
        kind: "er",
        entities: [
          {
            entityId: "person",
            label: "Person",
            attributes: [{ attributeId: "person-id", name: "id", type: "uuid", key: true }],
          },
          {
            entityId: "order",
            label: "Order",
            attributes: [{ attributeId: "order-id", name: "id", type: "uuid", key: true }],
          },
        ],
        relationships: [
          {
            relationshipId: "person-places-order",
            source: "person",
            target: "order",
            sourceCardinality: "one",
            targetCardinality: "many",
            label: "places",
          },
        ],
      },
      {
        blockId: "support-flow",
        schemaVersion: 8,
        kind: "swimlane",
        lanes: [
          { laneId: "customer", label: "Customer", kind: "actor" },
          { laneId: "support", label: "Support", kind: "team" },
        ],
        steps: [
          { stepId: "report", laneId: "customer", label: "Report" },
          { stepId: "triage", laneId: "support", label: "Is it a defect?", decision: true },
        ],
        connections: [{ connectionId: "report-triage", source: "report", target: "triage" }],
      },
      {
        blockId: "release-mindmap",
        schemaVersion: 8,
        kind: "mindmap",
        nodes: [
          { nodeId: "release", label: "Release" },
          { nodeId: "tests", label: "Tests", parentId: "release", note: "green on head" },
        ],
      },
    ];
    const exported = { ...document, blocks };
    expect(decodeCanvasStaticExportDocument(exported)).toEqual(exported);
  });

  it("round-trips pie, donut, stacked-bar, grouped-bar, and bar-line charts in a static export document", () => {
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
    const charts = [
      {
        blockId: "pie-1",
        schemaVersion: 1,
        kind: "chart",
        chartType: "pie",
        series: [
          {
            seriesId: "share",
            label: "Share",
            points: [
              { x: "Product", y: 42 },
              { x: "Services", y: 28 },
            ],
          },
        ],
      },
      {
        blockId: "donut-1",
        schemaVersion: 1,
        kind: "chart",
        chartType: "donut",
        series: [
          {
            seriesId: "cost",
            label: "Cost",
            points: [
              { x: "Compute", y: 12 },
              { x: "Storage", y: 4 },
            ],
          },
        ],
      },
      {
        blockId: "stacked-1",
        schemaVersion: 1,
        kind: "chart",
        chartType: "stacked-bar",
        series: [quarters("product", [10, 14, 12]), quarters("services", [6, 8, 9])],
      },
      {
        blockId: "grouped-1",
        schemaVersion: 1,
        kind: "chart",
        chartType: "grouped-bar",
        series: [quarters("product", [10, 14, 12]), quarters("services", [6, 8, 9])],
      },
      {
        blockId: "combo-1",
        schemaVersion: 1,
        kind: "chart",
        chartType: "bar-line",
        series: [
          quarters("revenue", [40, 52, 48], "bar"),
          quarters("margin", [12, 15, 11], "line"),
        ],
      },
    ] as const;
    for (const block of charts) {
      const exported = { ...document, blocks: [block] };
      expect(decodeCanvasStaticExportDocument(exported)).toEqual(exported);
    }
  });

  it("shares a metric with its number format, sparkline, direction, and caption", () => {
    const exported = {
      ...document,
      blocks: [
        {
          blockId: "metric-trend",
          schemaVersion: 1,
          kind: "metric",
          label: "Lines of code",
          value: 1_360_000,
          format: "compact",
          delta: 12_400,
          goodDirection: "up",
          sparkline: [1.2, 1.24, 1.27, 1.3],
          caption: "since last release",
        },
      ],
    };
    expect(decodeCanvasStaticExportDocument(exported)).toEqual(exported);
  });

  it("shares a comparison matrix with its weights, readings, notes, and recommendation from share version 4", () => {
    const matrix = {
      blockId: "state-store",
      schemaVersion: 10,
      kind: "comparison-matrix",
      options: [
        { optionId: "sqlite", label: "SQLite", detail: "One file per host" },
        { optionId: "postgres", label: "Postgres" },
      ],
      criteria: [
        { criterionId: "ops", label: "Operational cost", weight: 2, prefer: "lower" },
        { criterionId: "offline", label: "Works offline" },
        { criterionId: "licence", label: "Licence" },
      ],
      cells: [
        { criterionId: "ops", optionId: "sqlite", score: 1, note: "No server to run" },
        { criterionId: "offline", optionId: "postgres", glyph: "partial" },
        { criterionId: "licence", optionId: "sqlite", text: "Public domain" },
      ],
      scoreRange: { min: 1, max: 5 },
      recommendedOptionId: "sqlite",
      recommendation: "No server to run.",
    };
    const exported = { ...document, schemaVersion: 4, blocks: [matrix] };
    expect(decodeCanvasStaticExportDocument(exported)).toEqual(exported);
    expect(() =>
      decodeCanvasStaticExportDocument({ ...document, schemaVersion: 3, blocks: [matrix] }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        schemaVersion: 4,
        blocks: [{ ...matrix, recommendation: "token sk-proj-abcdefghijklmnopqrstu" }],
      }),
    ).toThrow();
  });

  it("shares a display formula and a paragraph with inline formulas from share version 5", () => {
    const blocks = [
      {
        blockId: "bayes",
        schemaVersion: 11,
        kind: "math",
        layout: "display",
        source: "P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}",
        caption: "Bayes' theorem",
      },
      {
        blockId: "area",
        schemaVersion: 11,
        kind: "math",
        layout: "inline",
        runs: [{ text: "A circle covers " }, { math: "\\pi r^2" }, { text: "." }],
      },
    ];
    const exported = { ...document, schemaVersion: 5, blocks };
    expect(decodeCanvasStaticExportDocument(exported)).toEqual(exported);
    expect(() =>
      decodeCanvasStaticExportDocument({ ...document, schemaVersion: 4, blocks }),
    ).toThrow();
    // The secret filter reads formula sources and prose like any other export text.
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        schemaVersion: 5,
        blocks: [{ ...blocks[0], source: "\\text{sk-proj-abcdefghijklmnopqrstu}" }],
      }),
    ).toThrow();
  });

  it("shares treemaps, heatmaps, bar lists, number formats, table displays, and a dragged board from share version 3", () => {
    const blocks = [
      {
        blockId: "repository-map",
        schemaVersion: 5,
        kind: "treemap",
        measures: [{ measureId: "loc", label: "Lines of code", format: "compact" }],
        sizeBy: "loc",
        colorBy: "loc",
        colorScale: "sequential",
        startNodeId: "octant",
        nodes: [
          { nodeId: "octant", label: "octant" },
          { nodeId: "contracts", label: "contracts", parentId: "octant", values: { loc: 38_400 } },
        ],
      },
      {
        blockId: "commits-by-hour",
        schemaVersion: 6,
        kind: "heatmap",
        layout: "matrix",
        valueLabel: "Commits",
        format: "number",
        scale: "sequential",
        rows: [{ rowId: "mon", label: "Mon" }],
        columns: [{ columnId: "h09", label: "09" }],
        cells: [{ rowId: "mon", columnId: "h09", value: 3, note: "After the review" }],
      },
      {
        blockId: "test-failures",
        schemaVersion: 6,
        kind: "heatmap",
        layout: "calendar",
        scale: "diverging",
        days: [{ date: "2026-10-01", value: 2, note: "Flaky on CI" }],
      },
      {
        blockId: "hottest-files",
        schemaVersion: 7,
        kind: "bar-list",
        valueLabel: "Edits",
        secondaryLabel: "Lines",
        format: "number",
        secondaryFormat: "compact",
        scale: "sequential",
        rows: [{ label: "packages/contracts/src/canvas.ts", value: 19, secondaryValue: 1_290 }],
      },
      {
        blockId: "revenue",
        schemaVersion: 1,
        kind: "chart",
        chartType: "line",
        format: "compact",
        series: [{ seriesId: "revenue", label: "Revenue", points: [{ x: "Q1", y: 1_200_000 }] }],
      },
      {
        blockId: "coverage",
        schemaVersion: 1,
        kind: "table",
        columns: [
          { id: "file", label: "File", type: "text" },
          { id: "covered", label: "Covered", type: "number", format: "percent", display: "bar" },
          { id: "state", label: "State", type: "status", display: "status" },
        ],
        rows: [["canvas.ts", 0.82, "ok"]],
      },
      {
        blockId: "board",
        schemaVersion: 2,
        kind: "diagram",
        layout: "manual",
        nodes: [
          { nodeId: "web", label: "Web", x: 40, y: 40, positioned: true },
          { nodeId: "db", label: "Database" },
        ],
        edges: [{ edgeId: "web-db", source: "web", target: "db" }],
      },
    ];
    const exported = { ...document, schemaVersion: 3, blocks };
    expect(decodeCanvasStaticExportDocument(exported)).toEqual(exported);
    // A version 2 share is what a runtime without these wrote, so one that
    // carries any of them is refused rather than drawn without its readings.
    for (const block of blocks) {
      expect(() =>
        decodeCanvasStaticExportDocument({ ...document, schemaVersion: 2, blocks: [block] }),
      ).toThrow();
    }
  });

  it("carries every Canvas block kind and field except the ones a share refuses or drops", () => {
    const live = fieldPathsByKind(CanvasBlock.ast);
    const shared = fieldPathsByKind(CanvasStaticExportBlock.ast);
    // A design's markup draws only inside Octant and an action names a command
    // only this host runs, so a share refuses both. A source id resolves only
    // against the host that wrote it, so a share drops every one. A table
    // row's id is what a comment anchors to and a share carries no comments,
    // so a keyed row leaves as its cells.
    const refusedKinds = new Set(["design", "action"]);
    const flattened = new Set(["table.rows[].id", "table.rows[].cells"]);
    const dropped = (kind: string, path: string) =>
      /(?:^|\.)sourceIds?$/.test(path) || flattened.has(`${kind}.${path}`);
    const missing: string[] = [];
    for (const [kind, paths] of live) {
      const sharedPaths = shared.get(kind);
      if (refusedKinds.has(kind)) {
        expect(sharedPaths).toBeUndefined();
        continue;
      }
      if (sharedPaths === undefined) {
        missing.push(kind);
        continue;
      }
      for (const path of paths) {
        if (!dropped(kind, path) && !sharedPaths.has(path)) missing.push(`${kind}.${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("rejects secret-bearing export text and credential query URLs at decode time", () => {
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "rich-1",
            schemaVersion: 1,
            kind: "rich-text",
            text: "token ghp_abcdefghijklmnopqrstuvwx",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "link-1",
            schemaVersion: 1,
            kind: "link",
            label: "Artifact",
            href: "https://example.test/file?token=opaque-secret",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects secret-bearing labels and host paths at decode time", () => {
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "metric-1",
            schemaVersion: 1,
            kind: "metric",
            label: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            value: 1,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "rich-path",
            schemaVersion: 1,
            kind: "rich-text",
            text: "See /Users/alice/project/.env for details",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        blocks: [
          {
            blockId: "rich-file-url",
            schemaVersion: 1,
            kind: "rich-text",
            text: "file:///etc/passwd",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects authenticated-snapshot documents inside static-export receipts", () => {
    expect(() =>
      decodeCanvasStaticExportReceipt({
        schemaVersion: 1,
        kind: "canvas-static-export-receipt",
        exportId: ids.exportId,
        canvasId: ids.canvas,
        versionId: ids.version,
        sequence: 1,
        exportedAt: document.exportedAt,
        channel: "static-export",
        document: {
          ...document,
          channel: "authenticated-snapshot",
          threatModelId: "canvas-share-authenticated-snapshot-v1",
        },
        consent: request.consent,
      }),
    ).toThrow();
  });

  it("rejects secret-bearing document titles at decode time", () => {
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        title: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasStaticExportDocument({
        ...document,
        title: "See /Users/alice/project/.env for details",
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  CANVAS_AGGREGATE_TYPE,
  CANVAS_CREATED,
  CANVAS_DASHBOARD_SCHEMA_VERSION,
  CANVAS_MAX_DASHBOARD_CELLS,
  CANVAS_MAX_DASHBOARD_COLUMNS,
  CANVAS_BAR_LIST_SCHEMA_VERSION,
  CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION,
  CANVAS_DESIGN_ASSET_SCHEMA_VERSION,
  CANVAS_DESIGN_RUNNING_SCHEMA_VERSION,
  CANVAS_DESIGN_ASSETS_MAX_BYTES,
  CANVAS_DESIGN_DOCUMENT_SCHEMA_VERSION,
  CANVAS_MAX_DESIGN_ASSETS,
  CANVAS_MAX_DESIGN_MARKUP_LENGTH,
  CANVAS_DESIGN_SCHEMA_VERSION,
  CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION,
  CANVAS_THREAD_OWNED_SCHEMA_VERSION,
  CANVAS_CHART_CALLOUTS_SCHEMA_VERSION,
  CANVAS_FLOW_SCHEMA_VERSION,
  CANVAS_MOCKUP_LIBRARY_SCHEMA_VERSION,
  CANVAS_DESIGN_FIELDS_SCHEMA_VERSION,
  CANVAS_MAX_DESIGN_BRAND_TOKENS,
  CANVAS_MAX_DESIGN_NOTES_LENGTH,
  CANVAS_MAX_DIAGRAM_DETAIL_LENGTH,
  CANVAS_EVENT_NAMES,
  CANVAS_FLOW_CHARTS_SCHEMA_VERSION,
  CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH,
  CANVAS_MAX_FUNNEL_STAGES,
  CANVAS_MAX_RADAR_AXES,
  CANVAS_MAX_SANKEY_LINKS,
  CANVAS_MAX_SANKEY_NODES,
  CANVAS_MIN_RADAR_AXES,
  CANVAS_HEATMAP_SCHEMA_VERSION,
  CANVAS_MAX_BAR_LIST_ROWS,
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_DIAGRAM_EDGES,
  CANVAS_MAX_DIAGRAM_NODES,
  CANVAS_MAX_IMAGES,
  CANVAS_MAX_MATRIX_CRITERIA,
  CANVAS_MAX_MATRIX_NOTE_LENGTH,
  CANVAS_MAX_MATRIX_OPTIONS,
  CANVAS_MAX_MATRIX_WEIGHT,
  CANVAS_MAX_MATH_RUNS,
  CANVAS_MAX_MATH_SOURCE_LENGTH,
  CANVAS_MATH_SCHEMA_VERSION,
  CANVAS_MAX_MOCKUP_ANNOTATIONS,
  CANVAS_MAX_MOCKUP_NODES,
  CANVAS_MAX_MOCKUP_TABLE_COLUMNS,
  CANVAS_MAX_MOCKUP_VARIANTS,
  CANVAS_MOCKUP_CATALOG_SCHEMA_VERSION,
  CANVAS_MOCKUP_LEGACY_MAX_NODES,
  CANVAS_MAX_METRIC_SPARKLINE_POINTS,
  CANVAS_MAX_MINDMAP_NOTE_LENGTH,
  CANVAS_MAX_TABLE_ROWS,
  CANVAS_PRESENTATION_SCHEMA_VERSION,
  CANVAS_SCHEMA_VERSION,
  CANVAS_TABLE_ROW_ID_SCHEMA_VERSION,
  CANVAS_LAYOUT_GROUPS_SCHEMA_VERSION,
  CANVAS_TREEMAP_SCHEMA_VERSION,
  CANVAS_VERSION_APPENDED,
  CanvasCreated,
  CanvasDefinition,
  CanvasVersion,
  CanvasVersionAppended,
  decodeCanvasBlock,
  decodeCanvasCreated,
  decodeCanvasDefinition,
  decodeCanvasDesignAssetsOutcome,
  decodeCanvasDesignRunOutcome,
  decodeCanvasSourceManifestEntry,
  decodeCanvasVersion,
  decodeCanvasVersionAppended,
  canvasTableRowCells,
  canvasTableRowId,
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

  it("admits a Chat Canvas owned by its thread only from the version that declared it", () => {
    const threadOwned = {
      ...definition,
      provenance: { ...provenance, projectId: null },
      sourceManifest: [],
    } as const;
    expect(decodeCanvasDefinition(threadOwned)).toEqual(threadOwned);
    // A rolled-back runtime refuses it as a future version rather than
    // reading the missing Project as corruption.
    const older = CANVAS_THREAD_OWNED_SCHEMA_VERSION - 1;
    expect(() =>
      decodeCanvasDefinition({
        ...threadOwned,
        schemaVersion: older,
        blocks: [{ ...heading, schemaVersion: older }],
      }),
    ).toThrow();
    // Work and Code always have a Project to belong to.
    expect(() =>
      decodeCanvasDefinition({
        ...threadOwned,
        provenance: { ...threadOwned.provenance, mode: "work" },
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
    // Version 3 documents written before the presentation hint keep decoding,
    // and a version 4 document with a mockup still does too.
    expect(
      decodeCanvasDefinition({ ...definition, schemaVersion: 3, blocks: [mockup] }),
    ).toMatchObject({ blocks: [mockup] });
    expect(
      decodeCanvasDefinition({ ...definition, schemaVersion: 4, blocks: [mockup] }),
    ).toMatchObject({ blocks: [mockup] });
  });

  it("admits design blocks only under the version that declared them", () => {
    const design = {
      blockId: "design-1",
      schemaVersion: 9,
      kind: "design",
      title: "Checkout",
      size: "phone",
      frames: [{ frameId: "cart", title: "Cart", html: "<h1>Cart</h1>" }],
    } as const;
    expect(decodeCanvasDefinition({ ...definition, blocks: [design] })).toMatchObject({
      blocks: [design],
    });
    // A design arrived at version 9, after every earlier block kind and hint.
    for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(() =>
        decodeCanvasDefinition({ ...definition, schemaVersion, blocks: [design] }),
      ).toThrow();
    }
    expect(() =>
      decodeCanvasDefinition({ ...definition, blocks: [{ ...design, frames: [] }] }),
    ).toThrow();
    expect(() =>
      decodeCanvasDefinition({ ...definition, blocks: [{ ...design, size: "watch" }] }),
    ).toThrow();
  });

  it("holds a whole app window in one frame and refuses a frame or stylesheet past 64 KiB", () => {
    const appWindow = {
      blockId: "window",
      schemaVersion: CANVAS_DESIGN_RUNNING_SCHEMA_VERSION,
      kind: "design",
      title: "Workspace window",
      size: "desktop",
      runsScript: true,
      frames: [{ frameId: "app", title: "App", html: "x".repeat(CANVAS_MAX_DESIGN_MARKUP_LENGTH) }],
    } as const;
    expect(CANVAS_MAX_DESIGN_MARKUP_LENGTH).toBe(65_536);
    expect(decodeCanvasDefinition({ ...definition, blocks: [appWindow] })).toMatchObject({
      blocks: [appWindow],
    });
    const over = "x".repeat(CANVAS_MAX_DESIGN_MARKUP_LENGTH + 1);
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        blocks: [{ ...appWindow, frames: [{ ...appWindow.frames[0], html: over }] }],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasDefinition({ ...definition, blocks: [{ ...appWindow, styles: over }] }),
    ).toThrow();
  });

  it("admits a design document and a theme only under the version that declared them", () => {
    const article = {
      blockId: "article",
      schemaVersion: CANVAS_DESIGN_DOCUMENT_SCHEMA_VERSION,
      kind: "design",
      title: "Release notes",
      size: "document",
      frames: [
        { frameId: "notes", title: "Notes", html: '<article class="oct-article"></article>' },
      ],
    } as const;
    const themedPhone = {
      ...article,
      blockId: "themed-phone",
      size: "phone",
      theme: "workspace",
    } as const;
    for (const block of [article, themedPhone, { ...article, theme: "none" } as const]) {
      expect(decodeCanvasDefinition({ ...definition, blocks: [block] })).toMatchObject({
        blocks: [block],
      });
      // An older runtime reads these as a document it cannot draw yet, not as
      // a phone design drawn without the theme it asked for.
      expect(() =>
        decodeCanvasDefinition({
          ...definition,
          schemaVersion: CANVAS_DASHBOARD_SCHEMA_VERSION,
          blocks: [{ ...block, schemaVersion: CANVAS_DASHBOARD_SCHEMA_VERSION }],
        }),
      ).toThrow();
    }
    // A version-15 phone design without a theme stays readable.
    const phone = { ...article, schemaVersion: 15, size: "phone" } as const;
    expect(
      decodeCanvasDefinition({ ...definition, schemaVersion: 15, blocks: [phone] }),
    ).toMatchObject({ blocks: [phone] });
    expect(() =>
      decodeCanvasDefinition({ ...definition, blocks: [{ ...article, theme: "sepia" }] }),
    ).toThrow();
    expect(CANVAS_DESIGN_DOCUMENT_SCHEMA_VERSION).toBe(16);
  });

  it("admits a design's declared assets only under the version that declared them", () => {
    const mockup = {
      blockId: "phone",
      schemaVersion: CANVAS_DESIGN_ASSET_SCHEMA_VERSION,
      kind: "design",
      title: "Onboarding",
      size: "phone",
      assets: [
        {
          assetId: "home-shot",
          source: { kind: "project-file", path: "screens/home.png" },
          description: "Home screen",
        },
        {
          assetId: "hero",
          source: { kind: "generated-image", imageId: "11111111-1111-4111-8111-111111111111" },
        },
      ],
      frames: [
        { frameId: "home", title: "Home", html: '<img src="octant-asset:home-shot" alt="">' },
      ],
    } as const;
    expect(decodeCanvasDefinition({ ...definition, blocks: [mockup] })).toMatchObject({
      blocks: [mockup],
    });
    // An older runtime reads a design that names assets as a newer document,
    // not as a phone design with broken images.
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: CANVAS_DESIGN_DOCUMENT_SCHEMA_VERSION,
        blocks: [{ ...mockup, schemaVersion: CANVAS_DESIGN_DOCUMENT_SCHEMA_VERSION }],
      }),
    ).toThrow();
    // The definition holds references, never bytes, and only the two sources.
    for (const source of [
      { kind: "project-file", path: "a.png", bytes: "iVBORw0KGgo=" },
      { kind: "url", url: "https://example.test/a.png" },
      { kind: "generated-image", imageId: "not-a-uuid" },
    ]) {
      expect(() =>
        decodeCanvasDefinition({
          ...definition,
          blocks: [{ ...mockup, assets: [{ assetId: "x", source }] }],
        }),
      ).toThrow();
    }
    for (const assetId of ["has space", "colon:id", "", "-leading"]) {
      expect(() =>
        decodeCanvasDefinition({
          ...definition,
          blocks: [
            { ...mockup, assets: [{ assetId, source: { kind: "project-file", path: "a.png" } }] },
          ],
        }),
      ).toThrow();
    }
    const tooMany = Array.from({ length: CANVAS_MAX_DESIGN_ASSETS + 1 }, (_, index) => ({
      assetId: `a${String(index)}`,
      source: { kind: "project-file", path: "a.png" },
    }));
    expect(() =>
      decodeCanvasDefinition({ ...definition, blocks: [{ ...mockup, assets: tooMany }] }),
    ).toThrow();
    expect(CANVAS_DESIGN_ASSET_SCHEMA_VERSION).toBe(17);
  });

  it("admits a running design only under the version that declared it", () => {
    const prototype = {
      blockId: "checkout",
      schemaVersion: CANVAS_DESIGN_RUNNING_SCHEMA_VERSION,
      kind: "design",
      title: "Checkout",
      size: "phone",
      runsScript: true,
      frames: [{ frameId: "cart", title: "Cart", html: "<button>Pay</button>" }],
    } as const;
    expect(decodeCanvasDefinition({ ...definition, blocks: [prototype] })).toMatchObject({
      blocks: [prototype],
    });
    // An older runtime reads a running design as a newer document, never as a
    // static design whose script it would silently drop.
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: CANVAS_DESIGN_ASSET_SCHEMA_VERSION,
        blocks: [{ ...prototype, schemaVersion: CANVAS_DESIGN_ASSET_SCHEMA_VERSION }],
      }),
    ).toThrow();
    // A static design says so by leaving the field out; there is no false.
    expect(() =>
      decodeCanvasDefinition({ ...definition, blocks: [{ ...prototype, runsScript: false }] }),
    ).toThrow();
    expect(CANVAS_DESIGN_RUNNING_SCHEMA_VERSION).toBe(18);
  });

  it("offers a running design's page only as a ticketed path on the host", () => {
    const ready = {
      kind: "ready",
      canvasId: "22222222-2222-4222-8222-222222222222",
      versionId: "33333333-3333-4333-8333-333333333333",
      blockId: "checkout",
      page: `/api/canvas/design-page?ticket=${"a".repeat(43)}`,
    };
    expect(decodeCanvasDesignRunOutcome(ready)).toEqual(ready);
    for (const page of [
      "https://example.test/api/canvas/design-page?ticket=" + "a".repeat(43),
      "/api/canvas/design-page?ticket=short",
      `/api/canvas/design-page?ticket=${"a".repeat(43)}&windowCapability=x`,
      `//example.test/api/canvas/design-page?ticket=${"a".repeat(43)}`,
    ]) {
      expect(() => decodeCanvasDesignRunOutcome({ ...ready, page })).toThrow();
    }
  });

  it("keeps one design's resolved images inside what a paired client's gateway forwards", () => {
    // Base64 grows bytes by a third; the remote gateway forwards 8 MiB.
    expect(Math.ceil(CANVAS_DESIGN_ASSETS_MAX_BYTES / 3) * 4 + 64 * 1024).toBeLessThan(
      8 * 1024 * 1024,
    );
    const outcome = {
      kind: "ready",
      canvasId: "22222222-2222-4222-8222-222222222222",
      versionId: "33333333-3333-4333-8333-333333333333",
      blockId: "phone",
      assets: [
        { assetId: "hero", status: "resolved", mediaType: "image/png", data: "iVBORw0KGgo=" },
        { assetId: "shot", status: "unavailable", reason: "refused" },
      ],
    };
    expect(decodeCanvasDesignAssetsOutcome(outcome)).toEqual(outcome);
    expect(() =>
      decodeCanvasDesignAssetsOutcome({
        ...outcome,
        assets: [{ assetId: "hero", status: "resolved", mediaType: "image/svg+xml", data: "" }],
      }),
    ).toThrow();
  });

  it("admits a thread presentation only under the version that declared it", () => {
    expect(
      decodeCanvasDefinition({ ...definition, schemaVersion: 4, presentation: "inline" }),
    ).toMatchObject({ presentation: "inline" });
    expect(() =>
      decodeCanvasDefinition({ ...definition, schemaVersion: 3, presentation: "inline" }),
    ).toThrow();
    expect(() =>
      decodeCanvasDefinition({ ...definition, schemaVersion: 4, presentation: "floating" }),
    ).toThrow();
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
      {
        blockId: "bar-list-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "bar-list",
        valueLabel: "Edits",
        format: "number",
        scale: "sequential",
        rows: [
          { label: "apps/web", value: 41, secondaryValue: 1189 },
          { label: "packages/domain", value: 33 },
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

describe("canvas table column displays", () => {
  it("accepts an optional display on a table column and leaves it absent otherwise", () => {
    const block = decodeCanvasBlock({
      blockId: "table-display",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "table",
      columns: [
        { id: "asset", label: "Asset", type: "text" },
        { id: "requests", label: "Requests", type: "number", display: "bar" },
        { id: "errors", label: "Errors", type: "number", display: "heat" },
        { id: "state", label: "State", type: "text", display: "status" },
      ],
      rows: [["bundle.js", 1200, 3, "Ready"]],
    });

    expect(block).toMatchObject({
      columns: [{}, { display: "bar" }, { display: "heat" }, { display: "status" }],
    });
    const columns = (block as { readonly columns: ReadonlyArray<Record<string, unknown>> }).columns;
    expect(columns[0]).not.toHaveProperty("display");
  });

  it("rejects a display outside the closed set", () => {
    expect(() =>
      decodeCanvasBlock({
        blockId: "bad-column-display",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "table",
        columns: [{ id: "requests", label: "Requests", type: "number", display: "sparkline" }],
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
    // A treemap arrived at version 5: both the mockup-era v3 bound and the
    // presentation-era v4 bound refuse it as a declared future version.
    expect(() =>
      decodeCanvasDefinition({ ...definition, schemaVersion: 3, blocks: [treemap] }),
    ).toThrow();
    expect(() =>
      decodeCanvasDefinition({ ...definition, schemaVersion: 4, blocks: [treemap] }),
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

describe("heatmap blocks", () => {
  const matrix = {
    blockId: "commits-by-hour",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "heatmap",
    layout: "matrix",
    valueLabel: "Commits",
    format: "number",
    scale: "sequential",
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
  };
  const calendar = {
    blockId: "test-failures",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "heatmap",
    layout: "calendar",
    valueLabel: "Test failures",
    scale: "diverging",
    days: [
      { date: "2026-09-01", value: 0 },
      { date: "2026-09-02", value: 2 },
    ],
  };

  it("decodes a matrix with rows, columns, and a cell per coordinate", () => {
    const block = decodeCanvasBlock(matrix);

    expect(block).toMatchObject({
      kind: "heatmap",
      layout: "matrix",
      valueLabel: "Commits",
      scale: "sequential",
    });
  });

  it("decodes a calendar with one reading per date", () => {
    const block = decodeCanvasBlock(calendar);

    expect(block).toMatchObject({ kind: "heatmap", layout: "calendar", scale: "diverging" });
  });

  it("admits a heatmap only under the version that declared it", () => {
    // A heatmap arrived at version 6: a document declaring the presentation-era
    // v4 bound or the treemap-era v5 bound refuses it as a declared future
    // version.
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: 4,
        blocks: [matrix],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: CANVAS_TREEMAP_SCHEMA_VERSION,
        blocks: [matrix],
      }),
    ).toThrow();
    expect(
      decodeCanvasDefinition({
        ...definition,
        blocks: [calendar],
      }),
    ).toMatchObject({ blocks: [calendar] });
  });

  it("rejects an unknown layout or scale, a bad date, an over-long note, and executable fields", () => {
    expect(() => decodeCanvasBlock({ ...matrix, layout: "spiral" })).toThrow();
    expect(() => decodeCanvasBlock({ ...matrix, scale: "rainbow" })).toThrow();
    expect(() =>
      decodeCanvasBlock({ ...calendar, days: [{ date: "2026-02-30", value: 1 }] }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...matrix,
        cells: [{ rowId: "mon", columnId: "h09", value: 1, note: "x".repeat(121) }],
      }),
    ).toThrow();
    expect(() => decodeCanvasBlock({ ...matrix, onClick: "alert(1)" })).toThrow();
  });
});

describe("bar list blocks", () => {
  const barList = {
    blockId: "hottest-files",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "bar-list",
    valueLabel: "Edits",
    secondaryLabel: "Lines",
    format: "number",
    scale: "sequential",
    rows: [
      { label: "apps/web/src/canvas/blocks/ChartBlock.tsx", value: 41, secondaryValue: 1189 },
      { label: "packages/domain/src", value: 33 },
    ],
  };

  it("decodes a ranking of labeled rows with a value and an optional second value", () => {
    const block = decodeCanvasBlock(barList);

    expect(block).toMatchObject({
      kind: "bar-list",
      valueLabel: "Edits",
      scale: "sequential",
      rows: [
        { label: "apps/web/src/canvas/blocks/ChartBlock.tsx", value: 41, secondaryValue: 1189 },
        { label: "packages/domain/src", value: 33 },
      ],
    });
  });

  it("admits a bar list only under the version that declared it", () => {
    // A bar list arrived at version 7: a treemap-era v5 document and a
    // heatmap-era v6 document refuse it as a declared future version.
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: CANVAS_TREEMAP_SCHEMA_VERSION,
        blocks: [barList],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: CANVAS_HEATMAP_SCHEMA_VERSION,
        blocks: [barList],
      }),
    ).toThrow();
    expect(decodeCanvasDefinition({ ...definition, blocks: [barList] })).toMatchObject({
      blocks: [barList],
    });
  });

  it("rejects an unknown scale, an empty ranking, an over-long list, and executable fields", () => {
    expect(() => decodeCanvasBlock({ ...barList, scale: "rainbow" })).toThrow();
    expect(() => decodeCanvasBlock({ ...barList, rows: [] })).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...barList,
        rows: Array.from({ length: CANVAS_MAX_BAR_LIST_ROWS + 1 }, (_value, index) => ({
          label: `row-${String(index)}`,
          value: index,
        })),
      }),
    ).toThrow();
    expect(() => decodeCanvasBlock({ ...barList, onClick: "alert(1)" })).toThrow();
  });

  it("keeps the bar-list floor ahead of every earlier version", () => {
    expect(CANVAS_BAR_LIST_SCHEMA_VERSION).toBeGreaterThan(CANVAS_HEATMAP_SCHEMA_VERSION);
    expect(CANVAS_BAR_LIST_SCHEMA_VERSION).toBeLessThan(CANVAS_SCHEMA_VERSION);
  });
});

describe("comparison matrix blocks", () => {
  const matrix = {
    blockId: "state-store",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "comparison-matrix",
    options: [
      { optionId: "sqlite", label: "SQLite", detail: "one file per host" },
      { optionId: "postgres", label: "Postgres" },
    ],
    criteria: [
      { criterionId: "ops", label: "Operational cost", weight: 3, prefer: "lower" },
      { criterionId: "offline", label: "Works offline", weight: 2 },
      { criterionId: "licence", label: "Licence" },
    ],
    cells: [
      { criterionId: "ops", optionId: "sqlite", score: 1, note: "no server to run" },
      { criterionId: "ops", optionId: "postgres", score: 4 },
      { criterionId: "offline", optionId: "sqlite", glyph: "yes" },
      { criterionId: "offline", optionId: "postgres", glyph: "partial" },
      { criterionId: "licence", optionId: "sqlite", text: "Public domain" },
    ],
    scoreRange: { min: 1, max: 5 },
    recommendedOptionId: "sqlite",
    recommendation: "A local-first host has no server to run.",
  };

  it("decodes options, weighted criteria, and a score, text, or glyph in each cell", () => {
    const block = decodeCanvasBlock(matrix);
    expect(block).toMatchObject(matrix);
  });

  it("admits a comparison matrix only under the version that declared it", () => {
    for (const earlier of [CANVAS_DESIGN_SCHEMA_VERSION, CANVAS_BAR_LIST_SCHEMA_VERSION]) {
      expect(() =>
        decodeCanvasDefinition({ ...definition, schemaVersion: earlier, blocks: [matrix] }),
      ).toThrow();
    }
    expect(decodeCanvasDefinition({ ...definition, blocks: [matrix] })).toMatchObject({
      blocks: [matrix],
    });
    expect(CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION).toBe(10);
  });

  it("refuses a cell that carries two readings or none", () => {
    expect(() =>
      decodeCanvasBlock({
        ...matrix,
        cells: [{ criterionId: "ops", optionId: "sqlite", score: 1, glyph: "yes" }],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({ ...matrix, cells: [{ criterionId: "ops", optionId: "sqlite" }] }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...matrix,
        cells: [{ criterionId: "ops", optionId: "sqlite", glyph: "maybe" }],
      }),
    ).toThrow();
  });

  it("refuses a weight past its bound, an inverted score range, and an unknown preference", () => {
    expect(() =>
      decodeCanvasBlock({
        ...matrix,
        criteria: [{ criterionId: "ops", label: "Ops", weight: CANVAS_MAX_MATRIX_WEIGHT + 1 }],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...matrix,
        criteria: [{ criterionId: "ops", label: "Ops", weight: -1 }],
      }),
    ).toThrow();
    expect(() => decodeCanvasBlock({ ...matrix, scoreRange: { min: 5, max: 1 } })).toThrow();
    expect(() => decodeCanvasBlock({ ...matrix, scoreRange: { min: 3, max: 3 } })).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...matrix,
        criteria: [{ criterionId: "ops", label: "Ops", prefer: "middle" }],
      }),
    ).toThrow();
  });

  it("refuses an empty or oversized grid, a long note, and executable fields", () => {
    expect(() => decodeCanvasBlock({ ...matrix, options: [] })).toThrow();
    expect(() => decodeCanvasBlock({ ...matrix, criteria: [] })).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...matrix,
        options: Array.from({ length: CANVAS_MAX_MATRIX_OPTIONS + 1 }, (_value, index) => ({
          optionId: `option-${String(index)}`,
          label: `Option ${String(index)}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...matrix,
        criteria: Array.from({ length: CANVAS_MAX_MATRIX_CRITERIA + 1 }, (_value, index) => ({
          criterionId: `criterion-${String(index)}`,
          label: `Criterion ${String(index)}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...matrix,
        cells: [
          {
            criterionId: "ops",
            optionId: "sqlite",
            score: 1,
            note: "x".repeat(CANVAS_MAX_MATRIX_NOTE_LENGTH + 1),
          },
        ],
      }),
    ).toThrow();
    expect(() => decodeCanvasBlock({ ...matrix, html: "<b>x</b>" })).toThrow();
    expect(() => decodeCanvasBlock({ ...matrix, onClick: "alert(1)" })).toThrow();
  });
});

describe("math blocks", () => {
  const display = {
    blockId: "bayes",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "math",
    layout: "display",
    source: "P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}",
    caption: "Bayes' theorem",
  };
  const inline = {
    blockId: "area",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "math",
    layout: "inline",
    runs: [
      { text: "A circle of radius " },
      { math: "r" },
      { text: " covers " },
      { math: "\\pi r^2" },
    ],
  };

  it("decodes a display formula with a caption and a paragraph of prose and formula runs", () => {
    expect(decodeCanvasBlock(display)).toMatchObject(display);
    // Prose keeps the spaces that separate it from the formula beside it.
    expect(decodeCanvasBlock(inline)).toMatchObject(inline);
  });

  it("admits math only under the version that declared it", () => {
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION,
        blocks: [display],
      }),
    ).toThrow();
    expect(decodeCanvasDefinition({ ...definition, blocks: [display, inline] })).toMatchObject({
      blocks: [display, inline],
    });
    expect(CANVAS_MATH_SCHEMA_VERSION).toBe(11);
  });

  it("refuses a run that is both prose and a formula, or neither, and a blank prose run", () => {
    expect(() => decodeCanvasBlock({ ...inline, runs: [{ text: "x", math: "x" }] })).toThrow();
    expect(() => decodeCanvasBlock({ ...inline, runs: [{}] })).toThrow();
    expect(() => decodeCanvasBlock({ ...inline, runs: [{ text: "   " }] })).toThrow();
    expect(() => decodeCanvasBlock({ ...inline, runs: [] })).toThrow();
    // A display formula has a source, not runs, and an inline paragraph the reverse.
    expect(() => decodeCanvasBlock({ ...display, runs: inline.runs })).toThrow();
    expect(() => decodeCanvasBlock({ ...inline, source: "x" })).toThrow();
  });

  it("refuses an empty or oversized formula, too many runs, an unknown layout, and markup fields", () => {
    expect(() => decodeCanvasBlock({ ...display, source: "" })).toThrow();
    expect(() =>
      decodeCanvasBlock({ ...display, source: "x".repeat(CANVAS_MAX_MATH_SOURCE_LENGTH + 1) }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...inline,
        runs: Array.from({ length: CANVAS_MAX_MATH_RUNS + 1 }, () => ({ math: "x" })),
      }),
    ).toThrow();
    expect(() => decodeCanvasBlock({ ...display, layout: "block" })).toThrow();
    expect(() => decodeCanvasBlock({ ...display, html: "<math></math>" })).toThrow();
    expect(() => decodeCanvasBlock({ ...display, macros: { "\\f": "x" } })).toThrow();
  });
});

describe("entity-relationship, swimlane, and mind map diagram kinds", () => {
  const er = {
    blockId: "order-schema",
    schemaVersion: CANVAS_SCHEMA_VERSION,
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
  };

  it("decodes an entity-relationship block with named attributes and cardinalities", () => {
    const block = decodeCanvasBlock(er);
    expect(block.kind).toBe("er");
    if (block.kind !== "er") throw new Error("expected an er block");
    expect(block.entities).toHaveLength(2);
    expect(block.entities[0]?.attributes[0]).toMatchObject({ name: "id", key: true });
    expect(block.relationships[0]).toMatchObject({
      sourceCardinality: "one",
      targetCardinality: "many",
    });
  });

  it("rejects an entity-relationship cardinality outside the four named values", () => {
    expect(() =>
      decodeCanvasBlock({
        ...er,
        relationships: [{ ...er.relationships[0], targetCardinality: "several" }],
      }),
    ).toThrow();
  });

  it("keeps the diagram-kinds floor ahead of bar-list and below the design block", () => {
    expect(CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION).toBeGreaterThan(CANVAS_BAR_LIST_SCHEMA_VERSION);
    expect(CANVAS_DESIGN_SCHEMA_VERSION).toBeGreaterThan(CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION);
    expect(CANVAS_DESIGN_SCHEMA_VERSION).toBeLessThan(CANVAS_SCHEMA_VERSION);
  });

  it("refuses a diagram kind inside a document declaring an earlier version", () => {
    const definition = {
      schemaVersion: CANVAS_SCHEMA_VERSION,
      title: "Schema",
      provenance,
      sourceManifest: [],
      blocks: [er],
    };
    for (const earlier of [
      CANVAS_BAR_LIST_SCHEMA_VERSION,
      CANVAS_HEATMAP_SCHEMA_VERSION,
      CANVAS_PRESENTATION_SCHEMA_VERSION,
    ]) {
      expect(() => decodeCanvasDefinition({ ...definition, schemaVersion: earlier })).toThrow();
    }
    expect(decodeCanvasDefinition(definition)).toMatchObject({ blocks: [er] });
  });

  it("decodes a swimlane block with ordered lanes, a decision step, and a connection", () => {
    const swimlane = {
      blockId: "support-flow",
      schemaVersion: CANVAS_SCHEMA_VERSION,
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
    };
    expect(decodeCanvasBlock(swimlane)).toMatchObject({
      kind: "swimlane",
      lanes: [
        { laneId: "customer", label: "Customer", kind: "actor" },
        { laneId: "support", label: "Support", kind: "team" },
      ],
    });
    const decoded = decodeCanvasBlock(swimlane);
    if (decoded.kind !== "swimlane") throw new Error("expected a swimlane block");
    expect(decoded.steps[1]).toMatchObject({ stepId: "triage", decision: true });
    expect(decoded.connections[0]).toMatchObject({ source: "report", target: "triage" });
  });

  it("refuses a swimlane without a lane", () => {
    expect(() =>
      decodeCanvasBlock({
        blockId: "empty-lanes",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "swimlane",
        lanes: [],
        steps: [],
        connections: [],
      }),
    ).toThrow();
  });

  it("decodes a mind map whose topics name a parent and a note", () => {
    const mindmap = {
      blockId: "release-mindmap",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "mindmap",
      nodes: [
        { nodeId: "release", label: "Release" },
        { nodeId: "tests", label: "Tests", parentId: "release", note: "green on head" },
      ],
    };
    const decoded = decodeCanvasBlock(mindmap);
    expect(decoded.kind).toBe("mindmap");
    if (decoded.kind !== "mindmap") throw new Error("expected a mindmap block");
    expect(decoded.nodes[1]).toMatchObject({
      nodeId: "tests",
      parentId: "release",
      note: "green on head",
    });
  });

  it("refuses a mind map note past its bound", () => {
    expect(() =>
      decodeCanvasBlock({
        blockId: "long-note",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "mindmap",
        nodes: [
          { nodeId: "root", label: "Root" },
          {
            nodeId: "leaf",
            label: "Leaf",
            parentId: "root",
            note: "x".repeat(CANVAS_MAX_MINDMAP_NOTE_LENGTH + 1),
          },
        ],
      }),
    ).toThrow();
  });
});

describe("metric additions", () => {
  const metric = {
    blockId: "repo-lines",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "metric",
    label: "Lines of code",
    value: 1_360_000,
    format: "compact",
    delta: 12_400,
    goodDirection: "up",
    sparkline: [1.2, 1.24, 1.27, 1.3],
    caption: "since last release",
  };

  it("decodes a metric with a direction, a sparkline, and a caption", () => {
    expect(decodeCanvasBlock(metric)).toMatchObject({
      kind: "metric",
      goodDirection: "up",
      sparkline: [1.2, 1.24, 1.27, 1.3],
      caption: "since last release",
    });
  });

  it("leaves the new metric fields absent when an author does not name them", () => {
    const block = decodeCanvasBlock({
      blockId: "metric-plain",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "metric",
      label: "Requests",
      value: 42,
    });
    expect(block).not.toHaveProperty("goodDirection");
    expect(block).not.toHaveProperty("sparkline");
    expect(block).not.toHaveProperty("caption");
  });

  it("admits the new metric fields only under the version that introduced them", () => {
    // A heatmap-era v6 document carrying a sparkline, a direction, or a caption
    // is a declared future version; a plain v6 metric still decodes.
    for (const field of ["sparkline", "goodDirection", "caption"] as const) {
      expect(() =>
        decodeCanvasDefinition({
          ...definition,
          schemaVersion: CANVAS_HEATMAP_SCHEMA_VERSION,
          blocks: [
            { ...metric, schemaVersion: CANVAS_HEATMAP_SCHEMA_VERSION, [field]: metric[field] },
          ],
        }),
      ).toThrow();
    }
    const {
      sparkline: _sparkline,
      goodDirection: _goodDirection,
      caption: _caption,
      ...plain
    } = metric;
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: CANVAS_HEATMAP_SCHEMA_VERSION,
        blocks: [{ ...plain, schemaVersion: CANVAS_HEATMAP_SCHEMA_VERSION }],
      }),
    ).not.toThrow();
    expect(decodeCanvasDefinition({ ...definition, blocks: [metric] })).toMatchObject({
      blocks: [metric],
    });
  });

  it("rejects a direction outside the closed set and a sparkline past the budget", () => {
    expect(() => decodeCanvasBlock({ ...metric, goodDirection: "sideways" })).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...metric,
        sparkline: Array.from(
          { length: CANVAS_MAX_METRIC_SPARKLINE_POINTS + 1 },
          (_value, index) => index,
        ),
      }),
    ).toThrow();
  });
});

describe("mockup catalog", () => {
  const screen = {
    blockId: "settings",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "mockup",
    device: "browser",
    fidelity: "styled",
    title: "Settings",
    variants: [
      { variantId: "filled", label: "Filled" },
      { variantId: "empty", label: "Empty" },
    ],
    nodes: [
      { nodeId: "page", component: "stack", label: "Settings", variantId: "filled" },
      { nodeId: "title", component: "heading", label: "Settings", parentId: "page" },
      { nodeId: "plan", component: "select", label: "Plan", value: "Team", parentId: "page" },
      { nodeId: "beta", component: "checkbox", label: "Beta features", on: true, parentId: "page" },
      { nodeId: "status", component: "badge", label: "Active", tone: "success", parentId: "page" },
      { nodeId: "find", component: "icon", label: "Search", icon: "search", parentId: "page" },
      {
        nodeId: "members",
        component: "table",
        label: "Members",
        columns: ["Name", "Role"],
        rows: [["Ada", "Owner"]],
        parentId: "page",
      },
      { nodeId: "cards", component: "grid", label: "Cards", gridColumns: 2, parentId: "page" },
      { nodeId: "saved", component: "toast", label: "Saved", tone: "success", parentId: "page" },
      { nodeId: "blank", component: "stack", label: "Nothing here", variantId: "empty" },
    ],
    annotations: [{ nodeId: "plan", note: "Plan changes bill at the next cycle." }],
  } as const;

  it("decodes a styled browser screen with variants, catalog components, and a callout", () => {
    expect(decodeCanvasBlock(screen)).toMatchObject(screen);
    expect(decodeCanvasDefinition({ ...definition, blocks: [screen] })).toMatchObject({
      blocks: [screen],
    });
    expect(CANVAS_MOCKUP_CATALOG_SCHEMA_VERSION).toBe(12);
    expect(CANVAS_MOCKUP_CATALOG_SCHEMA_VERSION).toBeLessThan(CANVAS_SCHEMA_VERSION);
  });

  it("admits the catalog only under the version that declared it, and keeps a version-3 screen readable", () => {
    const legacy = {
      blockId: "legacy",
      schemaVersion: 3,
      kind: "mockup",
      device: "phone",
      title: "Settings",
      nodes: [{ nodeId: "screen", component: "window", label: "Settings" }],
    } as const;
    expect(
      decodeCanvasDefinition({ ...definition, schemaVersion: 11, blocks: [legacy] }),
    ).toMatchObject({ blocks: [legacy] });
    const older = { ...screen, schemaVersion: 11 } as const;
    expect(() =>
      decodeCanvasDefinition({ ...definition, schemaVersion: 11, blocks: [older] }),
    ).toThrow();
    for (const gated of [
      { ...legacy, device: "dock-panel" },
      { ...legacy, fidelity: "wireframe" },
      { ...legacy, nodes: [{ nodeId: "a", component: "badge", label: "New" }] },
      { ...legacy, annotations: [{ nodeId: "screen", note: "Why" }] },
      {
        ...legacy,
        nodes: Array.from({ length: CANVAS_MOCKUP_LEGACY_MAX_NODES + 1 }, (_value, index) => ({
          nodeId: `n${String(index)}`,
          component: "text",
          label: "Row",
        })),
      },
    ]) {
      expect(() =>
        decodeCanvasDefinition({ ...definition, schemaVersion: 11, blocks: [gated] }),
      ).toThrow();
      expect(() =>
        decodeCanvasDefinition({
          ...definition,
          blocks: [{ ...gated, schemaVersion: CANVAS_SCHEMA_VERSION }],
        }),
      ).not.toThrow();
    }
  });

  it("refuses a component, icon, or tone outside the closed sets", () => {
    expect(() =>
      decodeCanvasBlock({
        ...screen,
        nodes: [{ nodeId: "x", component: "iframe", label: "Embed" }],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...screen,
        nodes: [{ nodeId: "x", component: "icon", label: "Logo", icon: "brand-logo" }],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...screen,
        nodes: [{ nodeId: "x", component: "button", label: "Go", tone: "#ff0000" }],
      }),
    ).toThrow();
    // No markup, style, or image source rides on a node.
    expect(() =>
      decodeCanvasBlock({
        ...screen,
        nodes: [
          {
            nodeId: "x",
            component: "image-placeholder",
            label: "Hero",
            src: "https://x.test/a.png",
          },
        ],
      }),
    ).toThrow();
  });

  it("bounds nodes, variants, callouts, table width, and a custom size", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_value, index) => ({
        nodeId: `n${String(index)}`,
        component: "text",
        label: "Row",
      }));
    expect(() =>
      decodeCanvasBlock({ ...screen, variants: undefined, nodes: many(CANVAS_MAX_MOCKUP_NODES) }),
    ).not.toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...screen,
        variants: undefined,
        nodes: many(CANVAS_MAX_MOCKUP_NODES + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...screen,
        variants: Array.from({ length: CANVAS_MAX_MOCKUP_VARIANTS + 1 }, (_value, index) => ({
          variantId: `v${String(index)}`,
          label: "State",
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...screen,
        annotations: Array.from({ length: CANVAS_MAX_MOCKUP_ANNOTATIONS + 1 }, () => ({
          nodeId: "plan",
          note: "Note",
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...screen,
        nodes: [
          {
            nodeId: "t",
            component: "table",
            label: "Wide",
            columns: Array.from({ length: CANVAS_MAX_MOCKUP_TABLE_COLUMNS + 1 }, () => "Col"),
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({ ...screen, device: "custom", size: { width: 600, height: 400 } }),
    ).not.toThrow();
    expect(() =>
      decodeCanvasBlock({ ...screen, device: "custom", size: { width: 100_000, height: 400 } }),
    ).toThrow();
  });
});

describe("table row ids", () => {
  const table = {
    blockId: "vendors",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "table",
    columns: [
      { id: "vendor", label: "Vendor", type: "text" },
      { id: "price", label: "Price", type: "number" },
    ],
    rows: [{ id: "acme", cells: ["Acme", 12] }, ["Globex", 9]],
  } as const;

  it("decodes a table that mixes rows with a stable id and rows of bare cells", () => {
    const decoded = decodeCanvasDefinition({ ...definition, blocks: [table] });
    const block = decoded.blocks[0];
    if (block?.kind !== "table") throw new Error("expected a table");
    expect(block.rows.map(canvasTableRowId)).toEqual(["acme", undefined]);
    expect(block.rows.map(canvasTableRowCells)).toEqual([
      ["Acme", 12],
      ["Globex", 9],
    ]);
    expect(CANVAS_TABLE_ROW_ID_SCHEMA_VERSION).toBe(13);
    expect(CANVAS_SCHEMA_VERSION).toBeGreaterThanOrEqual(13);
  });

  it("admits a row id only under the version that declared it, and keeps an older table readable", () => {
    const older = { ...table, schemaVersion: 12 } as const;
    expect(() =>
      decodeCanvasDefinition({ ...definition, schemaVersion: 12, blocks: [older] }),
    ).toThrow();
    const bare = { ...older, rows: [["Acme", 12]] } as const;
    expect(
      decodeCanvasDefinition({ ...definition, schemaVersion: 12, blocks: [bare] }),
    ).toMatchObject({ blocks: [bare] });
  });

  it("refuses a row id that is not a bounded token and a keyed row with extra fields", () => {
    for (const row of [
      { id: "has space", cells: ["Acme", 12] },
      { id: "", cells: ["Acme", 12] },
      { id: "acme", cells: ["Acme", 12], index: 0 },
      { id: "acme" },
    ]) {
      expect(() => decodeCanvasBlock({ ...table, rows: [row] })).toThrow();
    }
  });
});

describe("funnel, radar, and sankey charts", () => {
  const funnel = {
    blockId: "signup-funnel",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "chart",
    chartType: "funnel",
    series: [
      {
        seriesId: "visitors",
        label: "Visitors",
        points: [
          { x: "Visited", y: 1200 },
          { x: "Signed up", y: 480 },
          { x: "Paid", y: 96 },
        ],
      },
    ],
  } as const;
  const radar = {
    blockId: "service-profile",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "chart",
    chartType: "radar",
    series: ["api", "web"].map((seriesId, index) => ({
      seriesId,
      label: seriesId.toUpperCase(),
      points: ["Speed", "Cost", "Uptime"].map((x, axis) => ({ x, y: axis + index + 1 })),
    })),
  } as const;
  const sankey = {
    blockId: "traffic",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "chart",
    chartType: "sankey",
    series: [],
    links: [
      { source: "Search", target: "Landing", value: 60 },
      { source: "Landing", target: "Signup", value: 25 },
    ],
  } as const;

  it("decodes each flow chart at the version that introduced them", () => {
    expect(CANVAS_FLOW_CHARTS_SCHEMA_VERSION).toBe(14);
    expect(CANVAS_SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
    const decoded = decodeCanvasDefinition({ ...definition, blocks: [funnel, radar, sankey] });
    expect(decoded.blocks).toEqual([funnel, radar, sankey]);
  });

  it("refuses a flow chart in a document that declares an earlier version", () => {
    for (const block of [funnel, radar, sankey]) {
      const older = { ...block, schemaVersion: 13 };
      expect(() =>
        decodeCanvasDefinition({ ...definition, schemaVersion: 13, blocks: [older] }),
      ).toThrow();
    }
  });

  it("refuses links on any chart but a sankey, and a sankey that plots series", () => {
    expect(() => decodeCanvasBlock({ ...funnel, links: sankey.links })).toThrow();
    expect(() => decodeCanvasBlock({ ...sankey, series: funnel.series })).toThrow();
    expect(() => decodeCanvasBlock({ ...sankey, links: [] })).toThrow();
    expect(() => decodeCanvasBlock({ ...sankey, links: undefined })).toThrow();
  });

  it("bounds a sankey's links, nodes, and node labels", () => {
    const tooMany = Array.from({ length: CANVAS_MAX_SANKEY_LINKS + 1 }, (_value, index) => ({
      source: `s${String(index % 8)}`,
      target: `t${String(index)}`,
      value: 1,
    }));
    expect(() => decodeCanvasBlock({ ...sankey, links: tooMany })).toThrow();
    const wide = Array.from({ length: CANVAS_MAX_SANKEY_NODES }, (_value, index) => ({
      source: "Hub",
      target: `n${String(index)}`,
      value: 1,
    }));
    expect(() => decodeCanvasBlock({ ...sankey, links: wide })).toThrow();
    const longLabel = "x".repeat(CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH + 1);
    expect(() =>
      decodeCanvasBlock({
        ...sankey,
        links: [{ source: longLabel, target: "Landing", value: 1 }],
      }),
    ).toThrow();
  });

  it("asks a funnel for one series of labeled stages within the stage budget", () => {
    expect(() => decodeCanvasBlock({ ...funnel, series: radar.series })).toThrow();
    const unlabeled = [
      {
        ...funnel.series[0],
        points: [
          { x: 1, y: 5 },
          { x: 2, y: 3 },
        ],
      },
    ];
    expect(() => decodeCanvasBlock({ ...funnel, series: unlabeled })).toThrow();
    const repeated = [
      {
        ...funnel.series[0],
        points: [
          { x: "Visited", y: 5 },
          { x: "Visited", y: 3 },
        ],
      },
    ];
    expect(() => decodeCanvasBlock({ ...funnel, series: repeated })).toThrow();
    const long = [
      {
        ...funnel.series[0],
        points: Array.from({ length: CANVAS_MAX_FUNNEL_STAGES + 1 }, (_value, index) => ({
          x: `Stage ${String(index)}`,
          y: 100 - index,
        })),
      },
    ];
    expect(() => decodeCanvasBlock({ ...funnel, series: long })).toThrow();
  });

  it("asks a radar for shared labeled axes within the axis bounds", () => {
    const axes = (count: number) =>
      Array.from({ length: count }, (_value, index) => ({ x: `Axis ${String(index)}`, y: 1 }));
    const withAxes = (count: number) => ({
      ...radar,
      series: [{ seriesId: "only", label: "Only", points: axes(count) }],
    });
    expect(decodeCanvasBlock(withAxes(CANVAS_MIN_RADAR_AXES))).toBeDefined();
    expect(decodeCanvasBlock(withAxes(CANVAS_MAX_RADAR_AXES))).toBeDefined();
    expect(() => decodeCanvasBlock(withAxes(CANVAS_MIN_RADAR_AXES - 1))).toThrow();
    expect(() => decodeCanvasBlock(withAxes(CANVAS_MAX_RADAR_AXES + 1))).toThrow();
    const [first, second] = radar.series;
    if (first === undefined || second === undefined) throw new Error("expected two series");
    const misaligned = [first, { ...second, points: [...second.points].reverse() }];
    expect(() => decodeCanvasBlock({ ...radar, series: misaligned })).toThrow();
  });
});

describe("dashboard layout", () => {
  const metric = {
    blockId: "error-rate",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "metric",
    label: "Error rate",
    value: 0.004,
    format: "percent",
  } as const;
  const status = {
    blockId: "api-status",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "status",
    label: "API",
    value: "Healthy",
    tone: "success",
  } as const;
  const dashboard = {
    blockId: "ops",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "dashboard",
    title: "Service health",
    columns: 3,
    cells: [{ blockId: "error-rate" }, { blockId: "api-status", span: 2 }],
  } as const;

  it("decodes a titled grid that places other blocks by id at the version that introduced it", () => {
    expect(CANVAS_DASHBOARD_SCHEMA_VERSION).toBe(15);
    const decoded = decodeCanvasDefinition({ ...definition, blocks: [dashboard, metric, status] });
    expect(decoded.blocks).toEqual([dashboard, metric, status]);
  });

  it("refuses a dashboard in a document that declares an earlier version", () => {
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: 14,
        blocks: [{ ...dashboard, schemaVersion: 14 }, metric, status].map((block) => ({
          ...block,
          schemaVersion: 14,
        })),
      }),
    ).toThrow();
  });

  it("bounds the cell count, the column count, and each span", () => {
    const cells = Array.from({ length: CANVAS_MAX_DASHBOARD_CELLS + 1 }, (_value, index) => ({
      blockId: `cell-${String(index)}`,
    }));
    expect(() => decodeCanvasBlock({ ...dashboard, cells })).toThrow();
    expect(() => decodeCanvasBlock({ ...dashboard, cells: [] })).toThrow();
    expect(() =>
      decodeCanvasBlock({ ...dashboard, columns: CANVAS_MAX_DASHBOARD_COLUMNS + 1 }),
    ).toThrow();
    expect(() => decodeCanvasBlock({ ...dashboard, columns: 0 })).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...dashboard,
        cells: [{ blockId: "error-rate", span: CANVAS_MAX_DASHBOARD_COLUMNS + 1 }],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({ ...dashboard, cells: [{ blockId: "error-rate", span: 1.5 }] }),
    ).toThrow();
  });

  it("refuses a cell that carries a block inline instead of naming one", () => {
    expect(() =>
      decodeCanvasBlock({ ...dashboard, cells: [{ blockId: "error-rate", block: metric }] }),
    ).toThrow();
    expect(() => decodeCanvasBlock({ ...dashboard, title: "" })).toThrow();
  });
});

describe("tabs and columns layout groups", () => {
  const definition = {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    title: "Design brief",
    provenance,
    sourceManifest: [],
  } as const;
  const text = (blockId: string, schemaVersion: number = CANVAS_SCHEMA_VERSION) => ({
    blockId,
    schemaVersion,
    kind: "rich-text",
    text: blockId,
  });
  const tabs = {
    blockId: "brief",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "tabs",
    panes: [
      { label: "Metrics", blockIds: ["a"] },
      { label: "Loop", blockIds: ["b"] },
    ],
  } as const;

  it("decodes tabs and columns at the version that introduced them", () => {
    const columns = {
      blockId: "row",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "columns",
      tracks: [{ blockIds: ["c"] }, { blockIds: ["d"] }],
    };
    const decoded = decodeCanvasDefinition({
      ...definition,
      blocks: [tabs, columns, text("a"), text("b"), text("c"), text("d")],
    });
    expect(decoded.blocks[0]).toEqual(tabs);
    expect(decoded.blocks[1]).toEqual(columns);
    expect(CANVAS_LAYOUT_GROUPS_SCHEMA_VERSION).toBe(19);
    expect(CANVAS_THREAD_OWNED_SCHEMA_VERSION).toBe(20);
    expect(CANVAS_DESIGN_FIELDS_SCHEMA_VERSION).toBe(21);
    expect(CANVAS_SCHEMA_VERSION).toBe(CANVAS_MOCKUP_LIBRARY_SCHEMA_VERSION);
  });

  it("keeps every version through the current one decodable when it gates nothing new", () => {
    for (const schemaVersion of [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]) {
      const decoded = decodeCanvasDefinition({
        ...definition,
        schemaVersion,
        blocks: [text("a", schemaVersion)],
      });
      expect(decoded.schemaVersion).toBe(schemaVersion);
    }
  });

  it("decodes a tab that holds a dashboard, which places the tiles", () => {
    const board = {
      blockId: "board",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "dashboard",
      title: "Launch metrics",
      cells: [{ blockId: "dau" }],
    } as const;
    const dau = {
      blockId: "dau",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "metric",
      label: "Daily players",
      value: 48200,
    } as const;
    const withBoard = {
      ...tabs,
      panes: [
        { label: "Metrics", blockIds: ["board"] },
        { label: "Loop", blockIds: ["b"] },
      ],
    } as const;
    const decoded = decodeCanvasDefinition({
      ...definition,
      blocks: [withBoard, board, dau, text("b")],
    });
    expect(decoded.blocks.slice(0, 2)).toEqual([withBoard, board]);
  });

  it("refuses tabs in a document that declares the version before them", () => {
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: 18,
        blocks: [{ ...tabs, schemaVersion: 18 }, text("a", 18), text("b", 18)],
      }),
    ).toThrow();
  });

  it("refuses a tab strip of one pane, an unlabeled pane, and an empty pane", () => {
    const [first, second] = tabs.panes;
    expect(() => decodeCanvasBlock({ ...tabs, panes: [first] })).toThrow();
    expect(() =>
      decodeCanvasBlock({ ...tabs, panes: [{ ...first, label: "" }, second] }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({ ...tabs, panes: [{ ...first, blockIds: [] }, second] }),
    ).toThrow();
  });
});

describe("design fields and richer diagrams", () => {
  const document = {
    schemaVersion: CANVAS_DESIGN_FIELDS_SCHEMA_VERSION,
    title: "Launch deck",
    provenance,
    sourceManifest: [],
  } as const;
  const deck = {
    blockId: "deck",
    schemaVersion: CANVAS_DESIGN_FIELDS_SCHEMA_VERSION,
    kind: "design",
    title: "Launch deck",
    size: "slide",
    theme: "brand",
    brand: { "color-primary": "#1a73e8", "font-heading": "Georgia, serif", "radius-card": "8px" },
    frames: [
      { frameId: "intro", title: "Intro", html: "<h1>Hi</h1>", notes: "Open with the demo." },
      { frameId: "close", title: "Close", html: "<h1>Bye</h1>" },
    ],
    assets: [
      {
        assetId: "shot",
        source: { kind: "browser-capture", captureId: "99999999-9999-4999-8999-999999999999" },
      },
    ],
  } as const;
  const architecture = {
    blockId: "arch",
    schemaVersion: CANVAS_DESIGN_FIELDS_SCHEMA_VERSION,
    kind: "diagram",
    nodes: [
      { nodeId: "web", label: "Web app", icon: "browser", detail: "React" },
      { nodeId: "db", label: "Orders", icon: "database" },
    ],
    edges: [{ edgeId: "e1", source: "web", target: "db" }],
    groups: [
      { groupId: "region", label: "Region", nodeIds: [] },
      { groupId: "data", label: "Data", nodeIds: ["db"], parentGroupId: "region" },
    ],
  } as const;

  it("decodes frame notes, a brand, a captured-page asset, and diagram icons and nesting at version 21", () => {
    const decoded = decodeCanvasDefinition({ ...document, blocks: [deck, architecture] });
    expect(decoded.blocks).toEqual([deck, architecture]);
  });

  it("keeps a version 20 document without the new fields decodable", () => {
    const older = {
      ...document,
      schemaVersion: 20,
      blocks: [
        {
          ...architecture,
          schemaVersion: 20,
          nodes: [{ nodeId: "web", label: "Web app" }],
          edges: [],
          groups: [{ groupId: "region", label: "Region", nodeIds: ["web"] }],
        },
        {
          ...deck,
          schemaVersion: 20,
          theme: "workspace",
          brand: undefined,
          assets: undefined,
          frames: [{ frameId: "intro", title: "Intro", html: "<h1>Hi</h1>" }],
        },
      ],
    };
    expect(decodeCanvasDefinition(older).schemaVersion).toBe(20);
  });

  it("refuses each new field in a document that declares version 20", () => {
    const frameNotes = { ...deck, theme: undefined, brand: undefined, assets: undefined };
    const brandOnly = { ...deck, frames: [deck.frames[1]], assets: undefined };
    const captureOnly = { ...deck, theme: undefined, brand: undefined, frames: [deck.frames[1]] };
    for (const block of [frameNotes, brandOnly, captureOnly, architecture]) {
      expect(() =>
        decodeCanvasDefinition({
          ...document,
          schemaVersion: 20,
          blocks: [{ ...block, schemaVersion: 20 }],
        }),
      ).toThrow();
    }
  });

  it("bounds notes, the brand, the node detail, and the icon list", () => {
    const [intro] = deck.frames;
    const tooLong = "x".repeat(CANVAS_MAX_DESIGN_NOTES_LENGTH + 1);
    expect(() => decodeCanvasBlock({ ...deck, frames: [{ ...intro, notes: tooLong }] })).toThrow();
    expect(() => decodeCanvasBlock({ ...deck, frames: [{ ...intro, notes: "" }] })).toThrow();
    const crowded = Object.fromEntries(
      Array.from({ length: CANVAS_MAX_DESIGN_BRAND_TOKENS + 1 }, (_value, index) => [
        `color-c${String(index)}`,
        "#fff",
      ]),
    );
    expect(() => decodeCanvasBlock({ ...deck, brand: crowded })).toThrow();
    expect(() => decodeCanvasBlock({ ...deck, brand: { "margin-top": "4px" } })).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...architecture,
        nodes: [
          { nodeId: "web", label: "Web", detail: "d".repeat(CANVAS_MAX_DIAGRAM_DETAIL_LENGTH + 1) },
        ],
        groups: [],
      }),
    ).toThrow();
    expect(() =>
      decodeCanvasBlock({
        ...architecture,
        nodes: [{ nodeId: "web", label: "Web", icon: "vendor-logo" }],
        groups: [],
      }),
    ).toThrow();
  });
});

describe("chart titles and point callouts", () => {
  const trend = {
    blockId: "subscribers",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "chart",
    chartType: "line",
    title: "Up 2,304 subscribers this year",
    subtitle: "Email subscribers per month",
    series: [
      {
        seriesId: "subscribers",
        label: "Subscribers",
        points: [
          { x: "Jan", y: 7_808, note: "+344" },
          { x: "Feb", y: 8_320 },
          { x: "Sep", y: 9_400, emphasis: true },
        ],
      },
    ],
  } as const;

  it("decodes a chart that states its finding and calls out its readings", () => {
    expect(decodeCanvasBlock(trend)).toMatchObject({
      title: "Up 2,304 subscribers this year",
      subtitle: "Email subscribers per month",
      series: [{ points: [{ note: "+344" }, { x: "Feb" }, { emphasis: true }] }],
    });
  });

  it("refuses a title, subtitle, note, or emphasis in a document older than the version that introduced them", () => {
    const older = { ...trend, schemaVersion: CANVAS_DESIGN_FIELDS_SCHEMA_VERSION };
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: CANVAS_DESIGN_FIELDS_SCHEMA_VERSION,
        blocks: [older],
      }),
    ).toThrow(/schema version 22/);
    const { title: _title, subtitle: _subtitle, ...untitled } = older;
    expect(() =>
      decodeCanvasDefinition({
        ...definition,
        schemaVersion: CANVAS_DESIGN_FIELDS_SCHEMA_VERSION,
        blocks: [
          {
            ...untitled,
            series: [{ ...older.series[0], points: [{ x: "Jan", y: 1, emphasis: true }] }],
          },
        ],
      }),
    ).toThrow(/schema version 22/);
  });

  it("refuses a callout on a chart with no single point to label", () => {
    expect(() =>
      decodeCanvasBlock({
        ...trend,
        chartType: "pie",
        series: [{ seriesId: "s", label: "Share", points: [{ x: "A", y: 1, note: "most" }] }],
      }),
    ).toThrow();
  });

  it("refuses more than twelve notes on one chart", () => {
    const points = Array.from({ length: 13 }, (_, index) => ({
      x: String(index),
      y: index,
      note: `+${String(index)}`,
    }));
    expect(() =>
      decodeCanvasBlock({ ...trend, series: [{ seriesId: "s", label: "S", points }] }),
    ).toThrow();
  });
});

import { CANVAS_SCHEMA_VERSION, type CanvasDefinition } from "@octant/contracts/canvas";
import { decodeCanvasActionBlock, type CanvasActionBlock } from "@octant/contracts/canvas-actions";

const ids = {
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

const base = { schemaVersion: CANVAS_SCHEMA_VERSION } as const;

export const chatProvenance = provenance;
export const canvasSource = source;

/** A stable, valid Canvas definition covering every first-party block kind. */
export const canvasFixture = {
  schemaVersion: CANVAS_SCHEMA_VERSION,
  title: "Signed Q3 report",
  provenance: chatProvenance,
  sourceManifest: [source],
  blocks: [
    { ...base, blockId: "heading-1", kind: "heading", level: 1, text: "Q3 Overview" },
    {
      ...base,
      blockId: "rich-text-1",
      kind: "rich-text",
      text: "Shipment volumes grew this quarter.",
    },
    {
      ...base,
      blockId: "callout-1",
      kind: "callout",
      tone: "info",
      title: "Note",
      text: "Numbers are preliminary.",
    },
    {
      ...base,
      blockId: "link-1",
      kind: "link",
      label: "Sources",
      href: "https://reports.octant.example/q3",
    },
    { ...base, blockId: "divider-1", kind: "divider" },
    {
      ...base,
      blockId: "citation-1",
      kind: "citation",
      sourceId: ids.source,
      label: "Shipment log",
      quote: "Total volume was above target.",
    },
    { ...base, blockId: "metric-1", kind: "metric", label: "Volume", value: 421, unit: "units" },
    { ...base, blockId: "progress-1", kind: "progress", label: "Complete", value: 0.75 },
    {
      ...base,
      blockId: "status-1",
      kind: "status",
      label: "State",
      value: "Ready",
      tone: "success",
    },
    {
      ...base,
      blockId: "values-1",
      kind: "key-value",
      entries: [
        { key: "Mode", value: "Chat" },
        { key: "Reviewed", value: true },
      ],
    },
    {
      ...base,
      blockId: "table-1",
      kind: "table",
      columns: [
        { id: "name", label: "Name", type: "text" },
        { id: "count", label: "Count", type: "number" },
      ],
      rows: [
        ["Octant", 2],
        ["Canvas", 5],
      ],
    },
    {
      ...base,
      blockId: "chart-1",
      kind: "chart",
      chartType: "line",
      series: [
        {
          seriesId: "requests",
          label: "Requests",
          points: [
            { x: 1, y: 5 },
            { x: 2, y: 8 },
            { x: 3, y: 6 },
          ],
        },
      ],
    },
    {
      ...base,
      blockId: "timeline-1",
      kind: "timeline",
      items: [
        {
          itemId: "event-1",
          title: "Created",
          startAt: "2026-08-01T21:00:00.000Z",
          status: "success",
        },
      ],
    },
    {
      ...base,
      blockId: "diagram-1",
      kind: "diagram",
      nodes: [
        { nodeId: "a", label: "Ingest" },
        { nodeId: "b", label: "Report" },
      ],
      edges: [{ edgeId: "a-b", source: "a", target: "b" }],
    },
    {
      ...base,
      blockId: "code-1",
      kind: "code-excerpt",
      language: "typescript",
      code: "const safe = true;",
      sourceId: ids.source,
      startLine: 1,
      endLine: 3,
    },
    { ...base, blockId: "pseudo-1", kind: "pseudocode", code: "validate before render" },
    {
      ...base,
      blockId: "diff-1",
      kind: "diff",
      sourceId: ids.source,
      hunks: [
        {
          header: "@@ -1 +1 @@",
          lines: [
            { kind: "context", text: "context line" },
            { kind: "add", text: "added line" },
            { kind: "remove", text: "removed line" },
          ],
        },
      ],
    },
    {
      ...base,
      blockId: "source-1",
      kind: "source-reference",
      sourceId: ids.source,
      label: "Notes",
    },
    {
      ...base,
      blockId: "summary-1",
      kind: "summary",
      summaryKind: "test",
      title: "Checks",
      items: [
        { label: "Contracts", value: "pass", status: "success" },
        { label: "Renderer", value: "pending", status: "warning" },
      ],
    },
    {
      ...base,
      blockId: "artifact-1",
      kind: "artifact-reference",
      sourceId: ids.source,
      label: "Artifact",
    },
    { ...base, blockId: "file-1", kind: "file-reference", sourceId: ids.source, label: "File" },
    {
      ...base,
      blockId: "preview-1",
      kind: "preview-reference",
      sourceId: ids.source,
      label: "Preview",
    },
    {
      ...base,
      blockId: "browser-1",
      kind: "browser-reference",
      sourceId: ids.source,
      label: "Browser",
    },
    {
      ...base,
      blockId: "evidence-1",
      kind: "evidence-reference",
      sourceId: ids.source,
      label: "Evidence",
    },
    { ...base, blockId: "image-1", kind: "image", sourceId: ids.source, alt: "A bounded diagram" },
  ],
} as unknown as CanvasDefinition;

/** An unsafe payload (e.g. a javascript: link) that must fail closed at render. */
export const unsafeLinkFixture = {
  ...canvasFixture,
  blocks: [
    {
      ...base,
      blockId: "link-unsafe",
      kind: "link",
      label: "Click me",
      href: "javascript:alert(1)",
    },
  ],
} as unknown as CanvasDefinition;

/**
 * Declarative Canvas action blocks (D1) used to exercise the D3 renderer. Each
 * decodes through the versioned contract so tests never hand the renderer an
 * unvalidated shape.
 */
export const openSourceActionFixture: CanvasActionBlock = decodeCanvasActionBlock({
  ...base,
  blockId: "action-open-source",
  kind: "action",
  label: "Open notes source",
  description: "Reveal the attachment this canvas summarizes.",
  command: { command: "canvas.open-source", sourceId: ids.source },
});

export const openThreadActionFixture: CanvasActionBlock = decodeCanvasActionBlock({
  ...base,
  blockId: "action-open-thread",
  kind: "action",
  label: "Open related thread",
  command: { command: "canvas.open-thread", threadRef: "opaque:thread-1" },
});

export const requestRefreshActionFixture: CanvasActionBlock = decodeCanvasActionBlock({
  ...base,
  blockId: "action-refresh",
  kind: "action",
  label: "Request a refresh",
  description: "Ask the host to refresh this canvas from its sources.",
  command: { command: "canvas.request-refresh" },
});

export const proposeThreadActionFixture: CanvasActionBlock = decodeCanvasActionBlock({
  ...base,
  blockId: "action-propose-thread",
  kind: "action",
  label: "Propose a new thread",
  command: { command: "canvas.propose-thread", prompt: "Investigate the Q3 volume spike" },
});

/** A stable set covering read, read+navigation, mutate, and approval-gated. */
export const canvasActionFixtures: readonly CanvasActionBlock[] = [
  openSourceActionFixture,
  openThreadActionFixture,
  requestRefreshActionFixture,
  proposeThreadActionFixture,
];

/** Structurally valid but hostile rich text that must render as inert text. */
export const hostileTextFixture = {
  ...canvasFixture,
  blocks: [
    {
      ...base,
      blockId: "hostile-text",
      kind: "rich-text",
      text: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>',
    },
  ],
} as unknown as CanvasDefinition;

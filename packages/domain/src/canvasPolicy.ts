import {
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_BAR_LIST_ROWS,
  CANVAS_MAX_DIAGRAM_EDGES,
  CANVAS_MAX_DIAGRAM_NODES,
  CANVAS_MAX_DEPTH,
  CANVAS_MAX_ER_ATTRIBUTES_PER_ENTITY,
  CANVAS_MAX_HEATMAP_CELLS,
  CANVAS_MAX_HEATMAP_COLUMNS,
  CANVAS_MAX_HEATMAP_DAYS,
  CANVAS_MAX_HEATMAP_NOTE_LENGTH,
  CANVAS_MAX_HEATMAP_ROWS,
  CANVAS_MAX_DESIGN_FRAMES,
  CANVAS_MAX_DESIGN_MARKUP_LENGTH,
  CANVAS_MAX_IMAGES,
  CANVAS_MAX_METRIC_SPARKLINE_POINTS,
  CANVAS_MAX_MINDMAP_NOTE_LENGTH,
  CANVAS_MAX_MOCKUP_DEPTH,
  CANVAS_MAX_MOCKUP_NODES,
  CANVAS_MAX_MOCKUP_TEXT_LENGTH,
  CANVAS_MAX_PAYLOAD_BYTES,
  CANVAS_MAX_SERIES,
  CANVAS_MAX_SWIMLANE_LANES,
  CANVAS_MAX_TABLE_ROWS,
  CANVAS_MAX_TEXT_BYTES,
  CANVAS_MAX_TREEMAP_DEPTH,
  CANVAS_MAX_TREEMAP_LEAVES,
  CANVAS_BAR_LIST_SCHEMA_VERSION,
  CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION,
  CANVAS_METRIC_TREND_SCHEMA_VERSION,
  CANVAS_HEATMAP_SCHEMA_VERSION,
  CANVAS_MOCKUP_SCHEMA_VERSION,
  CANVAS_PRESENTATION_SCHEMA_VERSION,
  CANVAS_SCHEMA_VERSION,
  CANVAS_TREEMAP_SCHEMA_VERSION,
  CANVAS_DESIGN_SCHEMA_VERSION,
  CanvasBlock,
  CanvasDefinition,
  CanvasVersion,
  canvasMetricUsesTrendFields,
  decodeCanvasDefinition,
  decodeCanvasVersion,
  type CanvasSourceId,
} from "@octant/contracts/canvas";
import { canvasDesignMarkupRefusal, canvasDesignStylesheetRefusal } from "./canvasDesignPolicy";

const encoder = new TextEncoder();

// Versions this runtime decodes: every historical version plus the current
// one. A document declaring anything else is refused as a future version,
// before its blocks are read, so a newer contract never reaches a renderer.
const SUPPORTED_CANVAS_SCHEMA_VERSIONS: readonly number[] = [
  1,
  2,
  3,
  CANVAS_PRESENTATION_SCHEMA_VERSION,
  CANVAS_TREEMAP_SCHEMA_VERSION,
  CANVAS_HEATMAP_SCHEMA_VERSION,
  CANVAS_BAR_LIST_SCHEMA_VERSION,
  CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION,
  CANVAS_SCHEMA_VERSION,
];

// A block kind that a document may only carry from the version that
// introduced it. A document declaring an older version but carrying the kind
// fails closed as a declared future version rather than a corrupt document.
const VERSION_GATED_BLOCK_KINDS: ReadonlyArray<{ readonly kind: string; readonly since: number }> =
  [
    { kind: "mockup", since: CANVAS_MOCKUP_SCHEMA_VERSION },
    { kind: "treemap", since: CANVAS_TREEMAP_SCHEMA_VERSION },
    { kind: "heatmap", since: CANVAS_HEATMAP_SCHEMA_VERSION },
    { kind: "bar-list", since: CANVAS_BAR_LIST_SCHEMA_VERSION },
    { kind: "er", since: CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION },
    { kind: "swimlane", since: CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION },
    { kind: "mindmap", since: CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION },
    { kind: "design", since: CANVAS_DESIGN_SCHEMA_VERSION },
  ];

export type CanvasPolicyRejectionCode =
  | "invalid-schema"
  | "unsupported-schema-version"
  | "unsafe-payload"
  | "depth-budget-exceeded"
  | "block-budget-exceeded"
  | "text-budget-exceeded"
  | "rows-budget-exceeded"
  | "series-budget-exceeded"
  | "node-budget-exceeded"
  | "edge-budget-exceeded"
  | "image-budget-exceeded"
  | "payload-budget-exceeded"
  | "duplicate-block-id"
  | "duplicate-source-id"
  | "missing-source"
  | "table-row-shape"
  | "duplicate-series-id"
  | "duplicate-node-id"
  | "duplicate-edge-id"
  | "dangling-edge"
  | "duplicate-group-id"
  | "dangling-group-member"
  | "overlapping-groups"
  | "duplicate-plan-phase-id"
  | "duplicate-plan-task-id"
  | "unknown-plan-phase"
  | "dangling-plan-dependency"
  | "plan-dependency-cycle"
  | "dangling-diagram-ref"
  | "state-nesting-cycle"
  | "mockup-depth-exceeded"
  | "mockup-node-budget-exceeded"
  | "mockup-text-budget-exceeded"
  | "dangling-mockup-parent"
  | "mockup-nesting-cycle"
  | "duplicate-measure-id"
  | "unknown-treemap-measure"
  | "treemap-roots"
  | "treemap-nesting-cycle"
  | "dangling-treemap-parent"
  | "treemap-value-placement"
  | "treemap-negative-value"
  | "duplicate-heatmap-row-id"
  | "duplicate-heatmap-column-id"
  | "unknown-heatmap-row"
  | "unknown-heatmap-column"
  | "duplicate-heatmap-cell"
  | "duplicate-heatmap-date"
  | "heatmap-rows-budget-exceeded"
  | "heatmap-columns-budget-exceeded"
  | "heatmap-cells-budget-exceeded"
  | "heatmap-days-budget-exceeded"
  | "heatmap-note-budget-exceeded"
  | "design-frame-budget-exceeded"
  | "design-markup-budget-exceeded"
  | "duplicate-design-frame-id"
  | "design-markup-refused"
  | "bar-list-rows-budget-exceeded"
  | "duplicate-bar-list-label"
  | "bar-list-negative-value"
  | "metric-sparkline-budget-exceeded"
  | "duplicate-er-attribute-id"
  | "er-attribute-budget-exceeded"
  | "unknown-swimlane-lane"
  | "duplicate-swimlane-lane-id"
  | "swimlane-lanes-budget-exceeded"
  | "mindmap-roots"
  | "dangling-mindmap-parent"
  | "mindmap-nesting-cycle"
  | "mindmap-note-budget-exceeded";

export class CanvasPolicyRejected extends Error {
  override readonly name = "CanvasPolicyRejected";

  constructor(
    readonly code: CanvasPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: CanvasPolicyRejectionCode, message: string): never {
  throw new CanvasPolicyRejected(code, message);
}

interface CanvasBudgetInspection {
  readonly maxDepth: number;
  readonly textBytes: number;
  readonly payloadBytes: number;
}

function inspectSafeValue(
  value: unknown,
  depth = 0,
  active = new Set<object>(),
  result: { maxDepth: number; textBytes: number } = { maxDepth: 0, textBytes: 0 },
): CanvasBudgetInspection {
  try {
    if (value === null || typeof value === "boolean") {
      result.maxDepth = Math.max(result.maxDepth, depth);
      return { ...result, payloadBytes: 0 };
    }
    if (typeof value === "string") {
      result.textBytes += encoder.encode(value).byteLength;
      result.maxDepth = Math.max(result.maxDepth, depth);
      return { ...result, payloadBytes: 0 };
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) reject("unsafe-payload", "Canvas numbers must be finite.");
      result.maxDepth = Math.max(result.maxDepth, depth);
      return { ...result, payloadBytes: 0 };
    }
    if (
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint"
    ) {
      reject("unsafe-payload", "Canvas payload contains a non-JSON value.");
    }
    if (depth > CANVAS_MAX_DEPTH) {
      reject("depth-budget-exceeded", `Canvas payload exceeds depth ${CANVAS_MAX_DEPTH}.`);
    }
    if (active.has(value)) reject("unsafe-payload", "Canvas payload contains a cycle.");

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
      reject("unsafe-payload", "Canvas payload contains a non-plain object.");
    }
    active.add(value);
    result.maxDepth = Math.max(result.maxDepth, depth);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string")
        reject("unsafe-payload", "Canvas payload contains a symbol key.");
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        reject("unsafe-payload", "Canvas payload contains a prototype-pollution key.");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        reject("unsafe-payload", "Canvas payload contains an accessor property.");
      }
      inspectSafeValue(descriptor.value, depth + 1, active, result);
    }
    active.delete(value);
    return { ...result, payloadBytes: 0 };
  } catch (error) {
    if (error instanceof CanvasPolicyRejected) throw error;
    reject("unsafe-payload", "Canvas payload could not be inspected safely.");
  }
}

function payloadBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) reject("unsafe-payload", "Canvas payload is not JSON encodable.");
    return encoder.encode(encoded).byteLength;
  } catch (error) {
    if (error instanceof CanvasPolicyRejected) throw error;
    reject("unsafe-payload", "Canvas payload could not be encoded safely.");
  }
}

function inspectCanvasPayload(value: unknown): CanvasBudgetInspection {
  const inspection = inspectSafeValue(value);
  return { ...inspection, payloadBytes: payloadBytes(value) };
}

function sourceIdsForBlock(block: CanvasBlock): ReadonlyArray<CanvasSourceId> {
  switch (block.kind) {
    case "citation":
    case "code-excerpt":
    case "diff":
    case "source-reference":
    case "artifact-reference":
    case "file-reference":
    case "preview-reference":
    case "browser-reference":
    case "evidence-reference":
    case "image":
      return "sourceId" in block && block.sourceId !== undefined ? [block.sourceId] : [];
    case "plan":
      return block.tasks.flatMap((task) => task.sourceIds ?? []);
    case "treemap":
      return block.nodes.flatMap((node) => (node.sourceId === undefined ? [] : [node.sourceId]));
    case "bar-list":
      return block.rows.flatMap((row) => (row.sourceId === undefined ? [] : [row.sourceId]));
    default:
      return [];
  }
}

export interface CanvasBudgetUsage {
  readonly maxDepth: number;
  readonly blockCount: number;
  readonly textBytes: number;
  readonly tableRows: number;
  readonly chartSeries: number;
  readonly diagramNodes: number;
  readonly diagramEdges: number;
  readonly imageCount: number;
  readonly payloadBytes: number;
}

function calculateBudgetUsage(
  definition: CanvasDefinition,
  inspection: CanvasBudgetInspection,
): CanvasBudgetUsage {
  let tableRows = 0;
  let chartSeries = 0;
  let diagramNodes = 0;
  let diagramEdges = 0;
  let imageCount = 0;

  for (const block of definition.blocks) {
    switch (block.kind) {
      case "table":
        tableRows += block.rows.length;
        break;
      case "chart":
        chartSeries += block.series.length;
        break;
      case "diagram":
        diagramNodes += block.nodes.length;
        diagramEdges += block.edges.length;
        break;
      case "sequence":
        diagramNodes += block.participants.length;
        diagramEdges += block.messages.length;
        break;
      case "state":
        diagramNodes += block.states.length;
        diagramEdges += block.transitions.length;
        break;
      case "er":
        diagramNodes += block.entities.length;
        diagramEdges += block.relationships.length;
        break;
      case "swimlane":
        diagramNodes += block.steps.length;
        diagramEdges += block.connections.length;
        break;
      case "mindmap":
        diagramNodes += block.nodes.length;
        break;
      case "image":
        imageCount += 1;
        break;
      default:
        break;
    }
  }

  return {
    maxDepth: inspection.maxDepth,
    blockCount: definition.blocks.length,
    textBytes: inspection.textBytes,
    tableRows,
    chartSeries,
    diagramNodes,
    diagramEdges,
    imageCount,
    payloadBytes: inspection.payloadBytes,
  };
}

/**
 * A document a newer runtime declared with a version this runtime has never
 * seen — either a future schema version or a version-gated field (a mockup
 * block from version 3, a thread presentation from version 4, a treemap from
 * version 5, a heatmap from version 6, a design block from version 7) inside a
 * document that declares an older version — must fail closed as an
 * unsupported schema version, before any content is read, rather than
 * collapsing into a generic "corrupt" decode failure. Works on both a
 * definition (`blocks` at the top level) and a version envelope (blocks under
 * `definition`).
 */
function declaredSchemaRejection(input: unknown): CanvasPolicyRejectionCode | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const envelope = input as {
    schemaVersion?: unknown;
    blocks?: unknown;
    presentation?: unknown;
    definition?: { blocks?: unknown; presentation?: unknown };
  };
  const declared = envelope.schemaVersion;
  if (typeof declared !== "number") return undefined;
  if (!SUPPORTED_CANVAS_SCHEMA_VERSIONS.includes(declared)) return "unsupported-schema-version";
  const presentation = envelope.presentation ?? envelope.definition?.presentation;
  if (declared < CANVAS_PRESENTATION_SCHEMA_VERSION && presentation !== undefined) {
    return "unsupported-schema-version";
  }
  const blocks = Array.isArray(envelope.blocks)
    ? envelope.blocks
    : Array.isArray(envelope.definition?.blocks)
      ? envelope.definition?.blocks
      : undefined;
  if (
    blocks?.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (VERSION_GATED_BLOCK_KINDS.some(
          (gated) => gated.kind === (block as { kind?: unknown }).kind && declared < gated.since,
        ) ||
          (declared < CANVAS_METRIC_TREND_SCHEMA_VERSION &&
            canvasMetricUsesTrendFields(block as Record<string, unknown>))),
    )
  ) {
    return "unsupported-schema-version";
  }
  return undefined;
}

function decodeDefinitionOrReject(input: unknown): CanvasDefinition {
  try {
    const definition = decodeCanvasDefinition(input);
    if (!SUPPORTED_CANVAS_SCHEMA_VERSIONS.includes(definition.schemaVersion)) {
      return reject(
        "unsupported-schema-version",
        `Canvas schema version ${String(definition.schemaVersion)} is unsupported.`,
      );
    }
    return definition;
  } catch (error) {
    if (error instanceof CanvasPolicyRejected) throw error;
    const schemaRejection = declaredSchemaRejection(input);
    if (schemaRejection !== undefined) {
      return reject(schemaRejection, "Canvas schema version is unsupported.");
    }
    const structuralBudget = inferStructuralBudgetCode(input);
    if (structuralBudget !== undefined) {
      return reject(structuralBudget, "Canvas structural budget is exceeded.");
    }
    return reject("invalid-schema", "Canvas definition failed strict schema validation.");
  }
}

function inferStructuralBudgetCode(input: unknown): CanvasPolicyRejectionCode | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    !Array.isArray((input as { blocks?: unknown }).blocks)
  ) {
    return undefined;
  }
  const blocks = (input as { blocks: ReadonlyArray<unknown> }).blocks;
  if (blocks.length > CANVAS_MAX_BLOCKS) return "block-budget-exceeded";
  let imageCount = 0;
  for (const candidate of blocks) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const block = candidate as {
      kind?: unknown;
      rows?: unknown;
      series?: unknown;
      nodes?: unknown;
      edges?: unknown;
      participants?: unknown;
      messages?: unknown;
      states?: unknown;
      transitions?: unknown;
      entities?: unknown;
      relationships?: unknown;
      lanes?: unknown;
      steps?: unknown;
      connections?: unknown;
      title?: unknown;
      columns?: unknown;
      cells?: unknown;
      days?: unknown;
      frames?: unknown;
      styles?: unknown;
      sparkline?: unknown;
    };
    if (block.kind === "image") imageCount += 1;
    if (
      block.kind === "table" &&
      Array.isArray(block.rows) &&
      block.rows.length > CANVAS_MAX_TABLE_ROWS
    ) {
      return "rows-budget-exceeded";
    }
    if (
      block.kind === "chart" &&
      Array.isArray(block.series) &&
      block.series.length > CANVAS_MAX_SERIES
    ) {
      return "series-budget-exceeded";
    }
    if (block.kind === "diagram") {
      if (Array.isArray(block.nodes) && block.nodes.length > CANVAS_MAX_DIAGRAM_NODES) {
        return "node-budget-exceeded";
      }
      if (Array.isArray(block.edges) && block.edges.length > CANVAS_MAX_DIAGRAM_EDGES) {
        return "edge-budget-exceeded";
      }
    }
    if (block.kind === "sequence" || block.kind === "state") {
      const nodes = block.kind === "sequence" ? block.participants : block.states;
      const edges = block.kind === "sequence" ? block.messages : block.transitions;
      if (Array.isArray(nodes) && nodes.length > CANVAS_MAX_DIAGRAM_NODES) {
        return "node-budget-exceeded";
      }
      if (Array.isArray(edges) && edges.length > CANVAS_MAX_DIAGRAM_EDGES) {
        return "edge-budget-exceeded";
      }
    }
    if (block.kind === "design") {
      if (Array.isArray(block.frames) && block.frames.length > CANVAS_MAX_DESIGN_FRAMES) {
        return "design-frame-budget-exceeded";
      }
      if (
        typeof block.styles === "string" &&
        block.styles.length > CANVAS_MAX_DESIGN_MARKUP_LENGTH
      ) {
        return "design-markup-budget-exceeded";
      }
      if (Array.isArray(block.frames)) {
        for (const frame of block.frames) {
          if (typeof frame !== "object" || frame === null) continue;
          const html = (frame as { html?: unknown }).html;
          if (typeof html === "string" && html.length > CANVAS_MAX_DESIGN_MARKUP_LENGTH) {
            return "design-markup-budget-exceeded";
          }
        }
      }
    }
    if (block.kind === "er") {
      if (Array.isArray(block.entities) && block.entities.length > CANVAS_MAX_DIAGRAM_NODES) {
        return "node-budget-exceeded";
      }
      if (
        Array.isArray(block.relationships) &&
        block.relationships.length > CANVAS_MAX_DIAGRAM_EDGES
      ) {
        return "edge-budget-exceeded";
      }
      if (Array.isArray(block.entities)) {
        for (const entity of block.entities) {
          if (typeof entity !== "object" || entity === null) continue;
          const attributes = (entity as { attributes?: unknown }).attributes;
          if (
            Array.isArray(attributes) &&
            attributes.length > CANVAS_MAX_ER_ATTRIBUTES_PER_ENTITY
          ) {
            return "er-attribute-budget-exceeded";
          }
        }
      }
    }
    if (block.kind === "swimlane") {
      if (Array.isArray(block.steps) && block.steps.length > CANVAS_MAX_DIAGRAM_NODES) {
        return "node-budget-exceeded";
      }
      if (Array.isArray(block.connections) && block.connections.length > CANVAS_MAX_DIAGRAM_EDGES) {
        return "edge-budget-exceeded";
      }
      if (Array.isArray(block.lanes) && block.lanes.length > CANVAS_MAX_SWIMLANE_LANES) {
        return "swimlane-lanes-budget-exceeded";
      }
    }
    if (block.kind === "mindmap") {
      if (Array.isArray(block.nodes) && block.nodes.length > CANVAS_MAX_DIAGRAM_NODES) {
        return "node-budget-exceeded";
      }
      if (Array.isArray(block.nodes)) {
        for (const node of block.nodes) {
          if (typeof node !== "object" || node === null) continue;
          const note = (node as { note?: unknown }).note;
          if (typeof note === "string" && note.length > CANVAS_MAX_MINDMAP_NOTE_LENGTH) {
            return "mindmap-note-budget-exceeded";
          }
        }
      }
    }
    if (block.kind === "mockup") {
      if (typeof block.title === "string" && block.title.length > CANVAS_MAX_MOCKUP_TEXT_LENGTH) {
        return "mockup-text-budget-exceeded";
      }
      if (Array.isArray(block.nodes) && block.nodes.length > CANVAS_MAX_MOCKUP_NODES) {
        return "mockup-node-budget-exceeded";
      }
      if (Array.isArray(block.nodes)) {
        for (const node of block.nodes) {
          if (typeof node !== "object" || node === null) continue;
          const label = (node as { label?: unknown }).label;
          if (typeof label === "string" && label.length > CANVAS_MAX_MOCKUP_TEXT_LENGTH) {
            return "mockup-text-budget-exceeded";
          }
        }
      }
    }
    if (
      block.kind === "treemap" &&
      Array.isArray(block.nodes) &&
      block.nodes.length > CANVAS_MAX_TREEMAP_LEAVES
    ) {
      return "node-budget-exceeded";
    }
    if (block.kind === "heatmap") {
      if (Array.isArray(block.rows) && block.rows.length > CANVAS_MAX_HEATMAP_ROWS) {
        return "heatmap-rows-budget-exceeded";
      }
      if (Array.isArray(block.columns) && block.columns.length > CANVAS_MAX_HEATMAP_COLUMNS) {
        return "heatmap-columns-budget-exceeded";
      }
      if (Array.isArray(block.cells) && block.cells.length > CANVAS_MAX_HEATMAP_CELLS) {
        return "heatmap-cells-budget-exceeded";
      }
      if (Array.isArray(block.days) && block.days.length > CANVAS_MAX_HEATMAP_DAYS) {
        return "heatmap-days-budget-exceeded";
      }
      const noted = [
        ...(Array.isArray(block.cells) ? block.cells : []),
        ...(Array.isArray(block.days) ? block.days : []),
      ];
      for (const entry of noted) {
        if (typeof entry !== "object" || entry === null) continue;
        const note = (entry as { note?: unknown }).note;
        if (typeof note === "string" && note.length > CANVAS_MAX_HEATMAP_NOTE_LENGTH) {
          return "heatmap-note-budget-exceeded";
        }
      }
    }
    if (
      block.kind === "bar-list" &&
      Array.isArray(block.rows) &&
      block.rows.length > CANVAS_MAX_BAR_LIST_ROWS
    ) {
      return "bar-list-rows-budget-exceeded";
    }
    if (
      block.kind === "metric" &&
      Array.isArray(block.sparkline) &&
      block.sparkline.length > CANVAS_MAX_METRIC_SPARKLINE_POINTS
    ) {
      return "metric-sparkline-budget-exceeded";
    }
  }
  if (imageCount > CANVAS_MAX_IMAGES) return "image-budget-exceeded";
  return undefined;
}

function validateCrossReferences(definition: CanvasDefinition): void {
  const sources = new Set<string>();
  for (const entry of definition.sourceManifest) {
    if (sources.has(entry.sourceId)) {
      reject("duplicate-source-id", `Canvas source ${entry.sourceId} is duplicated.`);
    }
    sources.add(entry.sourceId);
  }

  const blocks = new Set<string>();
  for (const block of definition.blocks) {
    if (blocks.has(block.blockId)) {
      reject("duplicate-block-id", `Canvas block ${block.blockId} is duplicated.`);
    }
    blocks.add(block.blockId);

    for (const sourceId of sourceIdsForBlock(block)) {
      if (!sources.has(sourceId)) {
        reject("missing-source", `Canvas block ${block.blockId} references a missing source.`);
      }
    }

    if (block.kind === "table") {
      for (const row of block.rows) {
        if (row.length !== block.columns.length) {
          reject(
            "table-row-shape",
            `Canvas table ${block.blockId} has a row with the wrong width.`,
          );
        }
      }
    }

    if (block.kind === "chart") {
      const series = new Set<string>();
      for (const item of block.series) {
        if (series.has(item.seriesId)) {
          reject("duplicate-series-id", `Canvas chart ${block.blockId} has duplicate series.`);
        }
        series.add(item.seriesId);
      }
    }

    if (block.kind === "plan") validatePlan(block);

    if (block.kind === "diagram") {
      const nodes = new Set<string>();
      for (const node of block.nodes) {
        if (nodes.has(node.nodeId)) {
          reject("duplicate-node-id", `Canvas diagram ${block.blockId} has duplicate nodes.`);
        }
        nodes.add(node.nodeId);
      }
      const edges = new Set<string>();
      for (const edge of block.edges) {
        if (edges.has(edge.edgeId)) {
          reject("duplicate-edge-id", `Canvas diagram ${block.blockId} has duplicate edges.`);
        }
        if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
          reject("dangling-edge", `Canvas diagram ${block.blockId} has an edge to a missing node.`);
        }
        edges.add(edge.edgeId);
      }
      const groups = new Set<string>();
      const grouped = new Set<string>();
      for (const group of block.groups ?? []) {
        if (groups.has(group.groupId)) {
          reject("duplicate-group-id", `Canvas diagram ${block.blockId} has duplicate groups.`);
        }
        groups.add(group.groupId);
        for (const nodeId of group.nodeIds) {
          if (!nodes.has(nodeId)) {
            reject(
              "dangling-group-member",
              `Canvas diagram ${block.blockId} groups a node it does not hold.`,
            );
          }
          // One boundary per node, so the grouping a reader sees is the one the
          // author meant rather than whichever frame happened to be drawn last.
          if (grouped.has(nodeId)) {
            reject(
              "overlapping-groups",
              `Canvas diagram ${block.blockId} puts one node in more than one group.`,
            );
          }
          grouped.add(nodeId);
        }
      }
    }

    if (block.kind === "sequence") validateSequence(block);
    if (block.kind === "state") validateState(block);
    if (block.kind === "er") validateEr(block);
    if (block.kind === "swimlane") validateSwimlane(block);
    if (block.kind === "mindmap") validateMindmap(block);
    if (block.kind === "mockup") validateMockup(block);
    if (block.kind === "design") validateDesign(block);
    if (block.kind === "treemap") validateTreemap(block);
    if (block.kind === "heatmap") validateHeatmap(block);
    if (block.kind === "bar-list") validateBarList(block);
    if (block.kind === "metric") validateMetric(block);
  }
}

/**
 * Frames are linked by id, so two frames sharing one would make a link land
 * on whichever came first. Markup a sandboxed frame could not draw as written
 * is refused with the reason, so the author can fix it rather than ship a
 * broken screen.
 */
function validateDesign(block: Extract<CanvasBlock, { readonly kind: "design" }>): void {
  if (block.styles !== undefined) {
    const refusal = canvasDesignStylesheetRefusal(block.styles);
    if (refusal !== undefined) {
      reject("design-markup-refused", `Canvas design ${block.blockId} stylesheet ${refusal}`);
    }
  }
  const frameIds = new Set<string>();
  for (const frame of block.frames) {
    const id = String(frame.frameId);
    if (frameIds.has(id)) {
      reject(
        "duplicate-design-frame-id",
        `Canvas design ${block.blockId} has two frames with the id ${id}.`,
      );
    }
    frameIds.add(id);
    const refusal = canvasDesignMarkupRefusal(frame.html);
    if (refusal !== undefined) {
      reject("design-markup-refused", `Canvas design ${block.blockId} frame ${id} ${refusal}`);
    }
  }
}

/**
 * A sequence's messages, activations, and notes name participants and messages
 * by id. A reference that does not resolve, or an activation that runs backward
 * through the message order, would draw a lifeline the author did not write.
 */
function validateSequence(block: Extract<CanvasBlock, { readonly kind: "sequence" }>): void {
  const participants = new Set<string>();
  for (const participant of block.participants) {
    const id = String(participant.participantId);
    if (participants.has(id)) {
      reject("duplicate-node-id", `Canvas sequence ${block.blockId} has duplicate participants.`);
    }
    participants.add(id);
  }
  const messages = new Map<string, number>();
  for (const [index, message] of block.messages.entries()) {
    const id = String(message.messageId);
    if (messages.has(id)) {
      reject("duplicate-edge-id", `Canvas sequence ${block.blockId} has duplicate messages.`);
    }
    if (!participants.has(String(message.from)) || !participants.has(String(message.to))) {
      reject(
        "dangling-edge",
        `Canvas sequence ${block.blockId} has a message to a missing participant.`,
      );
    }
    messages.set(id, index);
  }
  const activations = new Set<string>();
  for (const activation of block.activations ?? []) {
    const id = String(activation.activationId);
    if (activations.has(id)) {
      reject("duplicate-group-id", `Canvas sequence ${block.blockId} has duplicate activations.`);
    }
    activations.add(id);
    if (!participants.has(String(activation.participantId))) {
      reject(
        "dangling-diagram-ref",
        `Canvas sequence ${block.blockId} activates a missing participant.`,
      );
    }
    const start = messages.get(String(activation.startMessageId));
    const end = messages.get(String(activation.endMessageId));
    if (start === undefined || end === undefined || start > end) {
      reject(
        "dangling-diagram-ref",
        `Canvas sequence ${block.blockId} has an activation that does not span its messages in order.`,
      );
    }
  }
  const notes = new Set<string>();
  for (const note of block.notes ?? []) {
    const id = String(note.noteId);
    if (notes.has(id)) {
      reject("duplicate-group-id", `Canvas sequence ${block.blockId} has duplicate notes.`);
    }
    notes.add(id);
    if (note.participantId !== undefined && !participants.has(String(note.participantId))) {
      reject(
        "dangling-diagram-ref",
        `Canvas sequence ${block.blockId} notes a missing participant.`,
      );
    }
    if (note.afterMessageId !== undefined && !messages.has(String(note.afterMessageId))) {
      reject("dangling-diagram-ref", `Canvas sequence ${block.blockId} notes a missing message.`);
    }
  }
}

/**
 * A state's parent and a transition's ends must be states in the same block.
 * Nesting is a parent chain, so a cycle or a chain past the depth budget would
 * draw a box inside itself.
 */
function validateState(block: Extract<CanvasBlock, { readonly kind: "state" }>): void {
  const states = new Map<
    string,
    { readonly role?: "initial" | "final"; readonly parentId?: string }
  >();
  for (const state of block.states) {
    const id = String(state.stateId);
    if (states.has(id)) {
      reject("duplicate-node-id", `Canvas state diagram ${block.blockId} has duplicate states.`);
    }
    states.set(id, {
      ...(state.role === undefined ? {} : { role: state.role }),
      ...(state.parentId === undefined ? {} : { parentId: String(state.parentId) }),
    });
  }
  for (const [id, state] of states) {
    if (state.parentId === undefined) continue;
    const parent = states.get(state.parentId);
    if (parent === undefined) {
      reject(
        "dangling-diagram-ref",
        `Canvas state diagram ${block.blockId} nests a state it does not hold.`,
      );
    }
    if (parent.role === "initial" || parent.role === "final") {
      reject(
        "dangling-diagram-ref",
        `Canvas state diagram ${block.blockId} nests a state inside an initial or final state.`,
      );
    }
    const seen = new Set<string>([id]);
    let current: string | undefined = state.parentId;
    let depth = 1;
    while (current !== undefined) {
      if (seen.has(current)) {
        reject(
          "state-nesting-cycle",
          `Canvas state diagram ${block.blockId} nests a state inside itself.`,
        );
      }
      seen.add(current);
      depth += 1;
      if (depth > CANVAS_MAX_DEPTH) {
        reject(
          "depth-budget-exceeded",
          `Canvas state diagram ${block.blockId} nests states deeper than ${CANVAS_MAX_DEPTH}.`,
        );
      }
      current = states.get(current)?.parentId;
    }
  }
  const transitions = new Set<string>();
  for (const transition of block.transitions) {
    const id = String(transition.transitionId);
    if (transitions.has(id)) {
      reject(
        "duplicate-edge-id",
        `Canvas state diagram ${block.blockId} has duplicate transitions.`,
      );
    }
    transitions.add(id);
    if (!states.has(String(transition.source)) || !states.has(String(transition.target))) {
      reject(
        "dangling-edge",
        `Canvas state diagram ${block.blockId} has a transition to a missing state.`,
      );
    }
  }
}

/**
 * An entity-relationship block names each entity by id, and every relationship
 * must land on two entities the block holds. An attribute id repeats only
 * within its own entity, and the per-entity attribute list is bounded, so a
 * schema that exceeds either would draw a table the picture cannot carry.
 */
function validateEr(block: Extract<CanvasBlock, { readonly kind: "er" }>): void {
  const entities = new Set<string>();
  for (const entity of block.entities) {
    const id = String(entity.entityId);
    if (entities.has(id)) {
      reject(
        "duplicate-node-id",
        `Canvas entity relationship ${block.blockId} has duplicate entities.`,
      );
    }
    entities.add(id);
    if (entity.attributes.length > CANVAS_MAX_ER_ATTRIBUTES_PER_ENTITY) {
      reject(
        "er-attribute-budget-exceeded",
        `Canvas entity relationship ${block.blockId} has an entity with more than ${String(CANVAS_MAX_ER_ATTRIBUTES_PER_ENTITY)} attributes.`,
      );
    }
    const attributes = new Set<string>();
    for (const attribute of entity.attributes) {
      const attributeId = String(attribute.attributeId);
      if (attributes.has(attributeId)) {
        reject(
          "duplicate-er-attribute-id",
          `Canvas entity relationship ${block.blockId} repeats an attribute.`,
        );
      }
      attributes.add(attributeId);
    }
  }
  const relationships = new Set<string>();
  for (const relationship of block.relationships) {
    const id = String(relationship.relationshipId);
    if (relationships.has(id)) {
      reject(
        "duplicate-edge-id",
        `Canvas entity relationship ${block.blockId} has duplicate relationships.`,
      );
    }
    relationships.add(id);
    if (!entities.has(String(relationship.source)) || !entities.has(String(relationship.target))) {
      reject(
        "dangling-edge",
        `Canvas entity relationship ${block.blockId} has a relationship to a missing entity.`,
      );
    }
  }
}

/**
 * A swimlane's steps name the lane they sit in, and every connection must land
 * on two steps the block holds. A lane order past the lane budget or a step on
 * a lane the block does not declare would draw a band nobody ordered.
 */
function validateSwimlane(block: Extract<CanvasBlock, { readonly kind: "swimlane" }>): void {
  if (block.lanes.length > CANVAS_MAX_SWIMLANE_LANES) {
    reject(
      "swimlane-lanes-budget-exceeded",
      `Canvas swimlane ${block.blockId} has more than ${String(CANVAS_MAX_SWIMLANE_LANES)} lanes.`,
    );
  }
  const lanes = new Set<string>();
  for (const lane of block.lanes) {
    const id = String(lane.laneId);
    if (lanes.has(id)) {
      reject("duplicate-swimlane-lane-id", `Canvas swimlane ${block.blockId} repeats a lane.`);
    }
    lanes.add(id);
  }
  const steps = new Set<string>();
  for (const step of block.steps) {
    const id = String(step.stepId);
    if (steps.has(id)) {
      reject("duplicate-node-id", `Canvas swimlane ${block.blockId} has duplicate steps.`);
    }
    if (!lanes.has(String(step.laneId))) {
      reject(
        "unknown-swimlane-lane",
        `Canvas swimlane ${block.blockId} places a step in a lane it does not hold.`,
      );
    }
    steps.add(id);
  }
  const connections = new Set<string>();
  for (const connection of block.connections) {
    const id = String(connection.connectionId);
    if (connections.has(id)) {
      reject("duplicate-edge-id", `Canvas swimlane ${block.blockId} has duplicate connections.`);
    }
    connections.add(id);
    if (!steps.has(String(connection.source)) || !steps.has(String(connection.target))) {
      reject(
        "dangling-edge",
        `Canvas swimlane ${block.blockId} has a connection to a missing step.`,
      );
    }
  }
}

/**
 * A mind map is one root over topics that name their parent. A second root, a
 * parent the block does not hold, a cycle, a chain past the depth budget, or a
 * note past its length would each draw a map the data does not support.
 */
function validateMindmap(block: Extract<CanvasBlock, { readonly kind: "mindmap" }>): void {
  const parents = new Map<string, string | undefined>();
  for (const node of block.nodes) {
    const id = String(node.nodeId);
    if (parents.has(id)) {
      reject("duplicate-node-id", `Canvas mind map ${block.blockId} has duplicate topics.`);
    }
    if (node.note !== undefined && node.note.length > CANVAS_MAX_MINDMAP_NOTE_LENGTH) {
      reject(
        "mindmap-note-budget-exceeded",
        `Canvas mind map ${block.blockId} has a note longer than ${String(CANVAS_MAX_MINDMAP_NOTE_LENGTH)} characters.`,
      );
    }
    parents.set(id, node.parentId === undefined ? undefined : String(node.parentId));
  }
  let roots = 0;
  for (const [_id, parentId] of parents) {
    if (parentId === undefined) {
      roots += 1;
      continue;
    }
    if (!parents.has(parentId)) {
      reject(
        "dangling-mindmap-parent",
        `Canvas mind map ${block.blockId} nests a topic it does not hold.`,
      );
    }
  }
  // One root: a forest is not a map a reader can follow from a single topic.
  if (parents.size > 0 && roots !== 1) {
    reject("mindmap-roots", `Canvas mind map ${block.blockId} does not have exactly one root.`);
  }
  for (const [id, parentId] of parents) {
    const seen = new Set<string>([id]);
    let current = parentId;
    let depth = 1;
    while (current !== undefined) {
      if (seen.has(current)) {
        reject(
          "mindmap-nesting-cycle",
          `Canvas mind map ${block.blockId} nests a topic inside itself.`,
        );
      }
      seen.add(current);
      depth += 1;
      if (depth > CANVAS_MAX_DEPTH) {
        reject(
          "depth-budget-exceeded",
          `Canvas mind map ${block.blockId} nests topics deeper than ${CANVAS_MAX_DEPTH}.`,
        );
      }
      current = parents.get(current);
    }
  }
}

/**
 * A mockup's nodes name their parent. A chain longer than the depth limit, a
 * parent the block does not hold, or a cycle would draw a screen inside itself.
 */
function validateMockup(block: Extract<CanvasBlock, { readonly kind: "mockup" }>): void {
  if (block.title.length > CANVAS_MAX_MOCKUP_TEXT_LENGTH) {
    reject(
      "mockup-text-budget-exceeded",
      `Canvas mockup ${block.blockId} has a title longer than ${CANVAS_MAX_MOCKUP_TEXT_LENGTH} characters.`,
    );
  }
  if (block.nodes.length > CANVAS_MAX_MOCKUP_NODES) {
    reject(
      "mockup-node-budget-exceeded",
      `Canvas mockup ${block.blockId} has more than ${CANVAS_MAX_MOCKUP_NODES} nodes.`,
    );
  }
  const nodes = new Map<string, string | undefined>();
  for (const node of block.nodes) {
    const id = String(node.nodeId);
    if (nodes.has(id)) {
      reject("duplicate-node-id", `Canvas mockup ${block.blockId} has duplicate nodes.`);
    }
    if (node.label.length > CANVAS_MAX_MOCKUP_TEXT_LENGTH) {
      reject(
        "mockup-text-budget-exceeded",
        `Canvas mockup ${block.blockId} has text longer than ${CANVAS_MAX_MOCKUP_TEXT_LENGTH} characters.`,
      );
    }
    nodes.set(id, node.parentId === undefined ? undefined : String(node.parentId));
  }
  for (const [id, parentId] of nodes) {
    if (parentId !== undefined && !nodes.has(parentId)) {
      reject(
        "dangling-mockup-parent",
        `Canvas mockup ${block.blockId} nests a node it does not hold.`,
      );
    }
    const seen = new Set<string>([id]);
    let current = parentId;
    let depth = 1;
    while (current !== undefined) {
      if (seen.has(current)) {
        reject(
          "mockup-nesting-cycle",
          `Canvas mockup ${block.blockId} nests a node inside itself.`,
        );
      }
      seen.add(current);
      depth += 1;
      if (depth > CANVAS_MAX_MOCKUP_DEPTH) {
        reject(
          "mockup-depth-exceeded",
          `Canvas mockup ${block.blockId} nests nodes deeper than ${CANVAS_MAX_MOCKUP_DEPTH}.`,
        );
      }
      current = nodes.get(current);
    }
  }
}

/**
 * A plan's phases and tasks are referenced by id: tasks name their phase and
 * the tasks they wait on. Every reference must resolve inside the block, and
 * dependencies must not loop, or the checklist, the kanban, and the
 * dependency view would each draw a different, impossible plan.
 */
function validatePlan(block: Extract<CanvasBlock, { readonly kind: "plan" }>): void {
  const phases = new Set<string>();
  for (const phase of block.phases) {
    if (phases.has(phase.phaseId)) {
      reject("duplicate-plan-phase-id", `Canvas plan ${block.blockId} has duplicate phases.`);
    }
    phases.add(phase.phaseId);
  }
  const tasks = new Map<string, ReadonlyArray<string>>();
  for (const task of block.tasks) {
    if (tasks.has(task.taskId)) {
      reject("duplicate-plan-task-id", `Canvas plan ${block.blockId} has duplicate tasks.`);
    }
    if (!phases.has(task.phaseId)) {
      reject("unknown-plan-phase", `Canvas plan ${block.blockId} has a task in a missing phase.`);
    }
    tasks.set(task.taskId, task.dependsOn ?? []);
  }
  for (const [taskId, dependsOn] of tasks) {
    for (const dependency of dependsOn) {
      if (dependency === taskId || !tasks.has(dependency)) {
        reject(
          "dangling-plan-dependency",
          `Canvas plan ${block.blockId} has a task waiting on a task it does not hold.`,
        );
      }
    }
  }
  // Depth-first walk with an on-path set: meeting a task already on the
  // current path means the dependencies loop.
  const settled = new Set<string>();
  const onPath = new Set<string>();
  const visit = (taskId: string): void => {
    if (settled.has(taskId)) return;
    if (onPath.has(taskId)) {
      reject("plan-dependency-cycle", `Canvas plan ${block.blockId} has circular dependencies.`);
    }
    onPath.add(taskId);
    for (const dependency of tasks.get(taskId) ?? []) visit(dependency);
    onPath.delete(taskId);
    settled.add(taskId);
  };
  for (const taskId of tasks.keys()) visit(taskId);
}

/**
 * A treemap is one root over leaves that carry every declared measure. A
 * group's reading is the sum of its children, so a group carrying its own
 * value, a leaf missing one, a dangling parent, a cycle, or a chain past the
 * depth budget would each draw a picture the data does not support. Sizes are
 * areas, so every value must be finite and not negative.
 */
function validateTreemap(block: Extract<CanvasBlock, { readonly kind: "treemap" }>): void {
  if (block.nodes.length > CANVAS_MAX_TREEMAP_LEAVES) {
    reject(
      "node-budget-exceeded",
      `Canvas treemap ${block.blockId} has more than ${String(CANVAS_MAX_TREEMAP_LEAVES)} nodes.`,
    );
  }
  const measures = new Set<string>();
  for (const measure of block.measures) {
    const id = String(measure.measureId);
    if (measures.has(id)) {
      reject("duplicate-measure-id", `Canvas treemap ${block.blockId} has duplicate measures.`);
    }
    measures.add(id);
  }
  if (!measures.has(String(block.sizeBy))) {
    reject(
      "unknown-treemap-measure",
      `Canvas treemap ${block.blockId} sizes by a measure it does not declare.`,
    );
  }
  if (!measures.has(String(block.colorBy))) {
    reject(
      "unknown-treemap-measure",
      `Canvas treemap ${block.blockId} colours by a measure it does not declare.`,
    );
  }

  const parents = new Map<string, string | undefined>();
  const valued = new Set<string>();
  for (const node of block.nodes) {
    const id = String(node.nodeId);
    if (parents.has(id)) {
      reject("duplicate-node-id", `Canvas treemap ${block.blockId} has duplicate nodes.`);
    }
    if (node.values !== undefined) valued.add(id);
    parents.set(id, node.parentId === undefined ? undefined : String(node.parentId));
  }

  const childrenOf = new Map<string, string[]>();
  let roots = 0;
  for (const [id, parentId] of parents) {
    if (parentId === undefined) {
      roots += 1;
      continue;
    }
    if (!parents.has(parentId)) {
      reject(
        "dangling-treemap-parent",
        `Canvas treemap ${block.blockId} nests a node it does not hold.`,
      );
    }
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(id);
    childrenOf.set(parentId, siblings);
  }
  // One root: a forest draws no single whole to read.
  if (roots !== 1) {
    reject("treemap-roots", `Canvas treemap ${block.blockId} does not have exactly one root.`);
  }

  for (const [id, parentId] of parents) {
    const seen = new Set<string>([id]);
    let current = parentId;
    let depth = 1;
    while (current !== undefined) {
      if (seen.has(current)) {
        reject(
          "treemap-nesting-cycle",
          `Canvas treemap ${block.blockId} nests a node inside itself.`,
        );
      }
      seen.add(current);
      depth += 1;
      if (depth > CANVAS_MAX_TREEMAP_DEPTH) {
        reject(
          "depth-budget-exceeded",
          `Canvas treemap ${block.blockId} nests deeper than ${String(CANVAS_MAX_TREEMAP_DEPTH)}.`,
        );
      }
      current = parents.get(current);
    }
  }

  // Values sit on leaves; a group sums its children, so it carries none.
  for (const id of parents.keys()) {
    const isLeaf = (childrenOf.get(id)?.length ?? 0) === 0;
    const carriesValues = valued.has(id);
    if (isLeaf && !carriesValues) {
      reject(
        "treemap-value-placement",
        `Canvas treemap ${block.blockId} has a leaf with no value.`,
      );
    }
    if (!isLeaf && carriesValues) {
      reject(
        "treemap-value-placement",
        `Canvas treemap ${block.blockId} puts a value on a group it sums instead.`,
      );
    }
  }

  for (const node of block.nodes) {
    const values = node.values;
    if (values === undefined) continue;
    for (const [key, value] of Object.entries(values)) {
      if (!measures.has(key)) {
        reject(
          "unknown-treemap-measure",
          `Canvas treemap ${block.blockId} carries a value for a measure it does not declare.`,
        );
      }
      if (!Number.isFinite(value) || value < 0) {
        reject(
          "treemap-negative-value",
          `Canvas treemap ${block.blockId} has a value that is negative or not finite.`,
        );
      }
    }
    for (const measure of measures) {
      if (!Object.prototype.hasOwnProperty.call(values, measure)) {
        reject(
          "treemap-value-placement",
          `Canvas treemap ${block.blockId} has a leaf missing a declared measure.`,
        );
      }
    }
  }
}

/**
 * A heatmap's cells name their row and column by id, and a calendar lists one
 * reading per date. A cell on a missing axis, a coordinate listed twice, a
 * repeated date, a note past its length, or a grid past its row, column, cell,
 * or day budget would each draw a picture the data does not support.
 */
function validateHeatmap(block: Extract<CanvasBlock, { readonly kind: "heatmap" }>): void {
  if (block.layout === "matrix") {
    if (block.rows.length > CANVAS_MAX_HEATMAP_ROWS) {
      reject(
        "heatmap-rows-budget-exceeded",
        `Canvas heatmap ${block.blockId} has more than ${String(CANVAS_MAX_HEATMAP_ROWS)} rows.`,
      );
    }
    if (block.columns.length > CANVAS_MAX_HEATMAP_COLUMNS) {
      reject(
        "heatmap-columns-budget-exceeded",
        `Canvas heatmap ${block.blockId} has more than ${String(CANVAS_MAX_HEATMAP_COLUMNS)} columns.`,
      );
    }
    if (block.cells.length > CANVAS_MAX_HEATMAP_CELLS) {
      reject(
        "heatmap-cells-budget-exceeded",
        `Canvas heatmap ${block.blockId} has more than ${String(CANVAS_MAX_HEATMAP_CELLS)} cells.`,
      );
    }
    const rows = new Set<string>();
    for (const row of block.rows) {
      const id = String(row.rowId);
      if (rows.has(id)) {
        reject("duplicate-heatmap-row-id", `Canvas heatmap ${block.blockId} repeats a row.`);
      }
      rows.add(id);
    }
    const columns = new Set<string>();
    for (const column of block.columns) {
      const id = String(column.columnId);
      if (columns.has(id)) {
        reject("duplicate-heatmap-column-id", `Canvas heatmap ${block.blockId} repeats a column.`);
      }
      columns.add(id);
    }
    const coordinates = new Set<string>();
    for (const cell of block.cells) {
      if (!rows.has(String(cell.rowId))) {
        reject(
          "unknown-heatmap-row",
          `Canvas heatmap ${block.blockId} has a cell on a row it does not hold.`,
        );
      }
      if (!columns.has(String(cell.columnId))) {
        reject(
          "unknown-heatmap-column",
          `Canvas heatmap ${block.blockId} has a cell on a column it does not hold.`,
        );
      }
      const coordinate = `${String(cell.rowId)}\u0000${String(cell.columnId)}`;
      if (coordinates.has(coordinate)) {
        reject(
          "duplicate-heatmap-cell",
          `Canvas heatmap ${block.blockId} lists one coordinate more than once.`,
        );
      }
      coordinates.add(coordinate);
      if (cell.note !== undefined && cell.note.length > CANVAS_MAX_HEATMAP_NOTE_LENGTH) {
        reject(
          "heatmap-note-budget-exceeded",
          `Canvas heatmap ${block.blockId} has a note longer than ${String(CANVAS_MAX_HEATMAP_NOTE_LENGTH)} characters.`,
        );
      }
    }
    return;
  }

  if (block.days.length > CANVAS_MAX_HEATMAP_DAYS) {
    reject(
      "heatmap-days-budget-exceeded",
      `Canvas heatmap ${block.blockId} has more than ${String(CANVAS_MAX_HEATMAP_DAYS)} days.`,
    );
  }
  const orderedDates = block.days.map((day) => day.date).sort();
  const firstDate = orderedDates[0];
  const lastDate = orderedDates[orderedDates.length - 1];
  if (firstDate !== undefined && lastDate !== undefined) {
    // The picture fills the days between the first and last reading, so a span
    // past the day budget would draw more days than the block may declare.
    const span =
      (Date.parse(`${lastDate}T00:00:00.000Z`) - Date.parse(`${firstDate}T00:00:00.000Z`)) /
        86_400_000 +
      1;
    if (span > CANVAS_MAX_HEATMAP_DAYS) {
      reject(
        "heatmap-days-budget-exceeded",
        `Canvas heatmap ${block.blockId} spans more than ${String(CANVAS_MAX_HEATMAP_DAYS)} days.`,
      );
    }
  }
  const dates = new Set<string>();
  for (const day of block.days) {
    if (dates.has(day.date)) {
      reject("duplicate-heatmap-date", `Canvas heatmap ${block.blockId} repeats a date.`);
    }
    dates.add(day.date);
    if (day.note !== undefined && day.note.length > CANVAS_MAX_HEATMAP_NOTE_LENGTH) {
      reject(
        "heatmap-note-budget-exceeded",
        `Canvas heatmap ${block.blockId} has a note longer than ${String(CANVAS_MAX_HEATMAP_NOTE_LENGTH)} characters.`,
      );
    }
  }
}

/**
 * A bar list is a ranking of magnitudes. A repeated label would draw one entry
 * twice, a row past the row budget would draw a list longer than the block may
 * declare, and a negative value has no bar length, so each is refused. The
 * sort order is not validated: largest-first is the default the renderer
 * applies, and the person may reverse it as view state.
 */
function validateBarList(block: Extract<CanvasBlock, { readonly kind: "bar-list" }>): void {
  if (block.rows.length > CANVAS_MAX_BAR_LIST_ROWS) {
    reject(
      "bar-list-rows-budget-exceeded",
      `Canvas bar list ${block.blockId} has more than ${String(CANVAS_MAX_BAR_LIST_ROWS)} rows.`,
    );
  }
  const labels = new Set<string>();
  for (const row of block.rows) {
    if (labels.has(row.label)) {
      reject(
        "duplicate-bar-list-label",
        `Canvas bar list ${block.blockId} lists one label more than once.`,
      );
    }
    labels.add(row.label);
    if (!Number.isFinite(row.value) || row.value < 0) {
      reject(
        "bar-list-negative-value",
        `Canvas bar list ${block.blockId} has a value that is negative or not finite.`,
      );
    }
    if (
      row.secondaryValue !== undefined &&
      (!Number.isFinite(row.secondaryValue) || row.secondaryValue < 0)
    ) {
      reject(
        "bar-list-negative-value",
        `Canvas bar list ${block.blockId} has a second value that is negative or not finite.`,
      );
    }
  }
}

/**
 * A metric's sparkline is a bounded glance. The contract caps it, so this
 * re-check only fires for a caller that bypassed the decoder; the block stays
 * otherwise unconstrained because an absent direction simply means neutral.
 */
function validateMetric(block: Extract<CanvasBlock, { readonly kind: "metric" }>): void {
  if (
    block.sparkline !== undefined &&
    block.sparkline.length > CANVAS_MAX_METRIC_SPARKLINE_POINTS
  ) {
    reject(
      "metric-sparkline-budget-exceeded",
      `Canvas metric ${block.blockId} has a sparkline longer than ${String(CANVAS_MAX_METRIC_SPARKLINE_POINTS)} points.`,
    );
  }
}

function enforceBudgets(usage: CanvasBudgetUsage): void {
  if (usage.maxDepth > CANVAS_MAX_DEPTH) {
    reject("depth-budget-exceeded", `Canvas depth ${usage.maxDepth} exceeds ${CANVAS_MAX_DEPTH}.`);
  }
  if (usage.blockCount > CANVAS_MAX_BLOCKS) {
    reject("block-budget-exceeded", `Canvas block count exceeds ${CANVAS_MAX_BLOCKS}.`);
  }
  if (usage.textBytes > CANVAS_MAX_TEXT_BYTES) {
    reject("text-budget-exceeded", `Canvas text exceeds ${CANVAS_MAX_TEXT_BYTES} bytes.`);
  }
  if (usage.tableRows > CANVAS_MAX_TABLE_ROWS) {
    reject("rows-budget-exceeded", `Canvas table rows exceed ${CANVAS_MAX_TABLE_ROWS}.`);
  }
  if (usage.chartSeries > CANVAS_MAX_SERIES) {
    reject("series-budget-exceeded", `Canvas series exceed ${CANVAS_MAX_SERIES}.`);
  }
  if (usage.diagramNodes > CANVAS_MAX_DIAGRAM_NODES) {
    reject("node-budget-exceeded", `Canvas diagram nodes exceed ${CANVAS_MAX_DIAGRAM_NODES}.`);
  }
  if (usage.diagramEdges > CANVAS_MAX_DIAGRAM_EDGES) {
    reject("edge-budget-exceeded", `Canvas diagram edges exceed ${CANVAS_MAX_DIAGRAM_EDGES}.`);
  }
  if (usage.imageCount > CANVAS_MAX_IMAGES) {
    reject("image-budget-exceeded", `Canvas images exceed ${CANVAS_MAX_IMAGES}.`);
  }
  if (usage.payloadBytes > CANVAS_MAX_PAYLOAD_BYTES) {
    reject("payload-budget-exceeded", `Canvas payload exceeds ${CANVAS_MAX_PAYLOAD_BYTES} bytes.`);
  }
}

/**
 * Decode and validate a Canvas definition before any renderer, persistence,
 * or authority service consumes it. The raw value is inspected first so
 * cycles, accessors, prototype pollution, and hostile depth fail closed even
 * when a caller has bypassed TypeScript types.
 */
export function validateCanvasDefinition(input: unknown): CanvasDefinition {
  const rawInspection = inspectCanvasPayload(input);
  if (rawInspection.maxDepth > CANVAS_MAX_DEPTH) {
    reject("depth-budget-exceeded", `Canvas depth exceeds ${CANVAS_MAX_DEPTH}.`);
  }
  if (rawInspection.textBytes > CANVAS_MAX_TEXT_BYTES) {
    reject("text-budget-exceeded", `Canvas text exceeds ${CANVAS_MAX_TEXT_BYTES} bytes.`);
  }
  if (rawInspection.payloadBytes > CANVAS_MAX_PAYLOAD_BYTES) {
    reject("payload-budget-exceeded", `Canvas payload exceeds ${CANVAS_MAX_PAYLOAD_BYTES} bytes.`);
  }

  const definition = decodeDefinitionOrReject(input);
  const decodedInspection = inspectCanvasPayload(definition);
  const usage = calculateBudgetUsage(definition, decodedInspection);
  validateCrossReferences(definition);
  enforceBudgets(usage);
  return definition;
}

export const validateCanvas = validateCanvasDefinition;

export function measureCanvasBudget(input: CanvasDefinition): CanvasBudgetUsage {
  const definition = validateCanvasDefinition(input);
  return calculateBudgetUsage(definition, inspectCanvasPayload(definition));
}

export function validateCanvasVersion(input: unknown): CanvasVersion {
  const rawInspection = inspectCanvasPayload(input);
  if (
    rawInspection.maxDepth > CANVAS_MAX_DEPTH ||
    rawInspection.payloadBytes > CANVAS_MAX_PAYLOAD_BYTES
  ) {
    reject("payload-budget-exceeded", "Canvas version envelope exceeds the safe payload budget.");
  }
  let version: CanvasVersion;
  try {
    version = decodeCanvasVersion(input);
  } catch (error) {
    if (error instanceof CanvasPolicyRejected) throw error;
    const schemaRejection = declaredSchemaRejection(input);
    if (schemaRejection !== undefined) {
      return reject(schemaRejection, "Canvas schema version is unsupported.");
    }
    return reject("invalid-schema", "Canvas version failed strict schema validation.");
  }
  if (version.schemaVersion !== version.definition.schemaVersion) {
    reject("invalid-schema", "Canvas version and definition schema versions differ.");
  }
  validateCanvasDefinition(version.definition);
  return version;
}

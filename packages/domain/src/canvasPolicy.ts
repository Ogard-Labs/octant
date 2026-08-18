import {
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_DIAGRAM_EDGES,
  CANVAS_MAX_DIAGRAM_NODES,
  CANVAS_MAX_DEPTH,
  CANVAS_MAX_IMAGES,
  CANVAS_MAX_PAYLOAD_BYTES,
  CANVAS_MAX_SERIES,
  CANVAS_MAX_TABLE_ROWS,
  CANVAS_MAX_TEXT_BYTES,
  CanvasBlock,
  CanvasDefinition,
  CanvasVersion,
  decodeCanvasDefinition,
  decodeCanvasVersion,
  type CanvasSourceId,
} from "@octant/contracts/canvas";

const encoder = new TextEncoder();

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
  | "overlapping-groups";

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

function decodeDefinitionOrReject(input: unknown): CanvasDefinition {
  try {
    const definition = decodeCanvasDefinition(input);
    if (definition.schemaVersion !== 1) {
      return reject(
        "unsupported-schema-version",
        `Canvas schema version ${String(definition.schemaVersion)} is unsupported.`,
      );
    }
    return definition;
  } catch (error) {
    if (error instanceof CanvasPolicyRejected) throw error;
    const structuralBudget = inferStructuralBudgetCode(input);
    if (structuralBudget !== undefined) {
      return reject(structuralBudget, "Canvas structural budget is exceeded.");
    }
    if (
      typeof input === "object" &&
      input !== null &&
      "schemaVersion" in input &&
      typeof (input as { schemaVersion?: unknown }).schemaVersion === "number" &&
      (input as { schemaVersion?: unknown }).schemaVersion !== 1
    ) {
      return reject("unsupported-schema-version", "Canvas schema version is unsupported.");
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
    return reject("invalid-schema", "Canvas version failed strict schema validation.");
  }
  if (version.schemaVersion !== version.definition.schemaVersion) {
    reject("invalid-schema", "Canvas version and definition schema versions differ.");
  }
  validateCanvasDefinition(version.definition);
  return version;
}

import {
  CANVAS_MAX_BLOCKS,
  CANVAS_MAX_DIAGRAM_EDGES,
  CANVAS_MAX_DIAGRAM_NODES,
  CANVAS_MAX_DEPTH,
  CANVAS_MAX_DESIGN_FRAMES,
  CANVAS_MAX_DESIGN_MARKUP_LENGTH,
  CANVAS_MAX_IMAGES,
  CANVAS_MAX_MOCKUP_DEPTH,
  CANVAS_MAX_MOCKUP_NODES,
  CANVAS_MAX_MOCKUP_TEXT_LENGTH,
  CANVAS_MAX_PAYLOAD_BYTES,
  CANVAS_MAX_SERIES,
  CANVAS_MAX_TABLE_ROWS,
  CANVAS_MAX_TEXT_BYTES,
  CANVAS_SCHEMA_VERSION,
  CanvasBlock,
  CanvasDefinition,
  CanvasVersion,
  decodeCanvasDefinition,
  decodeCanvasVersion,
  type CanvasSourceId,
} from "@octant/contracts/canvas";
import { canvasDesignMarkupRefusal, canvasDesignStylesheetRefusal } from "./canvasDesignPolicy";

const encoder = new TextEncoder();

// Versions this runtime decodes: every historical version plus the current
// one. A document declaring anything else is refused as a future version,
// before its blocks are read, so a newer contract never reaches a renderer.
const SUPPORTED_CANVAS_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3, 4, CANVAS_SCHEMA_VERSION];

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
  | "design-frame-budget-exceeded"
  | "design-markup-budget-exceeded"
  | "duplicate-design-frame-id"
  | "design-markup-refused";

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
 * block from version 3, a thread presentation from version 4, a design block
 * from version 5) inside a
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
  if (declared === CANVAS_SCHEMA_VERSION) return undefined;
  const presentation = envelope.presentation ?? envelope.definition?.presentation;
  if (declared < 4 && presentation !== undefined) return "unsupported-schema-version";
  const blocks = Array.isArray(envelope.blocks)
    ? envelope.blocks
    : Array.isArray(envelope.definition?.blocks)
      ? envelope.definition?.blocks
      : undefined;
  const carries = (kind: string) =>
    blocks?.some(
      (block) =>
        typeof block === "object" && block !== null && (block as { kind?: unknown }).kind === kind,
    ) === true;
  if (declared < 3 && carries("mockup")) return "unsupported-schema-version";
  if (declared < 5 && carries("design")) return "unsupported-schema-version";
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
      title?: unknown;
      frames?: unknown;
      styles?: unknown;
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
    if (block.kind === "mockup") validateMockup(block);
    if (block.kind === "design") validateDesign(block);
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

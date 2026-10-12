import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBlock,
  type CanvasBlockId,
  type CanvasErCardinality,
} from "@octant/contracts/canvas";

/**
 * Translating a bounded Mermaid subset into the Canvas's own typed blocks.
 *
 * Mermaid is never rendered. A diagram an author already has in Mermaid is
 * read here, statement by statement, into a `diagram`, `sequence`, `state`,
 * `er`, or `mindmap` block, which Octant's own layout then draws, comments
 * anchor to, and a share carries. The subset is closed: a construct this
 * reader does not know — styling, classes, click handlers, links, loops and
 * alternatives, notes it cannot place — refuses the whole import with the
 * line that stopped it, so the caller keeps the source as a code block
 * rather than a picture that silently lost part of what it said.
 */

export type CanvasMermaidRefusalReason =
  /** The first statement names no diagram this reader translates. */
  | "unsupported-diagram"
  /** A statement inside a supported diagram uses a construct outside the subset. */
  | "unsupported-construct"
  /** The source holds no diagram header, or a header and nothing else. */
  | "empty"
  /** The source is longer than this reader accepts. */
  | "too-large"
  /** The translation is not a block the catalog admits, such as one past a budget. */
  | "invalid-result";

export type CanvasMermaidImport =
  | {
      readonly status: "imported";
      readonly block: CanvasBlock;
    }
  | {
      readonly status: "refused";
      readonly reason: CanvasMermaidRefusalReason;
      /** The 1-based source line that stopped the import, when one did. */
      readonly line?: number;
      readonly detail: string;
    };

/** A Mermaid diagram past this is a document, not a figure; it stays code. */
export const CANVAS_MERMAID_MAX_SOURCE_LENGTH = 32_768;

/** Languages a code block may name for the host to try an import. */
export function isCanvasMermaidLanguage(language: string): boolean {
  return language.toLowerCase() === "mermaid";
}

/**
 * Why the reader stopped. It unwinds the statement walk and is caught at the
 * one public entry, which returns it as a value; it never leaves this module.
 */
class Refusal {
  constructor(
    readonly reason: CanvasMermaidRefusalReason,
    readonly detail: string,
    readonly line?: number,
  ) {}
}

interface Statement {
  readonly text: string;
  readonly line: number;
  /** Leading spaces, tabs counted as two; the mind map reads its tree from it. */
  readonly indent: number;
}

function statements(source: string): ReadonlyArray<Statement> {
  const result: Statement[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const withoutComment = raw.trimStart().startsWith("%%") ? "" : raw;
    const expanded = withoutComment.replace(/\t/g, "  ");
    const indent = expanded.length - expanded.trimStart().length;
    for (const part of expanded.split(";")) {
      const text = part.trim();
      if (text.length > 0) result.push({ text, line: index + 1, indent });
    }
  });
  return result;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Mermaid ids allow underscores, Canvas ids do not; an underscore becomes a
 * hyphen, and two Mermaid ids that land on one Canvas id refuse the import
 * rather than merge two nodes.
 */
class Ids {
  readonly #seen = new Map<string, string>();
  readonly #what: string;

  constructor(what: string) {
    this.#what = what;
  }

  canvas(mermaidId: string, line: number): string {
    const mapped = mermaidId.replace(/_/g, "-");
    if (!TOKEN.test(mapped) || mapped.length > 128) {
      throw new Refusal(
        "unsupported-construct",
        `${this.#what} id "${mermaidId}" is not supported.`,
        line,
      );
    }
    const earlier = this.#seen.get(mapped);
    if (earlier !== undefined && earlier !== mermaidId) {
      throw new Refusal(
        "unsupported-construct",
        `${this.#what} ids "${earlier}" and "${mermaidId}" would name the same node.`,
        line,
      );
    }
    this.#seen.set(mapped, mermaidId);
    return mapped;
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function unsupported(statement: Statement, what = "This statement"): Refusal {
  return new Refusal(
    "unsupported-construct",
    `${what} is outside the Mermaid subset Canvas imports: ${statement.text.slice(0, 80)}`,
    statement.line,
  );
}

/** Statements no supported diagram type translates: styling, interaction, and layout hints. */
const REFUSED_KEYWORDS =
  /^(classDef|class|style|linkStyle|click|callback|direction|accTitle|accDescr|title|%%\{)/;

export function importCanvasMermaid(source: string, blockId: CanvasBlockId): CanvasMermaidImport {
  if (source.length > CANVAS_MERMAID_MAX_SOURCE_LENGTH) {
    return {
      status: "refused",
      reason: "too-large",
      detail: `Mermaid source over ${String(CANVAS_MERMAID_MAX_SOURCE_LENGTH)} characters stays a code block.`,
    };
  }
  try {
    const all = statements(source);
    const [header, ...body] = all;
    if (header === undefined) throw new Refusal("empty", "The Mermaid source is empty.");
    const words = header.text.split(/\s+/);
    const kind = words[0] ?? "";
    let block: unknown;
    if (kind === "flowchart" || kind === "graph") block = flowchart(header, body, blockId);
    else if (kind === "sequenceDiagram") block = sequence(header, body, blockId);
    else if (kind === "stateDiagram" || kind === "stateDiagram-v2")
      block = state(header, body, blockId);
    else if (kind === "erDiagram") block = er(header, body, blockId);
    else if (kind === "mindmap") block = mindmap(header, body, blockId);
    else {
      throw new Refusal(
        "unsupported-diagram",
        `Canvas imports flowchart, graph, sequenceDiagram, stateDiagram, erDiagram, and mindmap; "${kind.slice(0, 40)}" stays a code block.`,
        header.line,
      );
    }
    try {
      return { status: "imported", block: decodeCanvasBlock(block) };
    } catch {
      throw new Refusal(
        "invalid-result",
        "The translated diagram is not a block the Canvas catalog admits, such as one past a node budget or with an empty label.",
      );
    }
  } catch (error) {
    if (error instanceof Refusal) {
      return {
        status: "refused",
        reason: error.reason,
        ...(error.line === undefined ? {} : { line: error.line }),
        detail: error.detail,
      };
    }
    throw error;
  }
}

// ── flowchart / graph ───────────────────────────────────────────────────────

type FlowRole = "process" | "decision" | "terminator" | undefined;

interface FlowNode {
  readonly nodeId: string;
  label: string;
  role: FlowRole;
}

/**
 * A node reference with an optional shape: `id`, `id[Label]` (process),
 * `id(Label)` (the plain box), `id([Label])` (terminator), `id{Label}`
 * (decision). Every other Mermaid shape is refused.
 */
const NODE_REF =
  /^([A-Za-z0-9_][A-Za-z0-9_-]*)(?:\(\[(.+?)\]\)|\[(?![[(/\\])(.+?)\]|\((?![([])(.+?)\)|\{(?!\{)(.+?)\})?$/;

/**
 * A link between two nodes, with an optional label written either way Mermaid
 * allows (`A -->|yes| B` or `A -- yes --> B`). The thick, bidirectional,
 * circle, cross, and dashed-without-arrow links are matched only so they can
 * be refused by name rather than read as part of a node. Each form is listed
 * on its own; the first that matches at a position wins, so the labelled
 * forms come before the bare arrows they contain.
 */
const LINK_FORMS: ReadonlyArray<string> = [
  String.raw`--\s+[^-|>\s][^|>]*?\s+(?:-->|---)`, // A -- label --> B, A -- label --- B
  String.raw`-\.\s+[^.>\s][^|>]*?\s+\.->`, // A -. label .-> B
  String.raw`-\.->`, // dashed arrow
  String.raw`-->`, // arrow
  String.raw`---`, // line
  String.raw`==>`, // thick, refused
  String.raw`<-->`, // bidirectional, refused
  String.raw`<--`, // reversed, refused
  String.raw`-\.-`, // dashed without an arrow, refused
  String.raw`--[ox](?=\s)`, // circle or cross end, refused
  String.raw`[ox]--`, // circle or cross start, refused
];
const LINK = new RegExp(String.raw`(${LINK_FORMS.join("|")})(\|[^|]*\|)?`);

function flowchart(header: Statement, body: ReadonlyArray<Statement>, blockId: CanvasBlockId) {
  const direction = header.text.split(/\s+/)[1] ?? "TD";
  let flow: "down" | "right";
  if (direction === "TD" || direction === "TB") flow = "down";
  else if (direction === "LR") flow = "right";
  else throw unsupported(header, `The direction ${direction}`);
  const ids = new Ids("Node");
  const nodes = new Map<string, FlowNode>();
  const edges: Array<Record<string, unknown>> = [];
  const groups: Array<{ groupId: string; label: string; nodeIds: string[] }> = [];
  let openGroup: { groupId: string; label: string; nodeIds: string[] } | undefined;
  const groupIds = new Ids("Subgraph");
  let pending: { readonly style: "line" | "arrow" | "dashed"; readonly label?: string } | undefined;

  const reference = (text: string, statement: Statement): string => {
    const match = NODE_REF.exec(text.trim());
    if (match === null) throw unsupported(statement, `The node "${text.trim().slice(0, 40)}"`);
    const nodeId = ids.canvas(match[1] ?? "", statement.line);
    const [terminator, process, plain, decision] = [match[2], match[3], match[4], match[5]];
    const label = terminator ?? process ?? plain ?? decision;
    const role: FlowRole =
      terminator !== undefined
        ? "terminator"
        : process !== undefined
          ? "process"
          : decision !== undefined
            ? "decision"
            : undefined;
    const existing = nodes.get(nodeId);
    if (existing === undefined) {
      nodes.set(nodeId, {
        nodeId,
        label: label === undefined ? (match[1] ?? nodeId) : unquote(label),
        role,
      });
    } else if (label !== undefined) {
      existing.label = unquote(label);
      existing.role = role;
    }
    if (openGroup !== undefined && !openGroup.nodeIds.includes(nodeId)) {
      openGroup.nodeIds.push(nodeId);
    }
    return nodeId;
  };

  for (const statement of body) {
    const text = statement.text;
    if (REFUSED_KEYWORDS.test(text) || /\s&\s/.test(text) || text.includes(":::")) {
      throw unsupported(statement);
    }
    const subgraph = /^subgraph\s+(.+)$/.exec(text);
    if (subgraph !== null) {
      if (openGroup !== undefined) throw unsupported(statement, "A nested subgraph");
      const spec = (subgraph[1] ?? "").trim();
      const named = /^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*\[(.+)\]$/.exec(spec);
      const rawId = named?.[1] ?? spec.replace(/\s+/g, "-");
      openGroup = {
        groupId: groupIds.canvas(rawId, statement.line),
        label: unquote(named?.[2] ?? spec),
        nodeIds: [],
      };
      continue;
    }
    if (text === "end") {
      if (openGroup === undefined) throw unsupported(statement, "An end without a subgraph");
      groups.push(openGroup);
      openGroup = undefined;
      continue;
    }
    // A chain: node (link node)*.
    let rest = text;
    let from: string | undefined;
    for (;;) {
      const link = LINK.exec(rest);
      const nodeText = link === null ? rest : rest.slice(0, link.index);
      const to = reference(nodeText, statement);
      if (from !== undefined && pending !== undefined) {
        edges.push({
          edgeId: `e${String(edges.length + 1)}`,
          source: from,
          target: to,
          style: pending.style,
          ...(pending.label === undefined ? {} : { label: pending.label }),
        });
      }
      from = to;
      if (link === null) break;
      pending = readLink(link[1] ?? "", link[2], statement);
      rest = rest.slice(link.index + link[0].length);
    }
    pending = undefined;
  }
  if (openGroup !== undefined) {
    throw new Refusal("unsupported-construct", `Subgraph ${openGroup.label} is never closed.`);
  }
  if (nodes.size === 0) throw new Refusal("empty", "The flowchart names no nodes.");
  // A node may sit in one group only; Mermaid lets a later subgraph claim a
  // node an earlier one drew, which the Canvas refuses rather than guesses.
  const grouped = new Set<string>();
  for (const group of groups) {
    for (const nodeId of group.nodeIds) {
      if (grouped.has(nodeId)) {
        throw new Refusal("unsupported-construct", `Node ${nodeId} is in more than one subgraph.`);
      }
      grouped.add(nodeId);
    }
  }
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "diagram",
    flow,
    nodes: [...nodes.values()].map((node) => ({
      nodeId: node.nodeId,
      label: node.label,
      ...(node.role === undefined ? {} : { role: node.role }),
    })),
    edges,
    ...(groups.length === 0 ? {} : { groups: groups.filter((group) => group.nodeIds.length > 0) }),
  };
}

function readLink(
  operator: string,
  piped: string | undefined,
  statement: Statement,
): { readonly style: "line" | "arrow" | "dashed"; readonly label?: string } {
  const named = /^--\s+(.+?)\s+(-->|---)$/.exec(operator);
  const dotted = /^-\.\s+(.+?)\s+\.->$/.exec(operator);
  const style =
    named !== null
      ? named[2] === "-->"
        ? "arrow"
        : "line"
      : dotted !== null || operator === "-.->"
        ? "dashed"
        : operator === "-->"
          ? "arrow"
          : operator === "---"
            ? "line"
            : undefined;
  if (style === undefined) throw unsupported(statement, `The link ${operator}`);
  const label = (piped === undefined ? (named?.[1] ?? dotted?.[1]) : piped.slice(1, -1))?.trim();
  return { style, ...(label === undefined || label.length === 0 ? {} : { label: unquote(label) }) };
}

// ── sequenceDiagram ─────────────────────────────────────────────────────────

// A participant id is word characters: a hyphen would run into the arrow.
const MESSAGE = /^(\w+)\s*(-->>|->>|-->|->)\s*(\w+)\s*:\s*(.+)$/;
const NOTE = /^Note\s+(left of|right of|over)\s+(\w+)\s*:\s*(.+)$/i;
// A Canvas note sits beside one participant; a note spanning two has no
// faithful translation, so the source stays code rather than losing one side.
const SPANNING_NOTE = /^Note\s+over\s+\w+\s*,/i;

function sequence(_header: Statement, body: ReadonlyArray<Statement>, blockId: CanvasBlockId) {
  const ids = new Ids("Participant");
  const participants = new Map<string, string>();
  const messages: Array<Record<string, unknown>> = [];
  const notes: Array<Record<string, unknown>> = [];
  const activations: Array<Record<string, unknown>> = [];
  const opened = new Map<string, number>();
  const participant = (mermaidId: string, statement: Statement, label?: string): string => {
    const id = ids.canvas(mermaidId, statement.line);
    if (!participants.has(id) || label !== undefined) participants.set(id, label ?? mermaidId);
    return id;
  };
  for (const statement of body) {
    const text = statement.text;
    const declared = /^(participant|actor)\s+(\w+)(?:\s+as\s+(.+))?$/.exec(text);
    if (declared !== null) {
      participant(
        declared[2] ?? "",
        statement,
        declared[3] === undefined ? undefined : unquote(declared[3]),
      );
      continue;
    }
    const message = MESSAGE.exec(text);
    if (message !== null) {
      messages.push({
        messageId: `m${String(messages.length + 1)}`,
        from: participant(message[1] ?? "", statement),
        to: participant(message[3] ?? "", statement),
        label: unquote(message[4] ?? ""),
      });
      continue;
    }
    if (SPANNING_NOTE.test(text)) throw unsupported(statement, "A note spanning two participants");
    const note = NOTE.exec(text);
    if (note !== null) {
      const last = messages.at(-1);
      notes.push({
        noteId: `n${String(notes.length + 1)}`,
        text: unquote(note[3] ?? ""),
        participantId: participant(note[2] ?? "", statement),
        ...(last === undefined ? {} : { afterMessageId: last["messageId"] }),
      });
      continue;
    }
    const toggle = /^(activate|deactivate)\s+(\w+)$/.exec(text);
    if (toggle !== null) {
      const id = participant(toggle[2] ?? "", statement);
      if (toggle[1] === "activate") {
        if (opened.has(id)) throw unsupported(statement, "A nested activation");
        opened.set(id, messages.length);
      } else {
        const start = opened.get(id);
        const startMessage = start === undefined ? undefined : messages[start];
        const endMessage = messages.at(-1);
        if (
          start === undefined ||
          startMessage === undefined ||
          endMessage === undefined ||
          messages.length <= start
        ) {
          throw unsupported(statement, "An activation that spans no message");
        }
        opened.delete(id);
        activations.push({
          activationId: `a${String(activations.length + 1)}`,
          participantId: id,
          startMessageId: startMessage["messageId"],
          endMessageId: endMessage["messageId"],
        });
      }
      continue;
    }
    throw unsupported(statement);
  }
  if (opened.size > 0) throw new Refusal("unsupported-construct", "An activation is never closed.");
  if (participants.size === 0) throw new Refusal("empty", "The sequence names no participants.");
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "sequence",
    participants: [...participants].map(([participantId, label]) => ({ participantId, label })),
    messages,
    ...(activations.length === 0 ? {} : { activations }),
    ...(notes.length === 0 ? {} : { notes }),
  };
}

// ── stateDiagram ────────────────────────────────────────────────────────────

const STATE_REF = "(\\[\\*\\]|[A-Za-z0-9_][A-Za-z0-9_-]*)";
const TRANSITION = new RegExp(`^${STATE_REF}\\s*-->\\s*${STATE_REF}(?:\\s*:\\s*(.+))?$`);

function state(_header: Statement, body: ReadonlyArray<Statement>, blockId: CanvasBlockId) {
  const ids = new Ids("State");
  const states = new Map<
    string,
    { label: string; role?: "initial" | "final"; parentId?: string }
  >();
  const transitions: Array<Record<string, unknown>> = [];
  const parents: string[] = [];
  const declare = (mermaidId: string, statement: Statement, label?: string): string => {
    const id = ids.canvas(mermaidId, statement.line);
    const parentId = parents.at(-1);
    const existing = states.get(id);
    if (existing === undefined) {
      states.set(id, {
        label: label ?? mermaidId,
        ...(parentId === undefined ? {} : { parentId }),
      });
    } else if (label !== undefined) {
      existing.label = label;
    }
    return id;
  };
  const pseudo = (role: "initial" | "final", statement: Statement): string => {
    if (parents.length > 0) throw unsupported(statement, "A start or end inside a composite state");
    // A Mermaid state id never holds a colon, so these cannot meet a state
    // the author named start or end.
    const id = role === "initial" ? "pseudo:start" : "pseudo:end";
    if (!states.has(id)) states.set(id, { label: role === "initial" ? "Start" : "End", role });
    return id;
  };
  for (const statement of body) {
    const text = statement.text;
    const alias = /^state\s+"(.+)"\s+as\s+([A-Za-z0-9_][A-Za-z0-9_-]*)$/.exec(text);
    if (alias !== null) {
      declare(alias[2] ?? "", statement, alias[1]);
      continue;
    }
    const composite = /^state\s+([A-Za-z0-9_][A-Za-z0-9_-]*)\s*\{$/.exec(text);
    if (composite !== null) {
      parents.push(declare(composite[1] ?? "", statement));
      continue;
    }
    if (text === "}") {
      if (parents.pop() === undefined)
        throw unsupported(statement, "A closing brace without a state");
      continue;
    }
    const transition = TRANSITION.exec(text);
    if (transition !== null) {
      const [rawSource, rawTarget] = [transition[1] ?? "", transition[2] ?? ""];
      if (rawSource === "[*]" && rawTarget === "[*]") throw unsupported(statement);
      const source =
        rawSource === "[*]" ? pseudo("initial", statement) : declare(rawSource, statement);
      const target =
        rawTarget === "[*]" ? pseudo("final", statement) : declare(rawTarget, statement);
      const label = transition[3]?.trim();
      transitions.push({
        transitionId: `t${String(transitions.length + 1)}`,
        source,
        target,
        // A Canvas transition always says what moves it; an unlabeled Mermaid
        // transition reads as a plain arrow.
        label: label === undefined || label.length === 0 ? "→" : unquote(label),
      });
      continue;
    }
    if (/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(text)) {
      declare(text, statement);
      continue;
    }
    throw unsupported(statement);
  }
  if (parents.length > 0)
    throw new Refusal("unsupported-construct", "A composite state is never closed.");
  if (states.size === 0) throw new Refusal("empty", "The state diagram names no states.");
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "state",
    states: [...states].map(([stateId, entry]) => ({
      stateId,
      label: entry.label,
      ...(entry.role === undefined ? {} : { role: entry.role }),
      ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
    })),
    transitions,
  };
}

// ── erDiagram ───────────────────────────────────────────────────────────────

const LEFT_CARDINALITY: Readonly<Record<string, CanvasErCardinality>> = {
  "||": "one",
  "|o": "zero-or-one",
  "}o": "many",
  "}|": "one-or-many",
};
const RIGHT_CARDINALITY: Readonly<Record<string, CanvasErCardinality>> = {
  "||": "one",
  "o|": "zero-or-one",
  "o{": "many",
  "|{": "one-or-many",
};
const ENTITY = "([A-Za-z0-9_][A-Za-z0-9_-]*)";
const RELATIONSHIP = new RegExp(
  `^${ENTITY}\\s+(\\|\\||\\|o|\\}o|\\}\\|)(--|\\.\\.)(\\|\\||o\\||o\\{|\\|\\{)\\s+${ENTITY}(?:\\s*:\\s*(.+))?$`,
);

function er(_header: Statement, body: ReadonlyArray<Statement>, blockId: CanvasBlockId) {
  const ids = new Ids("Entity");
  const entities = new Map<string, { label: string; attributes: Array<Record<string, unknown>> }>();
  const relationships: Array<Record<string, unknown>> = [];
  let open: string | undefined;
  const entity = (mermaidId: string, statement: Statement): string => {
    const id = ids.canvas(mermaidId, statement.line);
    if (!entities.has(id)) entities.set(id, { label: mermaidId, attributes: [] });
    return id;
  };
  for (const statement of body) {
    const text = statement.text;
    if (open !== undefined) {
      if (text === "}") {
        open = undefined;
        continue;
      }
      const attribute =
        /^([A-Za-z0-9_][A-Za-z0-9_()[\],-]*)\s+([A-Za-z0-9_][A-Za-z0-9_-]*)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?$/.exec(
          text,
        );
      const target = entities.get(open);
      if (attribute === null || target === undefined)
        throw unsupported(statement, "This attribute");
      // A Canvas attribute records only a primary key; a foreign or unique
      // key would be dropped, so the source stays code instead.
      const keys = attribute[3] ?? "";
      if (/FK|UK/.test(keys)) throw unsupported(statement, "A foreign or unique key marker");
      const name = attribute[2] ?? "";
      target.attributes.push({
        attributeId: `${name.replace(/_/g, "-")}`,
        name,
        type: attribute[1] ?? "",
        ...(keys.includes("PK") ? { key: true } : {}),
      });
      continue;
    }
    const opening = new RegExp(`^${ENTITY}\\s*\\{$`).exec(text);
    if (opening !== null) {
      open = entity(opening[1] ?? "", statement);
      continue;
    }
    const relationship = RELATIONSHIP.exec(text);
    if (relationship !== null) {
      const sourceCardinality = LEFT_CARDINALITY[relationship[2] ?? ""];
      const targetCardinality = RIGHT_CARDINALITY[relationship[4] ?? ""];
      if (sourceCardinality === undefined || targetCardinality === undefined) {
        throw unsupported(statement, "This cardinality");
      }
      const label = relationship[6]?.trim();
      relationships.push({
        relationshipId: `r${String(relationships.length + 1)}`,
        source: entity(relationship[1] ?? "", statement),
        target: entity(relationship[5] ?? "", statement),
        sourceCardinality,
        targetCardinality,
        ...(label === undefined || label.length === 0 ? {} : { label: unquote(label) }),
      });
      continue;
    }
    if (new RegExp(`^${ENTITY}$`).test(text)) {
      entity(text, statement);
      continue;
    }
    throw unsupported(statement);
  }
  if (open !== undefined)
    throw new Refusal("unsupported-construct", `Entity ${open} is never closed.`);
  if (entities.size === 0)
    throw new Refusal("empty", "The entity-relationship diagram names no entities.");
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "er",
    entities: [...entities].map(([entityId, entry]) => ({
      entityId,
      label: entry.label,
      attributes: entry.attributes,
    })),
    relationships,
  };
}

// ── mindmap ─────────────────────────────────────────────────────────────────

/** A topic: plain text, or `id[text]`, `id(text)`, `id((text))` with the shape dropped. */
const TOPIC = /^(?:[A-Za-z0-9_-]+)?(?:\(\((.+)\)\)|\[(.+)\]|\((.+)\))$/;

function mindmap(_header: Statement, body: ReadonlyArray<Statement>, blockId: CanvasBlockId) {
  const nodes: Array<Record<string, unknown>> = [];
  const stack: Array<{ readonly indent: number; readonly nodeId: string }> = [];
  for (const statement of body) {
    const text = statement.text;
    if (
      text.startsWith("::") ||
      text.includes(":::") ||
      text.includes("{{") ||
      text.startsWith(")")
    ) {
      throw unsupported(statement);
    }
    const shaped = TOPIC.exec(text);
    const label = unquote(shaped === null ? text : (shaped[1] ?? shaped[2] ?? shaped[3] ?? text));
    while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) >= statement.indent) stack.pop();
    const parent = stack.at(-1);
    if (parent === undefined && nodes.length > 0) {
      throw unsupported(statement, "A second root topic");
    }
    const nodeId = `t${String(nodes.length + 1)}`;
    nodes.push({ nodeId, label, ...(parent === undefined ? {} : { parentId: parent.nodeId }) });
    stack.push({ indent: statement.indent, nodeId });
  }
  if (nodes.length === 0) throw new Refusal("empty", "The mind map names no topics.");
  return { blockId, schemaVersion: CANVAS_SCHEMA_VERSION, kind: "mindmap", nodes };
}

import {
  CANVAS_MAX_DIAGRAM_EDGES,
  CANVAS_MAX_DIAGRAM_GROUP_DEPTH,
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
 * reader does not know — another shape or link, a `critical` or `break`
 * fragment, a fragment that holds no message — refuses the whole import with
 * the line that stopped it, so the caller keeps the source as a code block
 * rather than a picture that silently lost part of what it said.
 *
 * Where Mermaid says something the target block has no field for, the reader
 * keeps it in a field the block does have rather than extend the block: a
 * hexagon, subroutine, or parallelogram is a process whose detail names the
 * shape, a bidirectional link is one arrow each way, and a sequence fragment
 * (`loop`, `alt`, `opt`, `par`) is a note on its first message and another on
 * its last.
 *
 * Layout hints are the exception, and are read past: a direction, a link's
 * length or weight, and `autonumber` say how Mermaid would draw the diagram,
 * not what it holds, and Octant lays the block out itself. Styling is the
 * other exception, and is dropped: a directive, a `classDef`, `class`,
 * `style`, or `linkStyle` statement, a node's `:::class` suffix, and a
 * sequence's `rect` highlight say what colors Mermaid would use, and a Canvas
 * block takes the Canvas theme. A flowchart's `click` line is dropped with
 * them: a Canvas node runs nothing and opens nothing.
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

/**
 * The source as statements. A semicolon ends a statement in every diagram
 * type but the mind map, where a topic is its whole line: split there,
 * `Scope; risks` became two topics the author never wrote.
 */
/**
 * A `%%{init: …}%%` directive configures Mermaid's theme and may span lines.
 * Its line breaks stay so a refusal still names the author's line.
 */
function withoutDirectives(source: string): string {
  let result = "";
  let from = 0;
  for (;;) {
    const open = source.indexOf("%%{", from);
    const close = open === -1 ? -1 : source.indexOf("}%%", open + 3);
    // An unclosed directive is left alone: its line already reads as a comment.
    if (close === -1) return result + source.slice(from);
    result += source.slice(from, open) + source.slice(open, close).replace(/[^\n]/g, "");
    from = close + 3;
  }
}

function statements(source: string): ReadonlyArray<Statement> {
  const result: Statement[] = [];
  const lines = withoutDirectives(source)
    .split(/\r?\n/)
    .map((raw) => (raw.trimStart().startsWith("%%") ? "" : raw.replace(/\t/g, "  ")));
  const header = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  const wholeLines = /^mindmap(?:\s|$)/.test(header);
  lines.forEach((expanded, index) => {
    const indent = expanded.length - expanded.trimStart().length;
    for (const part of wholeLines ? [expanded] : expanded.split(";")) {
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

/** A label's text: its quotes dropped, and a `<br/>` read as the space it stands for. */
function unquote(value: string): string {
  const trimmed = value.trim();
  const bare =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  return bare
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `direction LR` and its kin: a layout hint, read past. */
const DIRECTION_HINT = /^direction\s+(?:TB|TD|BT|LR|RL)$/;

function unsupported(statement: Statement, what = "This statement"): Refusal {
  return new Refusal(
    "unsupported-construct",
    `${what} is outside the Mermaid subset Canvas imports: ${statement.text.slice(0, 80)}`,
    statement.line,
  );
}

/**
 * A styling statement in a flowchart or a state diagram, dropped. `class` is
 * styling only as `class <ids> <name>`; any other line that starts with the
 * word is refused like the unknown statement it is.
 */
const STYLING_STATEMENT =
  /^(?:(?:classDef|style|linkStyle)\s+\S.*|class\s+[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*\s+[A-Za-z0-9_-]+)$/;

/** A flowchart's `click` line binds a link or a script to a node, and is dropped. */
const CLICK_STATEMENT = /^click\s+\S.*$/;

/** The `:::class` suffix Mermaid allows after a node or a state, as regex source. */
const CLASS_SUFFIX = ":::[A-Za-z0-9_][A-Za-z0-9_-]*";

/** Statements no supported diagram type translates: interaction, titles, and malformed styling. */
const REFUSED_KEYWORDS =
  /^(?:(?:classDef|class|style|linkStyle|click|callback|direction|accTitle|accDescr|title)\b|%%\{)/;

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

/**
 * What a shape Canvas does not draw means in a flowchart. The node becomes a
 * process and carries the meaning as its detail line, so the distinction the
 * author drew is still on the picture.
 */
type FlowShapeDetail = "Preparation" | "Subroutine" | "Input or output" | undefined;

interface FlowNode {
  readonly nodeId: string;
  label: string;
  role: FlowRole;
  detail: FlowShapeDetail;
  /** A cylinder is a store: the plain box with the database glyph. */
  database: boolean;
}

interface FlowGroup {
  readonly groupId: string;
  readonly label: string;
  readonly nodeIds: string[];
  readonly parentGroupId?: string;
}

/**
 * A node reference with an optional shape: `id`, `id[Label]` (process),
 * `id(Label)` (the plain box), `id([Label])` and `id((Label))` (terminator: a
 * circle starts or ends a flow, and the pill is the shape Canvas draws for
 * that), `id[(Label)]` (a database), `id{Label}` (decision), and the three
 * shapes read as a process with a detail: `id{{Label}}` (hexagon),
 * `id[[Label]]` (subroutine), `id[/Label/]` and `id[\Label\]` (parallelogram).
 * Every other Mermaid shape is refused.
 */
const NODE_REF =
  /^([A-Za-z0-9_][A-Za-z0-9_-]*)(?:\(\[(.+?)\]\)|\(\((?!\()(.+?)\)\)|\[\((.+?)\)\]|\[(?![[(/\\])(.+?)\]|\((?![([])(.+?)\)|\{(?!\{)(.+?)\}|\{\{(.+?)\}\}|\[\[(.+?)\]\]|\[\/(.+?)\/\]|\[\\(.+?)\\\])?$/;

/**
 * A link between two nodes, with an optional label written either way Mermaid
 * allows (`A -->|yes| B` or `A -- yes --> B`). A thick arrow is an arrow, and
 * extra dashes, dots, or equals signs only ask Mermaid for a longer link. A
 * bidirectional link is an arrow each way. The reversed, circle, cross, and
 * arrowless thick or dashed links are matched only so they can be refused by
 * name rather than read as part of a node. Each form is listed on its own; the first that matches at a position
 * wins, so the labelled forms come before the bare arrows they contain.
 */
const LINK_FORMS: ReadonlyArray<string> = [
  String.raw`--\s+[^-|>\s][^|>]*?\s+(?:-{2,}>|-{3,})`, // A -- label --> B, A -- label --- B
  String.raw`==\s+[^=|>\s][^|>]*?\s+={2,}>`, // A == label ==> B
  String.raw`-\.\s+[^.>\s][^|>]*?\s+\.+->`, // A -. label .-> B
  String.raw`-\.+->`, // dashed arrow
  String.raw`-{2,}>`, // arrow
  String.raw`={2,}>`, // thick arrow
  String.raw`-{3,}`, // line
  String.raw`={3,}`, // thick without an arrow, refused
  String.raw`<-{2,}>`, // bidirectional
  String.raw`<--`, // reversed, refused
  String.raw`-\.-`, // dashed without an arrow, refused
  String.raw`--[ox](?=\s)`, // circle or cross end, refused
  // Only where it starts a link: the last letter of `todo` before an arrow
  // is part of the id, not a circle.
  String.raw`(?<![A-Za-z0-9_-])[ox]--`, // circle or cross start, refused
];
const LINK = new RegExp(String.raw`(${LINK_FORMS.join("|")})(\|[^|]*\|)?`);

/**
 * The nodes one side of a link names: `a & b` is two. An ampersand inside a
 * shape or a quoted label is part of the label, as in `rd[Research & Development]`.
 */
function ampersandList(text: string): ReadonlyArray<string> {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (character === '"') quoted = !quoted;
    else if (quoted) continue;
    else if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (character === "&" && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function flowchart(header: Statement, body: ReadonlyArray<Statement>, blockId: CanvasBlockId) {
  const direction = header.text.split(/\s+/)[1] ?? "TD";
  // Canvas lays a diagram out downward or rightward. A bottom-up or
  // right-to-left flowchart is the same graph, and its arrows still say which
  // way it reads.
  let flow: "down" | "right";
  if (direction === "TD" || direction === "TB" || direction === "BT") flow = "down";
  else if (direction === "LR" || direction === "RL") flow = "right";
  else throw unsupported(header, `The direction ${direction}`);
  const ids = new Ids("Node");
  const nodes = new Map<string, FlowNode>();
  const edges: Array<Record<string, unknown>> = [];
  const groups: FlowGroup[] = [];
  const openGroups: FlowGroup[] = [];
  const groupIds = new Ids("Subgraph");

  const reference = (text: string, statement: Statement): string => {
    // Only a suffix is a class: three colons inside a shape's label end in
    // the shape's closing bracket, not in a class name, and stay the label.
    const match = NODE_REF.exec(text.trim().replace(new RegExp(`${CLASS_SUFFIX}$`), ""));
    if (match === null) throw unsupported(statement, `The node "${text.trim().slice(0, 40)}"`);
    const nodeId = ids.canvas(match[1] ?? "", statement.line);
    const [terminator, circle, cylinder, process, plain, decision, hexagon, subroutine] =
      match.slice(2, 10);
    const parallelogram = match[10] ?? match[11];
    const detail: FlowShapeDetail =
      hexagon !== undefined
        ? "Preparation"
        : subroutine !== undefined
          ? "Subroutine"
          : parallelogram !== undefined
            ? "Input or output"
            : undefined;
    const label =
      terminator ??
      circle ??
      cylinder ??
      process ??
      plain ??
      decision ??
      hexagon ??
      subroutine ??
      parallelogram;
    const role: FlowRole =
      terminator !== undefined || circle !== undefined
        ? "terminator"
        : process !== undefined || detail !== undefined
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
        detail,
        database: cylinder !== undefined,
      });
    } else if (label !== undefined) {
      existing.label = unquote(label);
      existing.role = role;
      existing.detail = detail;
      existing.database = cylinder !== undefined;
    }
    // A node sits in the innermost subgraph that names it. Mermaid lets an
    // unrelated subgraph claim a node another one drew, which the Canvas
    // refuses rather than guesses; naming it again in an enclosing subgraph
    // moves nothing.
    const openGroup = openGroups.at(-1);
    const home = groups.find((group) => group.nodeIds.includes(nodeId));
    if (openGroup !== undefined && home === undefined) openGroup.nodeIds.push(nodeId);
    else if (openGroup !== undefined && home !== undefined && !openGroups.includes(home)) {
      throw new Refusal(
        "unsupported-construct",
        `Node ${nodeId} is in more than one subgraph.`,
        statement.line,
      );
    }
    return nodeId;
  };

  for (const statement of body) {
    const text = statement.text;
    if (DIRECTION_HINT.test(text) || STYLING_STATEMENT.test(text)) continue;
    if (CLICK_STATEMENT.test(text)) continue;
    if (REFUSED_KEYWORDS.test(text)) throw unsupported(statement);
    const subgraph = /^subgraph\s+(.+)$/.exec(text);
    if (subgraph !== null) {
      if (openGroups.length >= CANVAS_MAX_DIAGRAM_GROUP_DEPTH) {
        throw unsupported(
          statement,
          `A subgraph nested more than ${String(CANVAS_MAX_DIAGRAM_GROUP_DEPTH)} deep`,
        );
      }
      const spec = (subgraph[1] ?? "").trim();
      const named = /^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*\[(.+)\]$/.exec(spec);
      const title = unquote(named?.[2] ?? spec);
      const parent = openGroups.at(-1);
      const group: FlowGroup = {
        groupId: groupIds.canvas(named?.[1] ?? title.replace(/\s+/g, "-"), statement.line),
        label: title,
        nodeIds: [],
        ...(parent === undefined ? {} : { parentGroupId: parent.groupId }),
      };
      groups.push(group);
      openGroups.push(group);
      continue;
    }
    if (text === "end") {
      if (openGroups.pop() === undefined) throw unsupported(statement, "An end without a subgraph");
      continue;
    }
    // A chain: nodes (link nodes)*, where nodes is one node or an `&` list.
    let rest = text;
    let from: ReadonlyArray<string> | undefined;
    let pending: ReturnType<typeof readLink> | undefined;
    for (;;) {
      const link = LINK.exec(rest);
      const nodeText = link === null ? rest : rest.slice(0, link.index);
      const to = ampersandList(nodeText).map((part) => reference(part, statement));
      if (from !== undefined && pending !== undefined) {
        // Refused before the pairs exist: two long `&` lists multiply, and a
        // source inside the size bound could otherwise build millions of
        // edges only for the block catalog to refuse them.
        const perPair = pending.bothWays ? 2 : 1;
        if (edges.length + from.length * to.length * perPair > CANVAS_MAX_DIAGRAM_EDGES)
          throw unsupported(statement, "More links than a diagram holds");
        for (const source of from) {
          for (const target of to) {
            edges.push({
              edgeId: `e${String(edges.length + 1)}`,
              source,
              target,
              style: pending.style,
              ...(pending.label === undefined ? {} : { label: pending.label }),
            });
            // A Canvas edge has one arrowhead, so a link that points both ways
            // is the pair of arrows it stands for. The label says what the
            // link is once, on the arrow the author wrote first.
            if (pending.bothWays) {
              edges.push({
                edgeId: `e${String(edges.length + 1)}`,
                source: target,
                target: source,
                style: pending.style,
              });
            }
          }
        }
      }
      from = to;
      if (link === null) break;
      pending = readLink(link[1] ?? "", link[2], statement);
      rest = rest.slice(link.index + link[0].length);
    }
  }
  const unclosed = openGroups.at(-1);
  if (unclosed !== undefined) {
    throw new Refusal("unsupported-construct", `Subgraph ${unclosed.label} is never closed.`);
  }
  if (nodes.size === 0) throw new Refusal("empty", "The flowchart names no nodes.");
  // A subgraph that draws nothing is dropped, unless one it holds draws something.
  const drawn = new Set<string>();
  for (const group of groups.toReversed()) {
    if (group.nodeIds.length === 0 && !drawn.has(group.groupId)) continue;
    drawn.add(group.groupId);
    if (group.parentGroupId !== undefined) drawn.add(group.parentGroupId);
  }
  const kept = groups.filter((group) => drawn.has(group.groupId));
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "diagram",
    flow,
    nodes: [...nodes.values()].map((node) => ({
      nodeId: node.nodeId,
      label: node.label,
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.detail === undefined ? {} : { detail: node.detail }),
      ...(node.database ? { icon: "database" } : {}),
    })),
    edges,
    ...(kept.length === 0 ? {} : { groups: kept }),
  };
}

function readLink(
  operator: string,
  piped: string | undefined,
  statement: Statement,
): {
  readonly style: "line" | "arrow" | "dashed";
  readonly label?: string;
  readonly bothWays: boolean;
} {
  const bothWays = /^<-{2,}>$/.test(operator);
  const named = /^(?:--\s+(.+?)\s+(?:-{2,}>|-{3,})|==\s+(.+?)\s+={2,}>)$/.exec(operator);
  const dotted = /^-\.\s+(.+?)\s+\.+->$/.exec(operator);
  const style =
    dotted !== null || /^-\.+->$/.test(operator)
      ? "dashed"
      : (named !== null && operator.endsWith(">")) ||
          bothWays ||
          /^(?:-{2,}|={2,})>$/.test(operator)
        ? "arrow"
        : named !== null || /^-{3,}$/.test(operator)
          ? "line"
          : undefined;
  if (style === undefined) throw unsupported(statement, `The link ${operator}`);
  const inline = named?.[1] ?? named?.[2] ?? dotted?.[1];
  const label = (piped === undefined ? inline : piped.slice(1, -1))?.trim();
  return {
    style,
    bothWays,
    ...(label === undefined || label.length === 0 ? {} : { label: unquote(label) }),
  };
}

// ── sequenceDiagram ─────────────────────────────────────────────────────────

// A participant id is word characters: a hyphen would run into the arrow.
// A message has no line style in Canvas, so a lost (`-x`) or async (`-)`)
// arrow reads as the message it is. `+` or `-` before the receiver opens the
// receiver's activation or closes the sender's.
const MESSAGE = /^(\w+)\s*(?:-->>|->>|--x|-x|--\)|-\)|-->|->)\s*([+-]?)\s*(\w+)\s*:\s*(.+)$/;
const NOTE = /^Note\s+(left of|right of|over)\s+(\w+)\s*:\s*(.+)$/i;
// A Canvas note sits beside one participant or beside none, and no renderer
// draws it across lifelines. A note over two participants keeps its text and
// its place in the order, and names neither as its own.
const SPANNING_NOTE = /^Note\s+over\s+(\w+)\s*,\s*(\w+)\s*:\s*(.+)$/i;

/** A fragment keyword and the label after it, and the keywords that divide one. */
const FRAGMENT = /^(loop|alt|opt|par)(?:\s+(.+))?$/;
const FRAGMENT_PART = /^(else|and)(?:\s+(.+))?$/;
/** A `rect` is a background color behind some messages: styling, dropped. */
const RECT = /^rect\s+\S.*$/;
/**
 * A `box` around participants, with the color Mermaid lets it lead with. Only
 * a functional color or `transparent` is read as one: a named color cannot be
 * told from the first word of a title without the CSS color list, and a color
 * name left in a title loses nothing.
 */
const BOX = /^box(?:\s+(?:(?:rgba?|hsla?)\([^)]*\)|transparent(?=\s|$)))?(?:\s+(.+))?$/;

type SequenceFragmentKind = "loop" | "alt" | "opt" | "par";

interface SequenceFragment {
  /** `rect` holds messages like a fragment, and says nothing about them. */
  readonly kind: SequenceFragmentKind | "rect";
  /** How many messages existed when the current part opened. */
  partStart: number;
}

function isSequenceFragmentKind(word: string | undefined): word is SequenceFragmentKind {
  return word === "loop" || word === "alt" || word === "opt" || word === "par";
}

interface SequenceNote {
  text: string;
  /**
   * Whom each note the author wrote here sits beside, `undefined` for a note
   * over two participants. A fragment marker adds none.
   */
  readonly beside: Array<string | undefined>;
  readonly afterMessageId?: unknown;
}

function sequence(_header: Statement, body: ReadonlyArray<Statement>, blockId: CanvasBlockId) {
  const ids = new Ids("Participant");
  const participants = new Map<string, string>();
  const messages: Array<Record<string, unknown>> = [];
  const notes: SequenceNote[] = [];
  const boxes: Array<{ readonly title: string; readonly participantIds: string[] }> = [];
  let openBox: (typeof boxes)[number] | undefined;
  const activations: Array<Record<string, unknown>> = [];
  // A lifeline may be activated again while it is active; each `deactivate`
  // closes the innermost, as Mermaid's stacked bars do.
  const opened = new Map<string, number[]>();
  const fragments: SequenceFragment[] = [];
  // Fragment openings wait for the first message they hold, so the note sits
  // on that message's row rather than beside the message before the fragment.
  let opening: string[] = [];
  const participant = (mermaidId: string, statement: Statement, label?: string): string => {
    const id = ids.canvas(mermaidId, statement.line);
    if (!participants.has(id) || label !== undefined) participants.set(id, label ?? mermaidId);
    return id;
  };
  const activate = (id: string, startIndex: number): void => {
    opened.set(id, [...(opened.get(id) ?? []), startIndex]);
  };
  const deactivate = (id: string, statement: Statement): void => {
    const start = opened.get(id)?.pop();
    const startMessage = start === undefined ? undefined : messages[start];
    const endMessage = messages.at(-1);
    if (startMessage === undefined || endMessage === undefined) {
      throw unsupported(statement, "An activation that spans no message");
    }
    activations.push({
      activationId: `a${String(activations.length + 1)}`,
      participantId: id,
      startMessageId: startMessage["messageId"],
      endMessageId: endMessage["messageId"],
    });
  };
  /**
   * A note on the last message: one the author wrote, or a fragment boundary.
   * The layout draws every note of a message on that message's row, so a
   * second note there would cover the first (a closing `end loop` hid the
   * note the loop held). Everything said on one message is therefore one
   * note, in source order, joined by `; `, which no statement can contain
   * because a semicolon ends one. Notes before the first message have no row
   * to share and stay apart.
   */
  const annotate = (text: string, beside?: { readonly participantId?: string }): void => {
    const afterMessageId = messages.at(-1)?.["messageId"];
    const onRow = afterMessageId === undefined ? undefined : notes.at(-1);
    const note =
      onRow !== undefined && onRow.afterMessageId === afterMessageId
        ? onRow
        : { text: "", beside: [], ...(afterMessageId === undefined ? {} : { afterMessageId }) };
    if (note !== onRow) notes.push(note);
    note.text = note.text.length === 0 ? text : `${note.text}; ${text}`;
    if (beside !== undefined) note.beside.push(beside.participantId);
  };
  /** A part of a fragment that holds no message has no row to be marked on. */
  const closePart = (fragment: SequenceFragment, statement: Statement): void => {
    if (fragment.kind !== "rect" && fragment.partStart === messages.length) {
      throw unsupported(statement, `A part of ${fragment.kind} that holds no message`);
    }
    fragment.partStart = messages.length;
  };
  for (const statement of body) {
    const text = statement.text;
    if (text === "autonumber") continue;
    const declared = /^(participant|actor)\s+(\w+)(?:\s+as\s+(.+))?$/.exec(text);
    if (declared !== null) {
      const id = participant(
        declared[2] ?? "",
        statement,
        declared[3] === undefined ? undefined : unquote(declared[3]),
      );
      if (openBox !== undefined && !openBox.participantIds.includes(id)) {
        openBox.participantIds.push(id);
      }
      continue;
    }
    if (openBox !== undefined) {
      if (text !== "end") throw unsupported(statement, "A box that holds more than participants");
      openBox = undefined;
      continue;
    }
    const message = MESSAGE.exec(text);
    if (message !== null) {
      const from = participant(message[1] ?? "", statement);
      const to = participant(message[3] ?? "", statement);
      const messageId = `m${String(messages.length + 1)}`;
      messages.push({ messageId, from, to, label: unquote(message[4] ?? "") });
      if (opening.length > 0) {
        annotate(opening.join("; "));
        opening = [];
      }
      if (message[2] === "+") activate(to, messages.length - 1);
      if (message[2] === "-") deactivate(from, statement);
      continue;
    }
    const spanning = SPANNING_NOTE.exec(text);
    const note = spanning === null ? NOTE.exec(text) : null;
    if (spanning !== null || note !== null) {
      if (spanning !== null) {
        participant(spanning[1] ?? "", statement);
        participant(spanning[2] ?? "", statement);
      }
      annotate(
        unquote(spanning?.[3] ?? note?.[3] ?? ""),
        note === null ? {} : { participantId: participant(note[2] ?? "", statement) },
      );
      continue;
    }
    const toggle = /^(activate|deactivate)\s+(\w+)$/.exec(text);
    if (toggle !== null) {
      const id = participant(toggle[2] ?? "", statement);
      if (toggle[1] === "activate") activate(id, messages.length);
      else deactivate(id, statement);
      continue;
    }
    const fragment = FRAGMENT.exec(text);
    const kind = fragment?.[1];
    if (fragment !== null && isSequenceFragmentKind(kind)) {
      fragments.push({ kind, partStart: messages.length });
      opening.push(fragment[2] === undefined ? kind : `${kind}: ${unquote(fragment[2])}`);
      continue;
    }
    const part = FRAGMENT_PART.exec(text);
    if (part !== null) {
      const word = part[1] ?? "";
      const within = fragments.at(-1);
      if (within === undefined || within.kind !== (word === "else" ? "alt" : "par")) {
        throw unsupported(statement, `An ${word} outside its block`);
      }
      closePart(within, statement);
      opening.push(part[2] === undefined ? word : `${word}: ${unquote(part[2])}`);
      continue;
    }
    if (RECT.test(text)) {
      fragments.push({ kind: "rect", partStart: messages.length });
      continue;
    }
    if (text === "end") {
      const closed = fragments.pop();
      if (closed === undefined) throw unsupported(statement, "An end without a block");
      closePart(closed, statement);
      if (closed.kind !== "rect") annotate(`end ${closed.kind}`);
      continue;
    }
    const box = BOX.exec(text);
    if (box !== null) {
      // A box groups lifelines, not messages: Mermaid has none inside a fragment.
      if (fragments.length > 0) throw unsupported(statement, "A box inside another block");
      openBox = { title: box[1] === undefined ? "Group" : unquote(box[1]), participantIds: [] };
      boxes.push(openBox);
      continue;
    }
    throw unsupported(statement);
  }
  if ([...opened.values()].some((starts) => starts.length > 0)) {
    throw new Refusal("unsupported-construct", "An activation is never closed.");
  }
  const unclosed = fragments.at(-1);
  if (unclosed !== undefined || openBox !== undefined) {
    throw new Refusal("unsupported-construct", `A ${unclosed?.kind ?? "box"} is never closed.`);
  }
  if (participants.size === 0) throw new Refusal("empty", "The sequence names no participants.");
  // A sequence block has no participant groups. A box becomes a note beside no
  // message, which the layout stacks above the first: its title and the labels
  // of the participants it held, read once every alias is known.
  const boxNotes: ReadonlyArray<SequenceNote> = boxes
    .filter((box) => box.participantIds.length > 0)
    .map((box) => ({
      text: `${box.title}: ${box.participantIds.map((id) => participants.get(id) ?? id).join(", ")}`,
      beside: [],
    }));
  const allNotes = [...boxNotes, ...notes].map((note, index) => {
    // A joined note sits beside a participant only when every note the author
    // wrote there names that one; otherwise it would claim a note it is not for.
    const [participantId, ...others] = note.beside;
    const agreed = others.every((other) => other === participantId);
    return {
      noteId: `n${String(index + 1)}`,
      text: note.text,
      ...(participantId === undefined || !agreed ? {} : { participantId }),
      ...(note.afterMessageId === undefined ? {} : { afterMessageId: note.afterMessageId }),
    };
  });
  return {
    blockId,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "sequence",
    participants: [...participants].map(([participantId, label]) => ({ participantId, label })),
    messages,
    ...(activations.length === 0 ? {} : { activations }),
    ...(allNotes.length === 0 ? {} : { notes: allNotes }),
  };
}

// ── stateDiagram ────────────────────────────────────────────────────────────

const STATE_REF = "(\\[\\*\\]|[A-Za-z0-9_][A-Za-z0-9_-]*)";
const TRANSITION = new RegExp(
  `^${STATE_REF}(?:${CLASS_SUFFIX})?\\s*-->\\s*${STATE_REF}(?:${CLASS_SUFFIX})?(?:\\s*:\\s*(.+))?$`,
);
/** A state named on its own line, with the class it may carry. */
const BARE_STATE = new RegExp(`^([A-Za-z0-9_][A-Za-z0-9_-]*)(?:${CLASS_SUFFIX})?$`);

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
    if (DIRECTION_HINT.test(text) || STYLING_STATEMENT.test(text)) continue;
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
    const bare = BARE_STATE.exec(text);
    if (bare !== null) {
      declare(bare[1] ?? "", statement);
      continue;
    }
    const described = /^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(text);
    if (described !== null) {
      declare(described[1] ?? "", statement, unquote(described[2] ?? ""));
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
      // An `er` relationship has no field for a non-identifying (dotted)
      // link, so drawing one would turn it into an identifying link.
      if (relationship[3] === "..") {
        throw unsupported(statement, "A non-identifying relationship (..)");
      }
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

/** The characters Mermaid reads as the start or the end of a topic's shape. */
const SHAPE_DELIMITER = /[()[\]{}]/;
/** A shape's text: a quoted string, or text that holds no shape delimiter. */
const SHAPE_TEXT = String.raw`("[^"]*"|[^()[\]{}]+)`;
/**
 * A shaped topic, `id[text]`, `id(text)`, or `id((text))`, with the shape
 * dropped. As in Mermaid, the id is everything before the shape opens.
 */
const TOPIC = new RegExp(
  String.raw`^[^()[\]{}]*(?:\(\(${SHAPE_TEXT}\)\)|\[${SHAPE_TEXT}\]|\(${SHAPE_TEXT}\))$`,
);

function mindmap(_header: Statement, body: ReadonlyArray<Statement>, blockId: CanvasBlockId) {
  const nodes: Array<Record<string, unknown>> = [];
  const stack: Array<{ readonly indent: number; readonly nodeId: string }> = [];
  for (const statement of body) {
    const text = statement.text;
    if (text.startsWith("::") || text.includes(":::")) throw unsupported(statement);
    const shaped = TOPIC.exec(text);
    // A delimiter outside a shape this reads is a cloud, a bang, a hexagon, or
    // text after a shape. Its markup is never kept as the topic's label.
    if (shaped === null && SHAPE_DELIMITER.test(text)) throw unsupported(statement);
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

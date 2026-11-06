import {
  type BrowserAccessibilityAction,
  BROWSER_ACCESSIBILITY_ROLES,
  MAX_BROWSER_ACCESSIBILITY_CHILDREN,
  MAX_BROWSER_ACCESSIBILITY_DEPTH,
  MAX_BROWSER_ACCESSIBILITY_NODES,
  MAX_BROWSER_ACCESSIBILITY_TEXT,
  MAX_BROWSER_ACCESSIBILITY_VALUE,
  MAX_HUMAN_FRAME_HEIGHT,
  MAX_HUMAN_FRAME_WIDTH,
  type BrowserAccessibilityNode,
  type BrowserAccessibilityRole,
  type BrowserAccessibilityUpdate,
} from "@octant/contracts/browser-presentation";
import {
  autoAttachSurfaceFrames,
  findFrame,
  type ProtocolFrameTree,
  type SurfaceFrameTargets,
  type SurfaceProtocolSend,
} from "./browserSurfaceFrames";

/**
 * The accessibility mirror of Stable's hidden Browser window.
 *
 * Nightly shows the page as pixels, so a screen reader there finds nothing to
 * read. Stable reads the page's accessibility tree through its own protocol
 * attachment, frame by frame, and reduces it to a bounded description: roles,
 * names, values, states, page-coordinate bounds and the tree's order. Page
 * addresses stay here, and a password field's value never leaves.
 */

/** The part of a protocol accessibility node the mirror reads. */
export interface ProtocolAccessibilityNode {
  readonly nodeId?: unknown;
  readonly ignored?: unknown;
  readonly role?: { readonly value?: unknown };
  readonly name?: { readonly value?: unknown };
  readonly description?: { readonly value?: unknown };
  readonly value?: { readonly value?: unknown };
  readonly properties?: ReadonlyArray<{
    readonly name?: unknown;
    readonly value?: { readonly value?: unknown };
  }>;
  readonly childIds?: ReadonlyArray<unknown>;
  readonly parentId?: unknown;
  readonly backendDOMNodeId?: unknown;
}

export interface AccessibilityRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One document's tree, with the frames nested in it grafted at their frame elements. */
export interface AccessibilityFrameTree {
  /** Distinguishes documents in node identities; the top document is 0. */
  readonly ordinal: number;
  readonly nodes: ReadonlyArray<ProtocolAccessibilityNode>;
  /** Password fields, by their page node; their values never travel. */
  readonly secure: ReadonlySet<number>;
  /** Each node's border box in the top page's coordinates. */
  readonly bounds: ReadonlyMap<number, AccessibilityRect>;
  /** The documents of frame elements, by the frame element's page node. */
  readonly frames: ReadonlyMap<number, AccessibilityFrameTree>;
}

/** Where a mirrored node lives, kept in Stable for the mirror's actions. */
export interface AccessibilityAddress {
  readonly ordinal: number;
  readonly backendNodeId: number;
  readonly role: BrowserAccessibilityRole;
  readonly secure: boolean;
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly readonly: boolean;
}

export interface AccessibilityTree {
  readonly rootId: string;
  readonly focusedId: string | undefined;
  readonly truncated: boolean;
  readonly nodes: ReadonlyArray<BrowserAccessibilityNode>;
  readonly addresses: ReadonlyMap<string, AccessibilityAddress>;
}

const ROLES = new Set<string>(BROWSER_ACCESSIBILITY_ROLES);
/** Chromium's own role names that differ from their ARIA counterparts. */
const CHROMIUM_ROLES: Readonly<Record<string, BrowserAccessibilityRole>> = {
  RootWebArea: "document",
  WebArea: "document",
  StaticText: "text",
  Iframe: "group",
  IframePresentational: "group",
  LabelText: "generic",
  Section: "region",
  Paragraph: "paragraph",
  Pre: "generic",
  Code: "generic",
  DescriptionList: "list",
  DescriptionListTerm: "listitem",
  DescriptionListDetail: "listitem",
  ListMarker: "text",
  MenuListPopup: "listbox",
  MenuListOption: "option",
  PopUpButton: "combobox",
  SearchBox: "searchbox",
  Canvas: "img",
  Image: "img",
  image: "img",
  Figcaption: "generic",
  Legend: "generic",
  Abbr: "generic",
  Mark: "generic",
  Time: "generic",
  Strong: "generic",
  Emphasis: "generic",
  Subscript: "generic",
  Superscript: "generic",
  Insertion: "generic",
  Deletion: "generic",
  Blockquote: "group",
  ScrollBar: "generic",
  presentation: "generic",
  none: "generic",
  LayoutTable: "generic",
  LayoutTableRow: "generic",
  LayoutTableCell: "generic",
  feed: "list",
  definition: "generic",
  term: "generic",
  toolbar: "group",
  radiogroup: "group",
  directory: "list",
  note: "group",
  math: "img",
  marquee: "status",
  timer: "status",
  tooltip: "status",
  treegrid: "grid",
  application: "group",
  comment: "group",
};
/** Roles that never travel: line boxes and breaks are layout, not content. */
const DROPPED = new Set(["InlineTextBox", "LineBreak"]);
/** Roles named by their own content, whose descendants add nothing a reader needs. */
const LEAVES = new Set<BrowserAccessibilityRole>([
  "button",
  "checkbox",
  "combobox",
  "heading",
  "img",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "progressbar",
  "radio",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "text",
  "textbox",
]);
const VALUED = new Set<BrowserAccessibilityRole>([
  "combobox",
  "searchbox",
  "spinbutton",
  "slider",
  "progressbar",
  "textbox",
]);
const RANGED = new Set<BrowserAccessibilityRole>(["progressbar", "slider", "spinbutton"]);
/** Chromium shows a password field's characters as these when it shows any. */
const MASKED = /^[•●∙*]+$/u;

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed === "") return undefined;
  if (collapsed.length <= maximum) return collapsed.toWellFormed();
  // Never split a surrogate pair at the bound.
  const end = /[\uD800-\uDBFF]/u.test(collapsed[maximum - 1] ?? "") ? maximum - 1 : maximum;
  return collapsed.slice(0, end).toWellFormed();
}

function roleOf(raw: unknown): BrowserAccessibilityRole | "dropped" {
  if (typeof raw !== "string" || DROPPED.has(raw)) return "dropped";
  const mapped = CHROMIUM_ROLES[raw];
  if (mapped !== undefined) return mapped;
  return ROLES.has(raw) ? (raw as BrowserAccessibilityRole) : "generic";
}

function property(node: ProtocolAccessibilityNode, name: string): unknown {
  return node.properties?.find((entry) => entry.name === name)?.value?.value;
}

function tristate(value: unknown): "true" | "false" | "mixed" | undefined {
  if (value === true || value === "true") return "true";
  if (value === false || value === "false") return "false";
  return value === "mixed" ? "mixed" : undefined;
}

function finite(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 1e9
    ? number
    : undefined;
}

/** Bounds within the presentation's page-rectangle range, or none for content far off screen. */
function pageBounds(rect: AccessibilityRect | undefined): AccessibilityRect | undefined {
  if (rect === undefined) return undefined;
  const { x, y, width, height } = rect;
  return [x, y, width, height].every(Number.isFinite) &&
    Math.abs(x) <= MAX_HUMAN_FRAME_WIDTH &&
    Math.abs(y) <= MAX_HUMAN_FRAME_HEIGHT &&
    width >= 0 &&
    height >= 0 &&
    width <= MAX_HUMAN_FRAME_WIDTH * 2 &&
    height <= MAX_HUMAN_FRAME_HEIGHT * 2
    ? rect
    : undefined;
}

export function browserAccessibilityNodeId(ordinal: number, backendNodeId: number): string {
  return `${ordinal.toString(36)}-${String(backendNodeId)}`;
}

/**
 * Reduce the page's documents to the mirror's bounded tree. Ignored and
 * unnamed generic nodes give their children to their parent; a frame element
 * holds its document; descendants of a self-named control are dropped.
 * Past the node, depth or child bound the tree is cut and marked truncated.
 */
export function reduceBrowserAccessibility(top: AccessibilityFrameTree): AccessibilityTree {
  const nodes: BrowserAccessibilityNode[] = [];
  const addresses = new Map<string, AccessibilityAddress>();
  let truncated = false;
  let focusedId: string | undefined;

  const visit = (
    frame: AccessibilityFrameTree,
    byId: ReadonlyMap<string, ProtocolAccessibilityNode>,
    raw: ProtocolAccessibilityNode,
    depth: number,
    seen: Set<string>,
    frameDepth: number,
  ): string[] => {
    const axId = typeof raw.nodeId === "string" ? raw.nodeId : undefined;
    if (axId === undefined || seen.has(axId)) return [];
    seen.add(axId);
    const childrenOf = (nextDepth: number): string[] => {
      const out: string[] = [];
      for (const child of raw.childIds ?? []) {
        // A child past the bound would spend the node budget on what cannot travel.
        if (out.length >= MAX_BROWSER_ACCESSIBILITY_CHILDREN) {
          truncated = true;
          break;
        }
        const next = typeof child === "string" ? byId.get(child) : undefined;
        if (next !== undefined) out.push(...visit(frame, byId, next, nextDepth, seen, frameDepth));
      }
      return out;
    };
    const role = roleOf(raw.role?.value);
    if (role === "dropped") return [];
    const backend = raw.backendDOMNodeId;
    const name = text(raw.name?.value, MAX_BROWSER_ACCESSIBILITY_TEXT);
    const ignored = raw.ignored === true;
    const nested =
      typeof backend === "number" && frame.frames.has(backend)
        ? frame.frames.get(backend)
        : undefined;
    if (
      !nested &&
      (ignored ||
        typeof backend !== "number" ||
        (role === "generic" && name === undefined && property(raw, "focusable") !== true) ||
        (role === "text" && name === undefined))
    )
      return role === "text" ? [] : childrenOf(depth);
    if (typeof backend !== "number") return childrenOf(depth);
    if (
      nodes.length >= MAX_BROWSER_ACCESSIBILITY_NODES ||
      depth >= MAX_BROWSER_ACCESSIBILITY_DEPTH
    ) {
      truncated = true;
      return [];
    }
    const id = browserAccessibilityNodeId(frame.ordinal, backend);
    if (addresses.has(id)) return [];
    const valueText = raw.value?.value;
    const masked = typeof valueText === "string" && MASKED.test(valueText);
    const secure = frame.secure.has(backend) || (role === "textbox" && masked);
    const disabled = property(raw, "disabled") === true;
    const editable = typeof property(raw, "editable") === "string";
    const node: { -readonly [K in keyof BrowserAccessibilityNode]: BrowserAccessibilityNode[K] } = {
      id,
      role,
      children: [],
    };
    if (name !== undefined) node.name = name;
    const description = text(raw.description?.value, MAX_BROWSER_ACCESSIBILITY_TEXT);
    if (description !== undefined && description !== name) node.description = description;
    if (secure) node.secure = true;
    else if (VALUED.has(role) && !RANGED.has(role)) {
      const value = text(valueText, MAX_BROWSER_ACCESSIBILITY_VALUE);
      if (value !== undefined) node.value = value;
    }
    if (RANGED.has(role)) {
      const now = finite(valueText);
      const min = finite(property(raw, "valuemin"));
      const max = finite(property(raw, "valuemax"));
      const spoken = text(property(raw, "valuetext"), MAX_BROWSER_ACCESSIBILITY_VALUE);
      if (now !== undefined) node.valueNow = now;
      if (min !== undefined) node.valueMin = min;
      if (max !== undefined) node.valueMax = max;
      if (spoken !== undefined) node.value = spoken;
    }
    const level = finite(property(raw, "level"));
    if (level !== undefined && Number.isInteger(level) && level >= 1 && level <= 9)
      node.level = level;
    const checked = tristate(property(raw, "checked"));
    if (checked !== undefined) node.checked = checked;
    const pressed = tristate(property(raw, "pressed"));
    if (pressed !== undefined) node.pressed = pressed;
    const expanded = property(raw, "expanded");
    if (typeof expanded === "boolean") node.expanded = expanded;
    const selected = property(raw, "selected");
    if (typeof selected === "boolean") node.selected = selected;
    if (disabled) node.disabled = true;
    if (property(raw, "focusable") === true) node.focusable = true;
    if (property(raw, "required") === true) node.required = true;
    const invalid = property(raw, "invalid");
    if (invalid !== undefined && invalid !== false && invalid !== "false") node.invalid = true;
    if (property(raw, "readonly") === true) node.readonly = true;
    if (property(raw, "multiline") === true) node.multiline = true;
    const live = property(raw, "live");
    if (live === "polite" || live === "assertive") node.live = live;
    const bounds = pageBounds(frame.bounds.get(backend));
    if (bounds !== undefined) node.bounds = bounds;
    if (property(raw, "focused") === true) focusedId = id;
    nodes.push(node);
    addresses.set(id, {
      ordinal: frame.ordinal,
      backendNodeId: backend,
      role,
      secure,
      disabled,
      editable,
      readonly: node.readonly === true,
    });
    let children: string[];
    if (nested !== undefined)
      children = frameDepth < 8 ? graft(nested, depth + 1, frameDepth + 1) : [];
    else children = LEAVES.has(role) ? [] : childrenOf(depth + 1);
    if (children.length > MAX_BROWSER_ACCESSIBILITY_CHILDREN) {
      truncated = true;
      children = children.slice(0, MAX_BROWSER_ACCESSIBILITY_CHILDREN);
    }
    node.children = children;
    return [id];
  };

  const graft = (frame: AccessibilityFrameTree, depth: number, frameDepth: number): string[] => {
    const byId = new Map<string, ProtocolAccessibilityNode>();
    for (const raw of frame.nodes) if (typeof raw.nodeId === "string") byId.set(raw.nodeId, raw);
    const root = frame.nodes.find((raw) => raw.parentId === undefined) ?? frame.nodes[0];
    return root === undefined ? [] : visit(frame, byId, root, depth, new Set(), frameDepth);
  };

  const rootIds = graft(top, 0, 0);
  // A page whose root the tree omits still gets one document to hold its content.
  let rootId = rootIds.length === 1 ? rootIds[0] : undefined;
  if (rootId === undefined || nodes[0]?.id !== rootId) {
    rootId = browserAccessibilityNodeId(top.ordinal, 0);
    if (nodes.length >= MAX_BROWSER_ACCESSIBILITY_NODES) {
      const dropped = nodes.pop();
      if (dropped !== undefined) addresses.delete(dropped.id);
      truncated = true;
    }
    nodes.unshift({
      id: rootId,
      role: "document",
      children: rootIds.filter((id) => addresses.has(id)),
    });
  }
  // Truncation may cut a node after its parent listed it, or a parent's list
  // after its nodes were made; keep only what the root reaches.
  const listed = new Set(nodes.map((node) => node.id));
  const byId = new Map(
    nodes.map((node) => [
      node.id,
      node.children.every((child) => listed.has(child))
        ? node
        : { ...node, children: node.children.filter((child) => listed.has(child)) },
    ]),
  );
  const kept = new Set<string>();
  const order = [rootId];
  while (order.length > 0) {
    const id = order.pop();
    if (id === undefined || kept.has(id)) continue;
    kept.add(id);
    const node = byId.get(id);
    if (node !== undefined) order.push(...[...node.children].reverse());
  }
  if (kept.size !== nodes.length) truncated = true;
  const sound = nodes.flatMap((node) => {
    const travels = kept.has(node.id) ? byId.get(node.id) : undefined;
    return travels === undefined ? [] : [travels];
  });
  for (const id of addresses.keys()) if (!kept.has(id)) addresses.delete(id);
  return {
    rootId,
    focusedId: focusedId !== undefined && kept.has(focusedId) ? focusedId : undefined,
    truncated,
    nodes: sound,
    addresses,
  };
}

function sameNode(a: BrowserAccessibilityNode, b: BrowserAccessibilityNode): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The update that brings a mirror at `previous` to `next`: nothing when they
 * describe the same tree, a patch when few nodes changed, else the full tree.
 */
export function browserAccessibilityUpdate(
  previous: { readonly revision: number; readonly tree: AccessibilityTree } | undefined,
  next: AccessibilityTree,
  revision: number,
): BrowserAccessibilityUpdate | undefined {
  const head = {
    revision,
    rootId: next.rootId,
    truncated: next.truncated,
    ...(next.focusedId === undefined ? {} : { focusedId: next.focusedId }),
  };
  if (previous === undefined) return { kind: "full", ...head, nodes: next.nodes };
  const before = new Map(previous.tree.nodes.map((node) => [node.id, node]));
  const changed = next.nodes.filter((node) => {
    const old = before.get(node.id);
    return old === undefined || !sameNode(old, node);
  });
  const present = new Set(next.nodes.map((node) => node.id));
  const removed = previous.tree.nodes.map((node) => node.id).filter((id) => !present.has(id));
  if (
    changed.length === 0 &&
    removed.length === 0 &&
    previous.tree.rootId === next.rootId &&
    previous.tree.focusedId === next.focusedId &&
    previous.tree.truncated === next.truncated
  )
    return undefined;
  if (changed.length + removed.length > next.nodes.length / 2)
    return { kind: "full", ...head, nodes: next.nodes };
  return { kind: "patch", base: previous.revision, ...head, nodes: changed, removed };
}

interface ProtocolBoxModel {
  readonly model?: {
    readonly border?: ReadonlyArray<unknown>;
    readonly content?: ReadonlyArray<unknown>;
  };
}

function quadRect(quad: ReadonlyArray<unknown> | undefined): AccessibilityRect | undefined {
  if (quad === undefined || quad.length !== 8 || !quad.every((part) => typeof part === "number"))
    return undefined;
  const points = quad as ReadonlyArray<number>;
  const xs = [points[0], points[2], points[4], points[6]] as number[];
  const ys = [points[1], points[3], points[5], points[7]] as number[];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Where a document's own coordinates sit in the top page: its frame element's content box. */
export interface AccessibilityOffset {
  readonly x: number;
  readonly y: number;
}

/** A document the mirror read, and the protocol session that owns it. */
export interface AccessibilityDocument {
  readonly ordinal: number;
  readonly sessionId: string | undefined;
  readonly offset: AccessibilityOffset;
}

/** At most this many documents of one page are read: the top page and its frames. */
const MAX_FRAMES = 16;
const MAX_FRAME_DEPTH = 8;
/** Text fields checked for the password type; past this a field's value is withheld. */
const MAX_CHECKED_FIELDS = 128;

/** An attribute's lowercased value from the protocol's flat name, value list. */
function attributeOf(attributes: ReadonlyArray<unknown>, name: string): string | undefined {
  for (let at = 0; at + 1 < attributes.length; at += 2)
    if (String(attributes[at]).toLowerCase() === name)
      return String(attributes[at + 1]).toLowerCase();
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read the page's documents through Stable's own protocol attachment. A frame
 * on the page's site shares its parent's session and is read by its frame
 * identity; a frame on another site is its own target, announced by the
 * attachment's automatic frame attachment. Its coordinates are its own, so the
 * frame element's content box moves them into the top page's.
 */
export async function readBrowserAccessibility(options: {
  readonly send: SurfaceProtocolSend;
  readonly targets: SurfaceFrameTargets;
  /** Each session's accessibility events, enabled once per session. */
  readonly enable: (sessionId: string | undefined) => Promise<void>;
}): Promise<{
  readonly tree: AccessibilityTree;
  readonly documents: ReadonlyMap<number, AccessibilityDocument>;
}> {
  const { send } = options;
  const documents = new Map<number, AccessibilityDocument>();
  const readDocument = async (
    sessionId: string | undefined,
    frameId: string | undefined,
    offset: AccessibilityOffset,
    depth: number,
  ): Promise<AccessibilityFrameTree | undefined> => {
    if (documents.size >= MAX_FRAMES) return undefined;
    const ordinal = documents.size;
    documents.set(ordinal, { ordinal, sessionId, offset });
    await options.enable(sessionId);
    const answer = await send(
      "Accessibility.getFullAXTree",
      frameId === undefined ? {} : { frameId },
      sessionId,
    );
    const nodes =
      record(answer) && Array.isArray(answer.nodes)
        ? (answer.nodes as ReadonlyArray<ProtocolAccessibilityNode>).slice(
            0,
            MAX_BROWSER_ACCESSIBILITY_NODES * 4,
          )
        : [];
    const backendOf = (node: ProtocolAccessibilityNode) =>
      typeof node.backendDOMNodeId === "number" && node.ignored !== true
        ? node.backendDOMNodeId
        : undefined;
    // A text field is a password field when its element says so; one that
    // cannot be checked is treated as one, so no value travels by mistake.
    const secure = new Set<number>();
    const fields = nodes.filter((node) => node.role?.value === "textbox");
    await Promise.all(
      fields.map(async (node, index) => {
        const backend = backendOf(node);
        if (backend === undefined) return;
        if (index >= MAX_CHECKED_FIELDS) return void secure.add(backend);
        const described = await send(
          "DOM.describeNode",
          { backendNodeId: backend },
          sessionId,
        ).catch(() => undefined);
        const attributes =
          record(described) && record(described.node) && Array.isArray(described.node.attributes)
            ? (described.node.attributes as ReadonlyArray<unknown>)
            : undefined;
        if (attributes === undefined || attributeOf(attributes, "type") === "password")
          secure.add(backend);
      }),
    );
    const bounds = new Map<number, AccessibilityRect>();
    const visible = nodes
      .map(backendOf)
      .filter((backend): backend is number => backend !== undefined)
      .slice(0, MAX_BROWSER_ACCESSIBILITY_NODES * 2);
    await Promise.all(
      visible.map(async (backend) => {
        const box = (await send("DOM.getBoxModel", { backendNodeId: backend }, sessionId).catch(
          () => undefined,
        )) as ProtocolBoxModel | undefined;
        const rect = quadRect(box?.model?.border);
        if (rect !== undefined)
          bounds.set(backend, { ...rect, x: rect.x + offset.x, y: rect.y + offset.y });
      }),
    );
    const frames = new Map<number, AccessibilityFrameTree>();
    if (depth < MAX_FRAME_DEPTH) {
      const owners = nodes.filter(
        (node) =>
          (node.role?.value === "Iframe" || node.role?.value === "IframePresentational") &&
          backendOf(node) !== undefined,
      );
      let tree: ProtocolFrameTree | undefined;
      for (const owner of owners) {
        const backend = backendOf(owner);
        if (backend === undefined || documents.size >= MAX_FRAMES) continue;
        const described = await send(
          "DOM.describeNode",
          { backendNodeId: backend },
          sessionId,
        ).catch(() => undefined);
        const childId =
          record(described) && record(described.node) && typeof described.node.frameId === "string"
            ? described.node.frameId
            : undefined;
        if (childId === undefined) continue;
        tree ??= (await send("Page.getFrameTree", undefined, sessionId).catch(
          () => ({}),
        )) as ProtocolFrameTree;
        let child: AccessibilityFrameTree | undefined;
        if (findFrame(tree.frameTree, childId) !== undefined) {
          // The same renderer reports a nested document's boxes in the top page's coordinates.
          child = await readDocument(sessionId, childId, offset, depth + 1).catch(() => undefined);
        } else {
          const attached = (await autoAttachSurfaceFrames(send, options.targets, sessionId)).get(
            childId,
          );
          const box = (await send("DOM.getBoxModel", { backendNodeId: backend }, sessionId).catch(
            () => undefined,
          )) as ProtocolBoxModel | undefined;
          const content = quadRect(box?.model?.content);
          if (attached !== undefined && content !== undefined)
            child = await readDocument(
              attached.sessionId,
              undefined,
              { x: offset.x + content.x, y: offset.y + content.y },
              depth + 1,
            ).catch(() => undefined);
        }
        if (child !== undefined) frames.set(backend, child);
      }
    }
    return { ordinal, nodes, secure, bounds, frames };
  };
  const top = await readDocument(undefined, undefined, { x: 0, y: 0 }, 0);
  if (top === undefined) throw new Error("Browser accessibility could not be read.");
  return { tree: reduceBrowserAccessibility(top), documents };
}

/** The fastest the mirror rebuilds; changes in between wait for the next build. */
export const BROWSER_ACCESSIBILITY_BUILD_MS = 250;
/** How long one ask for the mirror is held open when nothing changed. */
export const BROWSER_ACCESSIBILITY_WAIT_MS = 1_000;
/** With no ask for this long, the page's accessibility events are turned off again. */
export const BROWSER_ACCESSIBILITY_IDLE_MS = 5_000;

export type BrowserAccessibilityRead = () => Promise<{
  readonly tree: AccessibilityTree;
  readonly documents: ReadonlyMap<number, AccessibilityDocument>;
}>;

/**
 * One tab's mirror: numbered revisions, the newest tree and where its nodes
 * live. An ask names the revision Nightly holds; it gets a patch from that
 * revision, the full tree when it holds another, or nothing once the page has
 * stayed the same for the held-open wait. A new document starts over with a
 * full tree, and actions name a revision of the current document.
 */
export class BrowserAccessibilityWatch {
  readonly #read: BrowserAccessibilityRead;
  readonly #idle: () => void;
  readonly #now: () => number;
  #revision = 0;
  #documentRevision = 1;
  #latest:
    | {
        readonly revision: number;
        readonly tree: AccessibilityTree;
        readonly documents: ReadonlyMap<number, AccessibilityDocument>;
      }
    | undefined;
  #building: Promise<void> | undefined;
  #lastBuild = 0;
  #dirty = true;
  #waiters = new Set<() => void>();
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: {
    readonly read: BrowserAccessibilityRead;
    /** Called once no ask has come for the idle bound. */
    readonly idle: () => void;
    readonly now?: () => number;
  }) {
    this.#read = options.read;
    this.#idle = options.idle;
    this.#now = options.now ?? Date.now;
  }

  /** The page changed: rebuild on the next ask, and wake one held open. */
  changed(): void {
    this.#dirty = true;
    for (const wake of this.#waiters) wake();
  }

  /** A new document: its nodes share nothing with the last one's. */
  replaced(): void {
    this.#latest = undefined;
    this.#documentRevision = this.#revision + 1;
    this.changed();
  }

  /** Where a node of a current-document revision lives, or nothing. */
  address(
    revision: number,
    nodeId: string,
  ):
    | { readonly address: AccessibilityAddress; readonly document: AccessibilityDocument }
    | undefined {
    const latest = this.#latest;
    if (latest === undefined || revision < this.#documentRevision || revision > latest.revision)
      return undefined;
    const address = latest.tree.addresses.get(nodeId);
    const document = address === undefined ? undefined : latest.documents.get(address.ordinal);
    return address === undefined || document === undefined ? undefined : { address, document };
  }

  async next(
    known: number,
    signal: AbortSignal | undefined,
    current: () => boolean,
  ): Promise<BrowserAccessibilityUpdate | "idle" | "refused"> {
    if (this.#closed) return "refused";
    this.#keepAlive();
    const deadline = this.#now() + BROWSER_ACCESSIBILITY_WAIT_MS;
    while (current() && !signal?.aborted && !this.#closed) {
      const held = this.#latest;
      // Nightly holds an older or unknown revision: it needs the current tree.
      if (held !== undefined && known !== held.revision && !this.#dirty)
        return browserAccessibilityUpdate(undefined, held.tree, held.revision) ?? "idle";
      if (
        this.#dirty ||
        held === undefined ||
        this.#now() - this.#lastBuild >= BROWSER_ACCESSIBILITY_WAIT_MS
      ) {
        const wait = this.#lastBuild + BROWSER_ACCESSIBILITY_BUILD_MS - this.#now();
        if (wait > 0) await this.#sleep(wait, signal, false);
        if (!current() || signal?.aborted || this.#closed) break;
        const before = this.#latest;
        await this.#build();
        const after = this.#latest;
        if (after === undefined) return "refused";
        if (after !== before || known !== after.revision) {
          const base = before !== undefined && known === before.revision ? before : undefined;
          return (
            browserAccessibilityUpdate(base, after.tree, after.revision) ??
            browserAccessibilityUpdate(undefined, after.tree, after.revision) ??
            "idle"
          );
        }
      }
      const left = deadline - this.#now();
      if (left <= 0) return "idle";
      await this.#sleep(left, signal, true);
      if (this.#now() >= deadline && !this.#dirty) return "idle";
    }
    return "refused";
  }

  close(): void {
    this.#closed = true;
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    for (const wake of this.#waiters) wake();
    this.#latest = undefined;
  }

  #keepAlive(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      // A later ask starts from a fresh full tree, as events were off meanwhile.
      this.#latest = undefined;
      this.#dirty = true;
      this.#idle();
    }, BROWSER_ACCESSIBILITY_IDLE_MS);
    this.#idleTimer.unref?.();
  }

  #build(): Promise<void> {
    this.#building ??= (async () => {
      this.#dirty = false;
      const generation = this.#documentRevision;
      try {
        const read = await this.#read();
        if (this.#closed || generation !== this.#documentRevision) return;
        const previous = this.#latest;
        if (
          previous !== undefined &&
          browserAccessibilityUpdate(previous, read.tree, previous.revision + 1) === undefined
        ) {
          this.#latest = { ...previous, documents: read.documents };
          return;
        }
        this.#revision += 1;
        this.#latest = { revision: this.#revision, ...read };
      } catch {
        this.#dirty = true;
      } finally {
        this.#lastBuild = this.#now();
      }
    })().finally(() => {
      this.#building = undefined;
    });
    return this.#building;
  }

  #sleep(ms: number, signal: AbortSignal | undefined, wake: boolean): Promise<void> {
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.#waiters.delete(finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", finish, { once: true });
      if (wake) this.#waiters.add(finish);
    });
  }
}

/** What an action from the mirror may do in the page: the person's own input, nothing more. */
export interface BrowserAccessibilityInput {
  readonly send: SurfaceProtocolSend;
  /** A left click at a page point, through the presentation's native input. */
  readonly press: (point: { readonly x: number; readonly y: number }) => boolean;
  /** One key press and release, through the presentation's native input. */
  readonly key: (keyCode: string) => boolean;
  /** Type text into the page's focused field, as the person's composition commits it. */
  readonly insertText: (text: string) => Promise<boolean>;
}

const TEXT_ROLES = new Set<BrowserAccessibilityRole>(["textbox", "searchbox", "combobox"]);
const STEPPED = new Set<BrowserAccessibilityRole>(["slider", "spinbutton"]);

/**
 * Carry out one action from the mirror on the node it names. A press is a click
 * at the node's centre, after scrolling it into view; a step is an arrow key
 * on the focused node; a new value replaces a text field's text. A password
 * field never takes a value from the mirror, and a disabled node only takes
 * focus and scrolling.
 */
export async function actOnBrowserAccessibilityNode(
  input: BrowserAccessibilityInput,
  found: { readonly address: AccessibilityAddress; readonly document: AccessibilityDocument },
  action: BrowserAccessibilityAction,
  current: () => boolean,
): Promise<boolean> {
  const { address, document } = found;
  const node = { backendNodeId: address.backendNodeId };
  const session = document.sessionId;
  if (address.disabled && action.action !== "focus" && action.action !== "scroll-into-view")
    return false;
  if (action.action === "set-value") {
    if (
      address.secure ||
      address.readonly ||
      !TEXT_ROLES.has(address.role) ||
      (address.role === "combobox" && !address.editable)
    )
      return false;
  }
  if (
    (action.action === "increment" || action.action === "decrement") &&
    !STEPPED.has(address.role)
  )
    return false;
  try {
    if (action.action === "scroll-into-view") {
      await input.send("DOM.scrollIntoViewIfNeeded", node, session);
      return current();
    }
    if (action.action === "press") {
      await input.send("DOM.scrollIntoViewIfNeeded", node, session);
      if (!current()) return false;
      const box = (await input.send("DOM.getBoxModel", node, session)) as ProtocolBoxModel;
      const rect = quadRect(box.model?.border);
      if (rect === undefined || rect.width <= 0 || rect.height <= 0 || !current()) return false;
      return input.press({
        x: Math.floor(document.offset.x + rect.x + rect.width / 2),
        y: Math.floor(document.offset.y + rect.y + rect.height / 2),
      });
    }
    await input.send("DOM.focus", node, session);
    if (!current()) return false;
    if (action.action === "focus") return true;
    if (action.action === "increment") return input.key("Up");
    if (action.action === "decrement") return input.key("Down");
    if (action.action !== "set-value") return false;
    // Select the field's own text so the new value replaces it, as typing would.
    const resolved = (await input.send("DOM.resolveNode", node, session)) as {
      readonly object?: { readonly objectId?: unknown };
    };
    const objectId = resolved.object?.objectId;
    if (typeof objectId !== "string") return false;
    try {
      await input.send(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration:
            "function () { if (typeof this.select === 'function') this.select(); }",
          returnByValue: true,
        },
        session,
      );
    } finally {
      void input.send("Runtime.releaseObject", { objectId }, session).catch(() => undefined);
    }
    if (!current()) return false;
    return action.value === "" ? input.key("Backspace") : await input.insertText(action.value);
  } catch {
    return false;
  }
}

/**
 * The Browser's page snapshot: a compact outline of what a page offers, with a
 * short reference for every element an agent can act on.
 *
 * `readBrowserPage` runs inside the page. Both runtimes hand its source to the
 * page (Playwright's `evaluate`, the desktop Browser's isolated world), so it
 * must stay self-contained: no imports, no helpers outside its body. It reads
 * the page and returns plain data; the host formats it and keeps the refs.
 *
 * The same function answers "is the element behind this ref still the one the
 * snapshot named?", so a ref is checked against the role and name it was given
 * rather than trusted because a selector still matches something.
 *
 * The reader walks one document and every open shadow root in it. A frame is
 * another document, often in another process, so the reader only marks where
 * one sits; the host reads each frame it may read with the same function and
 * splices the outlines together (`readFramedBrowserSnapshot`).
 */

/**
 * How a ref's selector steps into a frame or an open shadow root. Neither is
 * valid CSS, so a selector holding one can never be mistaken for a plain one.
 */
export const BROWSER_FRAME_HOP = " >>frame>> ";
export const BROWSER_SHADOW_HOP = " >>shadow>> ";
/** How deep frames nest before the outline stops reading them. */
export const MAX_BROWSER_SNAPSHOT_FRAME_DEPTH = 4;
/** How many frames one snapshot reads. */
export const MAX_BROWSER_SNAPSHOT_FRAMES = 16;

/** How many elements one snapshot may give a reference to. */
export const MAX_BROWSER_SNAPSHOT_REFS = 400;
/** How many outline lines one snapshot may carry, refs and text alike. */
export const MAX_BROWSER_SNAPSHOT_NODES = 800;
/** The longest outline the host returns, in characters. */
export const MAX_BROWSER_SNAPSHOT_CHARACTERS = 24 * 1024;

export interface BrowserPageSnapshotNode {
  readonly depth: number;
  readonly role: string;
  readonly name?: string;
  readonly ref?: string;
  readonly value?: string;
  /** A credential field: named, never valued. */
  readonly protected?: boolean;
  readonly states?: ReadonlyArray<string>;
  readonly level?: number;
  /** On an `iframe` line: the selector of the frame element, for the host to read into. */
  readonly frame?: string;
}

export interface BrowserPageSnapshotRef {
  readonly ref: string;
  readonly selector: string;
  readonly role: string;
  readonly name: string;
}

export interface BrowserPageSnapshot {
  readonly nodes: ReadonlyArray<BrowserPageSnapshotNode>;
  readonly refs: ReadonlyArray<BrowserPageSnapshotRef>;
  readonly truncated: boolean;
}

export type BrowserPageReadRequest =
  | {
      readonly mode: "snapshot";
      readonly maxRefs: number;
      readonly maxNodes: number;
      readonly protectCredentials: boolean;
      /**
       * The host already found a credential field somewhere on the page, in
       * another frame. No field shows a value.
       */
      readonly withholdValues: boolean;
      /** Refs already given out by the frames read before this one. */
      readonly refOffset?: number;
    }
  | { readonly mode: "verify"; readonly selector: string }
  | { readonly mode: "check"; readonly conditions: ReadonlyArray<BrowserPageCondition> };

/** One wait condition as the page checks it, with any ref already resolved. */
export type BrowserPageCondition =
  | { readonly kind: "text"; readonly text: string; readonly present: boolean }
  | { readonly kind: "url"; readonly contains: string }
  | { readonly kind: "load"; readonly state: "domcontentloaded" | "load" }
  | {
      readonly kind: "element";
      readonly target: string;
      readonly state: "attached" | "detached" | "visible" | "hidden" | "enabled" | "disabled";
    };

export type BrowserPageReadResult =
  | { readonly mode: "snapshot"; readonly snapshot: BrowserPageSnapshot }
  | {
      readonly mode: "verify";
      readonly element: { readonly role: string; readonly name: string } | null;
    }
  | { readonly mode: "check"; readonly met: ReadonlyArray<boolean> };

/**
 * Runs inside the page. See the module comment: nothing outside this body is
 * reachable once the source is handed to the page.
 */
export function readBrowserPage(request: BrowserPageReadRequest): BrowserPageReadResult {
  const credentialHint =
    /(?:password|passcode|one-time-code|otp|webauthn|cc-|credit|card|ssn|secret|token|api.?key)/;
  const clip = (value: string, limit: number): string => {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
  };
  const interactiveRoles = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "combobox",
    "listbox",
    "textbox",
    "searchbox",
    "spinbutton",
    "slider",
    "treeitem",
  ]);
  const isEditable = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    return (
      tag === "input" ||
      tag === "textarea" ||
      (element.getAttribute("contenteditable") ?? "false").toLowerCase() !== "false"
    );
  };
  const isCredential = (element: Element): boolean => {
    if (!isEditable(element)) return false;
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    const hint = [
      type,
      element.getAttribute("autocomplete"),
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("aria-label"),
    ]
      .join(" ")
      .toLowerCase();
    return type === "password" || credentialHint.test(hint);
  };
  const roleOf = (element: Element): string | undefined => {
    const explicit = (element.getAttribute("role") ?? "").trim().split(/\s+/)[0];
    if (explicit !== undefined && explicit !== "") return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return element.hasAttribute("href") ? "link" : undefined;
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return element.hasAttribute("multiple") ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "img";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return undefined;
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "file") return "button";
      return "textbox";
    }
    if ((element.getAttribute("contenteditable") ?? "false").toLowerCase() !== "false") {
      return "textbox";
    }
    return undefined;
  };
  // The text a person reads in a node, leaving out every field inside it: a
  // label that wraps a textarea would otherwise carry what was typed into it.
  // A shadow host reads as its shadow root, and a slot as what it was given.
  const readableText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof Element)) return "";
    if (node.localName === "select" || isEditable(node)) return "";
    const assigned = node instanceof HTMLSlotElement ? node.assignedNodes() : [];
    const shown =
      node.shadowRoot !== null
        ? node.shadowRoot.childNodes
        : assigned.length > 0
          ? assigned
          : node.childNodes;
    return Array.from(shown).map(readableText).join(" ");
  };
  // Ids and labels are looked up in the element's own root, which for an
  // element inside a shadow root is that root, not the document.
  const rootOf = (element: Element): Document | ShadowRoot => {
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root : document;
  };
  const textOf = (root: Document | ShadowRoot, id: string): string => {
    const target = root.getElementById(id);
    return target === null ? "" : readableText(target);
  };
  const nameOf = (element: Element): string => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => textOf(rootOf(element), id))
        .join(" ");
      if (joined.trim() !== "") return clip(joined, 120);
    }
    const label = element.getAttribute("aria-label");
    if (label !== null && label.trim() !== "") return clip(label, 120);
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const id = element.getAttribute("id");
      if (id !== null && id !== "") {
        for (const candidate of Array.from(rootOf(element).querySelectorAll("label"))) {
          if (candidate.htmlFor === id) return clip(readableText(candidate), 120);
        }
      }
      const wrapping = element.closest("label");
      if (wrapping !== null) return clip(readableText(wrapping), 120);
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) {
        return clip(element.getAttribute("value") ?? type, 120);
      }
    }
    const alt = element.getAttribute("alt");
    if (alt !== null && alt.trim() !== "") return clip(alt, 120);
    // An editable element's text is what was typed into it, never its name.
    if (tag !== "select" && !isEditable(element)) {
      const text = clip(readableText(element), 120);
      if (text !== "") return text;
    }
    const title = element.getAttribute("title") ?? element.getAttribute("placeholder");
    return title === null ? "" : clip(title, 120);
  };

  // A selector may step into open shadow roots; a frame hop is the host's to
  // take before it asks this document.
  // Inside a shadow root nothing anchors a path the way `html` does in the
  // document, so its first step matches only the root's own children.
  const resolve = (selector: string): Element | null => {
    let root: Document | ShadowRoot = document as Document | ShadowRoot;
    const parts = selector.split(" >>shadow>> ");
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      let found: Element | null = null;
      try {
        if (root instanceof ShadowRoot) {
          const [first = "", ...rest] = part.split(" > ");
          const top: Element | undefined = Array.from(root.children).find((child: Element) =>
            child.matches(first),
          );
          found =
            top === undefined
              ? null
              : rest.length === 0
                ? top
                : top.querySelector(`:scope > ${rest.join(" > ")}`);
        } else {
          found = root.querySelector(part);
        }
      } catch {
        return null;
      }
      if (found === null || index === parts.length - 1) return found;
      if (found.shadowRoot === null) return null;
      root = found.shadowRoot;
    }
    return null;
  };

  if (request.mode === "check") {
    const shown = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return (
        style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0
      );
    };
    const met = request.conditions.map((condition) => {
      if (condition.kind === "text") {
        const found = (document.body?.innerText ?? "").includes(condition.text);
        return found === condition.present;
      }
      if (condition.kind === "url") return location.href.includes(condition.contains);
      if (condition.kind === "load") {
        return condition.state === "load"
          ? document.readyState === "complete"
          : document.readyState !== "loading";
      }
      const element = resolve(condition.target);
      if (condition.state === "attached") return element !== null;
      if (condition.state === "detached") return element === null;
      if (condition.state === "visible") return element !== null && shown(element);
      if (condition.state === "hidden") return element === null || !shown(element);
      // `:disabled` covers what a control inherits, such as a disabled fieldset.
      const disabled =
        element !== null &&
        (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true");
      return element !== null && (condition.state === "disabled" ? disabled : !disabled);
    });
    return { mode: "check", met };
  }

  if (request.mode === "verify") {
    const element = resolve(request.selector);
    if (element === null) return { mode: "verify", element: null };
    return { mode: "verify", element: { role: roleOf(element) ?? "", name: nameOf(element) } };
  }

  const hidden = (element: Element): boolean => {
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") {
      return true;
    }
    const style = window.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  };
  // Ids and positions count within the element's own root: a shadow root is
  // its own scope, and the selector steps into it from its host.
  // In the document an id counts as unique only if no open shadow root holds
  // it too: the headless Browser's selectors pierce shadow roots.
  const idCount = (root: Document | ShadowRoot, id: string): number =>
    root instanceof ShadowRoot
      ? root.querySelectorAll(`#${CSS.escape(id)}`).length
      : roots.reduce((sum, each) => sum + each.querySelectorAll(`#${CSS.escape(id)}`).length, 0);
  const step = (node: Element, root: Document | ShadowRoot): string => {
    const id = node.getAttribute("id");
    if (id !== null && id !== "" && idCount(root, id) === 1) {
      return `#${CSS.escape(id)}`;
    }
    const tag = node.tagName.toLowerCase();
    const parent: ParentNode | null =
      node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode : null);
    if (parent === null) return tag;
    const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    return siblings.length <= 1 ? tag : `${tag}:nth-of-type(${String(siblings.indexOf(node) + 1)})`;
  };
  const selectorOf = (element: Element): string => {
    const root = element.getRootNode();
    const scope = root instanceof ShadowRoot ? root : document;
    const path: string[] = [];
    let current: Element | null = element;
    while (current !== null) {
      const piece = step(current, scope);
      path.unshift(piece);
      if (piece.startsWith("#") || current.tagName.toLowerCase() === "html") break;
      current = current.parentElement;
    }
    const own = path.join(" > ");
    return root instanceof ShadowRoot ? `${selectorOf(root.host)} >>shadow>> ${own}` : own;
  };
  const valueOf = (element: Element): string | undefined => {
    if (element instanceof HTMLSelectElement) {
      const chosen = Array.from(element.selectedOptions).map((option) => option.text);
      return chosen.length === 0 ? undefined : clip(chosen.join(", "), 80);
    }
    if (element instanceof HTMLInputElement) {
      if (["checkbox", "radio", "button", "submit", "reset", "file"].includes(element.type)) {
        return undefined;
      }
      return element.value === "" ? undefined : clip(element.value, 80);
    }
    if (element instanceof HTMLTextAreaElement) {
      return element.value === "" ? undefined : clip(element.value, 80);
    }
    return undefined;
  };
  const statesOf = (element: Element): string[] => {
    const states: string[] = [];
    if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") {
      states.push("disabled");
    }
    if (
      (element instanceof HTMLInputElement && element.checked) ||
      element.getAttribute("aria-checked") === "true"
    ) {
      states.push("checked");
    }
    if (element.getAttribute("aria-selected") === "true") states.push("selected");
    if (element.getAttribute("aria-expanded") === "true") states.push("expanded");
    if (element.getAttribute("aria-expanded") === "false") states.push("collapsed");
    if (element.hasAttribute("required") || element.getAttribute("aria-required") === "true") {
      states.push("required");
    }
    if (element instanceof HTMLInputElement && element.type === "file") states.push("file");
    return states;
  };

  // A document that holds a credential field shows no field's value at all: a
  // sign-in form's other fields (the account name, a recovery answer) are part
  // of the same sign-in, and the rule elsewhere withholds the whole page.
  const roots: Array<Document | ShadowRoot> = [document];
  for (let index = 0; index < roots.length; index += 1) {
    for (const element of Array.from(roots[index]?.querySelectorAll("*") ?? [])) {
      if (element.shadowRoot !== null) roots.push(element.shadowRoot);
    }
  }
  const holdsCredential =
    request.protectCredentials &&
    (request.withholdValues ||
      roots.some((root) => Array.from(root.querySelectorAll("*")).some(isCredential)));
  const nodes: BrowserPageSnapshotNode[] = [];
  const refs: BrowserPageSnapshotRef[] = [];
  const refOffset = request.refOffset ?? 0;
  let truncated = false;
  // The children a person sees: an open shadow root's instead of the host's
  // own, and a slot's assigned elements in place of its fallback.
  const shownChildren = (element: Element): ReadonlyArray<Element> => {
    if (element.shadowRoot !== null) return Array.from(element.shadowRoot.children);
    if (element instanceof HTMLSlotElement) {
      const assigned = element.assignedElements();
      if (assigned.length > 0) return assigned;
    }
    return Array.from(element.children);
  };
  const visit = (element: Element, depth: number): void => {
    if (truncated) return;
    if (["script", "style", "noscript", "template", "svg", "head"].includes(element.localName)) {
      return;
    }
    if (hidden(element)) return;
    const role = roleOf(element);
    let childDepth = depth;
    if (role !== undefined && (interactiveRoles.has(role) || role === "heading")) {
      if (nodes.length >= request.maxNodes) {
        truncated = true;
        return;
      }
      const name = nameOf(element);
      const credential = request.protectCredentials && isCredential(element);
      const value = credential || holdsCredential ? undefined : valueOf(element);
      const states = statesOf(element);
      const levelMatch = /^h([1-6])$/.exec(element.localName);
      let ref: string | undefined;
      if (role !== "heading") {
        if (refs.length >= request.maxRefs) {
          truncated = true;
          return;
        }
        ref = `e${String(refOffset + refs.length + 1)}`;
        refs.push({ ref, selector: selectorOf(element), role, name });
      }
      nodes.push({
        depth,
        role,
        ...(name === "" ? {} : { name }),
        ...(ref === undefined ? {} : { ref }),
        ...(value === undefined ? {} : { value }),
        ...(credential ? { protected: true } : {}),
        ...(states.length === 0 ? {} : { states }),
        ...(levelMatch?.[1] === undefined ? {} : { level: Number(levelMatch[1]) }),
      });
      // A control's own text is its name; listing it again would double it.
      if (role !== "listbox" && role !== "combobox") return;
      childDepth = depth + 1;
    } else if (element.localName === "p" || element.localName === "li") {
      const text = clip(readableText(element), 80);
      if (text !== "" && !element.querySelector("a[href], button, input, select, textarea")) {
        if (nodes.length >= request.maxNodes) {
          truncated = true;
          return;
        }
        nodes.push({ depth, role: "text", name: text });
        return;
      }
    } else if (element.localName === "iframe" || element.localName === "frame") {
      if (nodes.length >= request.maxNodes) {
        truncated = true;
        return;
      }
      const title = clip(element.getAttribute("title") ?? "", 120);
      nodes.push({
        depth,
        role: "iframe",
        ...(title === "" ? {} : { name: title }),
        frame: selectorOf(element),
      });
      return;
    }
    for (const child of shownChildren(element)) visit(child, childDepth);
  };
  if (document.body !== null) visit(document.body, 0);
  return { mode: "snapshot", snapshot: { nodes, refs, truncated } };
}

/**
 * The outline the agent reads: one line per element, indented by nesting,
 * with `[ref=eN]` on every element it can act on. A credential field reads
 * `protected` where a value would be.
 */
export function formatBrowserPageSnapshot(snapshot: BrowserPageSnapshot): string {
  const lines: string[] = [];
  let length = 0;
  for (const node of snapshot.nodes) {
    const parts = [`${"  ".repeat(Math.min(node.depth, 12))}- ${node.role}`];
    if (node.name !== undefined) parts.push(JSON.stringify(node.name));
    if (node.level !== undefined) parts.push(`[level=${String(node.level)}]`);
    if (node.ref !== undefined) parts.push(`[ref=${node.ref}]`);
    for (const state of node.states ?? []) parts.push(state);
    if (node.protected === true) parts.push("protected");
    else if (node.value !== undefined) parts.push(`value=${JSON.stringify(node.value)}`);
    const line = parts.join(" ");
    if (length + line.length + 1 > MAX_BROWSER_SNAPSHOT_CHARACTERS) {
      lines.push("- (outline truncated)");
      return lines.join("\n");
    }
    lines.push(line);
    length += line.length + 1;
  }
  if (snapshot.truncated) lines.push("- (outline truncated)");
  return lines.join("\n");
}

/**
 * Runs inside the page: the element a selector names in this document,
 * stepping into open shadow roots at each shadow hop. Self-contained, like the
 * reader, so a host can hand its source to a page or frame.
 */
export function resolveBrowserElement(selector: string): Element | null {
  let root: Document | ShadowRoot = document as Document | ShadowRoot;
  const parts = selector.split(" >>shadow>> ");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    let found: Element | null = null;
    try {
      // A shadow root's path starts at one of its own children; see the reader.
      if (root instanceof ShadowRoot) {
        const [first = "", ...rest] = part.split(" > ");
        const top: Element | undefined = Array.from(root.children).find((child: Element) =>
          child.matches(first),
        );
        found =
          top === undefined
            ? null
            : rest.length === 0
              ? top
              : top.querySelector(`:scope > ${rest.join(" > ")}`);
      } else {
        found = root.querySelector(part);
      }
    } catch {
      return null;
    }
    if (found === null || index === parts.length - 1) return found;
    if (found.shadowRoot === null) return null;
    root = found.shadowRoot;
  }
  return null;
}

/**
 * Runs inside the page: where a frame element's content starts in this
 * document's viewport, after bringing the frame into view. A point inside the
 * frame plus this offset is the point in the page that holds it.
 */
export function browserFrameContentOffset(
  frame: Element | null,
): { readonly x: number; readonly y: number } | null {
  if (!(frame instanceof HTMLIFrameElement || frame instanceof HTMLFrameElement)) return null;
  frame.scrollIntoView({ block: "nearest", inline: "nearest" });
  const box = frame.getBoundingClientRect();
  const style = window.getComputedStyle(frame);
  return {
    x: box.left + frame.clientLeft + Number.parseFloat(style.paddingLeft || "0"),
    y: box.top + frame.clientTop + Number.parseFloat(style.paddingTop || "0"),
  };
}

/** A ref's selector split at its frame hops: the frames to enter, then the element in the last. */
export function splitBrowserFrameTarget(target: string): {
  readonly frames: ReadonlyArray<string>;
  readonly element: string;
} {
  const parts = target.split(BROWSER_FRAME_HOP);
  return { frames: parts.slice(0, -1), element: parts.at(-1) ?? target };
}

/**
 * What the host can do with one frame of the page: read it with the shared
 * reader, or find the frame a frame element holds. A frame the context may not
 * read (its origin is outside the context's allowlist, or it cannot be reached)
 * comes back excluded, with its origin when one is known.
 */
export interface BrowserSnapshotFrames<Frame> {
  read(
    frame: Frame,
    limits: { readonly refOffset: number; readonly maxRefs: number; readonly maxNodes: number },
  ): Promise<BrowserPageSnapshot>;
  child(
    frame: Frame,
    selector: string,
  ): Promise<
    | { readonly status: "included"; readonly frame: Frame }
    | { readonly status: "excluded"; readonly origin?: string }
  >;
}

/**
 * The page's outline with its frames read into it: each frame the context may
 * read is listed under its `iframe` line, and its refs' selectors start with
 * the frame hops that reach it. One budget of refs and lines covers the whole
 * page, frames included.
 */
export async function readFramedBrowserSnapshot<Frame>(
  top: Frame,
  frames: BrowserSnapshotFrames<Frame>,
  limits: { readonly maxRefs: number; readonly maxNodes: number },
): Promise<BrowserPageSnapshot> {
  const nodes: BrowserPageSnapshotNode[] = [];
  const refs: BrowserPageSnapshotRef[] = [];
  let truncated = false;
  let framesRead = 0;
  const walk = async (
    frame: Frame,
    prefix: string,
    depthOffset: number,
    level: number,
  ): Promise<void> => {
    const read = await frames.read(frame, {
      refOffset: refs.length,
      maxRefs: Math.max(0, limits.maxRefs - refs.length),
      maxNodes: Math.max(0, limits.maxNodes - nodes.length),
    });
    if (read.truncated) truncated = true;
    for (const ref of read.refs) refs.push({ ...ref, selector: `${prefix}${ref.selector}` });
    for (const node of read.nodes) {
      const { frame: frameSelector, ...line } = node;
      const placed = { ...line, depth: line.depth + depthOffset };
      if (frameSelector === undefined) {
        nodes.push(placed);
        continue;
      }
      if (level >= MAX_BROWSER_SNAPSHOT_FRAME_DEPTH || framesRead >= MAX_BROWSER_SNAPSHOT_FRAMES) {
        nodes.push({ ...placed, states: ["not included"] });
        truncated = true;
        continue;
      }
      framesRead += 1;
      type Child = Awaited<ReturnType<BrowserSnapshotFrames<Frame>["child"]>>;
      const child: Child = await frames
        .child(frame, frameSelector)
        .catch((): Child => ({ status: "excluded" }));
      if (child.status === "excluded") {
        nodes.push({
          ...placed,
          ...(child.origin === undefined ? {} : { name: child.origin }),
          states: ["not included"],
        });
        continue;
      }
      const placedAt = nodes.push(placed) - 1;
      // A frame that navigates or goes away mid-read is left out on its own;
      // the rest of the page still reads.
      const before = { nodes: nodes.length, refs: refs.length };
      try {
        await walk(
          child.frame,
          `${prefix}${frameSelector}${BROWSER_FRAME_HOP}`,
          placed.depth + 1,
          level + 1,
        );
      } catch {
        nodes.length = before.nodes;
        refs.length = before.refs;
        nodes[placedAt] = { ...placed, states: ["not included"] };
      }
    }
  };
  await walk(top, "", 0, 0);
  // A frame read mid-page spends lines the frame's parent had already read.
  if (nodes.length > limits.maxNodes) {
    // A ref keeps its line: one the outline no longer shows is dropped too.
    const kept = nodes.slice(0, limits.maxNodes);
    const shown = new Set(kept.flatMap((node) => (node.ref === undefined ? [] : [node.ref])));
    return { nodes: kept, refs: refs.filter((ref) => shown.has(ref.ref)), truncated: true };
  }
  return { nodes, refs, truncated };
}

/**
 * Whether a page element still is the one a snapshot ref named: on the page
 * the snapshot read, with the role and name it recorded. A page that moved on
 * by itself between the snapshot and the action can hold an element with the
 * same selector, role, and name, so the address is checked too.
 */
export function browserRefStillMatches(
  expected: { readonly role: string; readonly name: string; readonly url: string },
  found: { readonly role: string; readonly name: string } | null,
  pageUrl: string,
): boolean {
  return (
    pageUrl === expected.url &&
    found !== null &&
    found.role === expected.role &&
    found.name === expected.name
  );
}

/**
 * Runs inside the page: resolve once the document has stopped changing for a
 * short quiet window, or when the cap runs out, whichever comes first. A page
 * that keeps changing (a clock, an animation) costs the cap and no more.
 */
export function awaitQuietPage(argument: {
  readonly quietMs: number;
  readonly capMs: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (quiet: boolean) => {
      observer.disconnect();
      clearTimeout(capTimer);
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      resolve(quiet);
    };
    const restart = () => {
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), argument.quietMs);
    };
    const observer = new MutationObserver(restart);
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const capTimer = setTimeout(() => finish(false), argument.capMs);
    restart();
  });
}

/** How long the page must stay unchanged after an action, and the most a settle waits. */
export const BROWSER_SETTLE_QUIET_MS = 250;
export const BROWSER_SETTLE_CAP_MS = 2_000;

/**
 * How the Browser answers a page's own dialog, whoever is driving: it accepts
 * what only informs or lets the page close, and declines what asks a question
 * the agent was not asked. The answer is reported, never hidden.
 */
export const BROWSER_DIALOG_POLICY = {
  alert: "accepted",
  confirm: "dismissed",
  prompt: "dismissed",
  beforeunload: "accepted",
} as const satisfies Record<string, "accepted" | "dismissed">;

export function dialogType(value: string): keyof typeof BROWSER_DIALOG_POLICY {
  return value === "confirm" || value === "prompt" || value === "beforeunload" ? value : "alert";
}

/** The conditions a page checks, with element targets the host already resolved. */
export function browserPageConditions(waitFor: {
  readonly conditions: ReadonlyArray<
    | { readonly kind: "text"; readonly text: string; readonly present: boolean }
    | { readonly kind: "url"; readonly contains: string }
    | { readonly kind: "load"; readonly state: "domcontentloaded" | "load" }
    | {
        readonly kind: "element";
        readonly target?: string | undefined;
        readonly state: "attached" | "detached" | "visible" | "hidden" | "enabled" | "disabled";
      }
  >;
}): ReadonlyArray<BrowserPageCondition> {
  return waitFor.conditions.map((condition) =>
    condition.kind === "element"
      ? { kind: "element", target: condition.target ?? ":not(*)", state: condition.state }
      : condition,
  );
}

export function waitSatisfied(match: "all" | "any", met: ReadonlyArray<boolean>): boolean {
  return match === "all" ? met.every(Boolean) : met.some(Boolean);
}

/** The sentence a timed-out wait answers with: which conditions never held. */
export function describeUnmetWait(
  timeoutMs: number,
  conditions: ReadonlyArray<BrowserPageCondition>,
  met: ReadonlyArray<boolean>,
): string {
  const unmet = conditions
    .filter((_condition, index) => met[index] !== true)
    .map((condition) => {
      if (condition.kind === "text") {
        return `text ${JSON.stringify(condition.text.slice(0, 80))} ${condition.present ? "present" : "absent"}`;
      }
      if (condition.kind === "url")
        return `address containing ${JSON.stringify(condition.contains.slice(0, 80))}`;
      if (condition.kind === "load") return `page ${condition.state}`;
      return `element ${JSON.stringify(condition.target.slice(0, 80))} ${condition.state}`;
    });
  return `The wait timed out after ${String(timeoutMs)} ms. Not met: ${unmet.join("; ")}.`;
}

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
 */

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
       * The host already found a credential field somewhere on the page, in a
       * frame or shadow root this reader does not walk. No field shows a value.
       */
      readonly withholdValues: boolean;
    }
  | { readonly mode: "verify"; readonly selector: string };

export type BrowserPageReadResult =
  | { readonly mode: "snapshot"; readonly snapshot: BrowserPageSnapshot }
  | {
      readonly mode: "verify";
      readonly element: { readonly role: string; readonly name: string } | null;
    };

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
  const textOf = (id: string): string => {
    const target = document.getElementById(id);
    return target === null ? "" : (target.textContent ?? "");
  };
  const nameOf = (element: Element): string => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const joined = labelledBy.split(/\s+/).map(textOf).join(" ");
      if (joined.trim() !== "") return clip(joined, 120);
    }
    const label = element.getAttribute("aria-label");
    if (label !== null && label.trim() !== "") return clip(label, 120);
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const id = element.getAttribute("id");
      if (id !== null && id !== "") {
        for (const candidate of Array.from(document.querySelectorAll("label"))) {
          if (candidate.htmlFor === id) return clip(candidate.textContent ?? "", 120);
        }
      }
      const wrapping = element.closest("label");
      if (wrapping !== null) return clip(wrapping.textContent ?? "", 120);
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) {
        return clip(element.getAttribute("value") ?? type, 120);
      }
    }
    const alt = element.getAttribute("alt");
    if (alt !== null && alt.trim() !== "") return clip(alt, 120);
    // An editable element's text is what was typed into it, never its name.
    if (tag !== "select" && !isEditable(element)) {
      const text = clip(element.textContent ?? "", 120);
      if (text !== "") return text;
    }
    const title = element.getAttribute("title") ?? element.getAttribute("placeholder");
    return title === null ? "" : clip(title, 120);
  };

  if (request.mode === "verify") {
    let element: Element | null = null;
    try {
      element = document.querySelector(request.selector);
    } catch {
      element = null;
    }
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
  const step = (node: Element): string => {
    const id = node.getAttribute("id");
    if (id !== null && id !== "" && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
      return `#${CSS.escape(id)}`;
    }
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent === null) return tag;
    const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    return siblings.length <= 1 ? tag : `${tag}:nth-of-type(${String(siblings.indexOf(node) + 1)})`;
  };
  const selectorOf = (element: Element): string => {
    const path: string[] = [];
    let current: Element | null = element;
    while (current !== null) {
      const piece = step(current);
      path.unshift(piece);
      if (piece.startsWith("#") || current.tagName.toLowerCase() === "html") break;
      current = current.parentElement;
    }
    return path.join(" > ");
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
    if (
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      (element instanceof HTMLFieldSetElement && element.disabled)
    ) {
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
  let truncated = false;
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
        ref = `e${String(refs.length + 1)}`;
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
      const text = clip(element.textContent ?? "", 80);
      if (text !== "" && !element.querySelector("a[href], button, input, select, textarea")) {
        if (nodes.length >= request.maxNodes) {
          truncated = true;
          return;
        }
        nodes.push({ depth, role: "text", name: text });
        return;
      }
    } else if (element.localName === "iframe") {
      if (nodes.length >= request.maxNodes) {
        truncated = true;
        return;
      }
      nodes.push({ depth, role: "iframe", name: "not included" });
      return;
    }
    for (const child of Array.from(element.children)) visit(child, childDepth);
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

/** Whether a page element still is the one a snapshot ref named. */
export function browserRefStillMatches(
  expected: { readonly role: string; readonly name: string },
  found: { readonly role: string; readonly name: string } | null,
): boolean {
  return found !== null && found.role === expected.role && found.name === expected.name;
}

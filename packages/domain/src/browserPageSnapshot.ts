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
 * The page audits read through the same function (`accessibility` and
 * `performance` modes), so a finding's selector is the one the snapshot keeps
 * for a ref, and the server can name the finding by that ref.
 *
 * The reader walks one document and every open shadow root in it. A frame is
 * another document, often in another process, so the reader only marks where
 * one sits; the host reads each frame it may read with the same function and
 * splices the outlines together (`readFramedBrowserSnapshot`).
 */

import type {
  BrowserAccessibilityReading,
  BrowserAccessibilityReadingFinding,
  BrowserPerformanceReading,
} from "./browserPageAudit";

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
  | { readonly mode: "check"; readonly conditions: ReadonlyArray<BrowserPageCondition> }
  /** The accessibility audit's checks, over this document and its open shadow roots. */
  | {
      readonly mode: "accessibility";
      readonly maxElements: number;
      readonly maxPerRule: number;
    }
  /** The browser's own record of this document's load, read back unchanged. */
  | { readonly mode: "performance"; readonly maxEntries: number };

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
  | { readonly mode: "check"; readonly met: ReadonlyArray<boolean> }
  | { readonly mode: "accessibility"; readonly reading: BrowserAccessibilityReading }
  | { readonly mode: "performance"; readonly reading: BrowserPerformanceReading };

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
  // The parent an element is drawn inside: the slot it is assigned to, else
  // its parent, else the host of the shadow root it sits in. A slotted
  // element's own parent is the host, whose shadow tree draws over it.
  const renderedParent = (element: Element): Element | null => {
    if (element.assignedSlot !== null) return element.assignedSlot;
    const parentNode: ParentNode | null = element.parentNode;
    return element.parentElement ?? (parentNode instanceof ShadowRoot ? parentNode.host : null);
  };
  // The nodes drawn inside an element, in the order a person meets them: an
  // open shadow root's in place of the host's own, and a slot's assigned
  // nodes in place of its fallback. The inverse of `renderedParent`.
  const shownNodes = (element: Element): ReadonlyArray<Node> => {
    if (element.shadowRoot !== null) return Array.from(element.shadowRoot.childNodes);
    if (element instanceof HTMLSlotElement) {
      const assigned = element.assignedNodes();
      if (assigned.length > 0) return assigned;
    }
    return Array.from(element.childNodes);
  };
  const shownChildren = (element: Element): ReadonlyArray<Element> =>
    shownNodes(element).filter((node): node is Element => node instanceof Element);
  // Inside an editable element, every descendant's text is what was typed:
  // `<div contenteditable><span>secret</span></div>` reads "secret" from the
  // span. The walk reaches every parent too: a slotted element's chain climbs
  // through its host.
  const withinEditable = (element: Element): boolean => {
    for (let current: Element | null = element; current !== null;) {
      if (isEditable(current)) return true;
      current = renderedParent(current);
    }
    return false;
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
    return shownNodes(node).map(readableText).join(" ");
  };
  // Ids and labels are looked up in the element's own root, which for an
  // element inside a shadow root is that root, not the document.
  const rootOf = (element: Element): Document | ShadowRoot => {
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root : document;
  };
  const textOf = (root: Document | ShadowRoot, id: string): string => {
    const target = root.getElementById(id);
    return target === null || withinEditable(target) ? "" : readableText(target);
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
  // document, so its first step matches only the root's own children. A path
  // that starts at an id needs no anchor: the id is unique in its root.
  const resolve = (selector: string): Element | null => {
    let root: Document | ShadowRoot = document as Document | ShadowRoot;
    const parts = selector.split(" >>shadow>> ");
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      let found: Element | null = null;
      try {
        if (root instanceof ShadowRoot && !part.startsWith("#")) {
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

  if (request.mode === "performance") {
    // Each entry type is read through an observer with `buffered`, which hands
    // back what the browser recorded since the document began loading without
    // waiting: the timeline is the browser's, and reading it changes nothing.
    const supported = (type: string) => PerformanceObserver.supportedEntryTypes.includes(type);
    const timeline = (type: string): ReadonlyArray<PerformanceEntry> => {
      if (!supported(type)) return [];
      const observer = new PerformanceObserver(() => undefined);
      try {
        observer.observe({ type, buffered: true });
        return observer.takeRecords().slice(-request.maxEntries);
      } catch {
        return [];
      } finally {
        observer.disconnect();
      }
    };
    const numberOf = (entry: PerformanceEntry, key: string): number => {
      const value: unknown = Reflect.get(entry, key);
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    const stringOf = (entry: PerformanceEntry, key: string): string => {
      const value: unknown = Reflect.get(entry, key);
      return typeof value === "string" ? value.slice(0, 2_048) : "";
    };
    const navigation = performance.getEntriesByType("navigation")[0];
    const paint = performance
      .getEntriesByType("paint")
      .find((entry) => entry.name === "first-contentful-paint");
    const largest = timeline("largest-contentful-paint").at(-1);
    const painted: unknown = largest === undefined ? undefined : Reflect.get(largest, "element");
    const lcpUrl = largest === undefined ? "" : stringOf(largest, "url");
    const reading: BrowserPerformanceReading = {
      now: performance.now(),
      ...(navigation === undefined
        ? {}
        : {
            navigation: {
              type: stringOf(navigation, "type"),
              responseStart: numberOf(navigation, "responseStart"),
              domContentLoaded: numberOf(navigation, "domContentLoadedEventEnd"),
              load: numberOf(navigation, "loadEventEnd"),
              transferSize: numberOf(navigation, "transferSize"),
            },
          }),
      ...(paint === undefined ? {} : { firstContentfulPaint: paint.startTime }),
      ...(largest === undefined
        ? {}
        : {
            largestContentfulPaint: {
              startTime: largest.startTime,
              ...(painted instanceof Element && painted.isConnected
                ? { selector: selectorOf(painted) }
                : {}),
              ...(lcpUrl === "" ? {} : { url: lcpUrl }),
            },
          }),
      ...(supported("layout-shift")
        ? {
            layoutShifts: timeline("layout-shift").map((entry) => ({
              startTime: entry.startTime,
              value: numberOf(entry, "value"),
              hadRecentInput: Reflect.get(entry, "hadRecentInput") === true,
            })),
          }
        : {}),
      ...(supported("longtask")
        ? {
            longTasks: timeline("longtask").map((entry) => ({
              startTime: entry.startTime,
              duration: entry.duration,
            })),
          }
        : {}),
      resources: performance
        .getEntriesByType("resource")
        .slice(0, request.maxEntries)
        .map((entry) => ({
          url: entry.name.slice(0, 2_048),
          initiatorType: stringOf(entry, "initiatorType"),
          contentType: stringOf(entry, "contentType"),
          transferSize: numberOf(entry, "transferSize"),
        })),
    };
    return { mode: "performance", reading };
  }

  if (request.mode === "accessibility") {
    const audited: Element[] = [];
    let truncatedAudit = false;
    // Rendered order, as the snapshot walks it: a host's shadow root in place
    // of its own children, and a slot's assigned elements where the slot sits,
    // so headings read in the order a person meets them. Light-DOM children no
    // slot takes are not drawn and are not audited.
    const pending: Element[] = document.documentElement === null ? [] : [document.documentElement];
    while (pending.length > 0) {
      const element = pending.pop();
      if (element === undefined) break;
      if (["script", "style", "noscript", "template", "head"].includes(element.localName)) continue;
      if (audited.length >= request.maxElements) {
        truncatedAudit = true;
        break;
      }
      audited.push(element);
      const children = shownChildren(element);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) pending.push(child);
      }
    }
    const found = new Map<BrowserAccessibilityReadingFinding["rule"], number>();
    const findings: BrowserAccessibilityReadingFinding[] = [];
    const report = (
      rule: BrowserAccessibilityReadingFinding["rule"],
      element: Element,
      detail?: BrowserAccessibilityReadingFinding["detail"],
    ): void => {
      const seen = (found.get(rule) ?? 0) + 1;
      found.set(rule, seen);
      if (seen > request.maxPerRule) return;
      // Named as the snapshot names it; an element the snapshot gives no role
      // is shown by its first words instead, and the page itself by neither.
      // Nothing is read from inside an editable element: its text is what was
      // typed, as the snapshot withholds it by never stepping inside.
      const whole = element === document.documentElement;
      const role = roleOf(element);
      const typed = withinEditable(element);
      const name = role === undefined || whole || typed ? "" : nameOf(element);
      const text = name !== "" || whole || typed ? "" : clip(readableText(element), 80);
      findings.push({
        rule,
        selector: selectorOf(element),
        ...(role === undefined ? {} : { role }),
        ...(name === "" ? {} : { name }),
        ...(text === "" ? {} : { text }),
        ...(detail === undefined ? {} : { detail }),
      });
    };
    // An element's rendered ancestors, itself first: through the slot that
    // draws it and the hosts of open shadow roots, so `aria-hidden`, `inert`,
    // and a disabled wrapper around a slot reach what the slot draws.
    const ancestry = (element: Element): Element[] => {
      const chain: Element[] = [];
      for (let current: Element | null = element; current !== null;) {
        chain.push(current);
        current = renderedParent(current);
      }
      return chain;
    };
    const rendered = (element: Element): boolean =>
      element.checkVisibility({ visibilityProperty: true });
    const ariaHidden = (element: Element): boolean =>
      ancestry(element).some((each) => each.getAttribute("aria-hidden") === "true");
    const inert = (element: Element): boolean =>
      ancestry(element).some((each) => each.hasAttribute("inert"));
    // Exposed to assistive technology: drawn, and not hidden from it on purpose.
    // An inert subtree is still drawn (`checkVisibility` holds), but the
    // browser leaves it out of the accessibility tree, so an inactive panel's
    // controls are not audited.
    const exposed = (element: Element): boolean =>
      rendered(element) && !ariaHidden(element) && !inert(element);
    const filled = (value: string | null | undefined): boolean =>
      value !== null && value !== undefined && value.replace(/\s+/g, "") !== "";
    const explicitRole = (element: Element): string =>
      (element.getAttribute("role") ?? "").trim().split(/\s+/)[0] ?? "";
    const pseudoText = (element: Element, which: "::before" | "::after"): string => {
      const content = window.getComputedStyle(element, which).content;
      return Array.from(content.matchAll(/"((?:[^"\\]|\\.)*)"/g), (match) => match[1] ?? "").join(
        " ",
      );
    };
    // The text a name is computed from: text, the alt text of images, the
    // label of a labelled descendant, and CSS-generated text. A field's value
    // is never read, so a control holding only a field reads as unnamed.
    // Text that is not drawn, or is hidden from assistive technology, names
    // nothing: `<button><span hidden>Save</span></button>` is unnamed. A label
    // or `aria-labelledby` target that is itself hidden still names, as
    // browsers name from it, and then so does everything inside it.
    const contentText = (node: Node, includeHidden: boolean): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (!(node instanceof Element)) return "";
      // The element's own style, not `checkVisibility`: a slot or any other
      // `display: contents` element has no box of its own yet shows its text.
      if (!includeHidden && hidden(node)) return "";
      if (["script", "style", "template", "noscript"].includes(node.localName)) return "";
      const label = node.getAttribute("aria-label");
      if (filled(label)) return label ?? "";
      const tag = node.localName;
      if (tag === "img" || tag === "area") return node.getAttribute("alt") ?? "";
      if (tag === "input" && (node.getAttribute("type") ?? "").toLowerCase() === "image") {
        return node.getAttribute("alt") ?? "";
      }
      if (tag === "svg") return node.querySelector("title")?.textContent ?? "";
      if (tag === "select" || isEditable(node)) return "";
      return [
        pseudoText(node, "::before"),
        ...shownNodes(node).map((each) => contentText(each, includeHidden)),
        pseudoText(node, "::after"),
      ].join(" ");
    };
    const labelledText = (element: Element): string =>
      (element.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter((id) => id !== "")
        .map((id) => {
          const target = rootOf(element).getElementById(id);
          return target === null ? "" : contentText(target, !exposed(target));
        })
        .join(" ");
    // Whether any source gives the element a name. The reader looks wider than
    // the snapshot's own naming and reports only when every source is empty,
    // so a finding errs toward silence rather than a false alarm.
    const hasName = (element: Element, fromContent: boolean): boolean => {
      if (
        filled(element.getAttribute("aria-label")) ||
        filled(labelledText(element)) ||
        filled(element.getAttribute("title"))
      ) {
        return true;
      }
      const tag = element.localName;
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ) {
        if (
          Array.from(element.labels ?? []).some((label) =>
            filled(contentText(label, !exposed(label))),
          )
        ) {
          return true;
        }
        if (filled(element.getAttribute("placeholder"))) return true;
        if (tag === "input" && (type === "submit" || type === "reset")) return true;
        if (tag === "input" && type === "button") return filled(element.getAttribute("value"));
        if (tag === "input" && type === "image") {
          return filled(element.getAttribute("alt")) || filled(element.getAttribute("value"));
        }
      }
      if (tag === "img" || tag === "area") return filled(element.getAttribute("alt"));
      if (tag === "svg") return filled(element.querySelector("title")?.textContent);
      return fromContent && filled(contentText(element, false));
    };
    const disabled = (element: Element): boolean =>
      ancestry(element).some(
        (each) => each.matches(":disabled") || each.getAttribute("aria-disabled") === "true",
      );

    const fieldTypes = new Set(["button", "submit", "reset", "image", "hidden"]);
    const fieldRoles = new Set([
      "textbox",
      "searchbox",
      "combobox",
      "listbox",
      "spinbutton",
      "slider",
      "checkbox",
      "radio",
      "switch",
    ]);
    let lastHeading: number | undefined;
    for (const element of audited) {
      const tag = element.localName;
      const role = explicitRole(element);
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      if (role === "presentation" || role === "none") continue;
      if (tag === "img" || (tag === "input" && type === "image") || role === "img") {
        if (exposed(element) && !(tag === "img" && element.hasAttribute("alt"))) {
          if (!hasName(element, false)) report("image-alt", element);
        }
        continue;
      }
      if (tag === "button" || (tag === "input" && type === "button") || role === "button") {
        if (exposed(element) && !hasName(element, true)) report("button-name", element);
        continue;
      }
      if (((tag === "a" || tag === "area") && element.hasAttribute("href")) || role === "link") {
        if (exposed(element) && !hasName(element, true)) report("link-name", element);
        continue;
      }
      if (
        (tag === "input" && !fieldTypes.has(type)) ||
        tag === "select" ||
        tag === "textarea" ||
        fieldRoles.has(role)
      ) {
        const native = tag === "input" || tag === "select" || tag === "textarea";
        // A custom checkbox, radio, or switch may take its name from its content.
        const fromContent =
          !native && (role === "checkbox" || role === "radio" || role === "switch");
        if (exposed(element) && !hasName(element, fromContent)) report("field-name", element);
        continue;
      }
      const level =
        /^h([1-6])$/.exec(tag)?.[1] ??
        (role === "heading" ? (element.getAttribute("aria-level") ?? "2") : undefined);
      if (level !== undefined && exposed(element)) {
        const number = Number.parseInt(level, 10);
        if (Number.isInteger(number) && number >= 1) {
          if (lastHeading !== undefined && number > lastHeading + 1) {
            report("heading-order", element, { level: number, previousLevel: lastHeading });
          }
          lastHeading = number;
        }
      }
    }

    if (!filled(document.title) && document.documentElement !== null) {
      report("document-title", document.documentElement);
    }
    if (
      document.documentElement !== null &&
      !filled(document.documentElement.getAttribute("lang")) &&
      !filled(document.documentElement.getAttribute("xml:lang"))
    ) {
      report("document-lang", document.documentElement);
    }

    // An id a label or an aria attribute points at must be unique in its root:
    // the reference reaches only the first element that holds it. Both the
    // references and the ids are read from the audited elements alone, so a
    // page larger than the bound costs no more than one at it, and no finding
    // names an element the audit did not read.
    const referencing = [
      "aria-labelledby",
      "aria-describedby",
      "aria-controls",
      "aria-owns",
      "aria-activedescendant",
      "aria-details",
      "aria-errormessage",
      "aria-flowto",
    ];
    const referencedIn = new Map<Document | ShadowRoot, Set<string>>();
    const heldIn = new Map<Document | ShadowRoot, Map<string, Element[]>>();
    for (const element of audited) {
      const root = rootOf(element);
      const id = element.getAttribute("id");
      if (id !== null && id !== "") {
        const held = heldIn.get(root) ?? new Map<string, Element[]>();
        heldIn.set(root, held);
        const holders = held.get(id);
        if (holders === undefined) held.set(id, [element]);
        else holders.push(element);
      }
      const referenced = referencedIn.get(root) ?? new Set<string>();
      referencedIn.set(root, referenced);
      for (const attribute of referencing) {
        for (const each of (element.getAttribute(attribute) ?? "").split(/\s+/)) {
          if (each !== "") referenced.add(each);
        }
      }
      if (element instanceof HTMLLabelElement && element.htmlFor !== "") {
        referenced.add(element.htmlFor);
      }
    }
    for (const [root, referenced] of referencedIn) {
      for (const id of referenced) {
        const holders = heldIn.get(root)?.get(id) ?? [];
        const second = holders[1];
        if (second !== undefined) {
          report("duplicate-id-aria", second, { id: clip(id, 64), count: holders.length });
        }
      }
    }

    // Keyboard focus that a screen reader cannot follow.
    const focusableSelector =
      "a[href], area[href], button, input:not([type=hidden]), select, textarea, iframe, summary, [contenteditable]:not([contenteditable=false]), audio[controls], video[controls], [tabindex]";
    for (const element of audited) {
      if (!element.matches(focusableSelector) || element.matches(":disabled")) continue;
      const tabIndex = element.getAttribute("tabindex");
      if (tabIndex !== null && Number.parseInt(tabIndex, 10) < 0) continue;
      if (!rendered(element) || inert(element)) continue;
      if (ariaHidden(element)) report("focusable-hidden", element);
    }

    // Contrast is judged only where the colours behind the text are known:
    // solid backgrounds, composited up the ancestors. Text over an image, a
    // gradient, or a layered element whose backdrop is another element is
    // counted as not measured rather than guessed, and so is text under a
    // filter, blend mode, or partial opacity anywhere above it: an ancestor's
    // opacity fades the text and its own opaque background together, so where
    // the search for a background stops says nothing about it.
    type Color = readonly [number, number, number, number];
    const parseColor = (value: string): Color | undefined => {
      const match =
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(
          value.trim(),
        );
      if (match === null) return undefined;
      const alpha =
        match[4] === undefined ? 1 : match[5] === "%" ? Number(match[4]) / 100 : Number(match[4]);
      return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
    };
    const over = (top: Color, bottom: Color): Color => [
      top[0] * top[3] + bottom[0] * (1 - top[3]),
      top[1] * top[3] + bottom[1] * (1 - top[3]),
      top[2] * top[3] + bottom[2] * (1 - top[3]),
      1,
    ];
    const canvasDark = /\bdark\b/.test(
      window.getComputedStyle(document.documentElement).colorScheme,
    );
    // The colour behind an element, or null when it cannot be known.
    const backdrops = new Map<Element, Color | null>();
    const backdrop = (element: Element): Color | null => {
      const known = backdrops.get(element);
      if (known !== undefined) return known;
      const style = window.getComputedStyle(element);
      const own = parseColor(style.backgroundColor);
      let result: Color | null;
      if (own === undefined || style.backgroundImage !== "none") {
        result = null;
      } else if (own[3] >= 1) {
        result = own;
      } else if (["absolute", "fixed", "sticky"].includes(style.position)) {
        result = null;
      } else {
        const parent = renderedParent(element);
        const below: Color | null =
          parent === null ? (canvasDark ? null : [255, 255, 255, 1]) : backdrop(parent);
        result = below === null ? null : own[3] > 0 ? over(own, below) : below;
      }
      backdrops.set(element, result);
      return result;
    };
    // Whether the element or any ancestor is drawn through a filter, a blend
    // mode, or partial opacity, which change the colours a person sees.
    const compositing = new Map<Element, boolean>();
    const composited = (element: Element): boolean => {
      const known = compositing.get(element);
      if (known !== undefined) return known;
      const style = window.getComputedStyle(element);
      const parent = renderedParent(element);
      const result =
        style.filter !== "none" ||
        style.mixBlendMode !== "normal" ||
        Number.parseFloat(style.opacity) < 1 ||
        (parent !== null && composited(parent));
      compositing.set(element, result);
      return result;
    };
    const luminance = (color: Color): number => {
      const channel = (value: number) => {
        const unit = value / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
    };
    const hex = (color: Color): string =>
      `#${color
        .slice(0, 3)
        .map((value) => Math.round(value).toString(16).padStart(2, "0"))
        .join("")}`;
    let contrastNotMeasured = 0;
    for (const element of audited) {
      if (
        element instanceof SVGElement ||
        ["option", "select", "textarea"].includes(element.localName)
      ) {
        continue;
      }
      // Text is judged where it is drawn: a host's own text is drawn by the
      // slot it is assigned to, in the slot's colours, and not at all if no
      // slot takes it. A slot, like any `display: contents` element, has no
      // box of its own, so the nearest ancestor with one stands for it.
      const ownText = shownNodes(element).some(
        (node) => node.nodeType === Node.TEXT_NODE && filled(node.textContent),
      );
      if (!ownText || disabled(element)) continue;
      let drawn: Element | null = element;
      while (drawn !== null && window.getComputedStyle(drawn).display === "contents") {
        drawn = renderedParent(drawn);
      }
      if (drawn === null || !rendered(drawn)) continue;
      if (drawn !== element && window.getComputedStyle(element).visibility !== "visible") continue;
      const box = drawn.getBoundingClientRect();
      // Text clipped to a point is for screen readers only.
      if (box.width < 2 || box.height < 2) continue;
      const style = window.getComputedStyle(element);
      const foreground = parseColor(
        style.getPropertyValue("-webkit-text-fill-color") || style.color,
      );
      if (foreground !== undefined && foreground[3] === 0) continue;
      const behind = backdrop(element);
      if (
        foreground === undefined ||
        behind === null ||
        style.textShadow !== "none" ||
        composited(element)
      ) {
        contrastNotMeasured += 1;
        continue;
      }
      const painted = foreground[3] < 1 ? over(foreground, behind) : foreground;
      const lighter = Math.max(luminance(painted), luminance(behind));
      const darker = Math.min(luminance(painted), luminance(behind));
      const ratio = (lighter + 0.05) / (darker + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      if (ratio < required) {
        report("color-contrast", element, {
          ratio: Math.floor(ratio * 100) / 100,
          required,
          foreground: hex(painted),
          background: hex(behind),
        });
      }
    }

    // Touch targets, only where the page is a touch device: on a fine pointer
    // the rule does not apply.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (touch) {
      const targetSelector =
        "a[href], area[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option]";
      const targets = audited
        .filter(
          (element) =>
            element.matches(targetSelector) &&
            exposed(element) &&
            !disabled(element) &&
            // A browser-drawn checkbox or radio keeps the size the browser gave it.
            !(
              element instanceof HTMLInputElement &&
              (element.type === "checkbox" || element.type === "radio") &&
              window.getComputedStyle(element).appearance !== "none"
            ),
        )
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.height > 0);
      // A link in a sentence is sized by the sentence it sits in: the nodes
      // drawn beside it, which for a slotted link are the slot's.
      const inline = (element: Element): boolean => {
        if (window.getComputedStyle(element).display !== "inline") return false;
        const parent = renderedParent(element);
        return (parent === null ? [] : shownNodes(parent)).some(
          (node) => node.nodeType === Node.TEXT_NODE && filled(node.textContent),
        );
      };
      // Whether one element is drawn inside another, across slots and hosts.
      const drawnInside = (inner: Element, outer: Element): boolean =>
        ancestry(inner).includes(outer);
      const small = (box: DOMRect) => box.width < 24 || box.height < 24;
      const centre = (box: DOMRect) => ({
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
      });
      const distanceTo = (point: { x: number; y: number }, box: DOMRect) =>
        Math.hypot(
          Math.max(box.left - point.x, 0, point.x - box.right),
          Math.max(box.top - point.y, 0, point.y - box.bottom),
        );
      // Every target the audit read is checked, but only against the targets
      // near it: each is filed in the 24 pixel cells its box, widened by the
      // 12 pixel reach of a neighbour's circle, covers, and a small target
      // looks only in the cells around its centre. A page whose boxes would
      // fill more cells, or put more targets side by side, than the budgets
      // allow says it was cut rather than answering from part of it.
      const cell = 24;
      const cells = new Map<string, Array<(typeof targets)[number]>>();
      let filed = 0;
      let compared = 0;
      const placed: Array<(typeof targets)[number]> = [];
      for (const target of targets) {
        const left = Math.floor((target.box.left - 12) / cell);
        const right = Math.floor((target.box.right + 12) / cell);
        const top = Math.floor((target.box.top - 12) / cell);
        const bottom = Math.floor((target.box.bottom + 12) / cell);
        filed += (right - left + 1) * (bottom - top + 1);
        if (filed > 100_000) {
          truncatedAudit = true;
          break;
        }
        for (let x = left; x <= right; x += 1) {
          for (let y = top; y <= bottom; y += 1) {
            const key = `${String(x)},${String(y)}`;
            const held = cells.get(key);
            if (held === undefined) cells.set(key, [target]);
            else held.push(target);
          }
        }
        placed.push(target);
      }
      for (const target of placed) {
        if (!small(target.box) || inline(target.element)) continue;
        const middle = centre(target.box);
        const near = new Set<(typeof targets)[number]>();
        for (let x = Math.floor((middle.x - cell) / cell); x * cell <= middle.x + cell; x += 1) {
          for (let y = Math.floor((middle.y - cell) / cell); y * cell <= middle.y + cell; y += 1) {
            for (const other of cells.get(`${String(x)},${String(y)}`) ?? []) near.add(other);
          }
        }
        compared += near.size;
        if (compared > 200_000) {
          truncatedAudit = true;
          break;
        }
        // The spacing exception: a 24 pixel circle on the target's centre that
        // reaches no other target, and no other small target's circle.
        const crowded = Array.from(near).some((other) => {
          if (other === target) return false;
          const reaches =
            distanceTo(middle, other.box) < 12 ||
            (small(other.box) &&
              Math.hypot(middle.x - centre(other.box).x, middle.y - centre(other.box).y) < 24);
          return (
            reaches &&
            !drawnInside(target.element, other.element) &&
            !drawnInside(other.element, target.element)
          );
        });
        if (crowded) {
          report("target-size", target.element, {
            width: Math.round(target.box.width),
            height: Math.round(target.box.height),
          });
        }
      }
    }

    const reading: BrowserAccessibilityReading = {
      findings,
      found: Array.from(found, ([rule, count]) => ({ rule, count })),
      touch,
      contrastNotMeasured,
      frames: roots.reduce((sum, root) => sum + root.querySelectorAll("iframe, frame").length, 0),
      truncated: truncatedAudit,
    };
    return { mode: "accessibility", reading };
  }

  const holdsCredential =
    request.protectCredentials &&
    (request.withholdValues ||
      roots.some((root) => Array.from(root.querySelectorAll("*")).some(isCredential)));
  const nodes: BrowserPageSnapshotNode[] = [];
  const refs: BrowserPageSnapshotRef[] = [];
  const refOffset = request.refOffset ?? 0;
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
      if (root instanceof ShadowRoot && !part.startsWith("#")) {
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
export function browserFrameContentOffset(frame: Element | null): {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
} | null {
  if (!(frame instanceof HTMLIFrameElement || frame instanceof HTMLFrameElement)) return null;
  frame.scrollIntoView({ block: "nearest", inline: "nearest" });
  const box = frame.getBoundingClientRect();
  const style = window.getComputedStyle(frame);
  // A scaled frame (a transform on it or an ancestor) draws its own pixels
  // smaller or larger: the drawn box against the laid-out one gives the scale.
  const scaleX = frame.offsetWidth > 0 ? box.width / frame.offsetWidth : 1;
  const scaleY = frame.offsetHeight > 0 ? box.height / frame.offsetHeight : 1;
  return {
    x: box.left + (frame.clientLeft + Number.parseFloat(style.paddingLeft || "0")) * scaleX,
    y: box.top + (frame.clientTop + Number.parseFloat(style.paddingTop || "0")) * scaleY,
    scaleX,
    scaleY,
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

export const BROWSER_EDITABLE_WORLD_ID = 1_002;
/**
 * The name the preload gives isolated world 1002. Electron reaches that world
 * only in the main frame; in a nested frame Stable finds the same world's
 * protocol context by this name.
 */
export const BROWSER_EDITABLE_WORLD_NAME = "octant-browser-presentation";

/**
 * Installed by the sandboxed document-start preload in every frame, before
 * page listeners. The function is serialized for the real-page test, so it
 * stays self-contained.
 */
export function observeBrowserEditableTarget() {
  const fresh = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
    bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  let root = document.documentElement;
  let supported = true;
  const documentLifetime = new MutationObserver(() => {
    const current = document.documentElement;
    if (root === null) root = current;
    else if (current !== root) supported = false;
  });
  documentLifetime.observe(document, { childList: true });
  let active: Element | null = null;
  let id = fresh();
  const retire = () => {
    active = null;
    id = fresh();
  };
  // Isolated globals do not isolate DOM event propagation. These window capture
  // observers must precede page scripts; an on-demand late observer is unsafe.
  window.addEventListener("focusin", retire, true);
  window.addEventListener("focusout", retire, true);
  const focused = (): Element | null | undefined => {
    if (!supported) return undefined;
    const next: unknown = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "activeElement",
    )?.get?.call(document);
    if (next !== null && !(next instanceof Element)) return undefined;
    return next;
  };
  // Chromium edits these input types as text. Email and number fields expose
  // no selection to page code; a password field's offsets stay in Stable.
  const TEXT = ["text", "search", "url", "tel"];
  const FIELD = ["email", "number"];
  const finite = (value: number) => Number.isFinite(value) && Math.abs(value) <= 100_000;
  const rect = (x: number, y: number, height: number) =>
    finite(x) && finite(y) && finite(height) && height > 0
      ? Object.freeze({ x, y, width: 0, height })
      : null;
  const pixels = (value: string) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  /** The start of a field's text box: a field without a selection API has no caret offset. */
  const fieldCaret = (element: Element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const top = pixels(style.borderTopWidth) + pixels(style.paddingTop);
    const height = box.height - top - pixels(style.borderBottomWidth) - pixels(style.paddingBottom);
    return rect(
      box.left + pixels(style.borderLeftWidth) + pixels(style.paddingLeft),
      box.top + top,
      Math.max(1, height),
    );
  };
  /** The collapsed start of the selection inside an editing host, one line high. */
  const richCaret = (host: Element, selection: Selection) => {
    if (selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!host.contains(range.startContainer)) return null;
    const point = range.cloneRange();
    point.collapse(true);
    const line = Array.from(point.getClientRects()).find((box) => box.height > 0);
    if (line !== undefined) return rect(line.left, line.top, line.height);
    // An empty line or host has no text box at the caret: its element gives
    // the line's start, and the line height bounds the caret.
    const container =
      point.startContainer instanceof Element
        ? point.startContainer
        : point.startContainer.parentElement;
    if (container === null) return null;
    const child =
      point.startContainer instanceof Element
        ? point.startContainer.childNodes[point.startOffset]
        : undefined;
    const anchor = child instanceof Element ? child : container;
    const box = anchor.getBoundingClientRect();
    const style = getComputedStyle(anchor);
    const lineHeight = pixels(style.lineHeight) || pixels(style.fontSize) * 1.2 || 16;
    return rect(
      box.left + pixels(style.borderLeftWidth) + pixels(style.paddingLeft),
      box.top + pixels(style.borderTopWidth) + pixels(style.paddingTop),
      Math.min(Math.max(1, lineHeight), Math.max(1, box.height)),
    );
  };
  return Object.freeze({
    /** Whether focus sits in a nested frame, whose own observer then answers. */
    inFrame: (): boolean => {
      const element = focused();
      return element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement;
    },
    read: (): {
      readonly id: string;
      readonly kind: "text" | "secure" | "field" | "rich";
      readonly selectionStart?: number;
      readonly selectionEnd?: number;
      readonly collapsed?: boolean;
      readonly caret?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    } | null => {
      const next = focused();
      if (next === undefined) return null;
      if (active !== next) {
        active = next;
        id = fresh();
      }
      if (active === null || !active.isConnected) return null;
      const input = active instanceof HTMLInputElement;
      if (!input && !(active instanceof HTMLTextAreaElement)) {
        // A rich text editor: the editing host holds focus and the selection.
        const editable =
          active instanceof HTMLElement
            ? Object.getOwnPropertyDescriptor(
                HTMLElement.prototype,
                "isContentEditable",
              )?.get?.call(active)
            : false;
        const selection = document.getSelection();
        if (editable !== true || selection === null) return null;
        const caret = richCaret(active, selection);
        return caret === null
          ? null
          : Object.freeze({ id, kind: "rich", collapsed: selection.isCollapsed, caret });
      }
      const prototype = input ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const native = (name: string): unknown =>
        Object.getOwnPropertyDescriptor(prototype, name)?.get?.call(active);
      if (native("readOnly") !== false || native("disabled") !== false) return null;
      const type = input ? String(native("type")) : "textarea";
      if (FIELD.includes(type)) {
        const caret = fieldCaret(active);
        return caret === null ? null : Object.freeze({ id, kind: "field", caret });
      }
      if (input && type !== "password" && !TEXT.includes(type)) return null;
      const start = native("selectionStart"),
        end = native("selectionEnd");
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        end > 1_048_576
      )
        return null;
      return Object.freeze({
        id,
        kind: type === "password" ? "secure" : "text",
        selectionStart: start,
        selectionEnd: end,
      });
    },
  });
}

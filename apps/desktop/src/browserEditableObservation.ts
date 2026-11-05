export const BROWSER_EDITABLE_WORLD_ID = 1_002;

/** Installed by the sandboxed document-start preload, before page listeners. */
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
  return Object.freeze({
    read: (): {
      readonly id: string;
      readonly selectionStart: number;
      readonly selectionEnd: number;
    } | null => {
      if (!supported) return null;
      const next: unknown = Object.getOwnPropertyDescriptor(
        Document.prototype,
        "activeElement",
      )?.get?.call(document);
      if (next !== null && !(next instanceof Element)) return null;
      if (active !== next) {
        active = next;
        id = fresh();
      }
      const input = active instanceof HTMLInputElement;
      if (active === null || (!input && !(active instanceof HTMLTextAreaElement))) return null;
      const prototype = input ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const native = (name: string): unknown =>
        Object.getOwnPropertyDescriptor(prototype, name)?.get?.call(active);
      if (input && !["text", "search", "url", "tel"].includes(String(native("type")))) return null;
      if (native("readOnly") !== false || native("disabled") !== false || !active.isConnected)
        return null;
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
      return Object.freeze({ id, selectionStart: start, selectionEnd: end });
    },
  });
}

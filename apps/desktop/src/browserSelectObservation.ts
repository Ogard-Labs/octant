/**
 * Installed by the sandboxed document-start preload of Stable's hidden Browser
 * window, in the same private isolated world as the editable observer. A
 * select list opened there would draw Chromium's own popup over a window
 * nobody can see, so a trusted press that would open one is held instead and
 * its options are offered to the person's native menu. Only a single-choice
 * list in the main frame is held; a list box draws inside the page itself.
 *
 * The function is serialized for the real-page test, so it stays self-contained.
 */
export function observeBrowserSelectPopup() {
  const MAX_OPTIONS = 512;
  const MAX_LABEL = 256;
  // Stable offers a hold only this soon after the person's own press; keep in step.
  const HOLD_MS = 1_500;
  // The person may take a while to choose from the menu once it is offered.
  const ANSWER_MS = 60_000;
  const fresh = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
    bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const mac = /Mac/.test(navigator.platform);
  let held: {
    readonly select: HTMLSelectElement;
    readonly token: string;
    readonly at: number;
  } | null = null;
  const single = (value: unknown): value is HTMLSelectElement =>
    value instanceof HTMLSelectElement && !value.multiple && value.size <= 1 && !value.disabled;
  const owner = (event: Event): HTMLSelectElement | null => {
    const target = event.composedPath()[0];
    if (single(target)) return target;
    if (target instanceof HTMLOptionElement || target instanceof HTMLOptGroupElement) {
      const select = target.closest("select");
      return single(select) ? select : null;
    }
    return null;
  };
  const hold = (event: Event, select: HTMLSelectElement) => {
    event.preventDefault();
    select.focus({ preventScroll: true });
    held = { select, token: fresh(), at: performance.now() };
  };
  // Window capture listeners registered before page scripts run first; a page
  // listener cannot stop them, and preventing the default keeps Chromium's
  // popup closed.
  window.addEventListener(
    "mousedown",
    (event) => {
      if (!event.isTrusted) return;
      const select = event.button === 0 ? owner(event) : null;
      // Any other press ends an earlier hold, so a later press elsewhere never
      // revives a list someone else opened.
      if (select === null) held = null;
      else hold(event, select);
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted) return;
      const select = owner(event);
      const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
      if (
        select !== null &&
        (event.key === " " || event.key === "F4" || (arrow && (event.altKey || mac)))
      )
        hold(event, select);
      else held = null;
    },
    true,
  );
  const live = (token: string) =>
    held !== null &&
    held.token === token &&
    held.select.isConnected &&
    !held.select.disabled &&
    performance.now() - held.at <= ANSWER_MS;
  const text = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    let end = Math.min(trimmed.length, MAX_LABEL);
    // Never split a surrogate pair at the bound.
    if (end < trimmed.length && /[\uD800-\uDBFF]/.test(trimmed[end - 1] ?? "")) end -= 1;
    return trimmed.slice(0, end).isWellFormed() ? trimmed.slice(0, end) : "";
  };
  return Object.freeze({
    read: () => {
      if (held === null || !live(held.token) || performance.now() - held.at > HOLD_MS) return null;
      const { select, token } = held;
      const options = Array.from(select.options);
      if (options.length === 0) return null;
      if (options.length > MAX_OPTIONS) return Object.freeze({ token, tooMany: true });
      const rect = select.getBoundingClientRect();
      return Object.freeze({
        token,
        age: Math.max(0, performance.now() - held.at),
        anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        selectedIndex: select.selectedIndex,
        options: options.map((option) => {
          const group =
            option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
          return {
            label: text(option.label),
            disabled: option.disabled || group?.disabled === true,
            ...(group === null ? {} : { group: text(group.label) }),
          };
        }),
      });
    },
    answer: (token: string, index: number): boolean => {
      if (held === null || !live(token)) return false;
      const { select } = held;
      held = null;
      const option = select.options[index];
      if (
        !Number.isInteger(index) ||
        option === undefined ||
        option.disabled ||
        (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)
      )
        return false;
      if (select.selectedIndex === index) return true;
      select.selectedIndex = index;
      // Chromium's own popup reports a choice as input then change.
      select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    dismiss: (token: string): boolean => {
      if (held === null || held.token !== token) return false;
      held = null;
      return true;
    },
  });
}

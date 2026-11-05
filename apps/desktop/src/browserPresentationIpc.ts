import type {
  HumanBrowserRequest,
  HumanBrowserResult,
} from "@octant/contracts/browser-presentation";

// The sandboxed preload cannot load Effect or a runtime package. Main and server
// independently decode the authoritative schema; these guards bound this IPC hop.
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: ReadonlyArray<string>) =>
  Object.keys(value).every((key) => allowed.includes(key));
const number = (value: unknown, maximum: number, minimum = 0): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
const integer = (value: unknown, maximum: number, minimum = 0): value is number =>
  number(value, maximum, minimum) && Number.isInteger(value);
const text = (value: unknown, maximum: number, minimum = 0): value is string =>
  typeof value === "string" && value.length >= minimum && value.length <= maximum;
function input(value: unknown): boolean {
  if (!record(value)) return false;
  if (
    value.modifiers !== undefined &&
    (!Array.isArray(value.modifiers) ||
      value.modifiers.length > 4 ||
      !value.modifiers.every((modifier) => ["shift", "control", "alt", "meta"].includes(modifier)))
  )
    return false;
  if (["keyDown", "keyUp", "char"].includes(String(value.type)))
    return keys(value, ["type", "keyCode", "modifiers"]) && text(value.keyCode, 64, 1);
  if (!integer(value.x, 1_920) || !integer(value.y, 1_200)) return false;
  if (value.type === "mouseWheel")
    return (
      keys(value, ["type", "x", "y", "deltaX", "deltaY", "modifiers"]) &&
      number(value.deltaX, 2_000, -2_000) &&
      number(value.deltaY, 2_000, -2_000)
    );
  return (
    ["mouseMove", "mouseDown", "mouseUp"].includes(String(value.type)) &&
    keys(value, ["type", "x", "y", "button", "clickCount", "modifiers"]) &&
    ["left", "middle", "right"].includes(String(value.button)) &&
    integer(value.clickCount, 2)
  );
}
function isRequest(value: unknown): value is HumanBrowserRequest {
  if (!record(value) || !uuid(value.contextId) || !uuid(value.threadId)) return false;
  const base = ["contextId", "threadId", "kind"];
  if (value.kind === "attach") return keys(value, base);
  if (!uuid(value.presentationId)) return false;
  const owned = [...base, "presentationId"];
  if (value.kind === "state" || value.kind === "detach") return keys(value, owned);
  if (value.kind === "frame")
    return (
      keys(value, [...owned, "acknowledgement"]) &&
      integer(value.acknowledgement, Number.MAX_SAFE_INTEGER)
    );
  if (value.kind === "input")
    return (
      keys(value, [...owned, "input", "frameSequence"]) &&
      integer(value.frameSequence, Number.MAX_SAFE_INTEGER) &&
      input(value.input)
    );
  if (value.kind === "layout")
    return (
      keys(value, [...owned, "layout"]) &&
      record(value.layout) &&
      keys(value.layout, ["width", "height", "visible"]) &&
      integer(value.layout.width, 1_920, 1) &&
      integer(value.layout.height, 1_200, 1) &&
      typeof value.layout.visible === "boolean"
    );
  if (value.kind === "command")
    return (
      keys(value, [...owned, "command"]) &&
      ["back", "forward", "reload", "stop"].includes(String(value.command))
    );
  if (value.kind === "tab")
    return (
      keys(value, [...owned, "command"]) &&
      record(value.command) &&
      (value.command.kind === "open"
        ? keys(value.command, ["kind"])
        : ["select", "close"].includes(String(value.command.kind)) &&
          keys(value.command, ["kind", "tabId"]) &&
          text(value.command.tabId, 64, 1))
    );
  return false;
}
function isState(value: unknown): boolean {
  return (
    record(value) &&
    keys(value, [
      "contextId",
      "url",
      "title",
      "loading",
      "canGoBack",
      "canGoForward",
      "control",
      "tabs",
      "activeTabId",
    ]) &&
    text(value.contextId, 64, 1) &&
    text(value.url, 8_192) &&
    text(value.title, 1_024) &&
    typeof value.loading === "boolean" &&
    typeof value.canGoBack === "boolean" &&
    typeof value.canGoForward === "boolean" &&
    ["idle", "user", "agent"].includes(String(value.control)) &&
    text(value.activeTabId, 64, 1) &&
    Array.isArray(value.tabs) &&
    value.tabs.length <= 32 &&
    value.tabs.every(
      (tab) =>
        record(tab) &&
        keys(tab, ["tabId", "url", "title"]) &&
        text(tab.tabId, 64, 1) &&
        text(tab.url, 8_192) &&
        text(tab.title, 1_024),
    )
  );
}
function isResult(value: unknown): value is HumanBrowserResult {
  if (!record(value)) return false;
  if (["accepted", "idle", "refused"].includes(String(value.status)))
    return keys(value, ["status"]);
  if (value.status === "attached")
    return keys(value, ["status", "presentationId"]) && uuid(value.presentationId);
  if (value.status === "state") return keys(value, ["status", "state"]) && isState(value.state);
  return (
    value.status === "frame" &&
    keys(value, ["status", "sequence", "width", "height", "dataUrl"]) &&
    integer(value.sequence, Number.MAX_SAFE_INTEGER, 1) &&
    integer(value.width, 1_920, 1) &&
    integer(value.height, 1_200, 1) &&
    text(value.dataUrl, Math.ceil((4 * 1_024 * 1_024 * 4) / 3) + 32) &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/.test(value.dataUrl)
  );
}
export function decodeHumanBrowserIpcRequest(value: unknown): HumanBrowserRequest {
  if (!isRequest(value)) throw new TypeError("Invalid Browser presentation request.");
  return value;
}
export function decodeHumanBrowserIpcResult(value: unknown): HumanBrowserResult {
  if (!isResult(value)) throw new TypeError("Invalid Browser presentation response.");
  return value;
}

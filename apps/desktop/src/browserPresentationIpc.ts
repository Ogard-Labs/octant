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
function composition(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.phase === "begin") return keys(value, ["phase", "editorId"]) && uuid(value.editorId);
  if (!uuid(value.compositionId)) return false;
  if (value.phase === "cancel") return keys(value, ["phase", "compositionId"]);
  if (!text(value.text, 256) || !value.text.isWellFormed()) return false;
  if (value.phase === "commit") return keys(value, ["phase", "compositionId", "text"]);
  if (
    value.phase !== "update" ||
    !keys(value, ["phase", "compositionId", "text", "selectionStart", "selectionEnd"]) ||
    !integer(value.selectionStart, value.text.length) ||
    !integer(value.selectionEnd, value.text.length) ||
    value.selectionEnd < value.selectionStart
  )
    return false;
  const candidate = value.text;
  const boundary = (offset: number) =>
    !(
      offset > 0 &&
      offset < candidate.length &&
      /[\uD800-\uDBFF]/.test(candidate[offset - 1] ?? "") &&
      /[\uDC00-\uDFFF]/.test(candidate[offset] ?? "")
    );
  return boundary(value.selectionStart) && boundary(value.selectionEnd);
}
function editor(value: unknown): boolean {
  if (!record(value) || !uuid(value.id)) return false;
  // A password field carries its identity alone, never offsets or a caret.
  if ("secure" in value) return keys(value, ["id", "secure"]) && value.secure === true;
  const offsets = "selectionStart" in value || "selectionEnd" in value;
  if (
    !keys(value, offsets ? ["id", "selectionStart", "selectionEnd", "caret"] : ["id", "caret"]) ||
    (offsets &&
      (!integer(value.selectionStart, 1_048_576) ||
        !integer(value.selectionEnd, 1_048_576) ||
        value.selectionEnd < value.selectionStart)) ||
    !record(value.caret) ||
    !keys(value.caret, ["x", "y", "width", "height"])
  )
    return false;
  return (
    number(value.caret.x, 1_920) &&
    number(value.caret.y, 1_200) &&
    number(value.caret.width, 1_920) &&
    number(value.caret.height, 1_200, Number.MIN_VALUE)
  );
}
const nodeId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-z]{1,8}-[0-9]{1,12}$/.test(value);
const wellFormed = (value: unknown, maximum: number): boolean =>
  text(value, maximum) && value.isWellFormed();
function accessibilityAction(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.action === "set-value")
    return keys(value, ["action", "value"]) && wellFormed(value.value, 1_024);
  return (
    keys(value, ["action"]) &&
    ["press", "focus", "scroll-into-view", "increment", "decrement"].includes(String(value.action))
  );
}
/** The mirror's closed roles; a test keeps this list equal to the contract's. */
export const BROWSER_ACCESSIBILITY_IPC_ROLES: ReadonlyArray<string> = [
  "alert",
  "alertdialog",
  "article",
  "banner",
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "dialog",
  "document",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "option",
  "paragraph",
  "progressbar",
  "radio",
  "region",
  "row",
  "rowheader",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "text",
  "textbox",
  "tree",
  "treeitem",
];
const ACCESSIBILITY_ROLES = new Set(BROWSER_ACCESSIBILITY_IPC_ROLES);
/** The contract's tree rule: unique nodes, one parent each, all reached from the root, at most 64 deep. */
function soundTree(
  nodes: ReadonlyArray<{ readonly id: string; readonly children: ReadonlyArray<string> }>,
  rootId: string,
): boolean {
  const byId = new Map<string, ReadonlyArray<string>>();
  for (const node of nodes) {
    if (byId.has(node.id)) return false;
    byId.set(node.id, node.children);
  }
  if (!byId.has(rootId)) return false;
  const parented = new Set<string>();
  for (const children of byId.values())
    for (const child of children) {
      if (!byId.has(child) || child === rootId || parented.has(child)) return false;
      parented.add(child);
    }
  let reached = 1;
  let level = [rootId];
  for (let depth = 1; level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of level) next.push(...(byId.get(id) ?? []));
    if ((next.length > 0 && depth >= 64) || reached + next.length > byId.size) return false;
    reached += next.length;
    level = next;
  }
  return reached === byId.size;
}
const NODE_FLAGS = [
  "secure",
  "disabled",
  "focusable",
  "required",
  "invalid",
  "readonly",
  "multiline",
] as const;
const NODE_KEYS = [
  "id",
  "role",
  "name",
  "description",
  "value",
  "level",
  "checked",
  "pressed",
  "expanded",
  "selected",
  "valueNow",
  "valueMin",
  "valueMax",
  "live",
  "bounds",
  "children",
  ...NODE_FLAGS,
];
function accessibilityNode(value: unknown): value is { id: string; children: string[] } {
  if (
    !record(value) ||
    !keys(value, NODE_KEYS) ||
    !nodeId(value.id) ||
    !ACCESSIBILITY_ROLES.has(String(value.role)) ||
    !Array.isArray(value.children) ||
    value.children.length > 512 ||
    !value.children.every(nodeId)
  )
    return false;
  // A password field's value never reaches the renderer.
  if (value.secure !== undefined && value.value !== undefined) return false;
  const optional = (name: string, check: (field: unknown) => boolean) =>
    value[name] === undefined || check(value[name]);
  const tristate = (field: unknown) => ["true", "false", "mixed"].includes(String(field));
  const range = (field: unknown) => number(field, 1e9, -1e9);
  return (
    optional("name", (field) => wellFormed(field, 512)) &&
    optional("description", (field) => wellFormed(field, 512)) &&
    optional("value", (field) => wellFormed(field, 1_024)) &&
    optional("level", (field) => integer(field, 9, 1)) &&
    optional("checked", tristate) &&
    optional("pressed", tristate) &&
    optional("expanded", (field) => typeof field === "boolean") &&
    optional("selected", (field) => typeof field === "boolean") &&
    optional("valueNow", range) &&
    optional("valueMin", range) &&
    optional("valueMax", range) &&
    optional("live", (field) => field === "polite" || field === "assertive") &&
    optional(
      "bounds",
      (field) =>
        record(field) &&
        keys(field, ["x", "y", "width", "height"]) &&
        number(field.x, 1_920, -1_920) &&
        number(field.y, 1_200, -1_200) &&
        number(field.width, 3_840) &&
        number(field.height, 2_400),
    ) &&
    NODE_FLAGS.every((flag) => optional(flag, (field) => field === true))
  );
}
function accessibilityUpdate(value: unknown): boolean {
  if (!record(value)) return false;
  const head = ["kind", "revision", "rootId", "focusedId", "truncated", "nodes"];
  if (
    !integer(value.revision, Number.MAX_SAFE_INTEGER, 1) ||
    !nodeId(value.rootId) ||
    (value.focusedId !== undefined && !nodeId(value.focusedId)) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 1_500 ||
    !value.nodes.every(accessibilityNode)
  )
    return false;
  if (value.kind === "full")
    return (
      keys(value, head) &&
      soundTree(value.nodes, value.rootId) &&
      (value.focusedId === undefined ||
        value.nodes.some((node: { readonly id: string }) => node.id === value.focusedId))
    );
  return (
    value.kind === "patch" &&
    keys(value, [...head, "base", "removed"]) &&
    integer(value.base, value.revision - 1, 1) &&
    Array.isArray(value.removed) &&
    value.removed.length <= 1_500 &&
    value.removed.every(nodeId)
  );
}
function isRequest(value: unknown): value is HumanBrowserRequest {
  if (!record(value) || !uuid(value.contextId) || !uuid(value.threadId)) return false;
  const base = ["contextId", "threadId", "kind"];
  if (value.kind === "attach") return keys(value, base);
  if (!uuid(value.presentationId)) return false;
  const owned = [...base, "presentationId"];
  if (value.kind === "state" || value.kind === "detach" || value.kind === "editor")
    return keys(value, owned);
  if (value.kind === "accessibility")
    return keys(value, [...owned, "revision"]) && integer(value.revision, Number.MAX_SAFE_INTEGER);
  if (value.kind === "accessibility-action")
    return (
      keys(value, [...owned, "revision", "nodeId", "action"]) &&
      integer(value.revision, Number.MAX_SAFE_INTEGER, 1) &&
      nodeId(value.nodeId) &&
      accessibilityAction(value.action)
    );
  if (value.kind === "composition")
    return keys(value, [...owned, "composition"]) && composition(value.composition);
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
  if (["accepted", "idle", "refused", "editor-unavailable"].includes(String(value.status)))
    return keys(value, ["status"]);
  if (value.status === "editor") return keys(value, ["status", "editor"]) && editor(value.editor);
  if (value.status === "accessibility")
    return keys(value, ["status", "update"]) && accessibilityUpdate(value.update);
  if (value.status === "composition-started")
    return keys(value, ["status", "compositionId"]) && uuid(value.compositionId);
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

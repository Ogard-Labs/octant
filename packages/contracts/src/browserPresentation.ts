import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { BrowserContextId, BrowserThreadId } from "./browserAutomation";

export const MAX_HUMAN_FRAME_WIDTH = 1_920;
export const MAX_HUMAN_FRAME_HEIGHT = 1_200;
export const MAX_HUMAN_FRAME_BYTES = 4 * 1_024 * 1_024;
export const BrowserPresentationId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserPresentationId"),
);
export type BrowserPresentationId = typeof BrowserPresentationId.Type;
export const decodeBrowserPresentationId = Schema.decodeUnknownSync(
  BrowserPresentationId,
  STRICT_DECODE_OPTIONS,
);
export const BrowserEditorId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserEditorId"),
);
export type BrowserEditorId = typeof BrowserEditorId.Type;
export const decodeBrowserEditorId = Schema.decodeUnknownSync(
  BrowserEditorId,
  STRICT_DECODE_OPTIONS,
);
export const BrowserCompositionId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserCompositionId"),
);
export type BrowserCompositionId = typeof BrowserCompositionId.Type;
export const decodeBrowserCompositionId = Schema.decodeUnknownSync(
  BrowserCompositionId,
  STRICT_DECODE_OPTIONS,
);
export const BrowserEditMenuId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserEditMenuId"),
);
export type BrowserEditMenuId = typeof BrowserEditMenuId.Type;
export const decodeBrowserEditMenuId = Schema.decodeUnknownSync(
  BrowserEditMenuId,
  STRICT_DECODE_OPTIONS,
);
export const BrowserEditAction = Schema.Literals([
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
]);
export type BrowserEditAction = typeof BrowserEditAction.Type;
export const BrowserEditFlags = Schema.Struct({
  undo: Schema.Boolean,
  redo: Schema.Boolean,
  cut: Schema.Boolean,
  copy: Schema.Boolean,
  paste: Schema.Boolean,
  selectAll: Schema.Boolean,
});
export type BrowserEditFlags = typeof BrowserEditFlags.Type;
export const MAX_BROWSER_COMPOSITION_TEXT = 256;
const CandidateText = Schema.String.check(
  Schema.isMaxLength(MAX_BROWSER_COMPOSITION_TEXT),
  Schema.makeFilter((text) => text.isWellFormed()),
);
const CandidateOffset = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: MAX_BROWSER_COMPOSITION_TEXT }),
);
export const HumanBrowserComposition = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("begin"), editorId: BrowserEditorId }),
  Schema.Struct({
    phase: Schema.Literal("update"),
    compositionId: BrowserCompositionId,
    text: CandidateText,
    selectionStart: CandidateOffset,
    selectionEnd: CandidateOffset,
  }).check(
    Schema.makeFilter((value) => {
      const boundary = (offset: number) =>
        offset <= value.text.length &&
        !(
          offset > 0 &&
          offset < value.text.length &&
          /[\uD800-\uDBFF]/.test(value.text[offset - 1] ?? "") &&
          /[\uDC00-\uDFFF]/.test(value.text[offset] ?? "")
        );
      return (
        value.selectionStart <= value.selectionEnd &&
        boundary(value.selectionStart) &&
        boundary(value.selectionEnd)
      );
    }),
  ),
  Schema.Struct({
    phase: Schema.Literal("commit"),
    compositionId: BrowserCompositionId,
    text: CandidateText,
  }),
  Schema.Struct({
    phase: Schema.Literal("cancel"),
    compositionId: BrowserCompositionId,
  }),
]);
export type HumanBrowserComposition = typeof HumanBrowserComposition.Type;
const EditorCaret = Schema.Struct({
  x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: MAX_HUMAN_FRAME_WIDTH })),
  y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: MAX_HUMAN_FRAME_HEIGHT })),
  width: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: MAX_HUMAN_FRAME_WIDTH })),
  height: Schema.Number.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_HUMAN_FRAME_HEIGHT),
  ),
});
/**
 * The focused page field, as Nightly may know it. A standard text control
 * carries its UTF16 selection offsets; an email or number field and a rich
 * text editor carry only their caret; a password field carries only its
 * identity, never a value, offset, caret or selection text.
 */
export const HumanBrowserEditor = Schema.Union([
  Schema.Struct({
    id: BrowserEditorId,
    selectionStart: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 1_048_576 }),
    ),
    selectionEnd: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 1_048_576 }),
    ),
    caret: EditorCaret,
  }),
  Schema.Struct({ id: BrowserEditorId, caret: EditorCaret }),
  Schema.Struct({ id: BrowserEditorId, secure: Schema.Literal(true) }),
]);
export type HumanBrowserEditor = typeof HumanBrowserEditor.Type;
export const decodeHumanBrowserEditor = Schema.decodeUnknownSync(
  HumanBrowserEditor,
  STRICT_DECODE_OPTIONS,
);
const Sequence = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Coordinate = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: MAX_HUMAN_FRAME_WIDTH }),
);
const Modifiers = Schema.optional(
  Schema.Array(Schema.Literals(["shift", "control", "alt", "meta"])).check(Schema.isMaxLength(4)),
);
export const HumanBrowserInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["mouseMove", "mouseDown", "mouseUp"]),
    x: Coordinate,
    y: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: MAX_HUMAN_FRAME_HEIGHT }),
    ),
    button: Schema.Literals(["left", "middle", "right"]),
    clickCount: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 2 })),
    modifiers: Modifiers,
  }),
  Schema.Struct({
    type: Schema.Literal("mouseWheel"),
    x: Coordinate,
    y: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: MAX_HUMAN_FRAME_HEIGHT }),
    ),
    deltaX: Schema.Number.check(Schema.isBetween({ minimum: -2_000, maximum: 2_000 })),
    deltaY: Schema.Number.check(Schema.isBetween({ minimum: -2_000, maximum: 2_000 })),
    modifiers: Modifiers,
  }),
  Schema.Struct({
    type: Schema.Literals(["keyDown", "keyUp", "char"]),
    keyCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    modifiers: Modifiers,
  }),
]);
export type HumanBrowserInput = typeof HumanBrowserInput.Type;
export const HumanBrowserLayout = Schema.Struct({
  width: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: MAX_HUMAN_FRAME_WIDTH }),
  ),
  height: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: MAX_HUMAN_FRAME_HEIGHT }),
  ),
  visible: Schema.Boolean,
});
export type HumanBrowserLayout = typeof HumanBrowserLayout.Type;
const TabCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("open") }),
  Schema.Struct({
    kind: Schema.Literals(["select", "close"]),
    tabId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  }),
]);
export const HumanBrowserState = Schema.Struct({
  contextId: Schema.String.check(Schema.isMaxLength(64)),
  url: Schema.String.check(Schema.isMaxLength(8_192)),
  title: Schema.String.check(Schema.isMaxLength(1_024)),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  control: Schema.Literals(["idle", "user", "agent"]),
  tabs: Schema.Array(
    Schema.Struct({
      tabId: Schema.String.check(Schema.isMaxLength(64)),
      url: Schema.String.check(Schema.isMaxLength(8_192)),
      title: Schema.String.check(Schema.isMaxLength(1_024)),
    }),
  ).check(Schema.isMaxLength(32)),
  activeTabId: Schema.String.check(Schema.isMaxLength(64)),
});
/**
 * A page popup Stable's hidden Browser window captured instead of showing:
 * a select list, a page dialog, a link or image menu, or a file chooser. Its
 * text is the page's own display copy and grants nothing; the identity is a
 * single-use ticket for one answer from the person.
 */
export const BrowserPagePopupId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserPagePopupId"),
);
export type BrowserPagePopupId = typeof BrowserPagePopupId.Type;
export const decodeBrowserPagePopupId = Schema.decodeUnknownSync(
  BrowserPagePopupId,
  STRICT_DECODE_OPTIONS,
);
export const MAX_BROWSER_SELECT_OPTIONS = 512;
export const MAX_BROWSER_SELECT_LABEL = 256;
export const MAX_BROWSER_DIALOG_TEXT = 2_048;
/** The native menu bound a select list must fit, counting group headings and separators. */
export const MAX_BROWSER_SELECT_MENU_ENTRIES = 1_024;

/** Entries Nightly's native menu needs for these options: each group adds a separator and heading. */
export function browserSelectMenuEntries(
  options: ReadonlyArray<{ readonly group?: string | undefined }>,
): number {
  let entries = 0;
  let group: string | undefined;
  options.forEach((option, index) => {
    if (index === 0 ? option.group !== undefined : option.group !== group) {
      if (index > 0) entries += 1;
      if (option.group !== undefined && option.group.trim() !== "") entries += 1;
    }
    group = option.group;
    entries += 1;
  });
  return entries;
}
export const MAX_BROWSER_CHOSEN_FILES = 8;
export const MAX_BROWSER_CHOSEN_PATH = 1_024;
const PopupText = (maximum: number) =>
  Schema.String.check(
    Schema.isMaxLength(maximum),
    Schema.makeFilter((text) => text.isWellFormed()),
  );
const PageRect = Schema.Struct({
  x: Schema.Number.check(
    Schema.isBetween({ minimum: -MAX_HUMAN_FRAME_WIDTH, maximum: MAX_HUMAN_FRAME_WIDTH }),
  ),
  y: Schema.Number.check(
    Schema.isBetween({ minimum: -MAX_HUMAN_FRAME_HEIGHT, maximum: MAX_HUMAN_FRAME_HEIGHT }),
  ),
  width: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: MAX_HUMAN_FRAME_WIDTH * 2 })),
  height: Schema.Number.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_HUMAN_FRAME_HEIGHT * 2 }),
  ),
});
export const HumanBrowserPagePopup = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("select"),
    id: BrowserPagePopupId,
    anchor: PageRect,
    options: Schema.Array(
      Schema.Struct({
        label: PopupText(MAX_BROWSER_SELECT_LABEL),
        disabled: Schema.Boolean,
        group: Schema.optional(PopupText(MAX_BROWSER_SELECT_LABEL)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BROWSER_SELECT_OPTIONS)),
    selectedIndex: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: -1, maximum: MAX_BROWSER_SELECT_OPTIONS - 1 }),
    ),
  }).check(
    Schema.makeFilter(
      (value) =>
        value.selectedIndex < value.options.length &&
        browserSelectMenuEntries(value.options) <= MAX_BROWSER_SELECT_MENU_ENTRIES,
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("dialog"),
    id: BrowserPagePopupId,
    dialog: Schema.Literals(["alert", "confirm", "beforeunload"]),
    message: PopupText(MAX_BROWSER_DIALOG_TEXT),
  }),
  Schema.Struct({
    kind: Schema.Literal("context"),
    id: BrowserPagePopupId,
    link: Schema.Boolean,
    image: Schema.Boolean,
  }).check(Schema.makeFilter((value) => value.link || value.image)),
  Schema.Struct({
    kind: Schema.Literal("file"),
    id: BrowserPagePopupId,
    multiple: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("notice"),
    id: BrowserPagePopupId,
    notice: Schema.Literal("dialogs-answered"),
  }),
]);
export type HumanBrowserPagePopup = typeof HumanBrowserPagePopup.Type;
export const BrowserContextAction = Schema.Literals([
  "open-link",
  "copy-link",
  "copy-image",
  "copy-image-address",
]);
export type BrowserContextAction = typeof BrowserContextAction.Type;
const ChosenPath = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(MAX_BROWSER_CHOSEN_PATH),
  Schema.makeFilter((path) => path.isWellFormed() && path.startsWith("/") && !path.includes("\0")),
);
export const HumanBrowserPopupAnswer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("select"),
    index: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: MAX_BROWSER_SELECT_OPTIONS - 1 }),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("dialog"), accept: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("context"), action: BrowserContextAction }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    paths: Schema.Array(ChosenPath).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_BROWSER_CHOSEN_FILES),
    ),
  }),
]);
export type HumanBrowserPopupAnswer = typeof HumanBrowserPopupAnswer.Type;
/**
 * A bounded description of the page's accessibility tree, which Nightly mirrors
 * over the Browser image so a screen reader can read and operate the page. It
 * only describes: page addresses never travel, a password field carries its
 * role and name but never its value, and every action from the mirror is
 * checked in Stable as the person's own input.
 */
export const MAX_BROWSER_ACCESSIBILITY_NODES = 1_500;
export const MAX_BROWSER_ACCESSIBILITY_DEPTH = 64;
export const MAX_BROWSER_ACCESSIBILITY_CHILDREN = 512;
export const MAX_BROWSER_ACCESSIBILITY_TEXT = 512;
export const MAX_BROWSER_ACCESSIBILITY_VALUE = 1_024;
export const BROWSER_ACCESSIBILITY_ROLES = [
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
] as const;
export const BrowserAccessibilityRole = Schema.Literals(BROWSER_ACCESSIBILITY_ROLES);
export type BrowserAccessibilityRole = typeof BrowserAccessibilityRole.Type;
/** A mirrored node's identity: the frame's ordinal and the page's own node number. */
export const BROWSER_ACCESSIBILITY_NODE_ID = /^[0-9a-z]{1,8}-[0-9]{1,12}$/;
const AccessibilityNodeId = Schema.String.check(Schema.isPattern(BROWSER_ACCESSIBILITY_NODE_ID));
const AccessibilityText = (maximum: number) =>
  Schema.String.check(
    Schema.isMaxLength(maximum),
    Schema.makeFilter((text) => text.isWellFormed()),
  );
const Tristate = Schema.Literals(["true", "false", "mixed"]);
const RangeNumber = Schema.Number.check(Schema.isBetween({ minimum: -1e9, maximum: 1e9 }));
export const BrowserAccessibilityNode = Schema.Struct({
  id: AccessibilityNodeId,
  role: BrowserAccessibilityRole,
  name: Schema.optional(AccessibilityText(MAX_BROWSER_ACCESSIBILITY_TEXT)),
  description: Schema.optional(AccessibilityText(MAX_BROWSER_ACCESSIBILITY_TEXT)),
  value: Schema.optional(AccessibilityText(MAX_BROWSER_ACCESSIBILITY_VALUE)),
  /** A password field: its value never leaves Stable. */
  secure: Schema.optional(Schema.Literal(true)),
  level: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 9 })),
  ),
  checked: Schema.optional(Tristate),
  pressed: Schema.optional(Tristate),
  expanded: Schema.optional(Schema.Boolean),
  selected: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Literal(true)),
  focusable: Schema.optional(Schema.Literal(true)),
  required: Schema.optional(Schema.Literal(true)),
  invalid: Schema.optional(Schema.Literal(true)),
  readonly: Schema.optional(Schema.Literal(true)),
  multiline: Schema.optional(Schema.Literal(true)),
  valueNow: Schema.optional(RangeNumber),
  valueMin: Schema.optional(RangeNumber),
  valueMax: Schema.optional(RangeNumber),
  live: Schema.optional(Schema.Literals(["polite", "assertive"])),
  bounds: Schema.optional(PageRect),
  children: Schema.Array(AccessibilityNodeId).check(
    Schema.isMaxLength(MAX_BROWSER_ACCESSIBILITY_CHILDREN),
  ),
}).check(Schema.makeFilter((node) => node.secure !== true || node.value === undefined));
export type BrowserAccessibilityNode = typeof BrowserAccessibilityNode.Type;
const AccessibilityRevision = Sequence.check(Schema.isGreaterThan(0));
/**
 * One change to the mirrored tree. A full tree replaces what Nightly holds; a
 * patch applies to exactly its base revision and is refused against any other.
 */
export const BrowserAccessibilityUpdate = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("full"),
    revision: AccessibilityRevision,
    rootId: AccessibilityNodeId,
    focusedId: Schema.optional(AccessibilityNodeId),
    truncated: Schema.Boolean,
    nodes: Schema.Array(BrowserAccessibilityNode).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_BROWSER_ACCESSIBILITY_NODES),
    ),
  }).check(
    Schema.makeFilter(
      (update) =>
        browserAccessibilityTreeIsSound(update.nodes, update.rootId) &&
        (update.focusedId === undefined ||
          update.nodes.some((node) => node.id === update.focusedId)),
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("patch"),
    base: AccessibilityRevision,
    revision: AccessibilityRevision,
    rootId: AccessibilityNodeId,
    focusedId: Schema.optional(AccessibilityNodeId),
    truncated: Schema.Boolean,
    nodes: Schema.Array(BrowserAccessibilityNode).check(
      Schema.isMaxLength(MAX_BROWSER_ACCESSIBILITY_NODES),
    ),
    removed: Schema.Array(AccessibilityNodeId).check(
      Schema.isMaxLength(MAX_BROWSER_ACCESSIBILITY_NODES),
    ),
  }).check(Schema.makeFilter((update) => update.base < update.revision)),
]);
export type BrowserAccessibilityUpdate = typeof BrowserAccessibilityUpdate.Type;

/**
 * A mirrored tree is sound when its identities are unique, its root exists,
 * every child exists and has one parent, every node is reachable from the root,
 * and the tree is no deeper than the mirror's bound. Nightly checks the same
 * rule after applying a patch.
 */
export function browserAccessibilityTreeIsSound(
  nodes: ReadonlyArray<{ readonly id: string; readonly children: ReadonlyArray<string> }>,
  rootId: string,
): boolean {
  if (nodes.length > MAX_BROWSER_ACCESSIBILITY_NODES) return false;
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
  // With one parent each and an unparented root, a walk from the root meets
  // each node once; a cycle elsewhere is unreachable and fails the count.
  let reached = 1;
  let level = [rootId];
  for (let depth = 1; level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of level) next.push(...(byId.get(id) ?? []));
    if (next.length > 0 && depth >= MAX_BROWSER_ACCESSIBILITY_DEPTH) return false;
    reached += next.length;
    if (reached > byId.size) return false;
    level = next;
  }
  return reached === byId.size;
}
export const BrowserAccessibilityAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["press", "focus", "scroll-into-view", "increment", "decrement"]),
  }),
  Schema.Struct({
    action: Schema.Literal("set-value"),
    value: AccessibilityText(MAX_BROWSER_ACCESSIBILITY_VALUE),
  }),
]);
export type BrowserAccessibilityAction = typeof BrowserAccessibilityAction.Type;
const Owner = { contextId: BrowserContextId, threadId: BrowserThreadId };
export const HumanBrowserRequest = Schema.Union([
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("edit-menu"),
    presentationId: BrowserPresentationId,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literals(["edit-menu-watch", "edit-menu-dismiss", "edit-menu-keyboard"]),
    presentationId: BrowserPresentationId,
    menuId: BrowserEditMenuId,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("edit-menu-action"),
    presentationId: BrowserPresentationId,
    menuId: BrowserEditMenuId,
    action: BrowserEditAction,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("popup"),
    presentationId: BrowserPresentationId,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("popup-answer"),
    presentationId: BrowserPresentationId,
    popupId: BrowserPagePopupId,
    answer: HumanBrowserPopupAnswer,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literals(["popup-dismiss", "popup-watch"]),
    presentationId: BrowserPresentationId,
    popupId: BrowserPagePopupId,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("accessibility"),
    presentationId: BrowserPresentationId,
    revision: Sequence,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("accessibility-action"),
    presentationId: BrowserPresentationId,
    revision: AccessibilityRevision,
    nodeId: AccessibilityNodeId,
    action: BrowserAccessibilityAction,
  }),
  Schema.Struct({ ...Owner, kind: Schema.Literal("attach") }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("editor"),
    presentationId: BrowserPresentationId,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("composition"),
    presentationId: BrowserPresentationId,
    composition: HumanBrowserComposition,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("layout"),
    presentationId: BrowserPresentationId,
    layout: HumanBrowserLayout,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("frame"),
    presentationId: BrowserPresentationId,
    acknowledgement: Sequence,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("input"),
    presentationId: BrowserPresentationId,
    input: HumanBrowserInput,
    frameSequence: Sequence,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("command"),
    presentationId: BrowserPresentationId,
    command: Schema.Literals(["back", "forward", "reload", "stop"]),
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("tab"),
    presentationId: BrowserPresentationId,
    command: TabCommand,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("state"),
    presentationId: BrowserPresentationId,
  }),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("detach"),
    presentationId: BrowserPresentationId,
  }),
]);
export type HumanBrowserRequest = typeof HumanBrowserRequest.Type;
export const HumanBrowserResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("edit-menu-pending"),
    menuId: BrowserEditMenuId,
  }),
  Schema.Struct({
    status: Schema.Literal("edit-menu"),
    menuId: BrowserEditMenuId,
    flags: BrowserEditFlags,
  }),
  Schema.Struct({ status: Schema.Literal("popup"), popup: HumanBrowserPagePopup }),
  Schema.Struct({
    status: Schema.Literal("accessibility"),
    update: BrowserAccessibilityUpdate,
  }),
  Schema.Struct({ status: Schema.Literal("editor"), editor: HumanBrowserEditor }),
  Schema.Struct({ status: Schema.Literal("editor-unavailable") }),
  Schema.Struct({
    status: Schema.Literal("composition-started"),
    compositionId: BrowserCompositionId,
  }),
  Schema.Struct({
    status: Schema.Literal("attached"),
    presentationId: BrowserPresentationId,
  }),
  Schema.Struct({
    status: Schema.Literal("frame"),
    sequence: Sequence.check(Schema.isGreaterThan(0)),
    width: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: MAX_HUMAN_FRAME_WIDTH }),
    ),
    height: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: MAX_HUMAN_FRAME_HEIGHT }),
    ),
    dataUrl: Schema.String.check(
      Schema.isMaxLength(Math.ceil((MAX_HUMAN_FRAME_BYTES * 4) / 3) + 32),
      Schema.isPattern(/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/),
    ),
  }),
  Schema.Struct({ status: Schema.Literal("state"), state: HumanBrowserState }),
  Schema.Struct({ status: Schema.Literals(["accepted", "idle", "refused"]) }),
]);
export type HumanBrowserResult = typeof HumanBrowserResult.Type;
export const decodeHumanBrowserRequest = Schema.decodeUnknownSync(
  HumanBrowserRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeHumanBrowserResult = Schema.decodeUnknownSync(
  HumanBrowserResult,
  STRICT_DECODE_OPTIONS,
);

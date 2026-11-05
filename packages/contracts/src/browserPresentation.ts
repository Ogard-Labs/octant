import { Schema } from "effect";
import { BrowserContextId, BrowserThreadId } from "./browserAutomation";

export const MAX_HUMAN_FRAME_WIDTH = 1_920;
export const MAX_HUMAN_FRAME_HEIGHT = 1_200;
export const MAX_HUMAN_FRAME_BYTES = 4 * 1_024 * 1_024;
const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const BrowserPresentationId = Schema.UUID.pipe(Schema.brand("BrowserPresentationId"));
export type BrowserPresentationId = typeof BrowserPresentationId.Type;
export const decodeBrowserPresentationId = Schema.decodeUnknownSync(BrowserPresentationId);
export const BrowserEditorId = Schema.UUID.pipe(Schema.brand("BrowserEditorId"));
export type BrowserEditorId = typeof BrowserEditorId.Type;
export const decodeBrowserEditorId = Schema.decodeUnknownSync(BrowserEditorId);
export const BrowserCompositionId = Schema.UUID.pipe(Schema.brand("BrowserCompositionId"));
export type BrowserCompositionId = typeof BrowserCompositionId.Type;
export const decodeBrowserCompositionId = Schema.decodeUnknownSync(BrowserCompositionId);
export const BrowserEditMenuId = Schema.UUID.pipe(Schema.brand("BrowserEditMenuId"));
export type BrowserEditMenuId = typeof BrowserEditMenuId.Type;
export const decodeBrowserEditMenuId = Schema.decodeUnknownSync(BrowserEditMenuId);
export const BrowserEditAction = Schema.Literal(
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
);
export type BrowserEditAction = typeof BrowserEditAction.Type;
export const BrowserEditFlags = Schema.Struct({
  undo: Schema.Boolean,
  redo: Schema.Boolean,
  cut: Schema.Boolean,
  copy: Schema.Boolean,
  paste: Schema.Boolean,
  selectAll: Schema.Boolean,
}).annotations(strict);
export type BrowserEditFlags = typeof BrowserEditFlags.Type;
export const MAX_BROWSER_COMPOSITION_TEXT = 256;
const CandidateText = Schema.String.pipe(
  Schema.maxLength(MAX_BROWSER_COMPOSITION_TEXT),
  Schema.filter((text) => text.isWellFormed()),
);
const CandidateOffset = Schema.Number.pipe(
  Schema.int(),
  Schema.between(0, MAX_BROWSER_COMPOSITION_TEXT),
);
export const HumanBrowserComposition = Schema.Union(
  Schema.Struct({ phase: Schema.Literal("begin"), editorId: BrowserEditorId }).annotations(strict),
  Schema.Struct({
    phase: Schema.Literal("update"),
    compositionId: BrowserCompositionId,
    text: CandidateText,
    selectionStart: CandidateOffset,
    selectionEnd: CandidateOffset,
  })
    .pipe(
      Schema.filter((value) => {
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
    )
    .annotations(strict),
  Schema.Struct({
    phase: Schema.Literal("commit"),
    compositionId: BrowserCompositionId,
    text: CandidateText,
  }).annotations(strict),
  Schema.Struct({
    phase: Schema.Literal("cancel"),
    compositionId: BrowserCompositionId,
  }).annotations(strict),
);
export type HumanBrowserComposition = typeof HumanBrowserComposition.Type;
export const HumanBrowserEditor = Schema.Struct({
  id: BrowserEditorId,
  selectionStart: Schema.Number.pipe(Schema.int(), Schema.between(0, 1_048_576)),
  selectionEnd: Schema.Number.pipe(Schema.int(), Schema.between(0, 1_048_576)),
  caret: Schema.Struct({
    x: Schema.Number.pipe(Schema.between(0, MAX_HUMAN_FRAME_WIDTH)),
    y: Schema.Number.pipe(Schema.between(0, MAX_HUMAN_FRAME_HEIGHT)),
    width: Schema.Number.pipe(Schema.between(0, MAX_HUMAN_FRAME_WIDTH)),
    height: Schema.Number.pipe(
      Schema.greaterThan(0),
      Schema.lessThanOrEqualTo(MAX_HUMAN_FRAME_HEIGHT),
    ),
  }).annotations(strict),
}).annotations(strict);
export type HumanBrowserEditor = typeof HumanBrowserEditor.Type;
export const decodeHumanBrowserEditor = Schema.decodeUnknownSync(HumanBrowserEditor);
const Sequence = Schema.Number.pipe(Schema.int(), Schema.between(0, Number.MAX_SAFE_INTEGER));
const Coordinate = Schema.Number.pipe(Schema.int(), Schema.between(0, MAX_HUMAN_FRAME_WIDTH));
const Modifiers = Schema.optional(
  Schema.Array(Schema.Literal("shift", "control", "alt", "meta")).pipe(Schema.maxItems(4)),
);
export const HumanBrowserInput = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("mouseMove", "mouseDown", "mouseUp"),
    x: Coordinate,
    y: Schema.Number.pipe(Schema.int(), Schema.between(0, MAX_HUMAN_FRAME_HEIGHT)),
    button: Schema.Literal("left", "middle", "right"),
    clickCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 2)),
    modifiers: Modifiers,
  }).annotations(strict),
  Schema.Struct({
    type: Schema.Literal("mouseWheel"),
    x: Coordinate,
    y: Schema.Number.pipe(Schema.int(), Schema.between(0, MAX_HUMAN_FRAME_HEIGHT)),
    deltaX: Schema.Number.pipe(Schema.between(-2_000, 2_000)),
    deltaY: Schema.Number.pipe(Schema.between(-2_000, 2_000)),
    modifiers: Modifiers,
  }).annotations(strict),
  Schema.Struct({
    type: Schema.Literal("keyDown", "keyUp", "char"),
    keyCode: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
    modifiers: Modifiers,
  }).annotations(strict),
);
export type HumanBrowserInput = typeof HumanBrowserInput.Type;
export const HumanBrowserLayout = Schema.Struct({
  width: Schema.Number.pipe(Schema.int(), Schema.between(1, MAX_HUMAN_FRAME_WIDTH)),
  height: Schema.Number.pipe(Schema.int(), Schema.between(1, MAX_HUMAN_FRAME_HEIGHT)),
  visible: Schema.Boolean,
}).annotations(strict);
export type HumanBrowserLayout = typeof HumanBrowserLayout.Type;
const TabCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("open") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("select", "close"),
    tabId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  }).annotations(strict),
);
export const HumanBrowserState = Schema.Struct({
  contextId: Schema.String.pipe(Schema.maxLength(64)),
  url: Schema.String.pipe(Schema.maxLength(8_192)),
  title: Schema.String.pipe(Schema.maxLength(1_024)),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  control: Schema.Literal("idle", "user", "agent"),
  tabs: Schema.Array(
    Schema.Struct({
      tabId: Schema.String.pipe(Schema.maxLength(64)),
      url: Schema.String.pipe(Schema.maxLength(8_192)),
      title: Schema.String.pipe(Schema.maxLength(1_024)),
    }),
  ).pipe(Schema.maxItems(32)),
  activeTabId: Schema.String.pipe(Schema.maxLength(64)),
}).annotations(strict);
const Owner = { contextId: BrowserContextId, threadId: BrowserThreadId };
export const HumanBrowserRequest = Schema.Union(
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("edit-menu"),
    presentationId: BrowserPresentationId,
  }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("edit-menu-watch", "edit-menu-dismiss", "edit-menu-keyboard"),
    presentationId: BrowserPresentationId,
    menuId: BrowserEditMenuId,
  }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("edit-menu-action"),
    presentationId: BrowserPresentationId,
    menuId: BrowserEditMenuId,
    action: BrowserEditAction,
  }).annotations(strict),
  Schema.Struct({ ...Owner, kind: Schema.Literal("attach") }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("editor"),
    presentationId: BrowserPresentationId,
  }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("composition"),
    presentationId: BrowserPresentationId,
    composition: HumanBrowserComposition,
  }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("layout"),
    presentationId: BrowserPresentationId,
    layout: HumanBrowserLayout,
  }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("frame"),
    presentationId: BrowserPresentationId,
    acknowledgement: Sequence,
  }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("input"),
    presentationId: BrowserPresentationId,
    input: HumanBrowserInput,
    frameSequence: Sequence,
  }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("command"),
    presentationId: BrowserPresentationId,
    command: Schema.Literal("back", "forward", "reload", "stop"),
  }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("tab"),
    presentationId: BrowserPresentationId,
    command: TabCommand,
  }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("state"),
    presentationId: BrowserPresentationId,
  }).annotations(strict),
  Schema.Struct({
    ...Owner,
    kind: Schema.Literal("detach"),
    presentationId: BrowserPresentationId,
  }).annotations(strict),
);
export type HumanBrowserRequest = typeof HumanBrowserRequest.Type;
export const HumanBrowserResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("edit-menu-pending"),
    menuId: BrowserEditMenuId,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("edit-menu"),
    menuId: BrowserEditMenuId,
    flags: BrowserEditFlags,
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("editor"), editor: HumanBrowserEditor }).annotations(
    strict,
  ),
  Schema.Struct({ status: Schema.Literal("editor-unavailable") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("composition-started"),
    compositionId: BrowserCompositionId,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("attached"),
    presentationId: BrowserPresentationId,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("frame"),
    sequence: Sequence.pipe(Schema.greaterThan(0)),
    width: Schema.Number.pipe(Schema.int(), Schema.between(1, MAX_HUMAN_FRAME_WIDTH)),
    height: Schema.Number.pipe(Schema.int(), Schema.between(1, MAX_HUMAN_FRAME_HEIGHT)),
    dataUrl: Schema.String.pipe(
      Schema.maxLength(Math.ceil((MAX_HUMAN_FRAME_BYTES * 4) / 3) + 32),
      Schema.pattern(/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/),
    ),
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("state"), state: HumanBrowserState }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("accepted", "idle", "refused") }).annotations(strict),
);
export type HumanBrowserResult = typeof HumanBrowserResult.Type;
export const decodeHumanBrowserRequest = Schema.decodeUnknownSync(HumanBrowserRequest);
export const decodeHumanBrowserResult = Schema.decodeUnknownSync(HumanBrowserResult);

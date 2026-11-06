import { Schema } from "effect";
import { BrowserEditorId } from "@octant/contracts/browser-presentation";

import { BROWSER_EDITABLE_WORLD_ID } from "./browserEditableObservation";
export { BROWSER_EDITABLE_WORLD_ID };
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Offset = Schema.Number.pipe(Schema.int(), Schema.between(0, 1_048_576));
const Coordinate = Schema.Number.pipe(Schema.finite(), Schema.between(-100_000, 100_000));
const Caret = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  width: Schema.Literal(0),
  height: Schema.Number.pipe(
    Schema.finite(),
    Schema.greaterThan(0),
    Schema.lessThanOrEqualTo(100_000),
  ),
}).annotations(strict);
const Selected = <Kind extends "text" | "secure">(kind: Kind) =>
  Schema.Struct({
    id: BrowserEditorId,
    kind: Schema.Literal(kind),
    selectionStart: Offset,
    selectionEnd: Offset,
  })
    .pipe(Schema.filter((value) => value.selectionEnd >= value.selectionStart))
    .annotations(strict);
const Target = Schema.Union(
  Selected("text"),
  Selected("secure"),
  Schema.Struct({ id: BrowserEditorId, kind: Schema.Literal("field"), caret: Caret }).annotations(
    strict,
  ),
  Schema.Struct({
    id: BrowserEditorId,
    kind: Schema.Literal("rich"),
    collapsed: Schema.Boolean,
    caret: Caret,
  }).annotations(strict),
);
/**
 * A focused field as its frame's observer reports it. A text control gives
 * UTF16 offsets for the native caret lookup; a field without a selection API
 * and a rich editor give their caret in their own frame's page coordinates.
 */
export type BrowserEditableTarget = typeof Target.Type;
export type BrowserEditableCaret = typeof Caret.Type;
const decode = Schema.decodeUnknownSync(Target, { onExcessProperty: "error" });

/** A private isolated world observes focus identity and UTF16 offsets, never field contents. */
export const BROWSER_EDITABLE_TARGET_CODE = `(() => {
  const bridge = globalThis.octantBrowserEditable;
  return bridge && typeof bridge.read === "function" ? bridge.read() : null;
})()`;
/** Whether the observed document's focus sits in a nested frame. */
export const BROWSER_EDITABLE_IN_FRAME_CODE = `(() => {
  const bridge = globalThis.octantBrowserEditable;
  return bridge && typeof bridge.inFrame === "function" ? bridge.inFrame() === true : false;
})()`;

type Evaluate = (
  world: number,
  scripts: ReadonlyArray<{ readonly code: string }>,
) => Promise<unknown>;

async function bounded(evaluate: Evaluate, code: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluate(BROWSER_EDITABLE_WORLD_ID, [{ code }]),
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readBrowserEditableTarget(
  evaluate: Evaluate,
): Promise<BrowserEditableTarget | undefined> {
  try {
    const value = await bounded(evaluate, BROWSER_EDITABLE_TARGET_CODE);
    return value === null ? undefined : decode(value);
  } catch {
    return undefined;
  }
}

/** True only for the observer's own answer; anything else is "not in a frame". */
export async function readBrowserEditableInFrame(evaluate: Evaluate): Promise<boolean> {
  try {
    return (await bounded(evaluate, BROWSER_EDITABLE_IN_FRAME_CODE)) === true;
  } catch {
    return false;
  }
}

/** The same field with the same selection, for a check that spans a lookup. */
export function sameBrowserEditableTarget(
  a: BrowserEditableTarget | undefined,
  b: BrowserEditableTarget | undefined,
): boolean {
  if (a === undefined || b === undefined || String(a.id) !== String(b.id)) return false;
  if (a.kind === "text" || a.kind === "secure")
    return (
      a.kind === b.kind &&
      a.selectionStart === b.selectionStart &&
      a.selectionEnd === b.selectionEnd
    );
  if (b.kind === "text" || b.kind === "secure" || b.kind !== a.kind) return false;
  return (
    a.caret.x === b.caret.x &&
    a.caret.y === b.caret.y &&
    a.caret.height === b.caret.height &&
    (a.kind !== "rich" || (b.kind === "rich" && a.collapsed === b.collapsed))
  );
}

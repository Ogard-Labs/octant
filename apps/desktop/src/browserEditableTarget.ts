import { Schema } from "effect";
import { BrowserEditorId } from "@octant/contracts/browser-presentation";

import { BROWSER_EDITABLE_WORLD_ID } from "./browserEditableObservation";
export { BROWSER_EDITABLE_WORLD_ID };
const Offset = Schema.Number.pipe(Schema.int(), Schema.between(0, 1_048_576));
const Target = Schema.Struct({
  id: BrowserEditorId,
  selectionStart: Offset,
  selectionEnd: Offset,
}).pipe(Schema.filter((value) => value.selectionEnd >= value.selectionStart));
export type BrowserEditableTarget = typeof Target.Type;
const decode = Schema.decodeUnknownSync(Target, { onExcessProperty: "error" });

/** A private isolated world observes focus identity and UTF16 offsets, never field contents. */
export const BROWSER_EDITABLE_TARGET_CODE = `(() => {
  const bridge = globalThis.octantBrowserEditable;
  return bridge && typeof bridge.read === "function" ? bridge.read() : null;
})()`;

export async function readBrowserEditableTarget(
  evaluate: (world: number, scripts: ReadonlyArray<{ readonly code: string }>) => Promise<unknown>,
): Promise<BrowserEditableTarget | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      evaluate(BROWSER_EDITABLE_WORLD_ID, [{ code: BROWSER_EDITABLE_TARGET_CODE }]),
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), 500);
      }),
    ]);
    return value === null ? undefined : decode(value);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

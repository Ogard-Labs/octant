import { describe, expect, it, vi } from "vitest";
import { decodeBrowserEditorId } from "@octant/contracts/browser-presentation";
import { BrowserTextComposition } from "./browserTextComposition";
const first = decodeBrowserEditorId("00000000-0000-4000-8000-000000000901");
const second = decodeBrowserEditorId("00000000-0000-4000-8000-000000000902");
function fixture() {
  let current = true;
  let id = first;
  const apply = vi.fn(async () => true);
  const owner = new BrowserTextComposition({
    current: () => current,
    source: () => ({
      editor: async () => ({
        id,
        selectionStart: 0,
        selectionEnd: 0,
        caret: { x: 20, y: 30, width: 0, height: 24 },
      }),
      apply,
    }),
  });
  return {
    owner,
    apply,
    expire: () => {
      current = false;
    },
    focus: (next: typeof id) => {
      id = next;
    },
  };
}
describe("current Browser text composition", () => {
  it("commits once and refuses an old cancellation after a successor begins", async () => {
    const f = fixture();
    const started = await f.owner.execute({ phase: "begin", editorId: first });
    if (started.status !== "composition-started") throw new Error("Composition refused");
    expect(
      await f.owner.execute({
        phase: "update",
        compositionId: started.compositionId,
        text: "é",
        selectionStart: 1,
        selectionEnd: 1,
      }),
    ).toEqual({ status: "accepted" });
    expect(
      await f.owner.execute({ phase: "commit", compositionId: started.compositionId, text: "é" }),
    ).toEqual({ status: "accepted" });
    f.focus(second);
    expect(await f.owner.execute({ phase: "begin", editorId: second })).toMatchObject({
      status: "composition-started",
    });
    expect(
      await f.owner.execute({ phase: "cancel", compositionId: started.compositionId }),
    ).toEqual({ status: "refused" });
    expect(f.apply).toHaveBeenCalledTimes(2);
    await f.owner.close();
  });
  it("retires pending acquisition and late results without resurrecting the old field", async () => {
    let finish: (() => void) | undefined;
    const waiting = new Promise<void>((done) => {
      finish = done;
    });
    const apply = vi.fn(async () => true);
    const owner = new BrowserTextComposition({
      current: () => true,
      source: () => ({
        editor: async () => {
          await waiting;
          return {
            id: first,
            selectionStart: 0,
            selectionEnd: 0,
            caret: { x: 20, y: 30, width: 0, height: 24 },
          };
        },
        apply,
      }),
    });
    const pending = owner.execute({ phase: "begin", editorId: first });
    await Promise.resolve();
    const closing = owner.close();
    finish?.();
    expect(await pending).toEqual({ status: "refused" });
    expect(await closing).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });
});

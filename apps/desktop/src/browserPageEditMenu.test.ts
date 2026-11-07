import { decodeBrowserEditorId } from "@octant/contracts/browser-presentation";
import { describe, expect, it } from "vitest";
import { BrowserPageEditMenu } from "./browserPageEditMenu";

const first = decodeBrowserEditorId("00000000-0000-4000-8000-000000000951");
const second = decodeBrowserEditorId("00000000-0000-4000-8000-000000000952");
const flags = { undo: true, redo: false, cut: false, copy: false, paste: false, selectAll: true };
function fixture() {
  let editor = first;
  let current = true;
  const applied: string[] = [];
  const menu = new BrowserPageEditMenu();
  const source = {
    current: () => current,
    editor: async () => editor,
    apply: (action: string) => {
      applied.push(action);
    },
  };
  return {
    menu,
    source,
    applied,
    editor: (value: typeof first) => {
      editor = value;
    },
    retire: () => {
      current = false;
    },
  };
}
describe("page editing menus", () => {
  it("applies one enabled action to the exact still-focused field", async () => {
    const f = fixture();
    f.menu.arm(first, f.source);
    f.menu.offer(flags);
    const result = await f.menu.read();
    expect(result.status).toBe("edit-menu");
    if (result.status !== "edit-menu") throw new Error("Expected native editing menu");
    expect(await f.menu.act(result.menuId, "redo")).toBe(false);
    expect(await f.menu.act(result.menuId, "selectAll")).toBe(true);
    expect(await f.menu.act(result.menuId, "selectAll")).toBe(false);
    expect(f.applied).toEqual(["selectAll"]);
  });
  it("refuses a successor field and wakes an owned menu watch on retirement", async () => {
    const f = fixture();
    f.menu.arm(first, f.source);
    f.menu.offer(flags);
    const result = await f.menu.read();
    if (result.status !== "edit-menu") throw new Error("Expected native editing menu");
    const waiting = f.menu.watch(result.menuId);
    f.menu.close();
    expect(await waiting).toBe(false);
    f.menu.arm(first, f.source);
    f.menu.offer(flags);
    f.editor(second);
    expect((await f.menu.read()).status).toBe("idle");
    expect(await f.menu.act(result.menuId, "selectAll")).toBe(false);
    expect(f.applied).toEqual([]);
  });
  it("refuses an old action whose native offer was replaced during validation", async () => {
    const f = fixture();
    let delayed = false;
    let release: (value: typeof first) => void = () => {};
    const source = {
      ...f.source,
      editor: () =>
        delayed
          ? new Promise<typeof first>((done) => {
              release = done;
            })
          : Promise.resolve(first),
    };
    f.menu.arm(first, source);
    f.menu.offer(flags);
    const initial = await f.menu.read();
    if (initial.status !== "edit-menu") throw new Error("Expected initial menu");
    delayed = true;
    const old = f.menu.act(initial.menuId, "selectAll");
    f.menu.offer(flags);
    delayed = false;
    release(first);
    expect(await old).toBe(false);
    const next = await f.menu.read();
    if (next.status !== "edit-menu") throw new Error("Expected successor menu");
    expect(next.menuId).not.toBe(initial.menuId);
    expect(await f.menu.act(next.menuId, "selectAll")).toBe(true);
    expect(f.applied).toEqual(["selectAll"]);
  });

  it("refuses retirement between metadata resolution and native effect dispatch", async () => {
    const f = fixture();
    f.menu.arm(first, f.source);
    f.menu.offer(flags);
    const menu = await f.menu.read();
    if (menu.status !== "edit-menu") throw new Error("Expected native menu");
    const action = f.menu.act(menu.menuId, "selectAll");
    queueMicrotask(() => queueMicrotask(() => f.menu.close()));
    expect(await action).toBe(false);
    expect(f.applied).toEqual([]);
  });

  it("does not dispatch after the source retires during metadata validation", async () => {
    const f = fixture();
    let release: (value: typeof first) => void = () => {};
    const source = {
      ...f.source,
      editor: () =>
        new Promise<typeof first>((done) => {
          release = done;
        }),
    };
    f.menu.arm(first, source);
    f.menu.offer(flags);
    const pending = f.menu.read();
    f.retire();
    release(first);
    expect((await pending).status).toBe("idle");
    expect(f.applied).toEqual([]);
  });
});

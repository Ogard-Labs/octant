import { decodeBrowserPagePopupId } from "@octant/contracts/browser-presentation";
import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
}));
vi.mock("electron", () => ({
  dialog: { showOpenDialog: electron.showOpenDialog, showMessageBox: electron.showMessageBox },
  screen: {},
  Menu: {},
  Notification: { isSupported: () => false },
}));
const { nightlyChosenFiles, nightlyPageDialog, nightlyPageMenu, presentNightlyPagePopup } =
  await import("./nightlyPagePopups");
const { decodeNativeMenuRequest } = await import("./nativeContextMenus");

const id = decodeBrowserPagePopupId("80000000-0000-4000-8000-000000000001");

describe("Nightly's native page popups", () => {
  it("lists a select's groups and options and maps only an enabled option back", () => {
    const menu = nightlyPageMenu({
      kind: "select",
      id,
      anchor: { x: 0, y: 0, width: 100, height: 20 },
      selectedIndex: 1,
      options: [
        { label: "Small", disabled: false },
        { label: "Large", disabled: false, group: "Big" },
        { label: "Huge", disabled: true, group: "Big" },
        { label: "", disabled: false },
      ],
    });
    expect(menu.items).toEqual([
      { kind: "radio", id: "0", label: "Small", enabled: true, checked: false },
      { kind: "separator" },
      { kind: "item", id: "1.0", label: "Big", enabled: false },
      { kind: "radio", id: "1", label: "Large", enabled: true, checked: true },
      { kind: "radio", id: "2", label: "Huge", enabled: false, checked: false },
      { kind: "separator" },
      { kind: "radio", id: "3", label: "—", enabled: true, checked: false },
    ]);
    expect(menu.positioningItem).toBe(3);
    expect(menu.answer("1")).toEqual({ kind: "select", index: 1 });
    expect(menu.answer("2")).toBeUndefined();
    expect(menu.answer("1.0")).toBeUndefined();
    expect(decodeNativeMenuRequest({ x: 0, y: 0, items: menu.items })).toBeDefined();
  });

  it("shows a 512-option list that a renderer menu could not", () => {
    const options = Array.from({ length: 512 }, (_, index) => ({
      label: `Option ${String(index)}`,
      disabled: false,
    }));
    const menu = nightlyPageMenu({
      kind: "select",
      id,
      anchor: { x: 0, y: 0, width: 1, height: 1 },
      selectedIndex: 0,
      options,
    });
    expect(decodeNativeMenuRequest({ x: 0, y: 0, items: menu.items })).toBeUndefined();
    expect(decodeNativeMenuRequest({ x: 0, y: 0, items: menu.items }, 1_024)).toBeDefined();
  });

  it("offers only the link or image actions the page target has", () => {
    const link = nightlyPageMenu({ kind: "context", id, link: true, image: false });
    expect(link.items.map((item) => (item.kind === "separator" ? "-" : item.label))).toEqual([
      "Open Link in New Tab",
      "Copy Link Address",
    ]);
    expect(link.answer("0")).toEqual({ kind: "context", action: "open-link" });
    expect(link.answer("2")).toBeUndefined();
    const both = nightlyPageMenu({ kind: "context", id, link: true, image: true });
    expect(both.items).toHaveLength(5);
  });

  it("never puts page text in a dialog's heading", () => {
    expect(
      nightlyPageDialog({ kind: "dialog", id, dialog: "confirm", message: "Octant needs you" }),
    ).toEqual({
      message: "This page says",
      detail: "Octant needs you",
      buttons: ["OK", "Cancel"],
      cancelId: 1,
    });
    expect(
      nightlyPageDialog({ kind: "dialog", id, dialog: "beforeunload", message: "" }),
    ).toMatchObject({
      buttons: ["Leave", "Stay"],
    });
  });

  it("refuses chosen files the page may not be handed", () => {
    expect(nightlyChosenFiles(["/a.txt"], false)).toEqual({ kind: "file", paths: ["/a.txt"] });
    expect(nightlyChosenFiles(["/a.txt", "/b.txt"], false)).toBeUndefined();
    expect(
      nightlyChosenFiles(
        Array.from({ length: 9 }, (_, i) => `/${String(i)}`),
        true,
      ),
    ).toBeUndefined();
    expect(nightlyChosenFiles([`/${"a".repeat(1_100)}`], false)).toBeUndefined();
    expect(nightlyChosenFiles(["/a\0b"], false)).toBeUndefined();
    expect(
      nightlyChosenFiles(
        Array.from({ length: 8 }, () => `/${"é".repeat(1_000)}`),
        true,
      ),
    ).toBeUndefined();
  });

  it("stops waiting on an open panel whose chooser Stable retired, and holds later popups behind it", async () => {
    let close: (value: { canceled: boolean; filePaths: string[] }) => void = () => {};
    electron.showOpenDialog.mockImplementation(
      () =>
        new Promise((done) => {
          close = done;
        }),
    );
    electron.showMessageBox.mockResolvedValue({ response: 0 });
    const window = { isDestroyed: () => false } as unknown as import("electron").BrowserWindow;
    const retired = new AbortController();
    const chooser = presentNightlyPagePopup(
      window,
      { kind: "file", id, multiple: false },
      { pointer: undefined },
      retired.signal,
    );
    retired.abort();
    expect(await chooser).toBeUndefined();
    const dialog = presentNightlyPagePopup(
      window,
      { kind: "dialog", id, dialog: "alert", message: "Hi" },
      { pointer: undefined },
      new AbortController().signal,
    );
    await new Promise((done) => setTimeout(done, 20));
    // No sheet is stacked over the panel still on screen.
    expect(electron.showMessageBox).not.toHaveBeenCalled();
    close({ canceled: false, filePaths: ["/late.txt"] });
    expect(await dialog).toEqual({ kind: "dialog", accept: true });
    expect(electron.showMessageBox).toHaveBeenCalledTimes(1);
  });
});

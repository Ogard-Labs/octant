import { EventEmitter } from "node:events";
import type { BrowserWindow, MenuItemConstructorOptions, PopupOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
const nativeMenus = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("electron", () => ({ Menu: { buildFromTemplate: nativeMenus.build } }));
import {
  decodeNativeMenuRequest,
  nativeMenuTemplate,
  nativeEditingMenu,
  popupNativeMenu,
} from "./nativeContextMenus";

const action = { kind: "item", id: "0", label: "Rename", enabled: true } as const;
const request = { x: 40, y: 60, items: [action] };

describe("native menu contributions", () => {
  it("refuses oversized, nested, duplicate, or authority-bearing contributions", () => {
    expect(decodeNativeMenuRequest(request)).toEqual(request);
    expect(decodeNativeMenuRequest({ ...request, placement: "above" })).toEqual({
      ...request,
      placement: "above",
    });
    for (const invalid of [
      { ...request, x: Infinity },
      { ...request, placement: "invalid" },
      { ...request, y: 40_000 },
      { ...request, items: [{ ...action, role: "quit" }] },
      { ...request, items: [{ ...action, click: "shell" }] },
      { ...request, items: [action, action] },
      {
        ...request,
        items: Array.from({ length: 161 }, (_, index) => ({ ...action, id: String(index) })),
      },
      { ...request, items: [{ ...action, label: "a".repeat(257) }] },
    ])
      expect(decodeNativeMenuRequest(invalid)).toBeUndefined();
    let items: unknown = [action];
    for (let i = 0; i < 6; i++) items = [{ kind: "submenu", label: "Copy", enabled: true, items }];
    expect(decodeNativeMenuRequest({ ...request, items })).toBeUndefined();
  });

  it("preserves submenus and refuses disabled clicks while removing empty separators", () => {
    const select = vi.fn();
    const template = nativeMenuTemplate(
      [
        { kind: "separator" },
        { ...action, enabled: false },
        { kind: "separator" },
        { kind: "separator" },
        {
          kind: "submenu",
          label: "Copy & share",
          enabled: true,
          items: [{ ...action, id: "3.0" }],
        },
        { kind: "separator" },
      ],
      select,
      "linux",
    );
    expect(template).toHaveLength(3);
    expect(template[0]).toMatchObject({ label: "Rename", enabled: false });
    expect(template[2]).toMatchObject({
      label: "Copy && share",
      submenu: [{ label: "Rename", enabled: true }],
    });
    // Invoke the captured Electron callback even for a disabled item.
    template[0]?.click?.(
      {} as Electron.MenuItem,
      {} as Electron.BrowserWindow,
      {} as Electron.KeyboardEvent,
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("resolves native selection after the close callback and scales the footer anchor", async () => {
    const webContents = Object.assign(new EventEmitter(), { getZoomFactor: () => 2 });
    const window = Object.assign(new EventEmitter(), {
      webContents,
      isDestroyed: () => false,
    }) as unknown as BrowserWindow;
    let options: PopupOptions | undefined;
    let entries: MenuItemConstructorOptions[] = [];
    nativeMenus.build.mockImplementation((template: MenuItemConstructorOptions[]) => {
      entries = template;
      return {
        items: template,
        popup: (value: PopupOptions) => {
          options = value;
        },
        closePopup: vi.fn(),
      };
    });
    const selected = popupNativeMenu(window, { ...request, placement: "above" });
    expect(options).toMatchObject({ window, x: 80, y: 120, positioningItem: 0 });
    options?.callback?.();
    entries[0]?.click?.({} as Electron.MenuItem, window, {} as Electron.KeyboardEvent);
    expect(await selected).toEqual({ kind: "selected", id: "0" });
    expect(webContents.listenerCount("did-start-navigation")).toBe(0);
    expect(window.listenerCount("closed")).toBe(0);
  });

  it("dismisses an earlier menu when replaced and the current menu on navigation", async () => {
    const webContents = Object.assign(new EventEmitter(), { getZoomFactor: () => 1 });
    const window = Object.assign(new EventEmitter(), {
      webContents,
      isDestroyed: () => false,
    }) as unknown as BrowserWindow;
    const close = vi.fn();
    nativeMenus.build.mockImplementation((template: MenuItemConstructorOptions[]) => ({
      items: template,
      popup: vi.fn(),
      closePopup: close,
    }));
    const earlier = popupNativeMenu(window, request);
    const current = popupNativeMenu(window, request);
    expect(await earlier).toEqual({ kind: "dismissed" });
    webContents.emit("did-start-navigation", {}, "about:blank", false, true);
    expect(await current).toEqual({ kind: "dismissed" });
    expect(close).toHaveBeenCalledTimes(2);
    expect(webContents.listenerCount("did-start-navigation")).toBe(0);
  });

  it("offers native editing roles only where Chromium allows the edit", () => {
    const editFlags = {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
      canDelete: false,
      canEditRichly: false,
    };
    expect(nativeEditingMenu({ isEditable: false, selectionText: "", editFlags })).toEqual([]);
    expect(nativeEditingMenu({ isEditable: false, selectionText: "Selected", editFlags })).toEqual([
      { role: "copy", enabled: true },
    ]);
    expect(nativeEditingMenu({ isEditable: true, selectionText: "", editFlags })).toContainEqual({
      role: "cut",
      enabled: false,
    });
    expect(nativeEditingMenu({ isEditable: true, selectionText: "", editFlags })).toContainEqual({
      role: "paste",
      enabled: true,
    });
  });
});

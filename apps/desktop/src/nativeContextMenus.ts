import {
  Menu,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type ContextMenuParams,
} from "electron";
import type {
  NativeMenuEntry,
  NativeMenuRequest,
  NativeMenuOutcome,
} from "@octant/contracts/shell";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: ReadonlyArray<string>): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}

export function decodeNativeMenuRequest(value: unknown): NativeMenuRequest | undefined {
  if (
    !record(value) ||
    !keys(value, ["x", "y", "items", ...(value.placement === undefined ? [] : ["placement"])]) ||
    (value.placement !== undefined && value.placement !== "above") ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    Math.abs(value.x) > 32_768 ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    Math.abs(value.y) > 32_768
  )
    return undefined;
  let count = 0;
  const ids = new Set<string>();
  function entries(raw: unknown, depth: number): ReadonlyArray<NativeMenuEntry> | undefined {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 160 || depth > 4) return undefined;
    const result: NativeMenuEntry[] = [];
    for (const item of raw) {
      if (++count > 160 || !record(item)) return undefined;
      if (item.kind === "separator" && keys(item, ["kind"])) {
        result.push({ kind: "separator" });
        continue;
      }
      if (
        typeof item.label !== "string" ||
        item.label.trim().length === 0 ||
        item.label.length > 256 ||
        typeof item.enabled !== "boolean"
      )
        return undefined;
      if (
        (item.kind === "item" || item.kind === "checkbox" || item.kind === "radio") &&
        keys(item, [
          "kind",
          "id",
          "label",
          "enabled",
          ...(item.checked === undefined ? [] : ["checked"]),
          ...(item.description === undefined ? [] : ["description"]),
        ]) &&
        (item.checked === undefined || typeof item.checked === "boolean") &&
        (item.description === undefined ||
          (typeof item.description === "string" && item.description.length <= 512)) &&
        typeof item.id === "string" &&
        /^[0-9.]{1,64}$/.test(item.id) &&
        !ids.has(item.id)
      ) {
        ids.add(item.id);
        result.push({
          kind: item.kind,
          id: item.id,
          label: item.label,
          enabled: item.enabled,
          ...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
          ...(typeof item.description === "string" ? { description: item.description } : {}),
        });
      } else if (item.kind === "submenu" && keys(item, ["kind", "label", "enabled", "items"])) {
        const children = entries(item.items, depth + 1);
        if (children === undefined) return undefined;
        result.push({ kind: "submenu", label: item.label, enabled: item.enabled, items: children });
      } else return undefined;
    }
    return result;
  }
  const items = entries(value.items, 0);
  return items === undefined
    ? undefined
    : {
        x: value.x,
        y: value.y,
        items,
        ...(value.placement === "above" ? { placement: "above" } : {}),
      };
}

export function nativeMenuTemplate(
  items: ReadonlyArray<NativeMenuEntry>,
  select: (id: string) => void,
  platform = process.platform,
): MenuItemConstructorOptions[] {
  const result: MenuItemConstructorOptions[] = [];
  for (const item of items) {
    if (item.kind === "separator") {
      if (result.length > 0 && result.at(-1)?.type !== "separator")
        result.push({ type: "separator" });
      continue;
    }
    // Ampersands are literal product copy, never renderer-supplied mnemonics.
    const label = platform === "darwin" ? item.label : item.label.replaceAll("&", "&&");
    result.push(
      item.kind === "submenu"
        ? {
            label,
            enabled: item.enabled,
            submenu: nativeMenuTemplate(item.items, select, platform),
          }
        : {
            label,
            enabled: item.enabled,
            ...(item.kind === "item" ? {} : { type: item.kind, checked: item.checked === true }),
            ...(item.description === undefined ? {} : { toolTip: item.description }),
            click: () => {
              if (item.enabled) select(item.id);
            },
          },
    );
  }
  if (result.at(-1)?.type === "separator") result.pop();
  return result;
}

const activeMenus = new WeakMap<BrowserWindow, () => void>();

export function popupNativeMenu(window: BrowserWindow, value: unknown): Promise<NativeMenuOutcome> {
  const request = decodeNativeMenuRequest(value);
  if (request === undefined || window.isDestroyed()) return Promise.resolve({ kind: "refused" });
  activeMenus.get(window)?.();
  return new Promise((resolve) => {
    let outcome: NativeMenuOutcome = { kind: "dismissed" };
    let settled = false;
    const menu = Menu.buildFromTemplate(
      nativeMenuTemplate(request.items, (id) => {
        outcome = { kind: "selected", id };
      }),
    );
    const finish = () => {
      if (settled) return;
      settled = true;
      activeMenus.delete(window);
      window.removeListener("closed", dismiss);
      window.webContents.removeListener("did-start-navigation", navigated);
      resolve(outcome);
    };
    const dismiss = () => {
      outcome = { kind: "dismissed" };
      menu.closePopup(window);
      finish();
    };
    const navigated = (
      _event: Electron.Event,
      _url: string,
      _inPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) dismiss();
    };
    activeMenus.set(window, dismiss);
    window.once("closed", dismiss);
    window.webContents.on("did-start-navigation", navigated);
    const zoom = window.webContents.getZoomFactor();
    menu.popup({
      window,
      x: Math.round(request.x * zoom),
      y: Math.round(request.y * zoom),
      ...(request.placement === "above" ? { positioningItem: menu.items.length - 1 } : {}),
      // Electron's close callback can precede the selected item's click on some
      // platforms. Settle after that native dispatch has returned.
      callback: () => {
        setImmediate(finish);
      },
    });
  });
}

export function nativeEditingMenu(
  params: Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">,
): MenuItemConstructorOptions[] {
  if (!params.isEditable)
    return params.selectionText.length === 0
      ? []
      : [{ role: "copy", enabled: params.editFlags.canCopy }];
  return [
    { role: "undo", enabled: params.editFlags.canUndo },
    { role: "redo", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { type: "separator" },
    { role: "selectAll", enabled: params.editFlags.canSelectAll },
  ];
}

export function installNativeEditingMenus(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    if (params.frame !== window.webContents.mainFrame) return;
    const template = nativeEditingMenu(params);
    if (template.length > 0)
      Menu.buildFromTemplate(template).popup({
        window,
        frame: params.frame,
        x: params.x,
        y: params.y,
      });
  });
}

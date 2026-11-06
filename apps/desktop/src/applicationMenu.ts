import { ringForVersion } from "@octant/domain";
import type { AppVersion } from "@octant/contracts/app-updates";
import type { MenuItemConstructorOptions } from "electron";

/**
 * Whether Octant keeps Chromium's developer tools: in development builds and
 * in Preview and candidate builds, but not in a packaged stable release (a
 * version with no prerelease tag). Their shortcut lives only on the menu, so
 * one decision covers both.
 */
export function developerToolsAllowed(build: {
  readonly packaged: boolean;
  readonly version: string;
}): boolean {
  return !build.packaged || ringForVersion(build.version as AppVersion) !== "stable";
}

export interface ApplicationMenuOptions {
  readonly appName: string;
  readonly onOpenSettings: () => void;
  /** `viaShortcut` is true when the ⌘Q accelerator, not a pointer click, chose Quit. */
  readonly onQuit: (request: { readonly viaShortcut: boolean }) => void;
  /**
   * Whether View keeps Reload and Toggle Developer Tools. A packaged Octant
   * Nightly client passes false: its window holds a host lease, and those
   * items would let anyone at the keyboard reload it away or script it.
   */
  readonly developerTools: boolean;
}

/** Standard macOS application menu plus Octant's shared Settings surface. */
export function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  return [
    {
      label: options.appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          accelerator: "CommandOrControl+,",
          click: options.onOpenSettings,
          label: "Settings…",
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        // An explicit item (not the `quit` role) marks the quit as interactive
        // so the active-work confirmation can tell it apart from signal- or
        // event-driven termination that nobody can answer.
        {
          accelerator: "CmdOrCtrl+Q",
          click: (_item, _window, event) =>
            options.onQuit({ viaShortcut: event?.triggeredByAccelerator === true }),
          label: `Quit ${options.appName}`,
        },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    options.developerTools
      ? { role: "viewMenu" }
      : {
          label: "View",
          submenu: [
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
    { role: "windowMenu" },
  ];
}

/**
 * The Windows and Linux menu bar of a packaged stable release: the standard
 * File, Edit, View and Window menus without the macOS application menu and
 * without Reload or Toggle Developer Tools. Removing the menu outright would
 * also take away zoom, fullscreen and the Edit roles' clipboard shortcuts.
 */
export function buildStableMenuTemplate(): MenuItemConstructorOptions[] {
  return buildApplicationMenuTemplate({
    appName: "Octant",
    onOpenSettings: () => {},
    onQuit: () => {},
    developerTools: false,
  }).slice(1);
}

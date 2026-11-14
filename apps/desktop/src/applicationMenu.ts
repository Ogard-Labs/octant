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
  /** Prepare to shut down…: moves this computer's threads to another before it goes off. */
  readonly onPrepareToShutDown?: () => void;
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
        ...(options.onPrepareToShutDown === undefined
          ? []
          : [{ click: options.onPrepareToShutDown, label: "Prepare to shut down…" }]),
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
 * The Windows and Linux menu bar: no application menu exists there, so File
 * carries Settings…, Prepare to shut down…, and Quit, the last through the same
 * interactive quit (and its active-work confirmation) as the macOS item. Edit,
 * View and Window stay, because removing the menu would also take away zoom,
 * fullscreen and the Edit roles' clipboard shortcuts.
 */
export function buildWindowsLinuxMenuTemplate(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  const [appMenu, , ...rest] = buildApplicationMenuTemplate(options);
  const appItems = Array.isArray(appMenu?.submenu) ? appMenu.submenu : [];
  const carried = (label: string) => appItems.filter((item) => item.label === label);
  return [
    {
      label: "File",
      submenu: [
        ...carried("Settings…"),
        { type: "separator" },
        ...carried("Prepare to shut down…"),
        { role: "close" },
        ...carried(`Quit ${options.appName}`),
      ],
    },
    ...rest,
  ];
}

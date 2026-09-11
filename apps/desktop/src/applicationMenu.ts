import type { MenuItemConstructorOptions } from "electron";

export interface ApplicationMenuOptions {
  readonly appName: string;
  readonly onOpenSettings: () => void;
  readonly onQuit: () => void;
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
          click: options.onQuit,
          label: `Quit ${options.appName}`,
        },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}

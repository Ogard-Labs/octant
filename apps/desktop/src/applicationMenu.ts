import type { MenuItemConstructorOptions } from "electron";

export interface ApplicationMenuOptions {
  readonly appName: string;
  readonly onOpenSettings: () => void;
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
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}

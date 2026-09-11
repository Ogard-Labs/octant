import { describe, expect, it, vi } from "vitest";
import { buildApplicationMenuTemplate } from "./applicationMenu";

describe("native application menu", () => {
  it("keeps Settings in the Octant menu and invokes the shared settings action", () => {
    const onOpenSettings = vi.fn();
    const template = buildApplicationMenuTemplate({
      appName: "Octant",
      onOpenSettings,
      onQuit: vi.fn(),
    });
    const appMenu = template[0];

    expect(appMenu?.label).toBe("Octant");
    expect(appMenu?.submenu).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Settings…", accelerator: "CommandOrControl+," }),
      ]),
    );

    const settings = Array.isArray(appMenu?.submenu)
      ? appMenu.submenu.find((item) => item.label === "Settings…")
      : undefined;
    expect(settings?.click).toBeTypeOf("function");
    settings?.click?.({} as never, {} as never, {} as never);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("marks menu quit as interactive so the active-work confirmation can show", () => {
    const onQuit = vi.fn();
    const template = buildApplicationMenuTemplate({
      appName: "Octant",
      onOpenSettings: vi.fn(),
      onQuit,
    });
    const appMenu = template[0];
    const quit = Array.isArray(appMenu?.submenu)
      ? appMenu.submenu.find((item) => item.label === "Quit Octant")
      : undefined;
    expect(quit?.accelerator).toBe("CmdOrCtrl+Q");
    quit?.click?.({} as never, {} as never, {} as never);
    expect(onQuit).toHaveBeenCalledOnce();
  });

  it("retains the standard File, Edit, View, and Window menus", () => {
    const template = buildApplicationMenuTemplate({
      appName: "Octant",
      onOpenSettings: vi.fn(),
      onQuit: vi.fn(),
    });
    expect(template.slice(1).map((item) => item.role)).toEqual([
      "fileMenu",
      "editMenu",
      "viewMenu",
      "windowMenu",
    ]);
  });
});

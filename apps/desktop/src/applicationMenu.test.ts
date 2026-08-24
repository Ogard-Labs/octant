import { describe, expect, it, vi } from "vitest";
import { buildApplicationMenuTemplate } from "./applicationMenu";

describe("native application menu", () => {
  it("keeps Settings in the Octant menu and invokes the shared settings action", () => {
    const onOpenSettings = vi.fn();
    const template = buildApplicationMenuTemplate({ appName: "Octant", onOpenSettings });
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

  it("retains the standard File, Edit, View, and Window menus", () => {
    const template = buildApplicationMenuTemplate({ appName: "Octant", onOpenSettings: vi.fn() });
    expect(template.slice(1).map((item) => item.role)).toEqual([
      "fileMenu",
      "editMenu",
      "viewMenu",
      "windowMenu",
    ]);
  });
});

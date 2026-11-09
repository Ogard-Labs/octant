import { describe, expect, it, vi } from "vitest";
import {
  buildApplicationMenuTemplate,
  buildStableMenuTemplate,
  developerToolsAllowed,
} from "./applicationMenu";

describe("native application menu", () => {
  it("keeps Settings in the Octant menu and invokes the shared settings action", () => {
    const onOpenSettings = vi.fn();
    const template = buildApplicationMenuTemplate({
      appName: "Octant",
      onOpenSettings,
      onQuit: vi.fn(),
      developerTools: true,
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

  it("offers Prepare to Shut Down just above Quit when the desktop can move threads", () => {
    const onPrepareToShutDown = vi.fn();
    const template = buildApplicationMenuTemplate({
      appName: "Octant",
      onOpenSettings: vi.fn(),
      onPrepareToShutDown,
      onQuit: vi.fn(),
      developerTools: true,
    });
    const items = Array.isArray(template[0]?.submenu) ? template[0].submenu : [];
    const labels = items.map((item) => item.label);
    const prepare = items.find((item) => item.label === "Prepare to Shut Down…");
    expect(labels.indexOf("Prepare to Shut Down…")).toBe(labels.indexOf("Quit Octant") - 1);
    prepare?.click?.({} as never, {} as never, {} as never);
    expect(onPrepareToShutDown).toHaveBeenCalledOnce();
  });

  it("marks menu quit as interactive so the active-work confirmation can show", () => {
    const onQuit = vi.fn();
    const template = buildApplicationMenuTemplate({
      appName: "Octant",
      onOpenSettings: vi.fn(),
      onQuit,
      developerTools: true,
    });
    const appMenu = template[0];
    const quit = Array.isArray(appMenu?.submenu)
      ? appMenu.submenu.find((item) => item.label === "Quit Octant")
      : undefined;
    expect(quit?.accelerator).toBe("CmdOrCtrl+Q");
    quit?.click?.({} as never, {} as never, {} as never);
    quit?.click?.({} as never, {} as never, { triggeredByAccelerator: true } as never);
    expect(onQuit).toHaveBeenNthCalledWith(1, { viaShortcut: false });
    expect(onQuit).toHaveBeenNthCalledWith(2, { viaShortcut: true });
  });

  it("retains the standard File, Edit, View, and Window menus", () => {
    const template = buildApplicationMenuTemplate({
      appName: "Octant",
      onOpenSettings: vi.fn(),
      onQuit: vi.fn(),
      developerTools: true,
    });
    expect(template.slice(1).map((item) => item.role)).toEqual([
      "fileMenu",
      "editMenu",
      "viewMenu",
      "windowMenu",
    ]);
  });

  it("leaves Reload and developer tools out of View when they are not offered", () => {
    const template = buildApplicationMenuTemplate({
      appName: "Octant Nightly",
      onOpenSettings: vi.fn(),
      onQuit: vi.fn(),
      developerTools: false,
    });
    expect(template[0]?.label).toBe("Octant Nightly");
    const view = template.find((item) => item.label === "View");
    expect(view?.role).toBeUndefined();
    const roles = Array.isArray(view?.submenu) ? view.submenu.map((item) => item.role) : [];
    expect(roles).toContain("togglefullscreen");
    for (const role of ["toggleDevTools", "reload", "forceReload"])
      expect(roles).not.toContain(role);
    expect(template.map((item) => item.role)).not.toContain("viewMenu");
  });
});

describe("developer tools by build", () => {
  it("keeps developer tools in development, candidate and preview builds and hides them in a stable release", () => {
    expect(developerToolsAllowed({ packaged: false, version: "0.2.0" })).toBe(true);
    expect(developerToolsAllowed({ packaged: true, version: "0.2.0-candidate.3" })).toBe(true);
    expect(developerToolsAllowed({ packaged: true, version: "0.2.0-preview.5" })).toBe(true);
    expect(developerToolsAllowed({ packaged: true, version: "0.2.0" })).toBe(false);
  });
});

describe("stable Windows and Linux menu", () => {
  it("keeps zoom, fullscreen and the Edit menu and offers neither reload nor developer tools", () => {
    const template = buildStableMenuTemplate();
    const roles = JSON.stringify(template);
    expect(template.map((item) => item.role ?? item.label)).toEqual([
      "fileMenu",
      "editMenu",
      "View",
      "windowMenu",
    ]);
    for (const role of ["zoomIn", "zoomOut", "resetZoom", "togglefullscreen"]) {
      expect(roles).toContain(`"${role}"`);
    }
    for (const role of ["reload", "forceReload", "toggleDevTools", "viewMenu"]) {
      expect(roles).not.toContain(`"${role}"`);
    }
  });
});

import { describe, expect, it } from "vitest";
import { resolveDesktopNodeRuntime, resolveDesktopHostRoot } from "./runtimePaths";

describe("packaged desktop worker runtime", () => {
  it("uses an independent macOS executable and physical host tree without changing the GUI entry", () => {
    const input = {
      packaged: true,
      platform: "darwin" as const,
      resourcesPath: "/Apps/Octant.app/Contents/Resources",
      execPath: "/Apps/Octant.app/Contents/MacOS/Octant",
      appRoot: "/Apps/Octant.app/Contents/Resources/app.asar",
    };
    expect(resolveDesktopNodeRuntime(input)).toBe(
      "/Apps/Octant.app/Contents/Frameworks/Octant Runtime.app/Contents/MacOS/Octant Runtime",
    );
    expect(resolveDesktopHostRoot(input)).toBe("/Apps/Octant.app/Contents/Resources/app");
  });
  it("preserves development and Linux runtime paths", () => {
    for (const input of [
      { packaged: false, platform: "darwin" as const },
      { packaged: true, platform: "linux" as const },
    ]) {
      const options = {
        ...input,
        execPath: "/runtime/electron",
        resourcesPath: "/runtime/resources",
        appRoot: "/source",
      };
      expect(resolveDesktopNodeRuntime(options)).toBe(options.execPath);
      expect(resolveDesktopHostRoot(options)).toBe(options.appRoot);
    }
  });
});

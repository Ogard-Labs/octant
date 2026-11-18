import { join } from "node:path";
import {
  desktopIdentity,
  desktopWindowStorageDirectory,
} from "@octant/host-runtime/desktop-identity";
import { describe, expect, it } from "vitest";
import {
  desktopUserDataDirectory,
  resolveDesktopHostRoot,
  resolveDesktopHostRuntimePaths,
  resolveDesktopNodeRuntime,
} from "./runtimePaths";

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

describe("desktop user data folder for the compile cache", () => {
  const stable = desktopIdentity("stable");
  const appData = "/Users/someone/Library/Application Support";

  it("is the data folder OCTANT_DATA_DIR names, the same one main sets as userData", () => {
    const configured = "/private/tmp/octant-test-data";
    const env = { OCTANT_DATA_DIR: configured };
    const expected = desktopWindowStorageDirectory(
      stable,
      resolveDesktopHostRuntimePaths(configured, appData, "darwin", env, {
        createDataDirectory: false,
      }).dataDirectory,
      appData,
    );
    const chosen = desktopUserDataDirectory({
      identity: stable,
      appDataDirectory: appData,
      platform: "darwin",
      env,
    });
    expect(chosen).toBe(expected);
    expect(chosen).not.toBe(join(appData, "Octant"));
  });

  it("is the default Octant folder without OCTANT_DATA_DIR and absent on Windows", () => {
    expect(
      desktopUserDataDirectory({
        identity: stable,
        appDataDirectory: appData,
        platform: "darwin",
        env: {},
      }),
    ).toBe(join(appData, "Octant"));
    expect(
      desktopUserDataDirectory({
        identity: stable,
        appDataDirectory: "C:\\Users\\someone\\AppData\\Roaming",
        platform: "win32",
        env: {},
      }),
    ).toBeUndefined();
  });
});

import { mkdtemp, mkdir, writeFile, symlink, rm, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { desktopIdentity } from "@octant/host-runtime";
import {
  createNodeRuntimePackagerOptions,
  validateRuntimeFrameworkIndependence,
} from "./desktop-node-runtime";
import { validateDarwinBundleIdentity } from "./package-desktop";

describe("standalone packaged worker identity", () => {
  it("cannot be validated as either trusted desktop main", () => {
    const options = createNodeRuntimePackagerOptions({
      stage: "/stage",
      out: "/out",
      version: "0.1.0",
      electronVersion: "43.7.11",
    });
    expect(options).toMatchObject({
      appBundleId: "app.octant.desktop.runtime",
      name: "Octant Runtime",
      electronVersion: "43.7.11",
      asar: false,
    });
    const metadata = {
      CFBundleIdentifier: options.appBundleId,
      CFBundleName: options.name,
      CFBundleExecutable: options.name,
    };
    for (const identity of [desktopIdentity("stable"), desktopIdentity("nightly")])
      expect(() => validateDarwinBundleIdentity(metadata, identity)).toThrow(/identity/);
  });
  it("requires independent Framework files and contained relative symlinks before any fuse write", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-runtime-pair-"));
    const make = async (name: string) => {
      const app = join(root, `${name}.app`);
      const framework = join(app, "Contents/Frameworks/Electron Framework.framework");
      await mkdir(join(framework, "Versions/A"), { recursive: true });
      await writeFile(join(framework, "Versions/A/Electron Framework"), "fixture");
      await symlink("A", join(framework, "Versions/Current"));
      await symlink("Versions/Current/Electron Framework", join(framework, "Electron Framework"));
      return { app, framework };
    };
    try {
      const primary = await make("desktop");
      const runtime = await make("runtime");
      await expect(
        validateRuntimeFrameworkIndependence(primary.app, runtime.app),
      ).resolves.toBeUndefined();
      await rm(join(runtime.framework, "Versions/A/Electron Framework"));
      await link(
        join(primary.framework, "Versions/A/Electron Framework"),
        join(runtime.framework, "Versions/A/Electron Framework"),
      );
      await expect(validateRuntimeFrameworkIndependence(primary.app, runtime.app)).rejects.toThrow(
        /share Framework/,
      );
      await rm(join(runtime.framework, "Versions/A/Electron Framework"));
      await symlink(
        join(primary.framework, "Versions/A/Electron Framework"),
        join(runtime.framework, "Versions/A/Electron Framework"),
      );
      await expect(validateRuntimeFrameworkIndependence(primary.app, runtime.app)).rejects.toThrow(
        /escapes/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

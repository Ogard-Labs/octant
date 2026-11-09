import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, link } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { downloadArtifact } from "@electron/get";
import { Cache } from "../node_modules/@electron/get/dist/Cache.js";
import { describe, expect, it, vi } from "vitest";
import { desktopIdentity } from "@octant/host-runtime";
import {
  createNodeRuntimePackagerOptions,
  resolveElectronPackagerDownload,
  validateRuntimeFrameworkIndependence,
} from "./desktop-node-runtime";
import {
  createPackagerOptions,
  DESKTOP_PACKAGE_TARGETS,
  validateDarwinBundleIdentity,
} from "./package-desktop";

describe("standalone packaged worker identity", () => {
  it("passes the same verified archive cache and checksums to the desktop and worker packagers", () => {
    const download = {
      cacheRoot: "/owned-electron-cache",
      checksums: {
        "electron-v43.7.11-darwin-arm64.zip":
          "e60ad7fb9c030ddfb5005a6bc54712bc78c2d3e760f7f010fa5b997e956aaefa",
      },
    };
    const desktop = createPackagerOptions(
      "/stage",
      "/out",
      "0.1.0",
      undefined,
      undefined,
      download,
    );
    const worker = createNodeRuntimePackagerOptions({
      stage: "/stage",
      out: "/out",
      version: "0.1.0",
      electronVersion: "43.7.11",
      download,
    });
    expect(desktop.download).toEqual(download);
    expect(worker.download).toEqual(download);
  });
  it("requires the installed version and target checksums even without an explicit cache", async () => {
    const installedPackage: unknown = JSON.parse(
      await readFile(new URL("../node_modules/electron/package.json", import.meta.url), "utf8"),
    );
    const installedChecksums: unknown = JSON.parse(
      await readFile(new URL("../node_modules/electron/checksums.json", import.meta.url), "utf8"),
    );
    for (const target of Object.values(DESKTOP_PACKAGE_TARGETS)) {
      const name = `electron-v43.7.11-${target.platform}-${target.arch}.zip`;
      const installedDownload = resolveElectronPackagerDownload({
        electronVersion: "43.7.11",
        platform: target.platform,
        arch: target.arch,
        installedPackage,
        checksums: installedChecksums,
      });
      expect(installedDownload.checksums[name]).toMatch(/^[a-f0-9]{64}$/);
      const input = {
        electronVersion: "43.7.11",
        platform: target.platform,
        arch: target.arch,
        installedPackage: { version: "43.7.11" },
        checksums: { [name]: "a".repeat(64) },
      };
      const download = resolveElectronPackagerDownload(input);
      expect(download).toEqual({ checksums: input.checksums });
      expect(
        createPackagerOptions("/stage", "/out", "0.1.0", target, undefined, download).download,
      ).toEqual(download);
      for (const invalid of [
        { ...input, installedPackage: { version: "43.7.12" } },
        { ...input, checksums: {} },
        { ...input, checksums: { [name]: "changed" } },
        { ...input, checksums: { [name]: "a".repeat(64), another: 42 } },
        { ...input, checksums: [] },
      ])
        expect(() => resolveElectronPackagerDownload(invalid)).toThrow();
    }
  });
  it("validates cached archive bytes without fetching a checksum manifest and refuses corruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-packager-cache-"));
    const name = "electron-v43.7.11-darwin-arm64.zip";
    const bytes = Buffer.from("owned synthetic archive bytes; never extracted");
    const checksums = { [name]: createHash("sha256").update(bytes).digest("hex") };
    const networkDownload = vi.fn(async () => {
      throw Error("No network is permitted in this cache proof.");
    });
    try {
      const path = new Cache(root).getCachePath(
        `https://github.com/electron/electron/releases/download/v43.7.11/${name}`,
        name,
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      const download = resolveElectronPackagerDownload({
        electronVersion: "43.7.11",
        platform: "darwin",
        arch: "arm64",
        installedPackage: { version: "43.7.11" },
        checksums,
        cacheRoot: root,
      });
      const input = {
        ...download,
        version: "43.7.11",
        platform: "darwin",
        arch: "arm64",
        artifactName: "electron",
        downloader: { download: networkDownload },
      };
      await expect(downloadArtifact(input)).resolves.toBe(path);
      expect(networkDownload).not.toHaveBeenCalled();
      await writeFile(path, "corrupt owned bytes");
      await expect(downloadArtifact(input)).rejects.toThrow("No network is permitted");
      expect(networkDownload).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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

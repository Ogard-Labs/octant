import { rebuild } from "@electron/rebuild";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** The sources the Linux binding compiles from; nothing else is staged. */
export const DESKTOP_PEER_LINUX_SOURCES = [
  "desktopPeerLinux.cc",
  "desktopPeerLinuxPolicy.h",
] as const;

/** The node-gyp target for the Linux binding: C++20, warnings as errors. */
export function desktopPeerLinuxBinding() {
  return {
    targets: [
      {
        target_name: "octant-desktop-peer-linux",
        sources: ["desktopPeerLinux.cc"],
        defines: ["NAPI_VERSION=8"],
        cflags_cc: ["-std=c++20", "-O2", "-Wall", "-Wextra", "-Werror", "-fexceptions"],
        "cflags_cc!": ["-fno-exceptions", "-std=gnu++17", "-std=gnu++20"],
      },
    ],
  };
}

/**
 * Only packaged Linux needs this component; development builds never load
 * it and report the native window protocol unavailable. It is built from
 * source against the pinned Electron headers, as the macOS binding is.
 */
export async function buildDesktopPeerLinux(
  destination = resolve(repositoryRoot, "apps/desktop/dist/native/octant-desktop-peer-linux.node"),
  arch: "x64" | "arm64" = "x64",
): Promise<void> {
  if (process.platform !== "linux") return;
  const manifest: unknown = JSON.parse(
    await readFile(resolve(repositoryRoot, "apps/desktop/package.json"), "utf8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("devDependencies" in manifest) ||
    typeof manifest.devDependencies !== "object" ||
    manifest.devDependencies === null ||
    !("electron" in manifest.devDependencies) ||
    typeof manifest.devDependencies.electron !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(manifest.devDependencies.electron)
  )
    throw new Error("Desktop Linux client trust requires the pinned Electron version.");

  const stage = await mkdtemp(resolve(tmpdir(), "octant-desktop-peer-linux-build-"));
  const moduleName = "@octant/desktop-peer-linux";
  const moduleRoot = resolve(stage, "node_modules", moduleName);
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(
    resolve(stage, "package.json"),
    JSON.stringify({
      name: "@octant/desktop-peer-linux-build",
      private: true,
      dependencies: { [moduleName]: "0.0.0" },
    }),
  );
  await writeFile(
    resolve(moduleRoot, "package.json"),
    JSON.stringify({ name: moduleName, version: "0.0.0", gypfile: true }),
  );
  for (const source of DESKTOP_PEER_LINUX_SOURCES)
    await cp(
      resolve(repositoryRoot, "apps/desktop/src/native", source),
      resolve(moduleRoot, source),
    );
  await writeFile(resolve(moduleRoot, "binding.gyp"), JSON.stringify(desktopPeerLinuxBinding()));
  await rebuild({
    buildPath: stage,
    electronVersion: manifest.devDependencies.electron,
    arch,
    force: true,
    buildFromSource: true,
    onlyModules: [moduleName],
    mode: "sequential",
    useCache: false,
  });
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(moduleRoot, "build/Release/octant-desktop-peer-linux.node"), destination);
}
if (import.meta.main) await buildDesktopPeerLinux();

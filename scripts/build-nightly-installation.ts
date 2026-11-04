import { rebuild } from "@electron/rebuild";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** Only packaged macOS needs this component; ordinary development stays unsigned. */
export async function buildNightlyInstallation(
  destination = resolve(
    repositoryRoot,
    "apps/desktop/dist/native/octant-nightly-installation.node",
  ),
): Promise<void> {
  if (process.platform !== "darwin") return;
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
    throw new Error("Nightly installation requires the pinned Electron version.");

  // Use the existing packaging builder for its pinned-header provisioning.
  // Requiring a cache during ordinary desktop build breaks a clean checkout.
  const stage = await mkdtemp(resolve(tmpdir(), "octant-nightly-installation-build-"));
  const moduleName = "@octant/nightly-installation";
  const moduleRoot = resolve(stage, "node_modules", moduleName);
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(
    resolve(stage, "package.json"),
    JSON.stringify({
      name: "@octant/nightly-installation-build",
      private: true,
      dependencies: { [moduleName]: "0.0.0" },
    }),
  );
  await writeFile(
    resolve(moduleRoot, "package.json"),
    JSON.stringify({ name: moduleName, version: "0.0.0", gypfile: true }),
  );
  for (const source of [
    "nightlyInstallation.mm",
    "desktopPeerPolicy.h",
    "desktopApplicationIdentity.h",
  ])
    await cp(
      resolve(repositoryRoot, "apps/desktop/src/native", source),
      resolve(moduleRoot, source),
    );
  await writeFile(
    resolve(moduleRoot, "binding.gyp"),
    JSON.stringify({
      targets: [
        {
          target_name: "octant-nightly-installation",
          sources: ["nightlyInstallation.mm"],
          defines: ["NAPI_VERSION=8"],
          libraries: [
            "-framework Security",
            "-framework CoreFoundation",
            "-framework AppKit",
            "-framework CoreServices",
            "-larchive",
          ],
          xcode_settings: {
            CLANG_CXX_LANGUAGE_STANDARD: "c++20",
            GCC_ENABLE_CPP_EXCEPTIONS: "YES",
            MACOSX_DEPLOYMENT_TARGET: "14.0",
            OTHER_CPLUSPLUSFLAGS: [
              "-O2",
              "-fblocks",
              "-Wall",
              "-Wextra",
              "-Werror",
              "-Wno-deprecated-declarations",
            ],
          },
        },
      ],
    }),
  );
  await rebuild({
    buildPath: stage,
    electronVersion: manifest.devDependencies.electron,
    arch: "arm64",
    force: true,
    buildFromSource: true,
    onlyModules: [moduleName],
    mode: "sequential",
    useCache: false,
  });
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(moduleRoot, "build/Release/octant-nightly-installation.node"), destination);
}
if (import.meta.main) await buildNightlyInstallation();

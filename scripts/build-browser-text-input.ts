import { rebuild } from "@electron/rebuild";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** Only packaged macOS needs this component; ordinary development stays unsigned. */
export async function buildBrowserTextInput(
  destination = resolve(repositoryRoot, "apps/desktop/dist/native/octant-browser-text-input.node"),
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
    throw new Error("Browser native text input requires the pinned Electron version.");

  // Use the existing packaging builder for its pinned-header provisioning.
  // Requiring a cache during ordinary desktop build breaks a clean checkout.
  const stage = await mkdtemp(resolve(tmpdir(), "octant-browser-text-build-"));
  const moduleName = "@octant/browser-text-input";
  const moduleRoot = resolve(stage, "node_modules", moduleName);
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(
    resolve(stage, "package.json"),
    JSON.stringify({
      name: "@octant/browser-text-build",
      private: true,
      dependencies: { [moduleName]: "0.0.0" },
    }),
  );
  await writeFile(
    resolve(moduleRoot, "package.json"),
    JSON.stringify({ name: moduleName, version: "0.0.0", gypfile: true }),
  );
  for (const source of ["browserTextInput.mm"])
    await cp(
      resolve(repositoryRoot, "apps/desktop/src/native", source),
      resolve(moduleRoot, source),
    );
  await writeFile(
    resolve(moduleRoot, "binding.gyp"),
    JSON.stringify({
      targets: [
        {
          target_name: "octant-browser-text-input",
          sources: ["browserTextInput.mm"],
          defines: ["NAPI_VERSION=8"],
          libraries: ["-framework AppKit"],
          xcode_settings: {
            CLANG_ENABLE_OBJC_ARC: "YES",
            CLANG_CXX_LANGUAGE_STANDARD: "c++20",
            GCC_ENABLE_CPP_EXCEPTIONS: "YES",
            MACOSX_DEPLOYMENT_TARGET: "14.0",
            OTHER_CPLUSPLUSFLAGS: [
              "-O2",
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
  await cp(resolve(moduleRoot, "build/Release/octant-browser-text-input.node"), destination);
}
if (import.meta.main) await buildBrowserTextInput();

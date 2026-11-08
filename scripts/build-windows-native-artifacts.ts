import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
export const WINDOWS_NATIVE_ARTIFACTS = [
  "octant-windows-host-owner.node",
  "octant-credential-helper.exe",
  "octant-desktop-peer-windows.node",
] as const;

/** Native resources contain only the fixed runtime artifacts, never QA readers or build files. */
export async function validateWindowsNativeArtifacts(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== WINDOWS_NATIVE_ARTIFACTS.length ||
    entries.some(
      (entry) => !entry.isFile() || !WINDOWS_NATIVE_ARTIFACTS.some((name) => name === entry.name),
    )
  )
    throw Error("Windows native resources must contain only the fixed runtime artifacts.");
  for (const name of WINDOWS_NATIVE_ARTIFACTS) {
    const bytes = await readFile(join(directory, name));
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0;
    if (
      bytes.subarray(0, 2).toString() !== "MZ" ||
      offset < 64 ||
      offset > bytes.length - 24 ||
      bytes.subarray(offset, offset + 4).toString() !== "PE\0\0" ||
      bytes.readUInt16LE(offset + 4) !== 0x8664 ||
      ((bytes.readUInt16LE(offset + 22) & 0x2000) !== 0) !== name.endsWith(".node")
    )
      throw Error(`Windows native resource is not the expected x64 PE artifact: ${name}.`);
  }
}

/** Build existing native sources on their matching host; SDK integrity belongs to installed node-gyp. */
export async function buildWindowsNativeArtifacts(destination: string): Promise<void> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw Error("Windows native resources require a native Windows x64 build host.");
  const stage = await mkdtemp(join(tmpdir(), "octant-windows-native-build-"));
  try {
    const node = await run("node", ["-p", "process.versions.node"], { cwd: root });
    const version = node.stdout.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error("Invalid native SDK version.");
    const rebuild = createRequire(import.meta.url).resolve("@electron/rebuild");
    const nodeGyp = createRequire(rebuild).resolve("node-gyp/bin/node-gyp.js");
    const sdk = join(stage, "sdk");
    const sdkEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.toLowerCase().startsWith("npm_config_") && name !== "NODEJS_ORG_MIRROR",
      ),
    );
    // Public install verifies the official headers and node.lib against SHASUMS256.
    // An owned devdir excludes stale SDK caches and concurrent package builders.
    await run(
      "node",
      [
        nodeGyp,
        "install",
        `--target=${version}`,
        "--arch=x64",
        `--devdir=${sdk}`,
        "--dist-url=https://nodejs.org/download/release",
      ],
      { cwd: root, env: sdkEnvironment },
    );
    const ownerBuild = join(stage, "owner");
    const credentialBuild = join(stage, "credentials");
    const peerBuild = join(stage, "desktop-peer");
    await run(
      "cmake",
      [
        "-S",
        join(root, "packages/host-runtime/native/windows-host-owner"),
        "-B",
        ownerBuild,
        "-A",
        "x64",
        `-DOCTANT_NODE_HEADERS=${join(sdk, version, "include/node")}`,
        `-DOCTANT_NODE_IMPORT_LIB=${join(sdk, version, "x64/node.lib")}`,
      ],
      { cwd: root },
    );
    await run(
      "cmake",
      ["--build", ownerBuild, "--config", "Release", "--target", "octant-windows-host-owner"],
      { cwd: root },
    );
    await run(
      "cmake",
      [
        "-S",
        join(root, "apps/desktop/native/windows-credential-helper"),
        "-B",
        credentialBuild,
        "-A",
        "x64",
      ],
      { cwd: root },
    );
    await run(
      "cmake",
      ["--build", credentialBuild, "--config", "Release", "--target", "octant-credential-helper"],
      { cwd: root },
    );
    await run(
      "cmake",
      [
        "-S",
        join(root, "apps/desktop/native/windows-desktop-peer"),
        "-B",
        peerBuild,
        "-A",
        "x64",
        `-DOCTANT_NODE_HEADERS=${join(sdk, version, "include/node")}`,
        `-DOCTANT_NODE_IMPORT_LIB=${join(sdk, version, "x64/node.lib")}`,
      ],
      { cwd: root },
    );
    await run(
      "cmake",
      ["--build", peerBuild, "--config", "Release", "--target", "octant-desktop-peer-windows"],
      { cwd: root },
    );
    await mkdir(destination, { recursive: true });
    await cp(
      join(ownerBuild, "Release", WINDOWS_NATIVE_ARTIFACTS[0]),
      join(destination, WINDOWS_NATIVE_ARTIFACTS[0]),
    );
    await cp(
      join(credentialBuild, "Release", WINDOWS_NATIVE_ARTIFACTS[1]),
      join(destination, WINDOWS_NATIVE_ARTIFACTS[1]),
    );
    await cp(
      join(peerBuild, "Release", WINDOWS_NATIVE_ARTIFACTS[2]),
      join(destination, WINDOWS_NATIVE_ARTIFACTS[2]),
    );
    await validateWindowsNativeArtifacts(destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

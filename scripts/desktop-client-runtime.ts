import { extractFile, getRawHeader, listPackage, statFile, uncache } from "@electron/asar";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import {
  flipFuses,
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";
import { desktopIdentity, type DesktopIdentity } from "@octant/host-runtime";

const DESKTOP_FUSES = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  resetAdHocDarwinSignature: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  [FuseV1Options.WasmTrapHandlers]: true,
} as const;

const REQUIRED_DESKTOP_FUSES: ReadonlyArray<readonly [FuseV1Options, boolean]> = [
  [FuseV1Options.RunAsNode, false],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
  [FuseV1Options.EnableNodeCliInspectArguments, false],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
  [FuseV1Options.OnlyLoadAppFromAsar, true],
];

/** Inspect the artifact, not only the options that were intended to produce it. */
export async function validateDesktopRuntimeFuses(bundlePath: string): Promise<void> {
  const wire = await getCurrentFuseWire(bundlePath);
  for (const [fuse, enabled] of REQUIRED_DESKTOP_FUSES) {
    const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE;
    if (wire[fuse] !== expected) {
      throw new Error(`Desktop runtime does not enforce ${FuseV1Options[fuse]}.`);
    }
  }
}

/** Only trusted desktop executables use this policy; worker runtimes are separate. */
export async function prepareDesktopRuntimeFuses(bundlePath: string): Promise<void> {
  await flipFuses(bundlePath, DESKTOP_FUSES);
  await validateDesktopRuntimeFuses(bundlePath);
}

/** Only native payloads need real paths; application JavaScript stays in ASAR. */
export const DESKTOP_UNPACKED_FILES = [
  "apps/desktop/node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib",
  "apps/desktop/node_modules/@trycua/cua-driver-darwin-arm64/cua_driver_node_runtime.node",
  "apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "apps/server/node_modules/node-pty/build/Release/pty.node",
  "apps/server/node_modules/node-pty/build/Release/spawn-helper",
  "apps/server/node_modules/@typescript/typescript-darwin-arm64/lib/tsc",
] as const;

/** Read the final archive, including its physical native files, before signing. */
export function readDesktopArchive(
  archive: string,
  integrity: unknown,
  identity: DesktopIdentity = desktopIdentity("nightly"),
): ReadonlyArray<{ readonly path: string; readonly content?: string }> {
  uncache(archive);
  const expected =
    typeof integrity === "object" && integrity !== null && "Resources/app.asar" in integrity
      ? integrity["Resources/app.asar"]
      : undefined;
  const hash = createHash("sha256").update(getRawHeader(archive).headerString).digest("hex");
  if (
    typeof expected !== "object" ||
    expected === null ||
    !("algorithm" in expected) ||
    expected.algorithm !== "SHA256" ||
    !("hash" in expected) ||
    expected.hash !== hash
  ) {
    throw new Error("Desktop archive integrity does not match its bundle metadata.");
  }
  const unpacked = new Set<string>(desktopUnpackedFiles(identity));
  const entries: Array<{ readonly path: string; readonly content?: string }> = [];
  for (const filename of listPackage(archive, { isPack: false })) {
    const path = filename.replace(/^\//, "");
    const entry = statFile(archive, path, false);
    if (identity.flavor === "stable" && path.startsWith("apps/server/"))
      throw new Error("Trusted desktop archive contains the worker server tree.");
    if ("files" in entry) continue;
    if ("link" in entry) throw new Error(`Desktop archive contains a symbolic link: ${path}.`);
    if (entry.unpacked && !unpacked.has(path))
      throw new Error(`Desktop archive contains unexpected unpacked file: ${path}.`);
    const bytes = extractFile(archive, path);
    if (
      entry.integrity?.algorithm !== "SHA256" ||
      createHash("sha256").update(bytes).digest("hex") !== entry.integrity.hash
    ) {
      throw new Error(`Desktop archive contains mismatched file bytes: ${path}.`);
    }
    const text = [".cjs", ".css", ".html", ".js", ".json", ".mjs"].includes(extname(path));
    entries.push({ path, ...(text ? { content: bytes.toString("utf8") } : {}) });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/** Native addons and adjacent libraries need stable physical paths under ASAR. */
export function packagedNativePath(path: string, identity: DesktopIdentity): string {
  const prefix = "Contents/Resources/app/";
  if (!path.startsWith(prefix)) return path;
  const payload = path.slice(prefix.length);
  if (identity.flavor === "stable" && payload.startsWith("apps/server/")) return path;
  if (!new Set<string>(desktopUnpackedFiles(identity)).has(payload))
    throw new Error(`Unexpected native application path: ${payload}.`);
  return `Contents/Resources/app.asar.unpacked/${payload}`;
}

export function desktopUnpackedFiles(identity: DesktopIdentity): ReadonlyArray<string> {
  return identity.flavor === "nightly"
    ? DESKTOP_UNPACKED_FILES
    : DESKTOP_UNPACKED_FILES.filter((path) => path.startsWith("apps/desktop/"));
}

/** This executable intentionally runs approved scripts and is not a desktop peer. */
export async function validateNodeRuntimeFuses(bundlePath: string): Promise<void> {
  const wire = await getCurrentFuseWire(bundlePath);
  if (wire[FuseV1Options.RunAsNode] !== FuseState.ENABLE)
    throw new Error("Worker runtime does not support its required Node entry.");
}

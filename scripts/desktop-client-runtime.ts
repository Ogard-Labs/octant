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
import type { DesktopIdentity } from "@octant/host-runtime";

const NIGHTLY_FUSES = {
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

const REQUIRED_NIGHTLY_FUSES: ReadonlyArray<readonly [FuseV1Options, boolean]> = [
  [FuseV1Options.RunAsNode, false],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
  [FuseV1Options.EnableNodeCliInspectArguments, false],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
  [FuseV1Options.OnlyLoadAppFromAsar, true],
];

/** Inspect the artifact, not only the options that were intended to produce it. */
export async function validateNightlyRuntimeFuses(bundlePath: string): Promise<void> {
  const wire = await getCurrentFuseWire(bundlePath);
  for (const [fuse, enabled] of REQUIRED_NIGHTLY_FUSES) {
    const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE;
    if (wire[fuse] !== expected) {
      throw new Error(`Nightly runtime does not enforce ${FuseV1Options[fuse]}.`);
    }
  }
}

/** Stable still runs its host and scoped terminal launcher in Node mode. */
export async function prepareNightlyRuntimeFuses(
  bundlePath: string,
  identity: DesktopIdentity,
): Promise<void> {
  if (identity.flavor !== "nightly") return;
  await flipFuses(bundlePath, NIGHTLY_FUSES);
  await validateNightlyRuntimeFuses(bundlePath);
}

/** Only native payloads need real paths; application JavaScript stays in ASAR. */
export const NIGHTLY_UNPACKED_FILES = [
  "apps/desktop/node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib",
  "apps/desktop/node_modules/@trycua/cua-driver-darwin-arm64/cua_driver_node_runtime.node",
  "apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "apps/server/node_modules/node-pty/build/Release/pty.node",
  "apps/server/node_modules/node-pty/build/Release/spawn-helper",
  "apps/server/node_modules/@typescript/typescript-darwin-arm64/lib/tsc",
] as const;

/** Read the final archive, including its physical native files, before signing. */
export function readNightlyArchive(
  archive: string,
  integrity: unknown,
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
    throw new Error("Nightly archive integrity does not match its bundle metadata.");
  }
  const unpacked = new Set<string>(NIGHTLY_UNPACKED_FILES);
  const entries: Array<{ readonly path: string; readonly content?: string }> = [];
  for (const filename of listPackage(archive, { isPack: false })) {
    const path = filename.replace(/^\//, "");
    const entry = statFile(archive, path, false);
    if ("files" in entry) continue;
    if ("link" in entry) throw new Error(`Nightly archive contains a symbolic link: ${path}.`);
    if (entry.unpacked && !unpacked.has(path))
      throw new Error(`Nightly archive contains unexpected unpacked file: ${path}.`);
    const bytes = extractFile(archive, path);
    if (
      entry.integrity?.algorithm !== "SHA256" ||
      createHash("sha256").update(bytes).digest("hex") !== entry.integrity.hash
    ) {
      throw new Error(`Nightly archive contains mismatched file bytes: ${path}.`);
    }
    const text = [".cjs", ".css", ".html", ".js", ".json", ".mjs"].includes(extname(path));
    entries.push({ path, ...(text ? { content: bytes.toString("utf8") } : {}) });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/** Native addons and adjacent libraries need stable physical paths under ASAR. */
export function packagedNativePath(path: string, identity: DesktopIdentity): string {
  const prefix = "Contents/Resources/app/";
  if (identity.flavor !== "nightly" || !path.startsWith(prefix)) return path;
  const payload = path.slice(prefix.length);
  if (!new Set<string>(NIGHTLY_UNPACKED_FILES).has(payload))
    throw new Error(`Unexpected native application path: ${payload}.`);
  return `Contents/Resources/app.asar.unpacked/${payload}`;
}

import { packager, type Options as PackagerOptions } from "@electron/packager";
import { rebuild, type RebuildOptions } from "@electron/rebuild";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_PRELOAD_FILENAME } from "../apps/desktop/src/runtimePaths";
import { buildCodeFileHelper } from "./build-code-file-helper";
import { buildKeychainHelper } from "./build-keychain-helper";
import {
  requireSigned,
  resolveSigningCredentials,
  signAndNotarizeDesktop,
  SIGNING_ENVIRONMENT_VARIABLES,
} from "./sign-desktop";

export const DESKTOP_PACKAGE_IDENTITY = {
  bundleId: "app.octant.desktop",
  productName: "Octant",
  /**
   * The release this repository is working toward. One place, because the
   * updater compares it against the feed and an app that cannot say which
   * version it is cannot refuse to go backwards (`docs/decisions/0034`).
   *
   * A stable release is this exact version; a preview is a prerelease of it.
   * Both are supplied per build by {@link resolveReleaseVersion}, which is why
   * this is the declared target rather than the string every build carries.
   */
  version: "0.1.0",
} as const;

export const RELEASE_VERSION_ENVIRONMENT_VARIABLE = "OCTANT_RELEASE_VERSION";
export const PACKAGE_TARGET_ENVIRONMENT_VARIABLE = "OCTANT_PACKAGE_TARGET";

/** Same grammar the updater compares by, so a build cannot mint a version it could not order. */
const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]{1,64})?$/;

/**
 * Desktop packaging targets this repository knows how to emit.
 *
 * `darwin-arm64` is the signed Apple Silicon path. `linux-x64` is the Ubuntu
 * dogfood AppImage path: unsigned, fail-closed for updates until a signed Linux
 * feed exists. Windows and other arches stay refused rather than half-shipped.
 */
export type DesktopPackageTargetId = "darwin-arm64" | "linux-x64";

export interface DesktopPackageTarget {
  readonly id: DesktopPackageTargetId;
  readonly platform: "darwin" | "linux";
  readonly arch: "arm64" | "x64";
}

export const DESKTOP_PACKAGE_TARGETS: Readonly<
  Record<DesktopPackageTargetId, DesktopPackageTarget>
> = {
  "darwin-arm64": { id: "darwin-arm64", platform: "darwin", arch: "arm64" },
  "linux-x64": { id: "linux-x64", platform: "linux", arch: "x64" },
};

/**
 * Pick the packaging target from the environment or the build host.
 *
 * Explicit `OCTANT_PACKAGE_TARGET` always wins. Otherwise macOS packages the
 * Apple Silicon app and Linux packages the x64 AppImage dogfood artifact.
 * Cross-host packaging is refused: native modules must match the machine that
 * rebuilds them.
 */
export function resolveDesktopPackageTarget(
  environment: Record<string, string | undefined>,
  host: { readonly platform: NodeJS.Platform; readonly arch: string } = process,
): DesktopPackageTarget {
  const configured = (environment[PACKAGE_TARGET_ENVIRONMENT_VARIABLE] ?? "").trim();
  if (configured !== "") {
    const target = DESKTOP_PACKAGE_TARGETS[configured as DesktopPackageTargetId];
    if (target === undefined) {
      throw new Error(
        `${PACKAGE_TARGET_ENVIRONMENT_VARIABLE} must be one of ${Object.keys(DESKTOP_PACKAGE_TARGETS).join(", ")}, not ${configured}.`,
      );
    }
    assertHostCanPackageTarget(target, host);
    return target;
  }
  if (host.platform === "darwin" && host.arch === "arm64") {
    return DESKTOP_PACKAGE_TARGETS["darwin-arm64"];
  }
  if (host.platform === "linux" && (host.arch === "x64" || host.arch === "x86_64")) {
    return DESKTOP_PACKAGE_TARGETS["linux-x64"];
  }
  throw new Error(
    `Desktop packaging has no default target for ${host.platform}/${host.arch}. Set ${PACKAGE_TARGET_ENVIRONMENT_VARIABLE}.`,
  );
}

function assertHostCanPackageTarget(
  target: DesktopPackageTarget,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
): void {
  const hostArch = host.arch === "x86_64" ? "x64" : host.arch;
  if (host.platform !== target.platform || hostArch !== target.arch) {
    throw new Error(
      `Cannot package ${target.id} on ${host.platform}/${host.arch}: native modules must be rebuilt on a matching host.`,
    );
  }
}

/**
 * The version this build stamps into the app.
 *
 * Defaults to the declared target, so a local package needs no environment.
 * An override must be that same target, optionally with a prerelease tag: a
 * release is `0.2.0` and a preview is `0.2.0-preview.…`. Anything else is
 * refused rather than accepted, because a build free to name any version is a
 * build that can publish `9.0.0` from a branch, and every install that saw it
 * would then refuse the real release as older.
 */
export function resolveReleaseVersion(
  environment: Record<string, string | undefined>,
  declared: string = DESKTOP_PACKAGE_IDENTITY.version,
): string {
  const configured = (environment[RELEASE_VERSION_ENVIRONMENT_VARIABLE] ?? "").trim();
  if (configured === "") return declared;
  if (!RELEASE_VERSION_PATTERN.test(configured)) {
    throw new Error(
      `${RELEASE_VERSION_ENVIRONMENT_VARIABLE} must be MAJOR.MINOR.PATCH with an optional prerelease tag, not ${configured}.`,
    );
  }
  const [core] = configured.split("-");
  if (core !== declared) {
    throw new Error(
      `${RELEASE_VERSION_ENVIRONMENT_VARIABLE} is ${configured}, but this repository declares ${declared}. Bump DESKTOP_PACKAGE_IDENTITY.version first.`,
    );
  }
  return configured;
}

const ELECTRON_VERSION = "43.1.0";
const STAGE_DIRECTORY = ".desktop-stage";
const PACKAGER_DIRECTORY = ".packager";
const EXTERNAL_RUNTIME_PACKAGES = [
  "effect",
  "better-sqlite3",
  "node-pty",
  "@opencode-ai/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "playwright-core",
  "yaml",
] as const;

export const PACKAGED_RUNTIME_IMPORTS = [
  "@anthropic-ai/claude-agent-sdk",
  "@opencode-ai/sdk",
  "better-sqlite3",
  "effect",
  "node-pty",
  "playwright-core",
  "yaml",
] as const;

/** Staged app payload shared by every desktop packaging target. */
export const REQUIRED_STAGED_PACKAGED_FILES = [
  "apps/desktop/dist/main.mjs",
  `apps/desktop/dist/${DESKTOP_PRELOAD_FILENAME}`,
  "apps/desktop/node_modules/effect/package.json",
  "apps/desktop/resources/icon.icns",
  "apps/desktop/resources/icon.png",
  "apps/desktop/resources/menuBarTemplate.png",
  "apps/desktop/resources/menuBarTemplate@2x.png",
  "apps/server/dist/main.mjs",
  "apps/web/dist/index.html",
  "apps/server/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
  "apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  "apps/server/node_modules/@opencode-ai/sdk/package.json",
  "apps/server/node_modules/effect/package.json",
  "apps/server/node_modules/better-sqlite3/package.json",
  "apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "apps/server/node_modules/node-pty/package.json",
  "apps/server/node_modules/node-pty/build/Release/pty.node",
  "apps/server/node_modules/playwright-core/package.json",
  "apps/server/node_modules/yaml/package.json",
] as const;

/** macOS-only node-pty helper; Linux uses forkpty and does not build this binary. */
export const REQUIRED_DARWIN_PTY_HELPER_FILE =
  "apps/server/node_modules/node-pty/build/Release/spawn-helper" as const;

export const REQUIRED_DARWIN_HELPER_FILES = [
  "Octant.app/Contents/Resources/native/octant-keychain-helper",
  "Octant.app/Contents/Resources/native/octant-code-file-helper",
] as const;

/** Full darwin-arm64 checklist (staged payload + PTY helper + Keychain/code-file helpers). */
export const REQUIRED_PACKAGED_FILES = [
  ...REQUIRED_STAGED_PACKAGED_FILES,
  REQUIRED_DARWIN_PTY_HELPER_FILE,
  ...REQUIRED_DARWIN_HELPER_FILES,
] as const;

export const PACKAGED_EXECUTABLE_FILES = [
  "native/octant-keychain-helper",
  "native/octant-code-file-helper",
  "app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
] as const;
export const PACKAGED_LINUX_EXECUTABLE_FILES = [] as const;
export const PACKAGED_ARM64_FILES = [
  "native/octant-keychain-helper",
  "native/octant-code-file-helper",
  "app/apps/server/node_modules/node-pty/build/Release/pty.node",
  "app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
] as const;
export const PACKAGED_LINUX_NATIVE_FILES = [
  "app/apps/server/node_modules/node-pty/build/Release/pty.node",
  "app/apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
] as const;
export const FORBIDDEN_PACKAGED_FILES = [
  "Octant.app/Contents/Resources/app/apps/desktop/dist/native/octant-keychain-helper",
  "Octant.app/Contents/Resources/app/apps/desktop/dist/native/octant-code-file-helper",
] as const;
/** Darwin helpers must never appear inside a Linux portable tree or AppDir. */
export const FORBIDDEN_LINUX_HELPER_PATTERNS = [
  /(?:^|\/)octant-keychain-helper$/,
  /(?:^|\/)octant-code-file-helper$/,
] as const;
export const FORBIDDEN_PACKAGED_EXECUTABLE_PATTERNS = [
  /^apps\/server\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+\//,
  /^apps\/server\/node_modules\/@anthropic-ai\/claude-agent-sdk\/(?:vendor\/)?claude(?:\.exe)?$/,
] as const;

export const REQUIRED_CODE_WEB_ASSET_PATTERNS = [
  { label: "Monaco editor pane", pattern: /^apps\/web\/dist\/assets\/MonacoEditorPane-[^/]+\.js$/ },
  { label: "Monaco editor API", pattern: /^apps\/web\/dist\/assets\/editor\.api-[^/]+\.js$/ },
  { label: "Monaco editor worker", pattern: /^apps\/web\/dist\/assets\/editor\.worker-[^/]+\.js$/ },
  {
    label: "Xterm runtime JavaScript",
    pattern: /^apps\/web\/dist\/assets\/xtermRuntime-[^/]+\.js$/,
  },
  { label: "Xterm runtime styles", pattern: /^apps\/web\/dist\/assets\/xtermRuntime-[^/]+\.css$/ },
] as const;

const ALLOWED_DARWIN_NATIVE_PAYLOADS = new Set([
  "Octant.app/Contents/Resources/native/octant-keychain-helper",
  "Octant.app/Contents/Resources/native/octant-code-file-helper",
  "Octant.app/Contents/Resources/app/apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "Octant.app/Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/pty.node",
  "Octant.app/Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
]);

const ALLOWED_LINUX_NATIVE_SUFFIXES = [
  "/resources/app/apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "/resources/app/apps/server/node_modules/node-pty/build/Release/pty.node",
] as const;

export function validateCodeWebAssets(paths: ReadonlyArray<string>): void {
  for (const requirement of REQUIRED_CODE_WEB_ASSET_PATTERNS) {
    if (!paths.some((path) => requirement.pattern.test(path))) {
      throw new Error(`Packaged renderer is missing ${requirement.label}.`);
    }
  }
}

export function validateNativePayloadAllowlist(paths: ReadonlyArray<string>): void {
  for (const path of paths) {
    const nativeCandidate =
      path.includes("/Contents/Resources/native/") ||
      path.endsWith(".node") ||
      path.endsWith("/spawn-helper");
    if (nativeCandidate && !ALLOWED_DARWIN_NATIVE_PAYLOADS.has(path)) {
      throw new Error(`Packaged bundle contains unexpected native payload ${path}.`);
    }
  }
}

/**
 * Linux portable trees and AppDirs may only carry the rebuilt SQLite and PTY
 * natives under resources/app — never Darwin Keychain/code-file helpers.
 */
export function validateLinuxNativePayloadAllowlist(paths: ReadonlyArray<string>): void {
  for (const path of paths) {
    if (FORBIDDEN_LINUX_HELPER_PATTERNS.some((pattern) => pattern.test(path))) {
      throw new Error(`Linux package contains Darwin-only helper ${path}.`);
    }
    const nativeCandidate = path.endsWith(".node") || path.endsWith("/spawn-helper");
    if (!nativeCandidate) continue;
    if (!ALLOWED_LINUX_NATIVE_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
      throw new Error(`Linux package contains unexpected native payload ${path}.`);
    }
  }
}

export function selectFinalBundlePaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const prefix = `${DESKTOP_PACKAGE_IDENTITY.productName}.app/`;
  return paths.filter((path) => path.startsWith(prefix));
}

export function selectLinuxPackagePaths(
  paths: ReadonlyArray<string>,
  packageDirectoryName: string,
): ReadonlyArray<string> {
  const prefix = `${packageDirectoryName}/`;
  return paths.filter((path) => path.startsWith(prefix));
}

export function linuxPackageDirectoryName(target: DesktopPackageTarget): string {
  return `${DESKTOP_PACKAGE_IDENTITY.productName}-${target.platform}-${target.arch}`;
}

export async function pruneUnusedNativePayloads(
  stageRoot: string,
  remove: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void> = rm,
): Promise<void> {
  for (const path of [
    "apps/server/node_modules/better-sqlite3/bin",
    "apps/server/node_modules/better-sqlite3/build/Release/test_extension.node",
    "apps/server/node_modules/better-sqlite3/build/Release/.deps",
    "apps/server/node_modules/better-sqlite3/build/Release/.forge-meta",
    "apps/server/node_modules/better-sqlite3/build/Release/obj",
    "apps/server/node_modules/better-sqlite3/build/Release/obj.target",
    "apps/server/node_modules/better-sqlite3/build/Release/sqlite3.a",
    "apps/server/node_modules/better-sqlite3/build/deps",
    "apps/server/node_modules/better-sqlite3/build/obj.target",
    "apps/server/node_modules/better-sqlite3/build/Makefile",
    "apps/server/node_modules/better-sqlite3/build/better_sqlite3.target.mk",
    "apps/server/node_modules/better-sqlite3/build/binding.Makefile",
    "apps/server/node_modules/better-sqlite3/build/config.gypi",
    "apps/server/node_modules/better-sqlite3/build/gyp-mac-tool",
    "apps/server/node_modules/better-sqlite3/build/test_extension.target.mk",
    "apps/server/node_modules/node-pty/bin",
    "apps/server/node_modules/node-pty/prebuilds",
    "apps/server/node_modules/node-pty/build/Release/.forge-meta",
    "apps/server/node_modules/node-pty/build/Release/.deps",
    "apps/server/node_modules/node-pty/build/Release/node-addon-api",
    "apps/server/node_modules/node-pty/build/Release/obj.target",
    "apps/server/node_modules/node-pty/build/obj.target",
    "apps/server/node_modules/node-pty/build/Makefile",
    "apps/server/node_modules/node-pty/build/binding.Makefile",
    "apps/server/node_modules/node-pty/build/config.gypi",
    "apps/server/node_modules/node-pty/build/gyp-mac-tool",
    "apps/server/node_modules/node-pty/build/pty.target.mk",
    "apps/server/node_modules/node-pty/build/spawn-helper.target.mk",
  ]) {
    await remove(resolve(stageRoot, path), { recursive: true, force: true });
  }
}

export async function stripNativeDebugMetadata(
  stageRoot: string,
  strip: (path: string) => Promise<void> = stripMachODebugMetadata,
  relativePaths: ReadonlyArray<string> = nativePayloadsToStrip("darwin"),
): Promise<void> {
  for (const path of relativePaths) {
    await strip(resolve(stageRoot, path));
  }
}

export function nativePayloadsToStrip(
  platform: DesktopPackageTarget["platform"],
): ReadonlyArray<string> {
  // node-pty only builds spawn-helper on macOS; Linux uses forkpty.
  if (platform === "darwin") {
    return [
      "apps/server/node_modules/node-pty/build/Release/pty.node",
      "apps/server/node_modules/node-pty/build/Release/spawn-helper",
    ];
  }
  return ["apps/server/node_modules/node-pty/build/Release/pty.node"];
}

async function stripMachODebugMetadata(path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("/usr/bin/strip", ["-S", path], (error) => {
      if (error === null) resolvePromise();
      else reject(new Error("Packaged native runtime debug metadata could not be stripped."));
    });
  });
}

async function stripElfDebugMetadata(path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("strip", ["--strip-debug", path], (error) => {
      if (error === null) {
        resolvePromise();
        return;
      }
      // Name the tool and target so a missing binutils install is actionable.
      reject(
        new Error(
          `Packaged native runtime debug metadata could not be stripped for ${path}: ${error.message}. Install binutils.`,
        ),
      );
    });
  });
}

export function nativeDebugStripForPlatform(
  platform: DesktopPackageTarget["platform"],
): (path: string) => Promise<void> {
  return platform === "darwin" ? stripMachODebugMetadata : stripElfDebugMetadata;
}

export function packagedBundlePath(requiredPath: string): string {
  return requiredPath.startsWith(`${DESKTOP_PACKAGE_IDENTITY.productName}.app/`)
    ? requiredPath
    : `${DESKTOP_PACKAGE_IDENTITY.productName}.app/Contents/Resources/app/${requiredPath}`;
}

export function packagedLinuxBundlePath(
  requiredPath: string,
  packageDirectoryName: string,
): string {
  return `${packageDirectoryName}/resources/app/${requiredPath}`;
}

export interface PackagedPayloadEntry {
  readonly path: string;
  readonly content?: string;
}

export interface ObservedChildProcess {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly once: (event: "exit", listener: () => void) => unknown;
  readonly off?: (event: "exit", listener: () => void) => unknown;
}

export async function waitForChildExit(
  child: ObservedChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const onExit = () => finish(resolve);
    const timeout = setTimeout(
      () => finish(() => reject(new Error(`Child process did not exit within ${timeoutMs}ms.`))),
      timeoutMs,
    );
    const finish = (complete: () => void) => {
      clearTimeout(timeout);
      child.off?.("exit", onExit);
      complete();
    };
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(resolve);
  });
}

export function createActivateAppleScript(appPath: string): string {
  return `tell application "${escapeAppleScriptString(appPath)}" to activate`;
}

export function createQuitAppleScript(appPath: string): string {
  return `tell application "${escapeAppleScriptString(appPath)}" to quit`;
}

function escapeAppleScriptString(appPath: string): string {
  const escapedPath = appPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return escapedPath;
}

export function createPackagerOptions(
  dir: string,
  out: string,
  version: string,
  target: DesktopPackageTarget = DESKTOP_PACKAGE_TARGETS["darwin-arm64"],
): PackagerOptions {
  return {
    appBundleId: DESKTOP_PACKAGE_IDENTITY.bundleId,
    appVersion: version,
    arch: target.arch,
    asar: false,
    dir,
    electronVersion: ELECTRON_VERSION,
    icon:
      target.platform === "darwin"
        ? resolve(dir, "apps/desktop/resources/icon.icns")
        : resolve(dir, "apps/desktop/resources/icon.png"),
    name: DESKTOP_PACKAGE_IDENTITY.productName,
    out,
    overwrite: true,
    platform: target.platform,
    prune: false,
    protocols: [{ name: "Octant Code links", schemes: ["octant"] }],
  };
}

export function createNativeRebuildOptions(
  stageRoot: string,
  target: DesktopPackageTarget = DESKTOP_PACKAGE_TARGETS["darwin-arm64"],
): RebuildOptions {
  return {
    arch: target.arch,
    buildPath: resolve(stageRoot, "apps/server"),
    electronVersion: ELECTRON_VERSION,
    force: true,
    onlyModules: ["better-sqlite3", "node-pty"],
  };
}

export function createServerRuntimeManifest() {
  return {
    name: "@octant/server-runtime",
    private: true,
    type: "module",
    dependencies: {
      "@anthropic-ai/claude-agent-sdk": "0.3.211",
      "@opencode-ai/sdk": "1.18.0",
      "better-sqlite3": "12.11.1",
      effect: "3.21.4",
      "node-pty": "1.1.0",
      "playwright-core": "1.62.0",
      yaml: "2.8.3",
    },
  } as const;
}

export function validatePackagedPayload(
  entries: ReadonlyArray<PackagedPayloadEntry>,
  target: DesktopPackageTarget = DESKTOP_PACKAGE_TARGETS["darwin-arm64"],
): void {
  const paths = new Set(entries.map((entry) => entry.path));
  const required = [
    ...REQUIRED_STAGED_PACKAGED_FILES,
    ...(target.platform === "darwin" ? [REQUIRED_DARWIN_PTY_HELPER_FILE] : []),
  ];
  for (const requiredPath of required) {
    if (!paths.has(requiredPath)) throw new Error(`Packaged payload is missing ${requiredPath}.`);
  }

  for (const entry of entries) {
    if (FORBIDDEN_PACKAGED_EXECUTABLE_PATTERNS.some((pattern) => pattern.test(entry.path))) {
      throw new Error(`Packaged payload contains SDK-bundled Claude executable ${entry.path}.`);
    }
    if (isForbiddenPath(entry.path)) {
      throw new Error(`Packaged payload contains forbidden packaged path ${entry.path}.`);
    }
    if (entry.content !== undefined && containsForbiddenIdentity(entry.content)) {
      throw new Error(`Packaged payload contains forbidden product identity in ${entry.path}.`);
    }
  }
  validateBundledInternalRuntime(entries);
  validateCodeWebAssets(entries.map((entry) => entry.path));
}

const UNRESOLVED_INTERNAL_RUNTIME_IMPORT =
  /\bfrom\s*["']@octant\/|\b(?:import|require)\s*(?:\(\s*)?["']@octant\//;

export function validateBundledInternalRuntime(entries: ReadonlyArray<PackagedPayloadEntry>): void {
  for (const entry of entries) {
    if (entry.content === undefined || !UNRESOLVED_INTERNAL_RUNTIME_IMPORT.test(entry.content)) {
      continue;
    }
    throw new Error(
      `Packaged payload contains an unresolved internal runtime import in ${entry.path}.`,
    );
  }
}

export async function stageDesktopRuntime(
  repositoryRoot: string,
  stageRoot: string,
  target: DesktopPackageTarget = DESKTOP_PACKAGE_TARGETS["darwin-arm64"],
): Promise<void> {
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  await copyBuiltDirectory(repositoryRoot, stageRoot, "apps/desktop/dist");
  await rm(resolve(stageRoot, "apps/desktop/dist/native"), { recursive: true, force: true });
  await cp(
    resolve(repositoryRoot, "apps/desktop/resources"),
    resolve(stageRoot, "apps/desktop/resources"),
    { recursive: true },
  );
  await copyBuiltDirectory(repositoryRoot, stageRoot, "apps/server/dist");
  await copyBuiltDirectory(repositoryRoot, stageRoot, "apps/web/dist");

  await writeJson(join(stageRoot, "package.json"), {
    name: "@octant/desktop-runtime",
    private: true,
    type: "module",
    version: "0.0.0-dev",
    productName: DESKTOP_PACKAGE_IDENTITY.productName,
    main: "apps/desktop/dist/main.mjs",
  });
  await writeJson(join(stageRoot, "apps/server/package.json"), createServerRuntimeManifest());

  await stageExternalRuntimePackages(repositoryRoot, stageRoot);
  await stageExternalRuntimePackages(repositoryRoot, stageRoot, ["effect"], "desktop");
  await rebuild(createNativeRebuildOptions(stageRoot, target));
  await pruneUnusedNativePayloads(stageRoot);
  await stripNativeDebugMetadata(
    stageRoot,
    nativeDebugStripForPlatform(target.platform),
    nativePayloadsToStrip(target.platform),
  );

  validatePackagedPayload(await collectPayloadEntries(stageRoot), target);
  await validatePackagedRuntimeImports(stageRoot);
  await validatePackagedRuntimeImports(stageRoot, ["effect"], "apps/desktop");
}

export async function validatePackagedRuntimeImports(
  stageRoot: string,
  imports: ReadonlyArray<string> = PACKAGED_RUNTIME_IMPORTS,
  runtimePath = "apps/server",
): Promise<void> {
  const probe = imports.map((packageName) => `import(${JSON.stringify(packageName)})`).join(",");
  const nodeExecutable = resolveNodeExecutable();
  await new Promise<void>((resolvePromise, reject) => {
    execFile(
      nodeExecutable,
      ["--input-type=module", "--eval", `await Promise.all([${probe}])`],
      {
        cwd: resolve(stageRoot, runtimePath),
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/exec-daemon",
        },
        timeout: 10_000,
      },
      (error) => {
        if (error === null) resolvePromise();
        else reject(new Error("Packaged server runtime imports did not resolve under Node."));
      },
    );
  });
}

/**
 * Resolve a real Node binary for the packaged-import probe.
 *
 * The probe must run under Node, not Bun. ADE Linux hosts often expose Node
 * only as `/exec-daemon/node`, so a hard-coded `/usr/bin/env node` with a
 * macOS-centric PATH fails closed before staging finishes.
 *
 * Default `which` uses Bun when the packaging script runs under Bun. Under
 * vitest (Node workers on macOS CI) Bun is absent, so fall through to the
 * current Node `process.execPath` and then fixed install locations — never
 * evaluate bare `Bun.which` as a default argument.
 */
export function resolveNodeExecutable(
  which: (command: string) => string | null = resolveNodeWhich,
  environment: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
  execPath: string = process.execPath,
): string {
  const configured = (environment.OCTANT_NODE_BINARY ?? "").trim();
  if (configured !== "") return configured;
  const fromPath = which("node");
  if (fromPath !== null) return fromPath;
  if (isNodeExecutablePath(execPath) && exists(execPath)) return execPath;
  for (const candidate of NODE_EXECUTABLE_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  throw new Error("Packaged runtime import probe requires Node on PATH (or OCTANT_NODE_BINARY).");
}

const NODE_EXECUTABLE_CANDIDATES = [
  "/usr/bin/node",
  "/bin/node",
  "/usr/local/bin/node",
  "/opt/homebrew/bin/node",
  "/exec-daemon/node",
] as const;

function resolveNodeWhich(command: string): string | null {
  const bunGlobal = (globalThis as { Bun?: { which?: (name: string) => string | null } }).Bun;
  return bunGlobal?.which?.(command) ?? null;
}

function isNodeExecutablePath(path: string): boolean {
  const base = basename(path);
  return base === "node" || base === "node.exe";
}

async function packageDesktop(repositoryRoot: string): Promise<{
  readonly target: DesktopPackageTarget;
  readonly artifactPath: string;
  readonly portableDirectoryPath?: string;
}> {
  const target = resolveDesktopPackageTarget(process.env);
  if (target.platform === "darwin") {
    const artifactPath = await packageDarwinDesktop(repositoryRoot, target);
    return { target, artifactPath };
  }
  return await packageLinuxDesktop(repositoryRoot, target);
}

async function packageDarwinDesktop(
  repositoryRoot: string,
  target: DesktopPackageTarget,
): Promise<string> {
  const outRoot = resolve(repositoryRoot, "out");
  const stageRoot = join(outRoot, STAGE_DIRECTORY);
  const packagerRoot = join(outRoot, PACKAGER_DIRECTORY);
  const finalApp = join(outRoot, `${DESKTOP_PACKAGE_IDENTITY.productName}.app`);

  await mkdir(outRoot, { recursive: true });
  await stageDesktopRuntime(repositoryRoot, stageRoot, target);
  await rm(packagerRoot, { recursive: true, force: true });
  await rm(finalApp, { recursive: true, force: true });

  const packagedDirectories = await packager(
    createPackagerOptions(stageRoot, packagerRoot, resolveReleaseVersion(process.env), target),
  );
  if (packagedDirectories.length !== 1) {
    throw new Error(
      `Expected one packaged desktop directory, received ${packagedDirectories.length}.`,
    );
  }
  const packagedApp = join(packagedDirectories[0]!, `${DESKTOP_PACKAGE_IDENTITY.productName}.app`);
  await rename(packagedApp, finalApp);
  await rm(packagerRoot, { recursive: true, force: true });

  const nativeResources = join(finalApp, "Contents/Resources/native");
  const keychainHelper = join(nativeResources, "octant-keychain-helper");
  await buildKeychainHelper(
    resolve(repositoryRoot, "apps/desktop/native/keychain-helper/OctantKeychainHelper.swift"),
    keychainHelper,
  );
  const codeFileHelper = join(nativeResources, "octant-code-file-helper");
  await buildCodeFileHelper(
    resolve(repositoryRoot, "apps/desktop/native/code-file-helper/OctantCodeFileHelper.swift"),
    codeFileHelper,
  );
  for (const relativePath of PACKAGED_EXECUTABLE_FILES) {
    await access(join(finalApp, "Contents/Resources", relativePath), 1);
  }
  for (const relativePath of PACKAGED_ARM64_FILES) {
    await validatePackagedArm64(join(finalApp, "Contents/Resources", relativePath));
  }

  const packagedPayload = join(finalApp, "Contents/Resources/app");
  validatePackagedPayload(await collectPayloadEntries(packagedPayload), target);
  const bundleEntries = await collectPayloadEntries(outRoot);
  const bundlePaths = new Set(bundleEntries.map((entry) => entry.path));
  validateNativePayloadAllowlist(selectFinalBundlePaths([...bundlePaths]));
  for (const requiredPath of REQUIRED_PACKAGED_FILES) {
    if (!bundlePaths.has(packagedBundlePath(requiredPath))) {
      throw new Error(`Packaged bundle is missing ${requiredPath}.`);
    }
  }
  for (const forbiddenPath of FORBIDDEN_PACKAGED_FILES) {
    if (bundlePaths.has(forbiddenPath)) {
      throw new Error(`Packaged bundle contains duplicate helper path ${forbiddenPath}.`);
    }
  }
  validatePackagedRendererPolicy(
    await readFile(join(packagedPayload, "apps/web/dist/index.html"), "utf8"),
  );
  await validateBundleIdentity(finalApp);
  return finalApp;
}

/**
 * Package the Linux peer Machine as an AppImage (and keep the portable
 * electron-packager directory beside it for inspection).
 *
 * Darwin helpers are never built here: Secret Service is host-runtime, and an
 * updater channel does not exist until Linux artifacts are signed separately.
 */
async function packageLinuxDesktop(
  repositoryRoot: string,
  target: DesktopPackageTarget,
): Promise<{
  readonly target: DesktopPackageTarget;
  readonly artifactPath: string;
  readonly portableDirectoryPath: string;
}> {
  const version = resolveReleaseVersion(process.env);
  const outRoot = resolve(repositoryRoot, "out");
  const stageRoot = join(outRoot, STAGE_DIRECTORY);
  const packagerRoot = join(outRoot, PACKAGER_DIRECTORY);
  const packageDirName = linuxPackageDirectoryName(target);
  const finalPackageDir = join(outRoot, packageDirName);
  const appImagePath = join(
    outRoot,
    `${DESKTOP_PACKAGE_IDENTITY.productName}-${version}-${target.id}.AppImage`,
  );

  await mkdir(outRoot, { recursive: true });
  await stageDesktopRuntime(repositoryRoot, stageRoot, target);
  await rm(packagerRoot, { recursive: true, force: true });
  await rm(finalPackageDir, { recursive: true, force: true });
  await rm(appImagePath, { force: true });

  const packagedDirectories = await packager(
    createPackagerOptions(stageRoot, packagerRoot, version, target),
  );
  if (packagedDirectories.length !== 1) {
    throw new Error(
      `Expected one packaged desktop directory, received ${packagedDirectories.length}.`,
    );
  }
  await rename(packagedDirectories[0]!, finalPackageDir);
  await rm(packagerRoot, { recursive: true, force: true });

  const resourcesRoot = join(finalPackageDir, "resources");
  for (const relativePath of PACKAGED_LINUX_NATIVE_FILES) {
    await validatePackagedElf(join(resourcesRoot, relativePath));
  }

  const packagedPayload = join(resourcesRoot, "app");
  validatePackagedPayload(await collectPayloadEntries(packagedPayload), target);
  const packageEntries = await collectPayloadEntries(finalPackageDir);
  validateLinuxNativePayloadAllowlist(
    packageEntries.map((entry) => `${packageDirName}/${entry.path}`),
  );
  for (const requiredPath of REQUIRED_STAGED_PACKAGED_FILES) {
    await access(join(packagedPayload, requiredPath));
  }
  validatePackagedRendererPolicy(
    await readFile(join(packagedPayload, "apps/web/dist/index.html"), "utf8"),
  );
  await validateLinuxPackageIdentity(finalPackageDir);

  const appImage = await buildLinuxAppImage({
    repositoryRoot,
    packageDirectory: finalPackageDir,
    appImagePath,
    version,
    target,
  });
  return {
    target,
    artifactPath: appImage,
    portableDirectoryPath: finalPackageDir,
  };
}

export function createLinuxDesktopEntry(version: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${DESKTOP_PACKAGE_IDENTITY.productName}`,
    `Comment=Octant desktop Machine ${version}`,
    `Exec=${DESKTOP_PACKAGE_IDENTITY.productName}`,
    "Icon=octant",
    "Categories=Development;",
    "StartupWMClass=Octant",
    "Terminal=false",
    "",
  ].join("\n");
}

export function createLinuxAppRunScript(executableName: string): string {
  return [
    "#!/bin/sh",
    // Resolve the AppDir even when the AppImage was extracted to a temp tree.
    'SELF="$(readlink -f "$0" 2>/dev/null || printf %s "$0")"',
    'HERE="${SELF%/*}"',
    // AppImage FUSE mounts are nosuid, so chrome-sandbox SUID cannot work.
    // Keep Chromium's user-namespace sandbox when the host allows unprivileged
    // userns; only pass --no-sandbox when that probe fails (fail closed for
    // launch). Residual Ubuntu 24.04 AppArmor profile gaps are documented in
    // packaging docs rather than weakening sandbox globally.
    "if unshare -Ur true >/dev/null 2>&1; then",
    `  exec "\${HERE}/${executableName}" "$@"`,
    "else",
    `  exec "\${HERE}/${executableName}" --no-sandbox "$@"`,
    "fi",
    "",
  ].join("\n");
}

export async function stageLinuxAppDir(input: {
  readonly packageDirectory: string;
  readonly appDir: string;
  readonly version: string;
}): Promise<void> {
  await rm(input.appDir, { recursive: true, force: true });
  await mkdir(input.appDir, { recursive: true });
  await cp(input.packageDirectory, input.appDir, { recursive: true });
  await writeFile(
    join(input.appDir, "AppRun"),
    createLinuxAppRunScript(DESKTOP_PACKAGE_IDENTITY.productName),
    "utf8",
  );
  await chmod(join(input.appDir, "AppRun"), 0o755);
  await writeFile(
    join(input.appDir, "octant.desktop"),
    createLinuxDesktopEntry(input.version),
    "utf8",
  );
  await cp(
    join(input.packageDirectory, "resources/app/apps/desktop/resources/icon.png"),
    join(input.appDir, "octant.png"),
  );
}

/**
 * Pin appimagetool 1.9.1 so dogfood hosts do not need a distro package and
 * do not execute a mutable continuous build. Verify SHA-256 before running.
 */
export const APPIMAGE_TOOL_URL =
  "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage";
export const APPIMAGE_TOOL_SHA256 =
  "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0";

async function buildLinuxAppImage(input: {
  readonly repositoryRoot: string;
  readonly packageDirectory: string;
  readonly appImagePath: string;
  readonly version: string;
  readonly target: DesktopPackageTarget;
}): Promise<string> {
  const toolsRoot = join(input.repositoryRoot, "out", ".tools");
  const appDir = join(
    input.repositoryRoot,
    "out",
    ".appdir",
    linuxPackageDirectoryName(input.target),
  );
  await stageLinuxAppDir({
    packageDirectory: input.packageDirectory,
    appDir,
    version: input.version,
  });
  await validateLinuxAppDirIdentity(appDir);
  const appImageTool = await ensureAppImageTool(toolsRoot);
  await runCommand([appImageTool, "--no-appstream", appDir, input.appImagePath], {
    env: {
      ...process.env,
      ARCH: input.target.arch === "x64" ? "x86_64" : input.target.arch,
      APPIMAGE_EXTRACT_AND_RUN: "1",
    },
  });
  await access(input.appImagePath, 1);
  await chmod(input.appImagePath, 0o755);
  await rm(appDir, { recursive: true, force: true });
  return input.appImagePath;
}

async function ensureAppImageTool(toolsRoot: string): Promise<string> {
  const destination = join(toolsRoot, "appimagetool-x86_64.AppImage");
  const existing = await stat(destination).catch(() => undefined);
  if (existing?.isFile()) {
    await assertAppImageToolDigest(destination);
    await chmod(destination, 0o755);
    return destination;
  }
  await mkdir(toolsRoot, { recursive: true });
  const response = await fetch(APPIMAGE_TOOL_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to download appimagetool (${response.status}). Install it locally or retry with network access.`,
    );
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  await assertAppImageToolDigest(destination);
  await chmod(destination, 0o755);
  return destination;
}

async function assertAppImageToolDigest(toolPath: string): Promise<void> {
  const digest = createHash("sha256")
    .update(await readFile(toolPath))
    .digest("hex");
  if (digest !== APPIMAGE_TOOL_SHA256) {
    throw new Error(
      `appimagetool SHA-256 mismatch (got ${digest}, expected ${APPIMAGE_TOOL_SHA256}). Refusing to execute.`,
    );
  }
}

async function validateLinuxPackageIdentity(packageDirectory: string): Promise<void> {
  await access(join(packageDirectory, DESKTOP_PACKAGE_IDENTITY.productName), 1);
}

/**
 * The desktop entry is written into the AppDir during staging, not into the
 * electron-packager directory, so identity for that file is checked here.
 */
async function validateLinuxAppDirIdentity(appDir: string): Promise<void> {
  await access(join(appDir, DESKTOP_PACKAGE_IDENTITY.productName), 1);
  const desktopPath = join(appDir, "octant.desktop");
  const existing = await stat(desktopPath).catch(() => undefined);
  if (existing?.isFile() !== true) {
    throw new Error("Packaged Linux AppDir is missing octant.desktop.");
  }
  const desktop = await readFile(desktopPath, "utf8");
  if (!desktop.includes(`Name=${DESKTOP_PACKAGE_IDENTITY.productName}`)) {
    throw new Error("Packaged Linux desktop entry is not Octant.");
  }
}

/**
 * The renderer's own policy has to survive the build, not merely appear in the
 * checked-in source. Vite rewrites `index.html` on its way into the bundle and
 * a unit test reading the repository copy cannot see the result, so the
 * document that actually ships is checked here.
 *
 * `frame-ancestors` is deliberately absent: user agents ignore it in a `meta`
 * element, and the served document's refusal to be framed comes from the
 * response header the remote route policy sets.
 */
export function validatePackagedRendererPolicy(indexHtml: string): void {
  const csp = indexHtml.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?\s*>/i,
  )?.[1];
  if (csp === undefined) {
    throw new Error("Packaged renderer document ships no Content-Security-Policy meta.");
  }

  // A substring check (`csp.includes("script-src 'self'")`) accepts an extra
  // source appended to a required directive and cannot see a directive that
  // is present but not the required text at all, so parse into directives and
  // compare each source list exactly.
  const directives = new Map<string, string>();
  for (const rawDirective of csp.split(";")) {
    const trimmed = rawDirective.trim();
    if (trimmed === "") continue;
    const [rawName, ...sources] = trimmed.split(/\s+/);
    if (rawName === undefined) continue;
    const name = rawName.toLowerCase();
    if (directives.has(name)) {
      // A browser applies only the first occurrence of a directive and
      // silently ignores every later one, so a weak first copy followed by a
      // strict-looking duplicate would read safe to a reviewer while shipping
      // the weak policy.
      throw new Error(`Packaged renderer Content-Security-Policy declares ${name} more than once.`);
    }
    directives.set(name, sources.join(" "));
  }

  const required: ReadonlyArray<readonly [string, string]> = [
    ["default-src", "'self'"],
    ["script-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
  ];
  for (const [name, expectedSources] of required) {
    const actualSources = directives.get(name);
    if (actualSources !== expectedSources) {
      throw new Error(
        `Packaged renderer Content-Security-Policy requires ${name} ${expectedSources}, found ${
          actualSources === undefined ? "no such directive" : actualSources
        }.`,
      );
    }
  }

  // script-src-elem and script-src-attr each take priority over script-src
  // for their narrower category when present, so either one can reopen what
  // an exact script-src just closed.
  for (const fallbackDirective of ["script-src-elem", "script-src-attr"] as const) {
    const fallbackSources = directives.get(fallbackDirective);
    if (fallbackSources !== undefined && fallbackSources !== "'self'") {
      throw new Error(
        `Packaged renderer Content-Security-Policy's ${fallbackDirective} (${fallbackSources}) is weaker than script-src.`,
      );
    }
  }
}

export type DesktopSigningOutcome =
  | { readonly kind: "signed"; readonly archivePath: string }
  | { readonly kind: "unsigned"; readonly missing: ReadonlyArray<string> };

/**
 * Sign and notarize the packaged app, or say plainly that it is unsigned.
 *
 * A local build without credentials still produces a working app — a
 * contributor has no certificate and should not need one. What it must never
 * do is produce something that could be mistaken for a release, so an unsigned
 * result is reported as unsigned and a declared release build refuses to
 * finish without the credentials rather than shipping past them.
 */
export async function signPackagedDesktop(input: {
  readonly repositoryRoot: string;
  readonly appPath: string;
  readonly environment: Record<string, string | undefined>;
  readonly run: (argv: ReadonlyArray<string>) => Promise<void>;
}): Promise<DesktopSigningOutcome> {
  const resolution = resolveSigningCredentials(input.environment);
  if (resolution.kind === "absent") {
    if (requireSigned(input.environment)) {
      throw new Error(
        `A release build must be signed, but ${resolution.missing.join(", ")} ${
          resolution.missing.length === 1 ? "is" : "are"
        } not set. Set ${SIGNING_ENVIRONMENT_VARIABLES.join(", ")} or drop OCTANT_RELEASE_BUILD.`,
      );
    }
    return { kind: "unsigned", missing: resolution.missing };
  }
  const archivePath = `${input.appPath.replace(/\.app$/, "")}-${resolveReleaseVersion(input.environment)}-darwin-arm64.zip`;
  await signAndNotarizeDesktop({
    repositoryRoot: input.repositoryRoot,
    appPath: input.appPath,
    archivePath,
    credentials: resolution.credentials,
    run: input.run,
  });
  return { kind: "signed", archivePath };
}

async function validatePackagedArm64(path: string): Promise<void> {
  const process = Bun.spawn(["/usr/bin/file", "-b", path], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const description = await new Response(process.stdout).text();
  if ((await process.exited) !== 0 || !description.includes("arm64")) {
    throw new Error("Packaged native runtime payload is not Apple Silicon.");
  }
}

async function validatePackagedElf(path: string): Promise<void> {
  const child = Bun.spawn(["/usr/bin/file", "-b", path], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const description = await new Response(child.stdout).text();
  if ((await child.exited) !== 0 || !/ELF\s+64-bit/.test(description)) {
    throw new Error(`Packaged native runtime payload is not a Linux ELF binary: ${path}.`);
  }
}

async function copyBuiltDirectory(
  repositoryRoot: string,
  stageRoot: string,
  repositoryPath: string,
): Promise<void> {
  const source = resolve(repositoryRoot, repositoryPath);
  const sourceStats = await stat(source).catch(() => undefined);
  if (!sourceStats?.isDirectory()) {
    throw new Error(
      `Required built output is missing: ${repositoryPath}. Run bun run build first.`,
    );
  }
  await copyRuntimeDirectory(source, resolve(stageRoot, repositoryPath));
}

async function stageExternalRuntimePackages(
  repositoryRoot: string,
  stageRoot: string,
  packageNames: ReadonlyArray<string> = EXTERNAL_RUNTIME_PACKAGES,
  application: "desktop" | "server" = "server",
): Promise<void> {
  const destinationNodeModules = resolve(stageRoot, `apps/${application}/node_modules`);
  const rootRequire = createRequire(resolve(repositoryRoot, "apps/server/package.json"));
  const stagedVersions = new Map<string, string>();
  for (const packageName of packageNames) {
    await stageExternalPackage(packageName, rootRequire, destinationNodeModules, stagedVersions);
  }
}

async function stageExternalPackage(
  packageName: string,
  requester: NodeRequire,
  destinationNodeModules: string,
  stagedVersions: Map<string, string>,
): Promise<void> {
  if (isSdkBundledExecutablePackage(packageName)) return;
  const manifestPath = await resolvePackageManifest(packageName, requester);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    readonly name: string;
    readonly version: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
  };
  const existingVersion = stagedVersions.get(manifest.name);
  if (existingVersion !== undefined) {
    if (existingVersion !== manifest.version) {
      throw new Error(
        `Runtime dependency collision for ${manifest.name}: ${existingVersion} and ${manifest.version}.`,
      );
    }
    return;
  }
  stagedVersions.set(manifest.name, manifest.version);

  const sourceDirectory = dirname(manifestPath);
  const destinationDirectory = resolve(destinationNodeModules, ...manifest.name.split("/"));
  await copyRuntimeDirectory(sourceDirectory, destinationDirectory);

  const packageRequire = createRequire(manifestPath);
  const dependencyNames = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ].sort();
  for (const dependencyName of dependencyNames) {
    try {
      await stageExternalPackage(
        dependencyName,
        packageRequire,
        destinationNodeModules,
        stagedVersions,
      );
    } catch (error) {
      if (dependencyName in (manifest.optionalDependencies ?? {})) continue;
      throw error;
    }
  }
}

function isSdkBundledExecutablePackage(packageName: string): boolean {
  return packageName.startsWith("@anthropic-ai/claude-agent-sdk-");
}

async function resolvePackageManifest(
  packageName: string,
  requester: NodeRequire,
): Promise<string> {
  try {
    return requester.resolve(`${packageName}/package.json`);
  } catch {
    let directory = dirname(requester.resolve(packageName));
    while (true) {
      const candidate = join(directory, "package.json");
      if (
        await access(candidate).then(
          () => true,
          () => false,
        )
      ) {
        const manifest = JSON.parse(await readFile(candidate, "utf8")) as {
          readonly name?: string;
        };
        if (manifest.name === packageName) return candidate;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error(`Could not resolve runtime package manifest for ${packageName}.`);
  }
}

async function copyRuntimeDirectory(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => !isForbiddenPath(relative(source, path)),
  });
}

async function collectPayloadEntries(root: string): Promise<ReadonlyArray<PackagedPayloadEntry>> {
  const entries: PackagedPayloadEntry[] = [];
  await collect(root, root, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function collect(
  root: string,
  directory: string,
  output: PackagedPayloadEntry[],
): Promise<void> {
  const directoryEntries = await readdir(directory, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of directoryEntries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(root, absolutePath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const path = relative(root, absolutePath).split(sep).join("/");
    output.push({ path, content: await readTextIfScannable(absolutePath) });
  }
}

async function readTextIfScannable(path: string): Promise<string | undefined> {
  const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".mjs"]);
  if (!textExtensions.has(extname(path))) return undefined;
  return await readFile(path, "utf8");
}

function isForbiddenPath(path: string): boolean {
  const normalized = path.split(sep).join("/");
  const fileName = basename(normalized).toLowerCase();
  return (
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName === ".npmrc" ||
    fileName === "credentials.json" ||
    fileName.endsWith(".map") ||
    fileName.endsWith(".pem") ||
    fileName.endsWith(".key") ||
    fileName.endsWith(".p12") ||
    fileName.endsWith(".mobileprovision")
  );
}

function containsForbiddenIdentity(content: string): boolean {
  const forbidden = new RegExp(`\\b(?:${"syn" + "ara"}|${"openor" + "bit"})(?:\\b|[._-])`, "i");
  return forbidden.test(content);
}

async function validateBundleIdentity(appPath: string): Promise<void> {
  const infoPlist = await readFile(join(appPath, "Contents/Info.plist"), "utf8");
  if (!infoPlist.includes(DESKTOP_PACKAGE_IDENTITY.bundleId)) {
    throw new Error("Packaged app bundle identifier is not Octant-specific.");
  }
  if (!infoPlist.includes(DESKTOP_PACKAGE_IDENTITY.productName)) {
    throw new Error("Packaged app product name is not Octant.");
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (import.meta.main) {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const packaged = await packageDesktop(repositoryRoot);
  if (packaged.target.platform === "darwin") {
    const outcome = await signPackagedDesktop({
      repositoryRoot,
      appPath: packaged.artifactPath,
      environment: process.env,
      run: (argv) => runCommand(argv),
    });
    if (outcome.kind === "signed") {
      console.log(`Packaged, signed, and notarized Apple Silicon app: ${packaged.artifactPath}`);
      console.log(`Release archive for the update feed: ${outcome.archivePath}`);
    } else {
      // Said out loud rather than left to be discovered: this build cannot be
      // updated in place, because there is no signature for the platform updater
      // to check a replacement against.
      console.log(`Packaged UNSIGNED Apple Silicon app: ${packaged.artifactPath}`);
      console.log(
        `Unsigned because ${outcome.missing.join(", ")} not set; it will not auto-update.`,
      );
    }
  } else {
    // Linux dogfood ships unsigned. A signed update channel is a separate
    // deliverable; until then the app refuses install so an AppImage cannot
    // become an unauthenticated code-delivery path.
    console.log(`Packaged UNSIGNED Linux AppImage: ${packaged.artifactPath}`);
    if (packaged.portableDirectoryPath !== undefined) {
      console.log(`Portable electron-packager directory: ${packaged.portableDirectoryPath}`);
    }
    console.log("Linux has no signed update channel yet; this build will not auto-update.");
  }
}

async function runCommand(
  argv: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("Empty command.");
  const spawnOptions = {
    stdin: "ignore" as const,
    stdout: "inherit" as const,
    stderr: "inherit" as const,
    ...(options.env === undefined ? {} : { env: options.env }),
  };
  const child = Bun.spawn([command, ...args], spawnOptions);
  if ((await child.exited) !== 0) {
    throw new Error(`${command} failed while packaging the desktop app.`);
  }
}

import { packager, type Options as PackagerOptions } from "@electron/packager";
import { rebuild, type RebuildOptions } from "@electron/rebuild";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_PRELOAD_FILENAME } from "../apps/desktop/src/runtimePaths";
import { buildCodeFileHelper } from "./build-code-file-helper";
import { buildKeychainHelper } from "./build-keychain-helper";

export const DESKTOP_PACKAGE_IDENTITY = {
  bundleId: "app.octant.desktop",
  productName: "Octant",
} as const;

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

export const REQUIRED_PACKAGED_FILES = [
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
  "apps/server/node_modules/node-pty/build/Release/spawn-helper",
  "apps/server/node_modules/playwright-core/package.json",
  "apps/server/node_modules/yaml/package.json",
  "Octant.app/Contents/Resources/native/octant-keychain-helper",
  "Octant.app/Contents/Resources/native/octant-code-file-helper",
] as const;

export const PACKAGED_EXECUTABLE_FILES = [
  "native/octant-keychain-helper",
  "native/octant-code-file-helper",
  "app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
] as const;
export const PACKAGED_ARM64_FILES = [
  "native/octant-keychain-helper",
  "native/octant-code-file-helper",
  "app/apps/server/node_modules/node-pty/build/Release/pty.node",
  "app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
] as const;
export const FORBIDDEN_PACKAGED_FILES = [
  "Octant.app/Contents/Resources/app/apps/desktop/dist/native/octant-keychain-helper",
  "Octant.app/Contents/Resources/app/apps/desktop/dist/native/octant-code-file-helper",
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

const ALLOWED_NATIVE_PAYLOADS = new Set([
  "Octant.app/Contents/Resources/native/octant-keychain-helper",
  "Octant.app/Contents/Resources/native/octant-code-file-helper",
  "Octant.app/Contents/Resources/app/apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "Octant.app/Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/pty.node",
  "Octant.app/Contents/Resources/app/apps/server/node_modules/node-pty/build/Release/spawn-helper",
]);

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
    if (nativeCandidate && !ALLOWED_NATIVE_PAYLOADS.has(path)) {
      throw new Error(`Packaged bundle contains unexpected native payload ${path}.`);
    }
  }
}

export function selectFinalBundlePaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const prefix = `${DESKTOP_PACKAGE_IDENTITY.productName}.app/`;
  return paths.filter((path) => path.startsWith(prefix));
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
): Promise<void> {
  for (const path of [
    "apps/server/node_modules/node-pty/build/Release/pty.node",
    "apps/server/node_modules/node-pty/build/Release/spawn-helper",
  ]) {
    await strip(resolve(stageRoot, path));
  }
}

async function stripMachODebugMetadata(path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("/usr/bin/strip", ["-S", path], (error) => {
      if (error === null) resolvePromise();
      else reject(new Error("Packaged native runtime debug metadata could not be stripped."));
    });
  });
}

export function packagedBundlePath(requiredPath: string): string {
  return requiredPath.startsWith(`${DESKTOP_PACKAGE_IDENTITY.productName}.app/`)
    ? requiredPath
    : `${DESKTOP_PACKAGE_IDENTITY.productName}.app/Contents/Resources/app/${requiredPath}`;
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

export function createPackagerOptions(dir: string, out: string): PackagerOptions {
  return {
    appBundleId: DESKTOP_PACKAGE_IDENTITY.bundleId,
    arch: "arm64",
    asar: false,
    dir,
    electronVersion: ELECTRON_VERSION,
    icon: resolve(dir, "apps/desktop/resources/icon.icns"),
    name: DESKTOP_PACKAGE_IDENTITY.productName,
    out,
    overwrite: true,
    platform: "darwin",
    prune: false,
    protocols: [{ name: "Octant Code links", schemes: ["octant"] }],
  };
}

export function createNativeRebuildOptions(stageRoot: string): RebuildOptions {
  return {
    arch: "arm64",
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

export function validatePackagedPayload(entries: ReadonlyArray<PackagedPayloadEntry>): void {
  const paths = new Set(entries.map((entry) => entry.path));
  for (const requiredPath of REQUIRED_PACKAGED_FILES.filter(
    (path) => !path.startsWith(`${DESKTOP_PACKAGE_IDENTITY.productName}.app/`),
  )) {
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
  await rebuild(createNativeRebuildOptions(stageRoot));
  await pruneUnusedNativePayloads(stageRoot);
  await stripNativeDebugMetadata(stageRoot);

  validatePackagedPayload(await collectPayloadEntries(stageRoot));
  await validatePackagedRuntimeImports(stageRoot);
  await validatePackagedRuntimeImports(stageRoot, ["effect"], "apps/desktop");
}

export async function validatePackagedRuntimeImports(
  stageRoot: string,
  imports: ReadonlyArray<string> = PACKAGED_RUNTIME_IMPORTS,
  runtimePath = "apps/server",
): Promise<void> {
  const probe = imports.map((packageName) => `import(${JSON.stringify(packageName)})`).join(",");
  await new Promise<void>((resolvePromise, reject) => {
    execFile(
      "/usr/bin/env",
      ["node", "--input-type=module", "--eval", `await Promise.all([${probe}])`],
      {
        cwd: resolve(stageRoot, runtimePath),
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" },
        timeout: 10_000,
      },
      (error) => {
        if (error === null) resolvePromise();
        else reject(new Error("Packaged server runtime imports did not resolve under Node."));
      },
    );
  });
}

async function packageDesktop(repositoryRoot: string): Promise<string> {
  const outRoot = resolve(repositoryRoot, "out");
  const stageRoot = join(outRoot, STAGE_DIRECTORY);
  const packagerRoot = join(outRoot, PACKAGER_DIRECTORY);
  const finalApp = join(outRoot, `${DESKTOP_PACKAGE_IDENTITY.productName}.app`);

  await mkdir(outRoot, { recursive: true });
  await stageDesktopRuntime(repositoryRoot, stageRoot);
  await rm(packagerRoot, { recursive: true, force: true });
  await rm(finalApp, { recursive: true, force: true });

  const packagedDirectories = await packager(createPackagerOptions(stageRoot, packagerRoot));
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
  validatePackagedPayload(await collectPayloadEntries(packagedPayload));
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
  await validateBundleIdentity(finalApp);
  return finalApp;
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
  const appPath = await packageDesktop(repositoryRoot);
  console.log(`Packaged unsigned Apple Silicon app: ${appPath}`);
}

/**
 * The install step for an agent a person added (Provider runtimes: "Any ACP
 * agent"). It puts the agent's executable on disk and says how its bytes were
 * checked; it never runs anything it put there. A registry agent installs
 * into Octant's managed folder for that agent only: an npm or uv package at
 * the exact release the host's listing pins, with install scripts and source
 * builds off, or an archive downloaded over HTTPS from the URL the listing
 * names and checked against its checksum when the registry lists one. A local
 * agent's install only checks that the person's executable is on disk.
 *
 * When the person later clicks Trust, `runAcpAgentInstallScripts` runs a
 * package's deferred install scripts once for that install: natively outside
 * Strict, and inside Octant's sandbox with writes limited to the agent's
 * install folder under Strict.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from "node:path";
import type {
  AcpAgentInstallIntegrity,
  AcpAgentInstallScriptsFailureReason,
  AddedAcpAgentConfiguration,
} from "@octant/contracts";
import type { AcpRegistryAgent } from "@octant/plugin-host/acp-agents";
import {
  makeProcessConfinementLive,
  ProcessConfinementError,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";

/** Why an install put nothing on disk. Each carries Octant's own sentence. */
export type AcpAgentInstallRefusalReason =
  | "fetches-off"
  | "not-listed"
  | "not-https"
  | "download-failed"
  | "too-large"
  | "checksum-mismatch"
  | "unsafe-archive"
  | "unpack-failed"
  | "write-failed"
  | "package-manager-missing"
  | "package-manager-failed"
  | "executable-missing";

export type AcpAgentInstallResult =
  | {
      readonly status: "installed";
      readonly executable: string;
      readonly integrity: AcpAgentInstallIntegrity;
      readonly hasInstallScripts?: boolean;
    }
  | {
      readonly status: "refused";
      readonly reason: AcpAgentInstallRefusalReason;
      readonly message: string;
    };

export type AcpAgentInstallScriptsResult =
  | { readonly status: "not-needed" }
  | {
      readonly status: "completed";
      readonly sandboxed: boolean;
      readonly completedAt: string;
    }
  | {
      readonly status: "failed";
      readonly sandboxed: boolean;
      readonly completedAt: string;
      readonly reason: AcpAgentInstallScriptsFailureReason;
      readonly message: string;
    };

export interface AcpAgentInstallPorts {
  readonly fetch: (url: string, init: { readonly redirect: "follow" }) => Promise<Response>;
  /** Runs a package manager directly, never through a shell. */
  readonly run: (
    executable: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
    },
  ) => Promise<{ readonly exitCode: number | null; readonly timedOut?: boolean }>;
  /** An executable found on the host's PATH, as an absolute path. */
  readonly findExecutable: (name: string) => Promise<string | undefined>;
  /** The Marketplace fetches switch: with it off, nothing is downloaded. */
  readonly fetchesAllowed: () => boolean;
  /** Confinement launcher used when Strict is on during Trust install-script runs. */
  readonly confinement?: ProcessConfinementPort;
  readonly clock?: () => string;
}

export const MAX_ACP_AGENT_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const PACKAGE_MANAGER_TIMEOUT_MS = 10 * 60 * 1000;
const PROCESS_GROUP_KILL_GRACE_MS = 2_000;
const MAX_SCANNED_NPM_PACKAGES = 2_000;
const NPM_INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

const refused = (reason: AcpAgentInstallRefusalReason, message: string): AcpAgentInstallResult => ({
  status: "refused",
  reason,
  message,
});

/**
 * Installs one added agent. `root` is that agent's own managed folder; each
 * install goes into a fresh folder under it, and the earlier ones are removed
 * only once the new one is on disk, so a failed reinstall leaves the agent as
 * it was.
 */
export async function installAcpAgent(
  input: {
    readonly configuration: AddedAcpAgentConfiguration;
    /** The host's listing for a registry agent; never anything a client sent. */
    readonly listing: AcpRegistryAgent | undefined;
    readonly root: string;
  },
  ports: AcpAgentInstallPorts,
): Promise<AcpAgentInstallResult> {
  const { source } = input.configuration;
  if (source.kind === "local") {
    return (await isExecutableFile(source.command))
      ? { status: "installed", executable: source.command, integrity: "local-command" }
      : refused("executable-missing", "The command is not an executable file on this host.");
  }
  const listing = input.listing;
  if (
    listing === undefined ||
    listing.registryId !== source.registryId ||
    listing.version !== source.version ||
    listing.distribution.kind !== source.distribution
  ) {
    return refused(
      "not-listed",
      "This release is no longer in Octant's registry listing. Remove the agent and add it again.",
    );
  }
  if (!ports.fetchesAllowed()) {
    return refused(
      "fetches-off",
      "Marketplace fetches are off in Settings, so Octant downloads nothing.",
    );
  }
  const destination = join(input.root, `${listing.version}-${randomUUID().slice(0, 8)}`);
  try {
    await mkdir(input.root, { recursive: true, mode: 0o700 });
    await mkdir(destination, { mode: 0o700 });
  } catch {
    return refused("write-failed", "Octant could not create the agent's install folder.");
  }
  let result: AcpAgentInstallResult;
  try {
    const distribution = listing.distribution;
    result =
      distribution.kind === "binary"
        ? await installArchive(distribution, destination, ports)
        : distribution.kind === "npx"
          ? await installNpmPackage(distribution, destination, ports)
          : await installUvPackage(distribution, destination, ports);
  } catch {
    result = refused("unpack-failed", "The agent could not be installed.");
  }
  if (result.status === "refused") {
    await rm(destination, { recursive: true, force: true });
    return result;
  }
  for (const entry of await readdir(input.root)) {
    if (join(input.root, entry) !== destination)
      await rm(join(input.root, entry), { recursive: true, force: true });
  }
  return result;
}

async function installArchive(
  distribution: Extract<AcpRegistryAgent["distribution"], { readonly kind: "binary" }>,
  destination: string,
  ports: AcpAgentInstallPorts,
): Promise<AcpAgentInstallResult> {
  if (new URL(distribution.archive).protocol !== "https:")
    return refused("not-https", "Octant downloads an agent only over HTTPS.");
  const command = relativeInside(distribution.command);
  if (command === undefined)
    return refused("unsafe-archive", "The registry names an executable outside its archive.");
  let response: Response;
  try {
    response = await ports.fetch(distribution.archive, { redirect: "follow" });
  } catch {
    return refused("download-failed", "The agent could not be downloaded.");
  }
  // A redirect may not leave HTTPS.
  if (response.url !== "" && new URL(response.url).protocol !== "https:")
    return refused("not-https", "Octant downloads an agent only over HTTPS.");
  if (!response.ok || response.body === null)
    return refused("download-failed", "The agent could not be downloaded.");
  const archivePath = join(destination, ".download");
  const hash = createHash("sha256");
  let bytes = 0;
  const file = createWriteStream(archivePath, { mode: 0o600 });
  // A full or unwritable disk fails the stream asynchronously, outside the
  // loop's try; without this listener the error would go unhandled and a
  // `drain` wait would never settle. The caller removes the partial file.
  let writeFailed = false;
  const failure = new Promise<void>((resolve) =>
    file.once("error", () => {
      writeFailed = true;
      resolve();
    }),
  );
  const reader = response.body.getReader();
  const notWritten = refused("write-failed", "The agent's download could not be written to disk.");
  try {
    while (!writeFailed) {
      const chunk = await Promise.race([reader.read(), failure.then(() => undefined)]);
      if (chunk === undefined || writeFailed) break;
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_ACP_AGENT_ARCHIVE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return refused("too-large", "The agent's download is larger than Octant accepts.");
      }
      hash.update(chunk.value);
      if (!file.write(chunk.value))
        await Promise.race([new Promise((resolve) => file.once("drain", resolve)), failure]);
    }
    if (writeFailed) {
      await reader.cancel().catch(() => undefined);
      return notWritten;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return refused("download-failed", "The agent could not be downloaded.");
  } finally {
    if (writeFailed) file.destroy();
    else await Promise.race([new Promise<void>((resolve) => file.end(resolve)), failure]);
  }
  if (writeFailed) return notWritten;
  const digest = hash.digest("hex");
  if (distribution.sha256 !== undefined && digest !== distribution.sha256.toLowerCase())
    return refused(
      "checksum-mismatch",
      "The download does not match the checksum the ACP registry lists, so Octant installed nothing.",
    );
  const unpacked = await unpackArchive(distribution.archive, archivePath, destination, command);
  await rm(archivePath, { force: true });
  if (unpacked !== undefined) return unpacked;
  const executable = await executableInside(destination, command);
  if (executable === undefined)
    return refused("executable-missing", "The archive does not hold the agent's executable.");
  return {
    status: "installed",
    executable,
    integrity: distribution.sha256 === undefined ? "unverified-download" : "sha256-verified",
  };
}

/**
 * Unpacks with the system's `tar` or `unzip`, which only write files. Every
 * entry is listed first and the archive is refused when one is absolute or
 * climbs out with `..`; a raw executable is kept under its command name.
 */
async function unpackArchive(
  url: string,
  archivePath: string,
  destination: string,
  command: string,
): Promise<AcpAgentInstallResult | undefined> {
  const name = new URL(url).pathname.toLowerCase();
  const format = name.endsWith(".zip")
    ? "zip"
    : name.endsWith(".tar.gz") || name.endsWith(".tgz")
      ? "gzip"
      : name.endsWith(".tar.bz2") || name.endsWith(".tbz2")
        ? "bzip2"
        : "raw";
  if (format === "raw") {
    const target = join(destination, command);
    await mkdir(join(target, ".."), { recursive: true });
    await rename(archivePath, target);
    await chmod(target, 0o755);
    return undefined;
  }
  const lister =
    format === "zip"
      ? await capture("unzip", ["-Z1", archivePath])
      : await capture("tar", [format === "gzip" ? "-tzf" : "-tjf", archivePath]);
  if (lister === undefined)
    return refused("unpack-failed", "The agent's archive could not be read.");
  for (const entry of lister.split("\n").filter((line) => line.length > 0)) {
    if (relativeInside(entry.replace(/\/$/u, "")) === undefined && entry !== "./")
      return refused("unsafe-archive", "The agent's archive writes outside its own folder.");
  }
  const unpack =
    format === "zip"
      ? await capture("unzip", ["-q", "-o", archivePath, "-d", destination])
      : await capture("tar", [format === "gzip" ? "-xzf" : "-xjf", archivePath, "-C", destination]);
  return unpack === undefined
    ? refused("unpack-failed", "The agent's archive could not be unpacked.")
    : undefined;
}

async function installNpmPackage(
  distribution: Extract<AcpRegistryAgent["distribution"], { readonly kind: "npx" | "uvx" }>,
  destination: string,
  ports: AcpAgentInstallPorts,
): Promise<AcpAgentInstallResult> {
  const npm = await ports.findExecutable("npm");
  if (npm === undefined)
    return refused(
      "package-manager-missing",
      "npm is not on this host, so Octant cannot install this agent.",
    );
  const { exitCode } = await ports.run(
    npm,
    [
      "install",
      "--prefix",
      destination,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      `${distribution.package}@${distribution.version}`,
    ],
    {
      cwd: destination,
      env: packageManagerEnvironment({ npm_config_ignore_scripts: "true" }),
      timeoutMs: PACKAGE_MANAGER_TIMEOUT_MS,
    },
  );
  if (exitCode !== 0)
    return refused("package-manager-failed", "npm could not install this agent's release.");
  const manifestPath = join(destination, "node_modules", distribution.package, "package.json");
  let bin: unknown;
  try {
    bin = (JSON.parse(await readFile(manifestPath, "utf8")) as { readonly bin?: unknown }).bin;
  } catch {
    return refused("executable-missing", "The package names no executable.");
  }
  const binName = packageBinName(distribution.package, bin);
  if (binName === undefined)
    return refused("executable-missing", "The package names no executable.");
  const executable = await executableInside(destination, join("node_modules", ".bin", binName));
  if (executable === undefined)
    return refused("executable-missing", "The package names no executable.");
  const hasInstallScripts = await detectNpmInstallScripts(destination);
  return { status: "installed", executable, integrity: "package-manager", hasInstallScripts };
}

async function installUvPackage(
  distribution: Extract<AcpRegistryAgent["distribution"], { readonly kind: "npx" | "uvx" }>,
  destination: string,
  ports: AcpAgentInstallPorts,
): Promise<AcpAgentInstallResult> {
  const uv = await ports.findExecutable("uv");
  if (uv === undefined)
    return refused(
      "package-manager-missing",
      "uv is not on this host, so Octant cannot install this agent.",
    );
  // `--no-build` takes published wheels only: building a source distribution
  // would run the package's own build code at install time.
  const { exitCode } = await ports.run(
    uv,
    ["tool", "install", "--no-build", `${distribution.package}==${distribution.version}`],
    {
      cwd: destination,
      env: packageManagerEnvironment({
        UV_TOOL_DIR: join(destination, "tools"),
        UV_TOOL_BIN_DIR: join(destination, "bin"),
      }),
      timeoutMs: PACKAGE_MANAGER_TIMEOUT_MS,
    },
  );
  if (exitCode !== 0)
    return refused("package-manager-failed", "uv could not install this agent's release.");
  const name = distribution.package.replace(/\[.*$/u, "");
  const executable = await executableInside(destination, join("bin", name));
  return executable === undefined
    ? refused("executable-missing", "The package names no executable.")
    : { status: "installed", executable, integrity: "package-manager", hasInstallScripts: false };
}

/**
 * Whether an installed npm prefix holds any package that declares lifecycle
 * install scripts (`preinstall`, `install`, `postinstall`) or a native
 * `binding.gyp` that `npm rebuild` would execute. Only directories resolving
 * inside `installFolder` are inspected.
 */
export async function detectNpmInstallScripts(installFolder: string): Promise<boolean> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(installFolder);
  } catch {
    return false;
  }
  const queue: string[] = [join(canonicalRoot, "node_modules")];
  const visited = new Set<string>();
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_SCANNED_NPM_PACKAGES) {
    const modulesDir = queue.shift();
    if (modulesDir === undefined) break;
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(modulesDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= MAX_SCANNED_NPM_PACKAGES) break;
      if (entry.startsWith(".")) continue;
      const entryPath = join(modulesDir, entry);
      if (entry.startsWith("@")) {
        let scoped: ReadonlyArray<string>;
        try {
          scoped = await readdir(entryPath);
        } catch {
          continue;
        }
        for (const name of scoped) {
          if (scanned >= MAX_SCANNED_NPM_PACKAGES) break;
          if (name.startsWith(".")) continue;
          const result = await inspectNpmPackageDirectory(
            join(entryPath, name),
            canonicalRoot,
            visited,
            queue,
          );
          scanned += 1;
          if (result) return true;
        }
        continue;
      }
      const result = await inspectNpmPackageDirectory(entryPath, canonicalRoot, visited, queue);
      scanned += 1;
      if (result) return true;
    }
  }
  return false;
}

async function inspectNpmPackageDirectory(
  directory: string,
  canonicalRoot: string,
  visited: Set<string>,
  queue: string[],
): Promise<boolean> {
  let resolved: string;
  try {
    if ((await lstat(directory)).isSymbolicLink()) return false;
    resolved = await realpath(directory);
    if (!resolved.startsWith(`${canonicalRoot}${sep}`)) return false;
    if (!(await stat(resolved)).isDirectory()) return false;
  } catch {
    return false;
  }
  if (visited.has(resolved)) return false;
  visited.add(resolved);
  try {
    const parsed = JSON.parse(await readFile(join(resolved, "package.json"), "utf8")) as {
      readonly scripts?: unknown;
    };
    if (typeof parsed.scripts === "object" && parsed.scripts !== null) {
      const scripts = parsed.scripts as Readonly<Record<string, unknown>>;
      for (const name of NPM_INSTALL_LIFECYCLE_SCRIPTS) {
        const value = scripts[name];
        if (typeof value === "string" && value.trim().length > 0) return true;
      }
    }
  } catch {
    // Missing or unreadable package.json contributes no install script.
  }
  try {
    if ((await stat(join(resolved, "binding.gyp"))).isFile()) return true;
  } catch {
    // No native addon build file.
  }
  queue.push(join(resolved, "node_modules"));
  return false;
}

/**
 * Resolves the managed package install folder for an added npm agent under
 * `root` (`<root>/<version>-<suffix>`), refusing anything outside `root`.
 */
async function resolveAcpAgentPackageInstallFolder(
  root: string,
  executable: string,
): Promise<string | undefined> {
  try {
    const canonicalRoot = await realpath(root);
    // An npm install places its executable at `<folder>/node_modules/.bin/<name>`.
    const candidate = dirname(dirname(dirname(executable)));
    const canonicalFolder = await realpath(candidate);
    if (dirname(canonicalFolder) !== canonicalRoot) return undefined;
    if (!(await stat(canonicalFolder)).isDirectory()) return undefined;
    return canonicalFolder;
  } catch {
    return undefined;
  }
}

/**
 * Whether an untrusted package ACP agent still has deferred install scripts
 * that will run when the person clicks Trust.
 */
export async function hasPendingAcpAgentInstallScripts(input: {
  readonly configuration: AddedAcpAgentConfiguration;
  readonly root: string;
}): Promise<boolean> {
  const { configuration } = input;
  if (configuration.source.kind !== "registry") return false;
  if (configuration.source.distribution !== "npx" && configuration.source.distribution !== "uvx") {
    return false;
  }
  const install = configuration.install;
  if (install === undefined || configuration.trusted || install.installScriptsCompleted === true) {
    return false;
  }
  if (install.hasInstallScripts === true) return true;
  if (install.hasInstallScripts === false || configuration.source.distribution === "uvx") {
    return false;
  }
  const folder = await resolveAcpAgentPackageInstallFolder(input.root, install.executable);
  return folder === undefined ? false : detectNpmInstallScripts(folder);
}

/**
 * Runs a package ACP agent's deferred install scripts when the person clicks
 * Trust. Non-package agents, packages without install scripts, and installs
 * whose scripts already completed return `{ status: "not-needed" }`. Outside
 * Strict scripts run natively with no Octant sandbox; under Strict they run
 * inside Octant's sandbox with writes limited to the agent's install folder.
 */
export async function runAcpAgentInstallScripts(
  input: {
    readonly configuration: AddedAcpAgentConfiguration;
    readonly root: string;
    readonly strict: boolean;
  },
  ports: Pick<AcpAgentInstallPorts, "findExecutable" | "run" | "confinement" | "clock">,
): Promise<AcpAgentInstallScriptsResult> {
  const { configuration } = input;
  if (configuration.source.kind !== "registry") return { status: "not-needed" };
  if (configuration.source.distribution !== "npx" && configuration.source.distribution !== "uvx") {
    return { status: "not-needed" };
  }
  const install = configuration.install;
  if (install === undefined || install.installScriptsCompleted === true) {
    return { status: "not-needed" };
  }
  // uv installs published wheels only (`--no-build`), which carry no install scripts.
  if (configuration.source.distribution === "uvx" || install.hasInstallScripts === false) {
    return { status: "not-needed" };
  }
  const completedAt = () => (ports.clock ?? (() => new Date().toISOString()))();
  const failed = (
    reason: AcpAgentInstallScriptsFailureReason,
    message: string,
  ): AcpAgentInstallScriptsResult => ({
    status: "failed",
    sandboxed: input.strict,
    completedAt: completedAt(),
    reason,
    message,
  });

  const installFolder = await resolveAcpAgentPackageInstallFolder(input.root, install.executable);
  if (installFolder === undefined) {
    return failed(
      "invalid-install-folder",
      "The agent's install folder is missing or invalid. Reinstall the agent and try again.",
    );
  }
  if (!(await detectNpmInstallScripts(installFolder))) {
    return { status: "not-needed" };
  }
  const npm = await ports.findExecutable("npm");
  if (npm === undefined) {
    return failed(
      "package-manager-missing",
      "npm is not on this host, so Octant cannot run this agent's install script.",
    );
  }

  const npmArgs = ["rebuild", "--prefix", installFolder, "--ignore-scripts=false"];
  let runResult: { readonly exitCode: number | null; readonly timedOut?: boolean };
  if (!input.strict) {
    runResult = await ports.run(npm, npmArgs, {
      cwd: installFolder,
      env: packageManagerEnvironment({ npm_config_ignore_scripts: "false" }),
      timeoutMs: PACKAGE_MANAGER_TIMEOUT_MS,
    });
  } else {
    const tempDir = join(installFolder, ".octant-install-tmp");
    const cacheDir = join(installFolder, ".octant-npm-cache");
    try {
      await mkdir(tempDir, { recursive: true, mode: 0o700 });
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    } catch {
      return failed(
        "invalid-install-folder",
        "Octant could not prepare the agent's install folder for its install script.",
      );
    }
    try {
      const baseEnv = packageManagerEnvironment({
        HOME: tempDir,
        TMPDIR: tempDir,
        npm_config_cache: cacheDir,
        npm_config_ignore_scripts: "false",
      });
      const node = await ports.findExecutable("node");
      const readRoots = await toolchainReadRoots([installFolder, tempDir, cacheDir], [npm, node]);
      const confinement = ports.confinement ?? makeProcessConfinementLive();
      let launch: ReturnType<ProcessConfinementPort["prepare"]>;
      try {
        launch = confinement.prepare({
          executable: npm,
          args: npmArgs,
          boundRoot: installFolder,
          temporaryDirectory: tempDir,
          networkEgress: "allow",
          writeBoundRoot: true,
          allowFileReadStar: true,
          allowProcessExec: true,
          allowProcessFork: true,
          readRoots,
          ...(baseEnv.PATH === undefined ? {} : { interpreterSearchPath: baseEnv.PATH }),
        });
      } catch (error) {
        if (error instanceof ProcessConfinementError) {
          return failed(
            "sandbox-unavailable",
            "Octant's sandbox is unavailable on this host, so the install script was not run under Strict.",
          );
        }
        throw error;
      }
      runResult = await ports.run(launch.command, launch.args, {
        cwd: installFolder,
        env: { ...baseEnv, ...launch.environment },
        timeoutMs: PACKAGE_MANAGER_TIMEOUT_MS,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (runResult.timedOut === true) {
    return failed("timed-out", "The package's install script timed out before finishing.");
  }
  if (runResult.exitCode !== 0) {
    return failed(
      "script-failed",
      input.strict
        ? "The package's install script failed inside Octant's sandbox."
        : "The package's install script failed.",
    );
  }
  const executableRelative = relative(installFolder, install.executable);
  const verified = await executableInside(installFolder, executableRelative);
  if (verified === undefined) {
    return failed(
      "executable-missing",
      "The package's executable is missing after its install script ran.",
    );
  }
  return {
    status: "completed",
    sandboxed: input.strict,
    completedAt: completedAt(),
  };
}

const SHARED_USER_HOME_CHILDREN = [
  ".local",
  ".config",
  ".cache",
  "Library",
  "Documents",
  "Desktop",
  "Downloads",
] as const;

const FORBIDDEN_SYSTEM_TOOLCHAIN_ROOTS: ReadonlyArray<string> = [
  "/",
  "/Users",
  "/home",
  "/var",
  "/private",
  "/private/var",
  "/tmp",
  "/private/tmp",
];

/**
 * Collects read-only toolchain roots so npm and node remain readable under
 * Strict confinement without ever climbing into `$HOME`, its ancestors, or
 * shared user-data directories (`~/.local`, `~/.config`, etc.). Explicit
 * `readRoots` bypass the private-home boundary, so widening to `$HOME` would
 * expose private user files to an install script.
 */
export async function toolchainReadRoots(
  baseRoots: ReadonlyArray<string>,
  executables: ReadonlyArray<string | undefined>,
  options?: { readonly homeDirectory?: string },
): Promise<ReadonlyArray<string>> {
  const roots = new Set<string>(baseRoots);
  const forbidden = new Set<string>(FORBIDDEN_SYSTEM_TOOLCHAIN_ROOTS);
  const home = options?.homeDirectory ?? homedir();
  const homeForms = new Set<string>();
  if (isAbsolute(home)) {
    homeForms.add(normalize(home));
    try {
      homeForms.add(await realpath(home));
    } catch {
      // Unresolvable home directory; keep the normalized form.
    }
  }
  for (const homePath of homeForms) {
    let ancestor = homePath;
    while (true) {
      forbidden.add(ancestor);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    for (const child of SHARED_USER_HOME_CHILDREN) {
      forbidden.add(join(homePath, child));
    }
  }
  const addExecutableDirs = (executablePath: string): void => {
    const dir1 = normalize(dirname(executablePath));
    if (!isAbsolute(dir1) || forbidden.has(dir1)) return;
    roots.add(dir1);
    // Only climb one level past a standard `.../bin/<tool>` folder (for example
    // `.../npm/bin/npm-cli.js` -> `.../npm` or `~/.volta/bin/node` -> `~/.volta`),
    // never to `$HOME` or a shared home child such as `~/.local`.
    if (basename(dir1) === "bin") {
      const dir2 = normalize(dirname(dir1));
      if (isAbsolute(dir2) && !forbidden.has(dir2)) roots.add(dir2);
    }
  };
  for (const executable of executables) {
    if (executable === undefined || !isAbsolute(executable)) continue;
    addExecutableDirs(executable);
    try {
      addExecutableDirs(await realpath(executable));
    } catch {
      // Unresolvable symlink target; keep the configured path's directories only.
    }
  }
  return [...roots];
}

/** A package's executable: its only bin, or the one named for the package. */
function packageBinName(packageName: string, bin: unknown): string | undefined {
  const unscoped = packageName.replace(/^@[^/]+\//u, "");
  if (typeof bin === "string") return unscoped;
  if (typeof bin !== "object" || bin === null) return undefined;
  const names = Object.keys(bin);
  if (names.length === 1) return names[0];
  return names.includes(unscoped) ? unscoped : undefined;
}

/** A relative path that stays inside its folder, or undefined. */
function relativeInside(path: string): string | undefined {
  const trimmed = path.replace(/^\.\//u, "");
  if (trimmed.length === 0 || isAbsolute(trimmed)) return undefined;
  const normalized = normalize(trimmed);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) return undefined;
  return normalized;
}

/** The executable at `relative` under `folder`, resolved, still inside it. */
async function executableInside(folder: string, relative: string): Promise<string | undefined> {
  try {
    const root = await realpath(folder);
    const resolved = await realpath(join(folder, relative));
    if (!resolved.startsWith(`${root}${sep}`)) return undefined;
    if (!(await isExecutableFile(resolved))) return undefined;
    return join(folder, relative);
  } catch {
    return undefined;
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The host environment a package manager needs, and nothing that names a key. */
function packageManagerEnvironment(
  extra: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const kept: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = process.env[name];
    if (value !== undefined) kept[name] = value;
  }
  return { ...kept, ...extra };
}

/** Runs a system unpacker directly and returns its output, or undefined on failure. */
function capture(command: string, args: ReadonlyArray<string>): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 16 * 1024 * 1024) output += chunk;
    });
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? output : undefined));
  });
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}

/** Terminates a spawned package-manager process and any children in its process group. */
function signalProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    void spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        // Process has already exited.
      }
    }
  }
}

async function waitUntilProcessGroupExited(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

/**
 * Escalates a surviving process group from SIGTERM to SIGKILL and waits for
 * bounded cleanup. Because stdio is ignored, the leader exiting on SIGTERM
 * does not prove its lifecycle-script descendants exited, so timeout and close
 * both await this same cleanup promise.
 */
async function ensureProcessGroupExited(
  child: ChildProcess,
  pid: number | undefined,
  graceMs: number,
): Promise<void> {
  if (pid === undefined || !processGroupExists(pid)) return;
  signalProcessGroup(child, pid, "SIGTERM");
  if (await waitUntilProcessGroupExited(pid, graceMs)) return;
  signalProcessGroup(child, pid, "SIGKILL");
  await waitUntilProcessGroupExited(pid, graceMs);
}

/** The live ports: the host's fetch, PATH and process spawning. */
export function makeAcpAgentInstallPorts(options: {
  readonly fetchesAllowed: () => boolean;
  readonly confinement?: ProcessConfinementPort;
  readonly clock?: () => string;
  readonly killGraceMs?: number;
}): AcpAgentInstallPorts {
  const killGraceMs = options.killGraceMs ?? PROCESS_GROUP_KILL_GRACE_MS;
  return {
    fetch: (url, init) => fetch(url, init),
    fetchesAllowed: options.fetchesAllowed,
    ...(options.confinement === undefined ? {} : { confinement: options.confinement }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    findExecutable: async (name) => {
      for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        if (!isAbsolute(directory)) continue;
        const candidate = join(directory, name);
        if (await isExecutableFile(candidate)) return candidate;
      }
      return undefined;
    },
    run: (executable, args, runOptions) =>
      new Promise((resolve) => {
        const detached = process.platform !== "win32";
        const child = spawn(executable, [...args], {
          cwd: runOptions.cwd,
          env: runOptions.env,
          stdio: "ignore",
          detached,
        });
        let settled = false;
        let timedOut = false;
        let cleanup: Promise<void> | undefined;
        const releaseTree = () =>
          (cleanup ??= ensureProcessGroupExited(child, child.pid, killGraceMs));
        const settle = (result: {
          readonly exitCode: number | null;
          readonly timedOut?: boolean;
        }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          void releaseTree().then(() => settle({ exitCode: null, timedOut: true }));
        }, runOptions.timeoutMs);
        child.once("error", () => {
          if (timedOut) return;
          settle({ exitCode: null });
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          void (async () => {
            if (timedOut) {
              await releaseTree();
              settle({ exitCode: code, timedOut: true });
              return;
            }
            if (detached && child.pid !== undefined && processGroupExists(child.pid)) {
              await releaseTree();
            }
            settle({ exitCode: code, ...(timedOut ? { timedOut: true } : {}) });
          })();
        });
      }),
  };
}

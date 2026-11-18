/**
 * The install step for an agent a person added (Provider runtimes: "Any ACP
 * agent"). It puts the agent's executable on disk and says how its bytes were
 * checked; it never runs anything it put there. A registry agent installs
 * into Octant's managed folder for that agent only: an npm or uv package at
 * the exact release the host's listing pins, with install scripts and source
 * builds off, or an archive downloaded over HTTPS from the URL the listing
 * names and checked against its checksum when the registry lists one. A local
 * agent's install only checks that the person's executable is on disk.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, normalize, sep } from "node:path";
import type { AcpAgentInstallIntegrity, AddedAcpAgentConfiguration } from "@octant/contracts";
import type { AcpRegistryAgent } from "@octant/plugin-host/acp-agents";

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
  | "package-manager-missing"
  | "package-manager-failed"
  | "executable-missing";

export type AcpAgentInstallResult =
  | {
      readonly status: "installed";
      readonly executable: string;
      readonly integrity: AcpAgentInstallIntegrity;
    }
  | {
      readonly status: "refused";
      readonly reason: AcpAgentInstallRefusalReason;
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
  ) => Promise<{ readonly exitCode: number | null }>;
  /** An executable found on the host's PATH, as an absolute path. */
  readonly findExecutable: (name: string) => Promise<string | undefined>;
  /** The Marketplace fetches switch: with it off, nothing is downloaded. */
  readonly fetchesAllowed: () => boolean;
}

export const MAX_ACP_AGENT_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const PACKAGE_MANAGER_TIMEOUT_MS = 10 * 60 * 1000;

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
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  const destination = join(input.root, `${listing.version}-${randomUUID().slice(0, 8)}`);
  await mkdir(destination, { mode: 0o700 });
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
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_ACP_AGENT_ARCHIVE_BYTES) {
        await reader.cancel();
        return refused("too-large", "The agent's download is larger than Octant accepts.");
      }
      hash.update(chunk.value);
      if (!file.write(chunk.value)) await new Promise((resolve) => file.once("drain", resolve));
    }
  } catch {
    return refused("download-failed", "The agent could not be downloaded.");
  } finally {
    await new Promise<void>((resolve) => file.end(resolve));
  }
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
  return executable === undefined
    ? refused("executable-missing", "The package names no executable.")
    : { status: "installed", executable, integrity: "package-manager" };
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
    : { status: "installed", executable, integrity: "package-manager" };
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

/** The live ports: the host's fetch, PATH and process spawning. */
export function makeAcpAgentInstallPorts(options: {
  readonly fetchesAllowed: () => boolean;
}): AcpAgentInstallPorts {
  return {
    fetch: (url, init) => fetch(url, init),
    fetchesAllowed: options.fetchesAllowed,
    findExecutable: async (name) => {
      for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        if (!isAbsolute(directory)) continue;
        const candidate = join(directory, name);
        if (await isExecutableFile(candidate)) return candidate;
      }
      return undefined;
    },
    run: (executable, args, options) =>
      new Promise((resolve) => {
        const child = spawn(executable, [...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: "ignore",
        });
        const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
        child.once("error", () => {
          clearTimeout(timer);
          resolve({ exitCode: null });
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code });
        });
      }),
  };
}

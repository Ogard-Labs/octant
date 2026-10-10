import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { DiscoveryCandidate, DiscoverySnapshot, ProviderDriverKind } from "@octant/contracts";
import { admittedBundledProviderDriverKinds } from "@octant/plugin-host/provider-drivers";
import type { ProviderDiscoveryDescriptor } from "@octant/provider-sdk/discovery";
import { discoverableDescriptorsForAdmittedDrivers } from "@octant/provider-sdk/driver-plugins";
import { execVersionRead, prepareConfinedVersionProbe } from "../process/confinedVersionProbe";
import type { SeatbeltConfinementPort } from "../process/seatbeltProfile";

// ── Budgets ─────────────────────────────────────────────────────────────────

const MAX_SCAN_DURATION_MS = 10_000;
const MAX_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT_BYTES = 4_096;
const MAX_CANDIDATES_PER_DRIVER = 4;
const MAX_TOTAL_CANDIDATES = 64;
const APPROVED_HOME_BIN_DIRECTORIES = [
  ".local/bin",
  ".bun/bin",
  ".kimi-code/bin",
  ".grok/bin",
] as const;
const ALIAS_FILES = [".bash_aliases", ".bash_profile", ".bashrc", ".zprofile", ".zshrc"] as const;
export const MAX_ALIAS_FILE_BYTES = 64 * 1024;
const MAX_ALIAS_LINES = 2_000;
const PROBE_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
] as const;

// ── Ports ───────────────────────────────────────────────────────────────────

export interface DiscoveryExecPort {
  (
    file: string,
    args: ReadonlyArray<string>,
    options: {
      timeout: number;
      maxBuffer: number;
      env?: NodeJS.ProcessEnv;
      /** A confined version read runs in its own scratch, not the host's cwd. */
      cwd?: string;
    },
  ): Promise<{ stdout: string; stderr: string }>;
}

export type DiscoveryTextRead =
  | { readonly kind: "ok"; readonly content: string }
  | { readonly kind: "too-large" }
  | { readonly kind: "unavailable" };

export interface DiscoveryFsPort {
  access(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean }>;
  realpath(path: string): Promise<string>;
  /**
   * Read-only shell alias inspection. Implementations must not source files
   * and must not allocate more than maxBytes of file content.
   */
  readonly readFile?: (path: string, maxBytes: number) => Promise<DiscoveryTextRead>;
}

export interface DiscoveryServiceOptions {
  readonly exec?: DiscoveryExecPort;
  /** Confinement for the version read of a candidate found on the host. */
  readonly versionProbeConfinement?: SeatbeltConfinementPort;
  readonly fs?: DiscoveryFsPort;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly hostId?: string;
  readonly admittedDriverKinds?: ReadonlySet<ProviderDriverKind>;
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface DiscoveryService {
  scan(signal?: AbortSignal): Promise<DiscoverySnapshot>;
  /** Canonical candidates from the most recent completed/partial scan. */
  getLastScanCandidates(): ReadonlyArray<DiscoveryCandidate>;
  /**
   * Checks an executable a person picked for a runtime of this kind, with the
   * validation and confined version probe the scan applies to what it finds.
   */
  checkPickedBinary(
    driverKind: ProviderDriverKind,
    path: string,
    signal?: AbortSignal,
  ): Promise<PickedBinaryCheck>;
}

export type PickedBinaryCheck =
  | { readonly status: "accepted"; readonly version: string }
  | {
      readonly status: "refused";
      readonly reason: "unsupported-kind" | "not-executable" | "probe-failed";
      readonly message: string;
    };

export function makeDiscoveryService(options: DiscoveryServiceOptions = {}): DiscoveryService {
  const exec = options.exec ?? defaultExec;
  const fs = options.fs ?? defaultFs;
  const now = options.now ?? Date.now;
  const hostId = options.hostId ?? "local";
  const environment = options.environment ?? process.env;
  const admittedDriverKinds = options.admittedDriverKinds ?? admittedBundledProviderDriverKinds();
  const versionProbeConfinement = options.versionProbeConfinement;

  let lastScanCandidates: DiscoveryCandidate[] = [];

  // One scan at a time: every scan starts a version and sign-in read per
  // installed runtime side by side, so overlapping requests from reusable
  // window capabilities would multiply that burst. A request that arrives
  // while one runs shares its result.
  let inFlightScan: Promise<DiscoverySnapshot> | undefined;
  const runScan = async (signal?: AbortSignal): Promise<DiscoverySnapshot> => {
    const startTime = now();
    const descriptors = discoverableDescriptorsForAdmittedDrivers(admittedDriverKinds);
    const candidates: DiscoveryCandidate[] = [];
    const searchedDirectories: Array<
      NonNullable<DiscoverySnapshot["searchedDirectories"]>[number]
    > = [];
    let status: DiscoverySnapshot["status"] = "completed";
    let message: string | undefined;

    // Collect all search directories: sanitized PATH + approved locations
    const pathDirs = [
      ...new Set([
        ...sanitizedPathDirs(environment.PATH ?? ""),
        ...approvedHomeBinDirs(environment.HOME),
      ]),
    ];
    const aliasTargets = await readAliasTargets(fs, environment.HOME, environment.SHELL, pathDirs);

    // Each driver's probes stay serial (one driver can name several
    // launchers), but the drivers run side by side. Probing them one after
    // another made the scan the sum of every runtime's version and sign-in
    // read: 7 to 17 s on a host with 17 runtimes, which Settings showed as a
    // scan that never ended.
    const scans = await Promise.all(
      descriptors.map(async (descriptor) => {
        try {
          return await scanDescriptor(
            descriptor,
            pathDirs,
            aliasTargets,
            exec,
            fs,
            environment,
            now,
            startTime,
            versionProbeConfinement,
            signal,
          );
        } catch {
          return undefined;
        }
      }),
    );

    for (const [index, found] of scans.entries()) {
      const descriptor = descriptors[index];
      if (descriptor === undefined) continue;
      if (found === undefined) {
        if (status === "completed") status = "partial";
        continue;
      }
      candidates.push(...found.candidates.slice(0, MAX_CANDIDATES_PER_DRIVER));
      searchedDirectories.push({
        driverKind: descriptor.driverKind as DiscoveryCandidate["driverKind"],
        directories: [...found.searchedDirectories],
      });
      if (found.outOfTime && status === "completed") {
        status = "partial";
        message = "Discovery scan exceeded its time budget.";
      }
    }
    if (signal?.aborted) {
      status = "cancelled";
      message = "Discovery scan was cancelled.";
    }

    // Deduplicate by the launcher path the scan examined, not the canonical target.
    const seen = new Set<string>();
    const deduplicated = candidates.filter((candidate) => {
      const key = candidate.discoveredPath ?? candidate.binaryPath;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const finalCandidates = deduplicated.slice(
      0,
      MAX_TOTAL_CANDIDATES,
    ) as DiscoverySnapshot["candidates"];
    lastScanCandidates = [...finalCandidates];
    const snapshot: DiscoverySnapshot = {
      hostId: hostId as DiscoverySnapshot["hostId"],
      candidates: finalCandidates,
      scannedAt: new Date(now()).toISOString() as DiscoverySnapshot["scannedAt"],
      scanDurationMs: now() - startTime,
      status,
      ...(searchedDirectories.length > 0 ? { searchedDirectories } : {}),
      ...(message !== undefined ? { message: message as DiscoverySnapshot["message"] } : {}),
    };
    return snapshot;
  };

  return {
    getLastScanCandidates() {
      return lastScanCandidates;
    },
    async checkPickedBinary(driverKind, path, signal) {
      const descriptor = discoverableDescriptorsForAdmittedDrivers(admittedDriverKinds).find(
        (candidate) => candidate.driverKind === driverKind,
      );
      if (
        descriptor === undefined ||
        descriptor.isDirectEndpoint ||
        descriptor.versionProbeArgs.length === 0
      ) {
        return {
          status: "refused",
          reason: "unsupported-kind",
          message: "Octant cannot check a picked binary for this runtime.",
        };
      }
      const validated = await validateExecutable(path, fs);
      if (validated === undefined) {
        return {
          status: "refused",
          reason: "not-executable",
          message: "The chosen file is not an executable program.",
        };
      }
      // A picked file was named by the person, not found by the scan, but it
      // runs under the same confinement: a host that cannot confine it never
      // runs it, and the pick is refused rather than accepted unchecked.
      const read = await readConfinedVersion(
        descriptor,
        validated.canonicalPath,
        exec,
        environment,
        versionProbeConfinement,
        signal,
      );
      // A program that exits cleanly but prints no version number (`echo`
      // printing its own arguments, a shell script that ignores them) is not
      // a runtime of this kind either.
      if (read === undefined || !/\d+\.\d+/.test(read)) {
        return {
          status: "refused",
          reason: "probe-failed",
          message: `The chosen file did not answer ${descriptor.displayName}'s version check.`,
        };
      }
      return { status: "accepted", version: read };
    },
    scan(signal?: AbortSignal): Promise<DiscoverySnapshot> {
      inFlightScan ??= runScan(signal).finally(() => {
        inFlightScan = undefined;
      });
      return inFlightScan;
    },
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function scanDescriptor(
  descriptor: ProviderDiscoveryDescriptor,
  pathDirs: ReadonlyArray<string>,
  aliasTargets: ReadonlyMap<string, string>,
  exec: DiscoveryExecPort,
  fs: DiscoveryFsPort,
  environment: NodeJS.ProcessEnv,
  now: () => number,
  startTime: number,
  versionProbeConfinement: SeatbeltConfinementPort | undefined,
  signal?: AbortSignal,
): Promise<{
  readonly candidates: DiscoveryCandidate[];
  readonly searchedDirectories: ReadonlyArray<string>;
  /** The driver's search stopped on the scan's time budget, not because it ran out of places. */
  readonly outOfTime: boolean;
}> {
  const candidates: DiscoveryCandidate[] = [];
  const seenPaths = new Set<string>();
  const searchedDirectories = new Set<string>();
  let outOfTime = false;

  // Search PATH directories + approved locations. Alias targets are appended
  // after ordinary paths so discovery remains deterministic when a shell
  // alias points at an already visible executable.
  const searchDirs = [...pathDirs, ...descriptor.approvedLocations];
  const aliasPaths = descriptor.executableNames.flatMap((execName) => {
    const target = aliasTargets.get(execName);
    if (target === undefined) return [];
    if (isAbsolute(target)) return [{ path: target, execName }];
    return pathDirs.map((dir) => ({ path: join(dir, target), execName }));
  });
  const candidatePaths = [
    ...searchDirs.flatMap((dir) =>
      descriptor.executableNames.map((execName) => ({ path: join(dir, execName), execName })),
    ),
    ...aliasPaths,
  ];

  for (const candidate of candidatePaths) {
    const candidatePath = candidate.path;
    if (signal?.aborted) break;
    if (now() - startTime > MAX_SCAN_DURATION_MS) {
      outOfTime = true;
      break;
    }
    if (candidates.length >= MAX_CANDIDATES_PER_DRIVER) break;

    searchedDirectories.add(directoryOf(candidatePath));
    const execName = candidate.execName;
    const validated = await validateExecutable(candidatePath, fs);
    if (validated === undefined) continue;
    if (seenPaths.has(validated.discoveredPath)) continue;
    seenPaths.add(validated.discoveredPath);

    // Version probe. The candidate is one the scan found on PATH or in an
    // approved directory rather than one the user named, so it is confined
    // before it runs; a host that cannot confine reports no version rather
    // than running it anyway.
    const version = await readConfinedVersion(
      descriptor,
      validated.canonicalPath,
      exec,
      environment,
      versionProbeConfinement,
    );

    // Auth readiness probe. This one reads the provider's own credential state
    // out of the user's home, so the confinement above would answer
    // "unauthenticated" for every installed provider. Giving it a home it can
    // read is a readiness-probe question under 0122, not a version read.
    let readiness: DiscoveryCandidate["readiness"] = "unknown";
    if (descriptor.authProbeArgs !== undefined) {
      try {
        await exec(validated.canonicalPath, [...descriptor.authProbeArgs], {
          timeout: MAX_PROBE_TIMEOUT_MS,
          maxBuffer: MAX_PROBE_OUTPUT_BYTES,
          env: sanitizeProbeEnvironment(environment),
        });
        readiness = "ready";
      } catch {
        readiness = "unauthenticated";
      }
    }

    candidates.push({
      driverKind: descriptor.driverKind as DiscoveryCandidate["driverKind"],
      displayName: (descriptor.displayNameForExecutable?.(execName) ??
        descriptor.displayName) as DiscoveryCandidate["displayName"],
      binaryPath: validated.canonicalPath as DiscoveryCandidate["binaryPath"],
      ...(validated.discoveredPath === validated.canonicalPath
        ? {}
        : { discoveredPath: validated.discoveredPath as DiscoveryCandidate["discoveredPath"] }),
      ...(version !== undefined ? { version: version as DiscoveryCandidate["version"] } : {}),
      readiness,
      pathSummary: summarizePath(
        validated.canonicalPath,
        environment.HOME,
      ) as DiscoveryCandidate["pathSummary"],
      onboardingGuidance: descriptor.onboardingGuidance as DiscoveryCandidate["onboardingGuidance"],
      detectedAt: new Date(now()).toISOString() as DiscoveryCandidate["detectedAt"],
    });
  }

  return { candidates, searchedDirectories: [...searchedDirectories], outOfTime };
}

/**
 * Runs the descriptor's version probe under the version-read confinement and
 * returns the first line it printed. Undefined when the host could not
 * confine it, or the program failed, timed out, or printed nothing.
 */
async function readConfinedVersion(
  descriptor: ProviderDiscoveryDescriptor,
  canonicalPath: string,
  exec: DiscoveryExecPort,
  environment: NodeJS.ProcessEnv,
  versionProbeConfinement: SeatbeltConfinementPort | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted) return undefined;
  const probe = prepareConfinedVersionProbe({
    binaryPath: canonicalPath,
    displayName: descriptor.displayName,
    args: descriptor.versionProbeArgs,
    environment: () => sanitizeProbeEnvironment(environment),
    ...(versionProbeConfinement === undefined ? {} : { confinement: versionProbeConfinement }),
  });
  if (probe.status !== "prepared") return undefined;
  try {
    const { stdout } = await exec(probe.launch.command, probe.launch.args, {
      timeout: MAX_PROBE_TIMEOUT_MS,
      maxBuffer: MAX_PROBE_OUTPUT_BYTES,
      env: probe.launch.environment,
      cwd: probe.launch.workingDirectory,
    });
    return extractVersion(stdout);
  } catch {
    return undefined;
  } finally {
    probe.launch.release();
  }
}

function directoryOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

/**
 * Read shell alias declarations without evaluating startup files. Sourcing a
 * profile would execute arbitrary user commands during a background scan, so
 * only a strict, single-token alias grammar is accepted here.
 */
async function readAliasTargets(
  fs: DiscoveryFsPort,
  home: string | undefined,
  shell: string | undefined,
  pathDirs: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> {
  const targets = new Map<string, string>();
  const conflicting = new Set<string>();
  if (home === undefined || !isAbsolute(home) || fs.readFile === undefined) return targets;
  if (/[`$(){}|;&<>!#*?[\\]'"]/.test(home)) return targets;

  for (const file of aliasFilesForShell(shell)) {
    let result: DiscoveryTextRead;
    try {
      result = await fs.readFile(join(resolve(home), file), MAX_ALIAS_FILE_BYTES);
    } catch {
      continue;
    }
    if (result.kind !== "ok") continue;
    const content = result.content;
    if (Buffer.byteLength(content, "utf8") > MAX_ALIAS_FILE_BYTES) continue;
    for (const line of content.split(/\r?\n/, MAX_ALIAS_LINES + 1).slice(0, MAX_ALIAS_LINES)) {
      const match = /^\s*alias\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match === null) continue;
      const name = match[1];
      const rawValue = match[2];
      if (name === undefined || rawValue === undefined) continue;
      const target = unwrapAliasValue(rawValue);
      if (target === undefined || /\s|[`$(){}|;&<>!#*?[\\]'"]/.test(target)) continue;
      if (conflicting.has(name)) continue;
      if (isAbsolute(target)) {
        setAliasTarget(targets, conflicting, name, target);
        continue;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(target)) continue;
      if (pathDirs.some((dir) => isAbsolute(join(dir, target)))) {
        setAliasTarget(targets, conflicting, name, target);
      }
    }
  }
  return targets;
}

function aliasFilesForShell(shell: string | undefined): ReadonlyArray<string> {
  const shellName = shell?.split("/").pop();
  if (shellName === "bash") {
    return ALIAS_FILES.filter((file) => file.startsWith(".bash"));
  }
  if (shellName === "zsh") {
    return ALIAS_FILES.filter((file) => file.startsWith(".z"));
  }
  return ALIAS_FILES;
}

function setAliasTarget(
  targets: Map<string, string>,
  conflicting: Set<string>,
  name: string,
  target: string,
): void {
  const previous = targets.get(name);
  if (previous !== undefined && previous !== target) {
    targets.delete(name);
    conflicting.add(name);
    return;
  }
  targets.set(name, target);
}

function unwrapAliasValue(value: string): string | undefined {
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    const quote = value[0];
    const unwrapped = value.slice(1, -1);
    if (quote === undefined || unwrapped.includes(quote)) return undefined;
    return unwrapped;
  }
  if (value.includes("'") || value.includes('"')) return undefined;
  return value;
}

/**
 * Validates an executable discovered only through sanitized PATH or approved
 * search directories. Symlink targets may resolve outside those directories
 * (Homebrew Cellar, nix store); we still require an absolute real file with
 * execute permission and never follow relative or broken links.
 *
 * Both spellings matter: the probe runs the canonical path, while instances
 * store the user-facing one (`/opt/homebrew/bin/codex`), so callers need the
 * discovered path to match a configured instance.
 */
async function validateExecutable(
  candidatePath: string,
  fs: DiscoveryFsPort,
): Promise<{ readonly discoveredPath: string; readonly canonicalPath: string } | undefined> {
  if (!isAbsolute(candidatePath)) return undefined;

  try {
    // Check existence and execute permission on the discovered path.
    await fs.access(candidatePath, constants.X_OK);
  } catch {
    return undefined;
  }

  try {
    const stat = await fs.lstat(candidatePath);
    if (stat.isSymbolicLink()) {
      const resolved = await fs.realpath(candidatePath);
      if (!isAbsolute(resolved)) return undefined;
      await fs.access(resolved, constants.X_OK);
      const targetStat = await fs.lstat(resolved);
      if (!targetStat.isFile()) return undefined;
      return { discoveredPath: candidatePath, canonicalPath: resolved };
    }
    if (!stat.isFile()) return undefined;
    return { discoveredPath: candidatePath, canonicalPath: candidatePath };
  } catch {
    return undefined;
  }
}

/** Extracts a version string from probe output (first line, trimmed). */
function extractVersion(stdout: string): string | undefined {
  const firstLine = stdout.split(/\r?\n/)[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) return undefined;
  // Cap at 128 chars
  return firstLine.slice(0, 128);
}

/** Creates a safe display summary of a path (no environment variable values). */
function summarizePath(absolutePath: string, home?: string): string {
  if (home === undefined) return absolutePath;
  if (home !== undefined && absolutePath.startsWith(home + "/")) {
    return "~/" + absolutePath.slice(home.length + 1);
  }
  return absolutePath;
}

/** Sanitizes PATH into individual directories, rejecting unsafe entries. */
function sanitizedPathDirs(pathValue: string): string[] {
  return pathValue
    .split(delimiter)
    .filter((dir) => {
      if (dir.length === 0) return false;
      if (!isAbsolute(dir)) return false;
      // Reject paths with shell metacharacters
      if (/[`$(){}|;&<>!#*?[\]'"]/g.test(dir)) return false;
      return true;
    })
    .map((dir) => resolve(dir));
}

/**
 * Finder-launched macOS apps inherit a deliberately small PATH. Search only a
 * bounded allowlist beneath the validated user HOME so supported runtimes do
 * not disappear merely because the app was started from Finder.
 */
export function approvedHomeBinDirs(home: string | undefined): string[] {
  if (home === undefined || !isAbsolute(home)) return [];
  if (/[`$(){}|;&<>!#*?[\]'"]/g.test(home)) return [];
  const canonicalHome = resolve(home);
  if (canonicalHome === dirname(canonicalHome)) return [];
  return APPROVED_HOME_BIN_DIRECTORIES.map((relative) => join(canonicalHome, relative));
}

/** Builds the smallest inherited environment required by local CLI probes. */
function sanitizeProbeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of PROBE_ENVIRONMENT_KEYS) {
    const value = env[key];
    if (value !== undefined) sanitized[key] = value;
  }
  return sanitized;
}

// ── Default ports ───────────────────────────────────────────────────────────

const defaultExec: DiscoveryExecPort = (file, args, options) =>
  execVersionRead(file, args, {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: options.env ?? {},
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

/**
 * Byte-bounded UTF-8 read for alias discovery. `readFile(path, "utf8")` then a
 * string-length check allocated the whole home file (and counted UTF-16 units,
 * not bytes). `stat` size is not a bound because the file can grow between
 * stat and read; a FIFO or device at the same path can also block `open`.
 */
export async function readDiscoveryText(
  path: string,
  maxBytes: number,
): Promise<DiscoveryTextRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { kind: "unavailable" };
  const budget = Math.min(maxBytes, MAX_ALIAS_FILE_BYTES);
  const nonblock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // Follow a final symlink so a linked rc remains inspectable. O_NONBLOCK
    // plus isFile() on the opened descriptor refuse FIFOs and devices without
    // blocking a background scan.
    handle = await open(path, constants.O_RDONLY | nonblock);
  } catch {
    return { kind: "unavailable" };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { kind: "unavailable" };
    if (opened.size > budget) return { kind: "too-large" };

    const buffer = Buffer.alloc(budget + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, null));
      } catch {
        return { kind: "unavailable" };
      }
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > budget) return { kind: "too-large" };
    try {
      return {
        kind: "ok",
        content: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total)),
      };
    } catch {
      return { kind: "unavailable" };
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const defaultFs: DiscoveryFsPort = {
  access: (path, mode) => access(path, mode),
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  readFile: readDiscoveryText,
};

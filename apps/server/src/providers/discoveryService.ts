import { execFile } from "node:child_process";
import { access, constants, lstat, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { DiscoveryCandidate, DiscoverySnapshot, ProviderDriverKind } from "@octant/contracts";
import { admittedBundledProviderDriverKinds } from "@octant/plugin-host/provider-drivers";
import type { ProviderDiscoveryDescriptor } from "@octant/provider-sdk/discovery";
import { discoverableDescriptorsForAdmittedDrivers } from "@octant/provider-sdk/driver-plugins";

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
const MAX_ALIAS_FILE_BYTES = 64 * 1024;
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
    options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface DiscoveryFsPort {
  access(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean }>;
  realpath(path: string): Promise<string>;
  /** Read-only shell alias inspection; implementations must not source files. */
  readonly readFile?: (path: string) => Promise<string>;
}

export interface DiscoveryServiceOptions {
  readonly exec?: DiscoveryExecPort;
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
}

export function makeDiscoveryService(options: DiscoveryServiceOptions = {}): DiscoveryService {
  const exec = options.exec ?? defaultExec;
  const fs = options.fs ?? defaultFs;
  const now = options.now ?? Date.now;
  const hostId = options.hostId ?? "local";
  const environment = options.environment ?? process.env;
  const admittedDriverKinds = options.admittedDriverKinds ?? admittedBundledProviderDriverKinds();

  let lastScanCandidates: DiscoveryCandidate[] = [];

  return {
    getLastScanCandidates() {
      return lastScanCandidates;
    },
    async scan(signal?: AbortSignal): Promise<DiscoverySnapshot> {
      const startTime = now();
      const descriptors = discoverableDescriptorsForAdmittedDrivers(admittedDriverKinds);
      const candidates: DiscoveryCandidate[] = [];
      let status: DiscoverySnapshot["status"] = "completed";
      let message: string | undefined;

      // Collect all search directories: sanitized PATH + approved locations
      const pathDirs = [
        ...new Set([
          ...sanitizedPathDirs(environment.PATH ?? ""),
          ...approvedHomeBinDirs(environment.HOME),
        ]),
      ];
      const aliasTargets = await readAliasTargets(fs, environment.HOME, pathDirs);

      for (const descriptor of descriptors) {
        if (signal?.aborted) {
          status = "cancelled";
          message = "Discovery scan was cancelled.";
          break;
        }
        if (now() - startTime > MAX_SCAN_DURATION_MS) {
          status = "partial";
          message = "Discovery scan exceeded its time budget.";
          break;
        }

        try {
          const found = await scanDescriptor(
            descriptor,
            pathDirs,
            aliasTargets,
            exec,
            fs,
            environment,
            now,
            startTime,
            signal,
          );
          candidates.push(...found.slice(0, MAX_CANDIDATES_PER_DRIVER));
        } catch {
          if (status === "completed") status = "partial";
        }

        if (candidates.length >= MAX_TOTAL_CANDIDATES) break;
      }

      // Deduplicate by canonical path
      const seen = new Set<string>();
      const deduplicated = candidates.filter((candidate) => {
        if (seen.has(candidate.binaryPath)) return false;
        seen.add(candidate.binaryPath);
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
        ...(message !== undefined ? { message: message as DiscoverySnapshot["message"] } : {}),
      };
      return snapshot;
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
  signal?: AbortSignal,
): Promise<DiscoveryCandidate[]> {
  const candidates: DiscoveryCandidate[] = [];
  const seenPaths = new Set<string>();

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
    if (now() - startTime > MAX_SCAN_DURATION_MS) break;
    if (candidates.length >= MAX_CANDIDATES_PER_DRIVER) break;

    const execName = candidate.execName;
    const validated = await validateExecutable(candidatePath, fs);
    if (validated === undefined) continue;
    if (seenPaths.has(validated)) continue;
    seenPaths.add(validated);

    // Version probe
    let version: string | undefined;
    try {
      const { stdout } = await exec(validated, [...descriptor.versionProbeArgs], {
        timeout: MAX_PROBE_TIMEOUT_MS,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        env: sanitizeProbeEnvironment(environment),
      });
      version = extractVersion(stdout);
    } catch {
      // Version probe failed; continue without version
    }

    // Auth readiness probe
    let readiness: DiscoveryCandidate["readiness"] = "unknown";
    if (descriptor.authProbeArgs !== undefined) {
      try {
        await exec(validated, [...descriptor.authProbeArgs], {
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
      binaryPath: validated as DiscoveryCandidate["binaryPath"],
      ...(version !== undefined ? { version: version as DiscoveryCandidate["version"] } : {}),
      readiness,
      pathSummary: summarizePath(validated, environment.HOME) as DiscoveryCandidate["pathSummary"],
      onboardingGuidance: descriptor.onboardingGuidance as DiscoveryCandidate["onboardingGuidance"],
      detectedAt: new Date(now()).toISOString() as DiscoveryCandidate["detectedAt"],
    });
  }

  return candidates;
}

/**
 * Read shell alias declarations without evaluating startup files. Sourcing a
 * profile would execute arbitrary user commands during a background scan, so
 * only a strict, single-token alias grammar is accepted here.
 */
async function readAliasTargets(
  fs: DiscoveryFsPort,
  home: string | undefined,
  pathDirs: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> {
  const targets = new Map<string, string>();
  if (home === undefined || !isAbsolute(home) || fs.readFile === undefined) return targets;
  if (/[`$(){}|;&<>!#*?[\\]'\"]/.test(home)) return targets;

  for (const file of ALIAS_FILES) {
    let content: string;
    try {
      content = await fs.readFile(join(resolve(home), file));
    } catch {
      continue;
    }
    if (content.length > MAX_ALIAS_FILE_BYTES) continue;
    for (const line of content.split(/\r?\n/, MAX_ALIAS_LINES + 1).slice(0, MAX_ALIAS_LINES)) {
      const match = /^\s*alias\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match === null) continue;
      const name = match[1];
      const rawValue = match[2];
      if (name === undefined || rawValue === undefined) continue;
      const target = unwrapAliasValue(rawValue);
      if (target === undefined || /\s|[`$(){}|;&<>!#*?[\\]'\"]/.test(target)) continue;
      if (isAbsolute(target)) {
        targets.set(name, target);
        continue;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(target)) continue;
      if (pathDirs.some((dir) => isAbsolute(join(dir, target)))) targets.set(name, target);
    }
  }
  return targets;
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
 * Validates that a path is a real executable file (not a broken symlink,
 * not a directory, not a symlink pointing outside approved locations).
 * Returns the canonical (realpath) path or undefined if invalid.
 */
/**
 * Validates an executable discovered only through sanitized PATH or approved
 * search directories. Symlink targets may resolve outside those directories
 * (Homebrew Cellar, nix store); we still require an absolute real file with
 * execute permission and never follow relative or broken links.
 */
async function validateExecutable(
  candidatePath: string,
  fs: DiscoveryFsPort,
): Promise<string | undefined> {
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
      return resolved;
    }
    if (!stat.isFile()) return undefined;
    return candidatePath;
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

function defaultExec(
  file: string,
  args: ReadonlyArray<string>,
  options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        env: options.env,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error !== null) rejectPromise(error);
        else resolvePromise({ stdout, stderr });
      },
    );
  });
}

const defaultFs: DiscoveryFsPort = {
  access: (path, mode) => access(path, mode),
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  readFile: async (path) => readFile(path, "utf8"),
};

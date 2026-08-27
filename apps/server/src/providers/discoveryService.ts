import { execFile } from "node:child_process";
import { access, constants, lstat, realpath } from "node:fs/promises";
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
  exec: DiscoveryExecPort,
  fs: DiscoveryFsPort,
  environment: NodeJS.ProcessEnv,
  now: () => number,
  startTime: number,
  signal?: AbortSignal,
): Promise<DiscoveryCandidate[]> {
  const candidates: DiscoveryCandidate[] = [];
  const seenPaths = new Set<string>();

  // Search PATH directories + approved locations
  const searchDirs = [...pathDirs, ...descriptor.approvedLocations];

  for (const dir of searchDirs) {
    if (signal?.aborted) break;
    if (now() - startTime > MAX_SCAN_DURATION_MS) break;
    if (candidates.length >= MAX_CANDIDATES_PER_DRIVER) break;

    for (const execName of descriptor.executableNames) {
      const candidatePath = join(dir, execName);
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
        displayName: descriptor.displayName as DiscoveryCandidate["displayName"],
        binaryPath: validated as DiscoveryCandidate["binaryPath"],
        ...(version !== undefined ? { version: version as DiscoveryCandidate["version"] } : {}),
        readiness,
        pathSummary: summarizePath(
          validated,
          environment.HOME,
        ) as DiscoveryCandidate["pathSummary"],
        onboardingGuidance:
          descriptor.onboardingGuidance as DiscoveryCandidate["onboardingGuidance"],
        detectedAt: new Date(now()).toISOString() as DiscoveryCandidate["detectedAt"],
      });
    }
  }

  return candidates;
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
function approvedHomeBinDirs(home: string | undefined): string[] {
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
};

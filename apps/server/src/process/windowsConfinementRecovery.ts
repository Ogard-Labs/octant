/**
 * Durable pre-ACL ownership records and serialized idempotent recovery sweep
 * for Windows Strict confined launches.
 *
 * Before `octant-windows-confine.exe` spawns and mutates any NTFS DACL or
 * creates an AppContainer profile, the host records the launch's container
 * name, grant paths and launcher path inside private host storage (outside all
 * container grants, so the confined runtime can neither read nor write it).
 * Normal exit, Stop (which may terminate the launcher outright), and server
 * startup/restart all serialize through this store to prove launcher exit and
 * run `octant-windows-confine.exe --recover` before deleting the record. Any
 * record whose termination or restoration cannot be proved stays on disk as
 * cleanup-pending and blocks affected re-admissions.
 */
import { execFile } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isSameOrInside, windowsGuardPath } from "@octant/domain/secret-guard-policy";
import {
  windowsConfinedRecoveryArguments,
  windowsNativePath,
} from "@octant/domain/windows-confinement-policy";
import { readWindowsProcessIdentity } from "./nodeOwnedProcessReceipt";
import { stopWindowsProcessTree, type WindowsProcessTreeStop } from "./windowsProcessTree";

export interface WindowsConfinementLeaseRecord {
  readonly schemaVersion: 1;
  readonly launchId: string;
  readonly appContainerName: string;
  readonly grants: ReadonlyArray<string>;
  readonly launcherPath: string;
  readonly createdAt: string;
  readonly launcherPid?: number;
  /** Native process creation identity (pid + start time hash) proving PID ownership. */
  readonly launcherIdentity?: string;
}

export type WindowsConfinementPreAclResult =
  | { readonly status: "recorded" }
  | { readonly status: "refused"; readonly message: string };

export type WindowsConfinementLeaseCleanupResult =
  | { readonly status: "clean" }
  | { readonly status: "cleanup-pending"; readonly message: string };

export type WindowsConfinementRecoverySummary =
  | { readonly status: "clean"; readonly recoveredCount: number }
  | {
      readonly status: "cleanup-pending";
      readonly recoveredCount: number;
      readonly pendingCount: number;
      readonly pendingPaths: ReadonlyArray<string>;
      readonly message: string;
    };

export interface WindowsConfinementLeaseStoreOptions {
  readonly leaseDirectory: string;
  readonly runRecovery?: (launcherPath: string, args: ReadonlyArray<string>) => Promise<boolean>;
  readonly stopProcessTree?: (pid: number) => Promise<WindowsProcessTreeStop>;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly readProcessIdentity?: (pid: number) => Promise<string | undefined>;
  readonly clock?: () => string;
}

const LAUNCH_ID_PATTERN = /^[0-9a-f]{32}$/u;
const CONTAINER_NAME_PATTERN = /^Octant\.Confined\.[0-9a-f]{32}$/u;
const RECOVERY_TIMEOUT_MS = 30_000;

export const WINDOWS_CLEANUP_PENDING_MESSAGE =
  "Windows sandbox cleanup is pending from an earlier interrupted run. Restart Octant or retry recovery before starting another confined launch.";

function defaultRunRecovery(launcherPath: string, args: ReadonlyArray<string>): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        launcherPath,
        [...args],
        {
          timeout: RECOVERY_TIMEOUT_MS,
          windowsHide: true,
        },
        (error) => {
          resolve(error === null);
        },
      );
    } catch {
      resolve(false);
    }
  });
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code === "EPERM";
  }
}

function parseLeaseRecord(raw: string): WindowsConfinementLeaseRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Readonly<Record<string, unknown>>;
  if (candidate.schemaVersion !== 1) return undefined;
  if (typeof candidate.launchId !== "string" || !LAUNCH_ID_PATTERN.test(candidate.launchId)) {
    return undefined;
  }
  if (
    typeof candidate.appContainerName !== "string" ||
    !CONTAINER_NAME_PATTERN.test(candidate.appContainerName)
  ) {
    return undefined;
  }
  if (
    typeof candidate.launcherPath !== "string" ||
    windowsNativePath(candidate.launcherPath) === undefined ||
    !/\\octant-windows-confine\.exe$/iu.test(candidate.launcherPath)
  ) {
    return undefined;
  }
  if (typeof candidate.createdAt !== "string" || candidate.createdAt.length === 0) {
    return undefined;
  }
  if (!Array.isArray(candidate.grants)) return undefined;
  const grants: string[] = [];
  for (const grant of candidate.grants) {
    if (typeof grant !== "string" || windowsNativePath(grant) === undefined) return undefined;
    grants.push(grant);
  }
  let launcherPid: number | undefined;
  if (candidate.launcherPid !== undefined) {
    if (
      typeof candidate.launcherPid !== "number" ||
      !Number.isSafeInteger(candidate.launcherPid) ||
      candidate.launcherPid < 1
    ) {
      return undefined;
    }
    launcherPid = candidate.launcherPid;
  }
  let launcherIdentity: string | undefined;
  if (candidate.launcherIdentity !== undefined) {
    if (typeof candidate.launcherIdentity !== "string" || candidate.launcherIdentity.length === 0) {
      return undefined;
    }
    launcherIdentity = candidate.launcherIdentity;
  }
  return {
    schemaVersion: 1,
    launchId: candidate.launchId,
    appContainerName: candidate.appContainerName,
    grants,
    launcherPath: candidate.launcherPath,
    createdAt: candidate.createdAt,
    ...(launcherPid === undefined ? {} : { launcherPid }),
    ...(launcherIdentity === undefined ? {} : { launcherIdentity }),
  };
}

function writeAtomicJson(filePath: string, value: WindowsConfinementLeaseRecord): void {
  const tempPath = `${filePath}.${String(process.pid)}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tempPath, filePath);
}

function pathsOverlap(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const leftForms = left
    .map((path) => windowsGuardPath(path))
    .filter((form): form is string => form !== undefined);
  const rightForms = right
    .map((path) => windowsGuardPath(path))
    .filter((form): form is string => form !== undefined);
  for (const a of leftForms) {
    for (const b of rightForms) {
      if (isSameOrInside(a, b) || isSameOrInside(b, a)) return true;
    }
  }
  return false;
}

interface PendingBlocker {
  readonly fileName: string;
  readonly global: boolean;
  readonly grants: ReadonlyArray<string>;
}

export class WindowsConfinementLeaseStore {
  readonly #leaseDirectory: string;
  readonly #runRecovery: (launcherPath: string, args: ReadonlyArray<string>) => Promise<boolean>;
  readonly #stopProcessTree: (pid: number) => Promise<WindowsProcessTreeStop>;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #readProcessIdentity: (pid: number) => Promise<string | undefined>;
  readonly #clock: () => string;
  readonly #activeLeases = new Set<string>();
  readonly #pendingBlockers = new Map<string, PendingBlocker>();
  readonly #pendingIdentityReads = new Map<string, Promise<void>>();
  #queue: Promise<void> = Promise.resolve();

  constructor(options: WindowsConfinementLeaseStoreOptions) {
    this.#leaseDirectory = options.leaseDirectory;
    this.#runRecovery = options.runRecovery ?? defaultRunRecovery;
    this.#stopProcessTree = options.stopProcessTree ?? stopWindowsProcessTree;
    this.#isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.#readProcessIdentity =
      options.readProcessIdentity ?? ((pid) => readWindowsProcessIdentity(pid));
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  get leaseDirectory(): string {
    return this.#leaseDirectory;
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #leaseFilePath(launchId: string): string {
    return join(this.#leaseDirectory, `${launchId}.json`);
  }

  /**
   * Returns a refusal message if an unrecovered/cleanup-pending lease overlaps
   * any of `grants` (or if a malformed lease blocks all launches globally).
   */
  pendingBlockerFor(grants: ReadonlyArray<string>): string | undefined {
    for (const blocker of this.#pendingBlockers.values()) {
      if (blocker.global || pathsOverlap(blocker.grants, grants)) {
        return WINDOWS_CLEANUP_PENDING_MESSAGE;
      }
    }
    // Also inspect disk for leftover files from a prior process if startup
    // recovery has not cleared them yet (ignoring leases owned by live runs).
    let entries: ReadonlyArray<string>;
    try {
      entries = readdirSync(this.#leaseDirectory);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const launchId = entry.slice(0, -".json".length);
      if (this.#activeLeases.has(launchId)) continue;
      let raw: string;
      try {
        raw = readFileSync(join(this.#leaseDirectory, entry), "utf8");
      } catch {
        return WINDOWS_CLEANUP_PENDING_MESSAGE;
      }
      const record = parseLeaseRecord(raw);
      if (record === undefined || pathsOverlap(record.grants, grants)) {
        return WINDOWS_CLEANUP_PENDING_MESSAGE;
      }
    }
    return undefined;
  }

  /**
   * Persists the durable pre-ACL ownership record before the native launcher
   * spawns or touches any ACL. Refuses if cleanup is pending for an overlapping
   * grant or if the record cannot be written durably.
   */
  recordPreAcl(input: {
    readonly launchId: string;
    readonly appContainerName: string;
    readonly grants: ReadonlyArray<string>;
    readonly launcherPath: string;
  }): WindowsConfinementPreAclResult {
    const blocker = this.pendingBlockerFor(input.grants);
    if (blocker !== undefined) return { status: "refused", message: blocker };
    const record: WindowsConfinementLeaseRecord = {
      schemaVersion: 1,
      launchId: input.launchId,
      appContainerName: input.appContainerName,
      grants: [...input.grants],
      launcherPath: input.launcherPath,
      createdAt: this.#clock(),
    };
    try {
      mkdirSync(this.#leaseDirectory, { recursive: true, mode: 0o700 });
      writeAtomicJson(this.#leaseFilePath(input.launchId), record);
      this.#activeLeases.add(input.launchId);
      return { status: "recorded" };
    } catch {
      return {
        status: "refused",
        message: "Windows sandbox ownership record could not be saved before launch.",
      };
    }
  }

  /**
   * Updates an active lease record with the spawned launcher PID and captures
   * its native creation identity (PID + start time) so recovery can verify PID
   * ownership before ever terminating a recovered PID.
   */
  recordLauncherPid(launchId: string, pid: number): void {
    if (!Number.isSafeInteger(pid) || pid < 1) return;
    const filePath = this.#leaseFilePath(launchId);
    try {
      const existing = parseLeaseRecord(readFileSync(filePath, "utf8"));
      if (existing === undefined) return;
      writeAtomicJson(filePath, { ...existing, launcherPid: pid });
    } catch {
      // The pre-ACL record already holds container and grant paths for recovery.
      return;
    }
    const capture = this.#readProcessIdentity(pid)
      .then((identity) => {
        if (identity === undefined || identity.length === 0) return;
        if (!this.#activeLeases.has(launchId)) return;
        try {
          const current = parseLeaseRecord(readFileSync(filePath, "utf8"));
          if (current === undefined || current.launcherPid !== pid) return;
          writeAtomicJson(filePath, { ...current, launcherIdentity: identity });
        } catch {
          // Lease was already recovered or removed.
        }
      })
      .catch(() => undefined);
    this.#pendingIdentityReads.set(launchId, capture);
  }

  /**
   * Serialized post-exit verification and cleanup for one launch. Proves the
   * launcher is dead, runs idempotent `--recover` to strip only this SID's
   * explicit ACEs and delete the AppContainer profile, and deletes the durable
   * record only once restoration is verified.
   */
  releaseAndVerify(launchId: string): Promise<WindowsConfinementLeaseCleanupResult> {
    return this.#enqueue(async () => {
      const pendingIdentity = this.#pendingIdentityReads.get(launchId);
      if (pendingIdentity !== undefined) {
        this.#pendingIdentityReads.delete(launchId);
        await pendingIdentity;
      }
      const fileName = `${launchId}.json`;
      const filePath = join(this.#leaseDirectory, fileName);
      const outcome = await this.#recoverFile(fileName, filePath);
      this.#activeLeases.delete(launchId);
      if (outcome.status === "clean") {
        this.#pendingBlockers.delete(fileName);
        return { status: "clean" };
      }
      this.#pendingBlockers.set(fileName, {
        fileName,
        global: outcome.global,
        grants: outcome.grants,
      });
      return { status: "cleanup-pending", message: WINDOWS_CLEANUP_PENDING_MESSAGE };
    });
  }

  /**
   * Startup/restart recovery sweep: recovers every leftover lease record on
   * disk before affected launches are admitted. Idempotent and bounded.
   */
  recoverAll(): Promise<WindowsConfinementRecoverySummary> {
    return this.#enqueue(async () => {
      let entries: ReadonlyArray<string>;
      try {
        entries = readdirSync(this.#leaseDirectory);
      } catch {
        this.#pendingBlockers.clear();
        return { status: "clean", recoveredCount: 0 };
      }
      let recoveredCount = 0;
      let pendingCount = 0;
      const pendingPaths = new Set<string>();
      for (const entry of entries) {
        if (!entry.endsWith(".json")) {
          if (entry.endsWith(".tmp")) {
            rmSync(join(this.#leaseDirectory, entry), { force: true });
          }
          continue;
        }
        const launchId = entry.slice(0, -".json".length);
        if (this.#activeLeases.has(launchId)) continue;
        const filePath = join(this.#leaseDirectory, entry);
        const outcome = await this.#recoverFile(entry, filePath);
        if (outcome.status === "clean") {
          this.#pendingBlockers.delete(entry);
          recoveredCount += 1;
        } else {
          pendingCount += 1;
          for (const grant of outcome.grants) pendingPaths.add(grant);
          this.#pendingBlockers.set(entry, {
            fileName: entry,
            global: outcome.global,
            grants: outcome.grants,
          });
        }
      }
      if (pendingCount === 0) {
        return { status: "clean", recoveredCount };
      }
      return {
        status: "cleanup-pending",
        recoveredCount,
        pendingCount,
        pendingPaths: [...pendingPaths],
        message: WINDOWS_CLEANUP_PENDING_MESSAGE,
      };
    });
  }

  async #recoverFile(
    _fileName: string,
    filePath: string,
  ): Promise<
    | { readonly status: "clean" }
    | {
        readonly status: "pending";
        readonly global: boolean;
        readonly grants: ReadonlyArray<string>;
      }
  > {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return { status: "clean" };
      return { status: "pending", global: true, grants: [] };
    }
    const record = parseLeaseRecord(raw);
    if (record === undefined) {
      return { status: "pending", global: true, grants: [] };
    }
    if (record.launcherPid !== undefined) {
      if (record.launcherIdentity === undefined) {
        // Without a captured creation identity we cannot prove a live PID is
        // still our launcher rather than a reused PID: never terminate it
        // blindly, and keep cleanup pending while the PID is alive.
        if (this.#isProcessAlive(record.launcherPid)) {
          return { status: "pending", global: false, grants: record.grants };
        }
      } else {
        let liveIdentity: string | undefined;
        try {
          liveIdentity = await this.#readProcessIdentity(record.launcherPid);
        } catch {
          // Could not prove whether a live process is our launcher; fail closed
          // without terminating an unverified PID.
          return { status: "pending", global: false, grants: record.grants };
        }
        // Only terminate when the live PID matches the exact recorded creation
        // identity. Undefined (gone) or a different identity (reused PID) proves
        // our launcher already exited.
        if (liveIdentity === record.launcherIdentity) {
          const stopped = await this.#stopProcessTree(record.launcherPid).catch(
            () => "failed" as const,
          );
          if (stopped === "failed") {
            return { status: "pending", global: false, grants: record.grants };
          }
          let afterIdentity: string | undefined;
          try {
            afterIdentity = await this.#readProcessIdentity(record.launcherPid);
          } catch {
            return { status: "pending", global: false, grants: record.grants };
          }
          if (afterIdentity === record.launcherIdentity) {
            return { status: "pending", global: false, grants: record.grants };
          }
        }
      }
    }
    const recoveryArgs = windowsConfinedRecoveryArguments({
      appContainerName: record.appContainerName,
      grants: record.grants,
    });
    if (recoveryArgs === undefined) {
      return { status: "pending", global: false, grants: record.grants };
    }
    const restored = await this.#runRecovery(record.launcherPath, recoveryArgs).catch(() => false);
    if (!restored) {
      return { status: "pending", global: false, grants: record.grants };
    }
    try {
      unlinkSync(filePath);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") {
        return { status: "pending", global: false, grants: record.grants };
      }
    }
    return { status: "clean" };
  }
}

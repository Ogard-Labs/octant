import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LOCAL_HOST_ID,
  decodeDiscoveredProviderFolderId,
  decodeImportProviderFoldersRequest,
  decodeImportProviderFoldersResult,
  decodeProjectId,
  decodeProviderFolderScanResult,
  type CodeProject,
  type DiscoveredFolderProvider,
  type DiscoveredProviderFolderId,
  type EventActor,
  type ImportProviderFoldersResult,
  type ImportedProviderFolderOutcome,
  type Project,
  type ProviderFolderScanResult,
  type ProviderFolderScanStopReason,
  type ProviderInstance,
  type UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import {
  groupDiscoveredProviderFolders,
  isExcludedProviderFolder,
  parseRemoteOwnerName,
  safeDiscoveredFolderName,
  type ObservedProviderFolder,
  type ParsedRemoteOwnerName,
} from "@octant/domain/provider-folder-scan-policy";
import {
  collectProviderProjectFolderDiscoveryPorts,
  type ProviderProjectFolderDiscoveryContext,
  type ProviderProjectFolderDiscoveryPort,
  type ProviderProjectFolderObservation,
} from "@octant/provider-sdk";
import type { BindingReceiptStorePort } from "./bindingReceiptStore";
import { commonOfLinkedWorktree } from "./code/hostWorktreeDiscovery";
import type { ProjectRootPort } from "./projectRootPort";
import type { ProjectServiceApi } from "./projectService";

export interface ProviderFolderScanLimits {
  /** Maximum session files or database rows inspected across all providers. */
  readonly maxFiles: number;
  /** Maximum distinct candidate folders inspected and kept. */
  readonly maxEntries: number;
  /** Maximum wall-clock time for a scan, in milliseconds. */
  readonly maxTimeMs: number;
}

export const DEFAULT_PROVIDER_FOLDER_SCAN_LIMITS: ProviderFolderScanLimits = {
  maxFiles: 2_000,
  maxEntries: 200,
  maxTimeMs: 5_000,
};

const CANDIDATE_TTL_MS = 10 * 60_000;
const GIT_FILE_MAX_BYTES = 64 * 1024;
const GIT_CONFIG_MAX_BYTES = 256 * 1024;
const MAX_GIT_ANCESTOR_DEPTH = 20;
const STRICT_IMPORT_REFUSAL_MESSAGE =
  "Importing discovered provider folders is unavailable while Strict is on.";

export interface ProviderFolderScanApi {
  readonly scan: (windowId: WindowId, signal?: AbortSignal) => Promise<ProviderFolderScanResult>;
  readonly importFolders: (
    windowId: WindowId,
    input: unknown,
    actor?: EventActor,
  ) => Promise<ImportProviderFoldersResult>;
}

export interface ProviderFolderScanServiceOptions {
  readonly homeDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Provider-neutral folder discovery ports (built-in adapters and any
   * plugin-contributed ports). May be passed as a static list or a getter.
   */
  readonly discoveryPorts:
    | ReadonlyArray<ProviderProjectFolderDiscoveryPort>
    | (() => ReadonlyArray<ProviderProjectFolderDiscoveryPort>);
  readonly readProviderInstances: () =>
    | ReadonlyArray<ProviderInstance>
    | Promise<ReadonlyArray<ProviderInstance>>;
  readonly readActiveCodeProjects: () => ReadonlyArray<Project>;
  readonly isHostStrict: () => boolean;
  /** Whether Code currently requires a Git repository; defaults to true. */
  readonly requireGitRepository?: () => boolean;
  readonly bindingReceiptStore: Pick<BindingReceiptStorePort, "issue">;
  readonly projectRootPort: Pick<ProjectRootPort, "validate">;
  readonly projectService: Pick<ProjectServiceApi, "executeProject">;
  readonly uuid?: () => string;
  readonly clock?: () => string;
  readonly now?: () => number;
  readonly limits?: Partial<ProviderFolderScanLimits>;
}

interface StoredCandidate {
  readonly id: DiscoveredProviderFolderId;
  readonly windowId: WindowId;
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly folderName: string;
  readonly isGitRepository: boolean;
  readonly expiresAt: number;
}

interface RawFolderActivity {
  readonly providers: Set<DiscoveredFolderProvider>;
  readonly sessionKeys: Set<string>;
  lastActivityMs: number;
}

interface ScanBudget {
  readonly limits: ProviderFolderScanLimits;
  readonly startedAtMs: number;
  readonly now: () => number;
  filesScanned: number;
  entriesCounted: number;
  stoppedReason: ProviderFolderScanStopReason | undefined;
}

/**
 * Host-owned read-only discovery and import of folders the person already used
 * with providers during first run.
 *
 * Provider-specific storage layouts and session parsing stay behind the
 * provider-neutral `ProviderProjectFolderDiscoveryPort` SDK seam. This service
 * owns scan budgets, Strict gating, cancellation, path canonicalization,
 * symlink/worktree/Downloads exclusions, Git remote parsing, opaque IDs, and
 * receipt-backed Code Project creation.
 */
export class ProviderFolderScanService implements ProviderFolderScanApi {
  readonly #homeDirectory: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #discoveryPorts:
    | ReadonlyArray<ProviderProjectFolderDiscoveryPort>
    | (() => ReadonlyArray<ProviderProjectFolderDiscoveryPort>);
  readonly #readProviderInstances: () =>
    | ReadonlyArray<ProviderInstance>
    | Promise<ReadonlyArray<ProviderInstance>>;
  readonly #readActiveCodeProjects: () => ReadonlyArray<Project>;
  readonly #isHostStrict: () => boolean;
  readonly #requireGitRepository: () => boolean;
  readonly #bindingReceiptStore: Pick<BindingReceiptStorePort, "issue">;
  readonly #projectRootPort: Pick<ProjectRootPort, "validate">;
  readonly #projectService: Pick<ProjectServiceApi, "executeProject">;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #now: () => number;
  readonly #limits: ProviderFolderScanLimits;
  readonly #candidates = new Map<string, StoredCandidate>();
  readonly #windowScanStates = new Map<string, { generation: number; activeScans: number }>();

  constructor(options: ProviderFolderScanServiceOptions) {
    this.#homeDirectory = options.homeDirectory;
    this.#env = options.env ?? process.env;
    this.#discoveryPorts = options.discoveryPorts;
    this.#readProviderInstances = options.readProviderInstances;
    this.#readActiveCodeProjects = options.readActiveCodeProjects;
    this.#isHostStrict = options.isHostStrict;
    this.#requireGitRepository = options.requireGitRepository ?? (() => true);
    this.#bindingReceiptStore = options.bindingReceiptStore;
    this.#projectRootPort = options.projectRootPort;
    this.#projectService = options.projectService;
    this.#uuid = options.uuid ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#now = options.now ?? Date.now;
    this.#limits = {
      maxFiles: options.limits?.maxFiles ?? DEFAULT_PROVIDER_FOLDER_SCAN_LIMITS.maxFiles,
      maxEntries: options.limits?.maxEntries ?? DEFAULT_PROVIDER_FOLDER_SCAN_LIMITS.maxEntries,
      maxTimeMs: options.limits?.maxTimeMs ?? DEFAULT_PROVIDER_FOLDER_SCAN_LIMITS.maxTimeMs,
    };
  }

  async scan(windowId: WindowId, signal?: AbortSignal): Promise<ProviderFolderScanResult> {
    const windowKey = String(windowId);
    const hiddenIfStrict = (): ProviderFolderScanResult | undefined => {
      if (!this.#isHostStrict()) return undefined;
      const activeState = this.#windowScanStates.get(windowKey);
      if (activeState !== undefined) activeState.generation += 1;
      this.#clearWindowCandidates(windowId);
      return decodeProviderFolderScanResult({ status: "hidden", reason: "strict" });
    };

    const initialStrict = hiddenIfStrict();
    if (initialStrict !== undefined) return initialStrict;

    const emptyResult = (): ProviderFolderScanResult =>
      decodeProviderFolderScanResult({
        status: "ready",
        groups: [],
        requireGitRepository: this.#requireGitRepository(),
        stoppedEarly: false,
        scannedAt: this.#clock(),
      });

    // An already-aborted request must not supersede an active scan or wipe its listing.
    if (signal?.aborted === true) return emptyResult();

    const existingState = this.#windowScanStates.get(windowKey);
    const windowState =
      existingState ??
      (() => {
        const created = { generation: 0, activeScans: 0 };
        this.#windowScanStates.set(windowKey, created);
        return created;
      })();
    windowState.generation += 1;
    windowState.activeScans += 1;
    const generation = windowState.generation;
    const isSuperseded = (): boolean =>
      windowState.generation !== generation || signal?.aborted === true;
    const shouldStopDiscovery = (): boolean => this.#isHostStrict() || isSuperseded();
    const emptyIfSuperseded = (): ProviderFolderScanResult | undefined =>
      isSuperseded() ? emptyResult() : undefined;

    try {
      this.#purgeExpired();
      const canonicalHome = await realpath(this.#homeDirectory).catch(() =>
        resolve(this.#homeDirectory),
      );
      const budget: ScanBudget = {
        limits: this.#limits,
        startedAtMs: this.#now(),
        now: this.#now,
        filesScanned: 0,
        entriesCounted: 0,
        stoppedReason: undefined,
      };

      const rawByCwd = new Map<string, RawFolderActivity>();
      const recordSession = (
        cwd: string,
        provider: DiscoveredFolderProvider,
        sessionKey: string,
        activityMs: number,
      ): boolean => {
        if (shouldStopDiscovery()) return false;
        if (!isAbsolute(cwd) || sessionKey.trim() === "") return true;
        const safeActivityMs = Number.isFinite(activityMs) && activityMs > 0 ? activityMs : 0;
        const existing = rawByCwd.get(cwd);
        if (existing !== undefined) {
          existing.providers.add(provider);
          existing.sessionKeys.add(`${provider}\0${sessionKey}`);
          if (safeActivityMs > existing.lastActivityMs) existing.lastActivityMs = safeActivityMs;
          return true;
        }
        if (rawByCwd.size >= budget.limits.maxEntries) {
          markStopped(budget, "entry-limit");
          return false;
        }
        rawByCwd.set(cwd, {
          providers: new Set([provider]),
          sessionKeys: new Set([`${provider}\0${sessionKey}`]),
          lastActivityMs: safeActivityMs,
        });
        budget.entriesCounted = rawByCwd.size;
        return true;
      };

      const providerInstances = await this.#readProviderInstances();
      const rawPorts =
        typeof this.#discoveryPorts === "function" ? this.#discoveryPorts() : this.#discoveryPorts;
      const ports = collectProviderProjectFolderDiscoveryPorts(rawPorts);

      for (const port of ports) {
        const strictNow = hiddenIfStrict();
        if (strictNow !== undefined) return strictNow;
        const supersededNow = emptyIfSuperseded();
        if (supersededNow !== undefined) return supersededNow;
        if (isDiscoveryStopped(budget)) break;

        const context: ProviderProjectFolderDiscoveryContext = {
          homeDirectory: canonicalHome,
          env: this.#env,
          providerInstances,
          isCancelled: () => shouldStopDiscovery() || isDiscoveryStopped(budget),
          remainingItemBudget: () =>
            shouldStopDiscovery() || isDiscoveryStopped(budget)
              ? 0
              : Math.max(0, budget.limits.maxFiles - budget.filesScanned),
          consumeItemBudget: () => !shouldStopDiscovery() && consumeFileBudget(budget),
          observe: (observation: ProviderProjectFolderObservation) =>
            recordSession(
              observation.workingDirectory,
              port.providerId,
              observation.sessionKey,
              observation.lastActivityMs,
            ),
        };

        try {
          const outcome = await port.discoverFolders(context);
          if (outcome.status === "stopped") {
            markStopped(budget, outcome.reason);
          }
        } catch {
          // A failing discovery adapter must not prevent other adapters or first run from completing.
        }
      }

      const strictBeforeInspect = hiddenIfStrict();
      if (strictBeforeInspect !== undefined) return strictBeforeInspect;
      const supersededBeforeInspect = emptyIfSuperseded();
      if (supersededBeforeInspect !== undefined) return supersededBeforeInspect;

      // Canonicalize every working directory already collected even when
      // discovery stopped at a file or entry cap, stopping here only if the
      // wall-clock deadline expires, the scan is superseded/aborted, or Strict turns on.
      const mergedByRoot = new Map<
        string,
        {
          readonly providers: Set<DiscoveredFolderProvider>;
          readonly sessionKeys: Set<string>;
          lastActivityMs: number;
          readonly device: number;
          readonly inode: number;
          readonly isGitRepository: boolean;
          readonly remote?: ParsedRemoteOwnerName;
        }
      >();

      for (const [cwd, activity] of rawByCwd) {
        const strictNow = hiddenIfStrict();
        if (strictNow !== undefined) return strictNow;
        const supersededNow = emptyIfSuperseded();
        if (supersededNow !== undefined) return supersededNow;
        if (isTimeExpired(budget)) {
          markStopped(budget, "time-limit");
          break;
        }
        const inspected = await inspectFolder(cwd, canonicalHome);
        if (inspected === undefined) continue;
        const existing = mergedByRoot.get(inspected.canonicalRoot);
        if (existing !== undefined) {
          for (const provider of activity.providers) existing.providers.add(provider);
          for (const key of activity.sessionKeys) existing.sessionKeys.add(key);
          if (activity.lastActivityMs > existing.lastActivityMs) {
            existing.lastActivityMs = activity.lastActivityMs;
          }
          continue;
        }
        if (mergedByRoot.size >= budget.limits.maxEntries) {
          markStopped(budget, "entry-limit");
          break;
        }
        mergedByRoot.set(inspected.canonicalRoot, {
          providers: new Set(activity.providers),
          sessionKeys: new Set(activity.sessionKeys),
          lastActivityMs: activity.lastActivityMs,
          device: inspected.device,
          inode: inspected.inode,
          isGitRepository: inspected.isGitRepository,
          ...(inspected.remote === undefined ? {} : { remote: inspected.remote }),
        });
      }

      // Recheck Strict and scan generation right before committing candidates so
      // an older or aborted scan can never clear a newer scan's visible IDs.
      const strictBeforeReturn = hiddenIfStrict();
      if (strictBeforeReturn !== undefined) return strictBeforeReturn;
      const supersededBeforeCommit = emptyIfSuperseded();
      if (supersededBeforeCommit !== undefined) return supersededBeforeCommit;

      const activeRoots = new Set(
        this.#activeCodeProjects().map((project) => project.binding.canonicalRoot),
      );

      this.#clearWindowCandidates(windowId);
      const expiresAt = this.#now() + CANDIDATE_TTL_MS;
      const observed: ObservedProviderFolder[] = [];

      for (const [canonicalRoot, entry] of mergedByRoot) {
        const folderName = safeDiscoveredFolderName(canonicalRoot);
        if (folderName === undefined) continue;
        const sessionCount = entry.sessionKeys.size;
        if (sessionCount < 1) continue;
        const id = decodeDiscoveredProviderFolderId(this.#uuid());
        this.#candidates.set(String(id), {
          id,
          windowId,
          canonicalPath: canonicalRoot,
          device: entry.device,
          inode: entry.inode,
          folderName,
          isGitRepository: entry.isGitRepository,
          expiresAt,
        });
        const lastActivityAt = toUtcTimestamp(entry.lastActivityMs, this.#clock);
        observed.push({
          id,
          folderName,
          ...(entry.remote === undefined
            ? {}
            : { repository: { slug: entry.remote.slug, groupKey: entry.remote.groupKey } }),
          providers: [...entry.providers],
          sessionCount,
          lastActivityAt,
          isGitRepository: entry.isGitRepository,
          alreadyImported: activeRoots.has(canonicalRoot),
        });
      }

      const groups = groupDiscoveredProviderFolders(observed);
      return decodeProviderFolderScanResult({
        status: "ready",
        groups,
        requireGitRepository: this.#requireGitRepository(),
        stoppedEarly: budget.stoppedReason !== undefined,
        ...(budget.stoppedReason === undefined ? {} : { stoppedEarlyReason: budget.stoppedReason }),
        scannedAt: this.#clock() as UtcTimestamp,
      });
    } finally {
      windowState.activeScans -= 1;
      if (windowState.activeScans <= 0 && this.#windowScanStates.get(windowKey) === windowState) {
        this.#windowScanStates.delete(windowKey);
      }
    }
  }

  async importFolders(
    windowId: WindowId,
    input: unknown,
    actor?: EventActor,
  ): Promise<ImportProviderFoldersResult> {
    if (this.#isHostStrict()) {
      this.#clearWindowCandidates(windowId);
      return decodeImportProviderFoldersResult({
        status: "refused",
        reason: "strict",
        message: STRICT_IMPORT_REFUSAL_MESSAGE,
      });
    }

    const request = decodeImportProviderFoldersRequest(input);
    this.#purgeExpired();
    const canonicalHome = await realpath(this.#homeDirectory).catch(() =>
      resolve(this.#homeDirectory),
    );
    const results: ImportedProviderFolderOutcome[] = [];

    for (let index = 0; index < request.folderIds.length; index += 1) {
      const folderId = request.folderIds[index];
      if (folderId === undefined) continue;
      if (this.#isHostStrict()) {
        this.#clearWindowCandidates(windowId);
        if (results.length === 0) {
          return decodeImportProviderFoldersResult({
            status: "refused",
            reason: "strict",
            message: STRICT_IMPORT_REFUSAL_MESSAGE,
          });
        }
        for (let remaining = index; remaining < request.folderIds.length; remaining += 1) {
          const pendingId = request.folderIds[remaining];
          if (pendingId === undefined) continue;
          results.push({
            folderId: pendingId,
            status: "refused",
            reason: "strict",
            message: STRICT_IMPORT_REFUSAL_MESSAGE,
          });
        }
        break;
      }

      const candidate = this.#candidates.get(String(folderId));
      if (
        candidate === undefined ||
        this.#now() >= candidate.expiresAt ||
        String(candidate.windowId) !== String(windowId)
      ) {
        results.push({
          folderId,
          status: "refused",
          reason: "not-found",
          message: "That folder is no longer listed. Scan again.",
        });
        continue;
      }

      // Verify the path has not been replaced with a symlink or swapped for
      // a different directory since the scan listed it.
      const unchanged = await verifyCandidateIdentity(candidate);
      if (!unchanged) {
        this.#candidates.delete(String(folderId));
        results.push({
          folderId,
          status: "refused",
          reason: "unavailable",
          message: "That folder changed since the scan. Scan again.",
        });
        continue;
      }

      let canonicalBinding;
      try {
        canonicalBinding = await this.#projectRootPort.validate("code", candidate.canonicalPath);
      } catch {
        this.#candidates.delete(String(folderId));
        results.push({
          folderId,
          status: "refused",
          reason: "unavailable",
          message: "That folder is no longer available.",
        });
        continue;
      }

      if (canonicalBinding.canonicalRoot !== candidate.canonicalPath) {
        this.#candidates.delete(String(folderId));
        results.push({
          folderId,
          status: "refused",
          reason: "unavailable",
          message: "That folder changed since the scan. Scan again.",
        });
        continue;
      }

      const gitContext = await inspectGitContext(canonicalBinding.canonicalRoot, canonicalHome);
      if (
        isExcludedProviderFolder(canonicalBinding.canonicalRoot, canonicalHome) ||
        gitContext.kind === "linked-worktree"
      ) {
        this.#candidates.delete(String(folderId));
        results.push({
          folderId,
          status: "refused",
          reason: "excluded",
          message: "That folder cannot be imported.",
        });
        continue;
      }

      if (this.#requireGitRepository() && gitContext.kind !== "git-repo") {
        results.push({
          folderId,
          status: "refused",
          reason: "requires-git",
          message:
            "This folder is not a Git repository. Use Choose a folder… to initialize Git, or allow non-Git folders in Settings › Code.",
        });
        continue;
      }

      // Recheck Strict after async validation right before issuing a receipt.
      if (this.#isHostStrict()) {
        this.#clearWindowCandidates(windowId);
        if (results.length === 0) {
          return decodeImportProviderFoldersResult({
            status: "refused",
            reason: "strict",
            message: STRICT_IMPORT_REFUSAL_MESSAGE,
          });
        }
        for (let remaining = index; remaining < request.folderIds.length; remaining += 1) {
          const pendingId = request.folderIds[remaining];
          if (pendingId === undefined) continue;
          results.push({
            folderId: pendingId,
            status: "refused",
            reason: "strict",
            message: STRICT_IMPORT_REFUSAL_MESSAGE,
          });
        }
        break;
      }

      const existing = this.#activeCodeProjects().find(
        (project) => project.binding.canonicalRoot === canonicalBinding.canonicalRoot,
      );
      if (existing !== undefined) {
        this.#candidates.delete(String(folderId));
        results.push({
          folderId,
          status: "already-imported",
          projectId: existing.id,
          name: existing.name,
        });
        continue;
      }

      const receipt = this.#bindingReceiptStore.issue({
        windowId,
        projectType: "code",
        canonicalBinding,
        now: this.#now(),
      });
      const projectId = decodeProjectId(this.#uuid());
      const created = await this.#projectService.executeProject(
        windowId,
        {
          kind: "create-code-project",
          projectId,
          expectedVersion: 0,
          name: candidate.folderName,
          receiptId: receipt.receiptId,
          hostId: LOCAL_HOST_ID,
        },
        actor,
      );
      this.#candidates.delete(String(folderId));
      if (created.kind === "code-project-created") {
        results.push({
          folderId,
          status: "created",
          projectId: created.project.id,
          name: created.project.name,
        });
      } else {
        results.push({
          folderId,
          status: "refused",
          reason: "unavailable",
          message: "That folder could not be imported as a Code Project.",
        });
      }
    }

    return decodeImportProviderFoldersResult({ status: "completed", results });
  }

  #activeCodeProjects(): ReadonlyArray<CodeProject> {
    return this.#readActiveCodeProjects().filter(
      (project): project is CodeProject =>
        project.type === "code" && project.lifecycle === "active",
    );
  }

  #clearWindowCandidates(windowId: WindowId): void {
    for (const [id, candidate] of this.#candidates) {
      if (String(candidate.windowId) === String(windowId)) this.#candidates.delete(id);
    }
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [id, candidate] of this.#candidates) {
      if (now >= candidate.expiresAt) this.#candidates.delete(id);
    }
  }
}

function isTimeExpired(budget: ScanBudget): boolean {
  return budget.now() - budget.startedAtMs >= budget.limits.maxTimeMs;
}

function isDiscoveryStopped(budget: ScanBudget): boolean {
  if (budget.stoppedReason !== undefined) return true;
  if (isTimeExpired(budget)) {
    markStopped(budget, "time-limit");
    return true;
  }
  return false;
}

function consumeFileBudget(budget: ScanBudget): boolean {
  if (isDiscoveryStopped(budget)) return false;
  if (budget.filesScanned >= budget.limits.maxFiles) {
    markStopped(budget, "file-limit");
    return false;
  }
  budget.filesScanned += 1;
  return true;
}

function markStopped(budget: ScanBudget, reason: ProviderFolderScanStopReason): void {
  budget.stoppedReason ??= reason;
}

async function verifyCandidateIdentity(candidate: StoredCandidate): Promise<boolean> {
  try {
    const linkInfo = await lstat(candidate.canonicalPath);
    if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) return false;
    const resolved = await realpath(candidate.canonicalPath);
    if (resolved !== candidate.canonicalPath) return false;
    const current = await stat(resolved);
    return (
      current.isDirectory() && current.dev === candidate.device && current.ino === candidate.inode
    );
  } catch {
    return false;
  }
}

async function inspectFolder(
  candidatePath: string,
  canonicalHome: string,
): Promise<
  | {
      readonly canonicalRoot: string;
      readonly device: number;
      readonly inode: number;
      readonly isGitRepository: boolean;
      readonly remote?: ParsedRemoteOwnerName;
    }
  | undefined
> {
  let canonicalPath: string;
  let info;
  try {
    canonicalPath = await realpath(candidatePath);
    info = await stat(canonicalPath);
    if (!info.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  if (isExcludedProviderFolder(canonicalPath, canonicalHome)) return undefined;

  const git = await inspectGitContext(canonicalPath, canonicalHome);
  if (git.kind === "linked-worktree") return undefined;
  if (git.kind === "git-repo") {
    if (isExcludedProviderFolder(git.repoRoot, canonicalHome)) return undefined;
    let rootStat = info;
    if (git.repoRoot !== canonicalPath) {
      try {
        rootStat = await stat(git.repoRoot);
        if (!rootStat.isDirectory()) return undefined;
      } catch {
        return undefined;
      }
    }
    const remote = await readGitRemoteOwnerName(git.gitConfigPath);
    return {
      canonicalRoot: git.repoRoot,
      device: rootStat.dev,
      inode: rootStat.ino,
      isGitRepository: true,
      ...(remote === undefined ? {} : { remote }),
    };
  }
  return {
    canonicalRoot: canonicalPath,
    device: info.dev,
    inode: info.ino,
    isGitRepository: false,
  };
}

async function inspectGitContext(
  canonicalPath: string,
  canonicalHome: string,
): Promise<
  | { readonly kind: "linked-worktree" }
  | { readonly kind: "git-repo"; readonly repoRoot: string; readonly gitConfigPath: string }
  | { readonly kind: "plain-folder" }
> {
  let cursor = canonicalPath;
  for (let depth = 0; depth < MAX_GIT_ANCESTOR_DEPTH; depth += 1) {
    if (cursor === canonicalHome || cursor === "/") break;
    const dotGit = join(cursor, ".git");
    let info;
    try {
      info = await lstat(dotGit);
    } catch {
      info = undefined;
    }
    if (info !== undefined) {
      if (info.isFile()) {
        const common = await commonOfLinkedWorktree(dotGit);
        if (common !== undefined) return { kind: "linked-worktree" };
        // Non-worktree `.git` file (such as an initialized Git submodule) binds
        // this checkout itself rather than walking up into the parent repo.
        const gitDir = await resolveGitDirPointer(dotGit);
        if (gitDir !== undefined) {
          return {
            kind: "git-repo",
            repoRoot: cursor,
            gitConfigPath: join(gitDir, "config"),
          };
        }
      } else if (info.isDirectory()) {
        return {
          kind: "git-repo",
          repoRoot: cursor,
          gitConfigPath: join(dotGit, "config"),
        };
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { kind: "plain-folder" };
}

/**
 * Resolves a non-worktree `.git` pointer file (`gitdir: <path>`) to its target
 * directory, returning undefined if malformed or missing.
 */
async function resolveGitDirPointer(dotGitPath: string): Promise<string | undefined> {
  const read = await readSmallFile(dotGitPath, GIT_FILE_MAX_BYTES);
  if (read === undefined) return undefined;
  const match = /^gitdir:\s*(.+)$/m.exec(read.text);
  const rawTarget = match?.[1]?.trim();
  if (rawTarget === undefined || rawTarget === "") return undefined;
  const resolved = isAbsolute(rawTarget)
    ? resolve(rawTarget)
    : resolve(dirname(dotGitPath), rawTarget);
  try {
    const canonical = await realpath(resolved);
    const info = await stat(canonical);
    return info.isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads `[remote "<name>"]` URLs from `.git/config` read-only and returns the
 * parsed `owner/name` for `origin`, or the single unambiguous remote when
 * `origin` is absent. Never returns a raw URL or credentials.
 */
async function readGitRemoteOwnerName(
  configPath: string,
): Promise<ParsedRemoteOwnerName | undefined> {
  const read = await readSmallFile(configPath, GIT_CONFIG_MAX_BYTES);
  if (read === undefined) return undefined;

  const remotes = new Map<string, string>();
  let currentRemote: string | undefined;
  for (const rawLine of read.text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const match = /^\[remote\s+"([^"]+)"\]$/i.exec(line);
      currentRemote = match?.[1];
      continue;
    }
    if (currentRemote === undefined || remotes.has(currentRemote)) continue;
    const urlMatch = /^url\s*=\s*(.+)$/i.exec(line);
    if (urlMatch?.[1] !== undefined) {
      remotes.set(currentRemote, urlMatch[1].trim());
    }
  }

  const originUrl = remotes.get("origin");
  if (originUrl !== undefined) return parseRemoteOwnerName(originUrl);

  const parsed: ParsedRemoteOwnerName[] = [];
  for (const url of remotes.values()) {
    const identity = parseRemoteOwnerName(url);
    if (identity !== undefined) parsed.push(identity);
  }
  const first = parsed[0];
  if (first === undefined) return undefined;
  return parsed.every((candidate) => candidate.groupKey === first.groupKey) ? first : undefined;
}

async function readSmallFile(
  path: string,
  maxBytes: number,
): Promise<{ readonly text: string; readonly mtimeMs: number } | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function toUtcTimestamp(ms: number, fallbackClock: () => string): UtcTimestamp {
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toISOString() as UtcTimestamp;
  }
  return fallbackClock() as UtcTimestamp;
}

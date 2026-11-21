import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
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
import type { BindingReceiptStorePort } from "./bindingReceiptStore";
import { commonOfLinkedWorktree } from "./code/hostWorktreeDiscovery";
import { openReadOnlySqlite } from "./persistence/sqlitePort";
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
const SESSION_HEAD_BYTES = 64 * 1024;
const GIT_FILE_MAX_BYTES = 64 * 1024;
const GIT_CONFIG_MAX_BYTES = 256 * 1024;
const OPENCODE_JSON_MAX_BYTES = 256 * 1024;
const MAX_GIT_ANCESTOR_DEPTH = 20;
const DATE_SEGMENT = /^\d{2,4}$/;
const CODEX_ROLLOUT_FILE = /^rollout-.+\.jsonl$/;
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
 * Host-side read-only discovery of folders the person already used with
 * Claude Code, Codex, OpenCode, and Pi during first run.
 *
 * Scanning reads session metadata only, never writes to another tool's files,
 * never leaves the machine, and sends only opaque IDs and safe display labels
 * (`owner/name` or single-segment folder name) to the renderer. Importing
 * ticked opaque IDs re-verifies each directory's canonical path and inode
 * before creating Code Projects through the existing Project create path and
 * its folder receipts. Under Strict, scanning is hidden and importing is
 * refused on the server, re-checked throughout async steps.
 */
export class ProviderFolderScanService implements ProviderFolderScanApi {
  readonly #homeDirectory: string;
  readonly #env: NodeJS.ProcessEnv;
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
  readonly #scanGenerationByWindow = new Map<string, number>();

  constructor(options: ProviderFolderScanServiceOptions) {
    this.#homeDirectory = options.homeDirectory;
    this.#env = options.env ?? process.env;
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
      this.#scanGenerationByWindow.set(
        windowKey,
        (this.#scanGenerationByWindow.get(windowKey) ?? 0) + 1,
      );
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

    const generation = (this.#scanGenerationByWindow.get(windowKey) ?? 0) + 1;
    this.#scanGenerationByWindow.set(windowKey, generation);
    const isSuperseded = (): boolean =>
      this.#scanGenerationByWindow.get(windowKey) !== generation || signal?.aborted === true;
    const emptyIfSuperseded = (): ProviderFolderScanResult | undefined =>
      isSuperseded() ? emptyResult() : undefined;

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
      if (this.#isHostStrict() || isSuperseded()) return false;
      if (!isAbsolute(cwd)) return true;
      const existing = rawByCwd.get(cwd);
      if (existing !== undefined) {
        existing.providers.add(provider);
        existing.sessionKeys.add(`${provider}\0${sessionKey}`);
        if (activityMs > existing.lastActivityMs) existing.lastActivityMs = activityMs;
        return true;
      }
      if (rawByCwd.size >= budget.limits.maxEntries) {
        markStopped(budget, "entry-limit");
        return false;
      }
      rawByCwd.set(cwd, {
        providers: new Set([provider]),
        sessionKeys: new Set([`${provider}\0${sessionKey}`]),
        lastActivityMs: activityMs,
      });
      budget.entriesCounted = rawByCwd.size;
      return true;
    };

    const roots = await this.#collectProviderHomes(canonicalHome);
    for (const runPhase of [
      () => this.#scanClaudeHomes(roots.claude, budget, recordSession),
      () => this.#scanCodexHomes(roots.codex, budget, recordSession),
      () => this.#scanOpenCodeHomes(roots.opencode, budget, recordSession),
      () => this.#scanPiHomes(roots.pi, budget, recordSession),
    ]) {
      const strictNow = hiddenIfStrict();
      if (strictNow !== undefined) return strictNow;
      const supersededNow = emptyIfSuperseded();
      if (supersededNow !== undefined) return supersededNow;
      if (isDiscoveryStopped(budget)) break;
      await runPhase();
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

  async #collectProviderHomes(canonicalHome: string): Promise<{
    readonly claude: ReadonlyArray<string>;
    readonly codex: ReadonlyArray<string>;
    readonly opencode: ReadonlyArray<string>;
    readonly pi: ReadonlyArray<string>;
  }> {
    const instances = await this.#readProviderInstances();

    const claudeRaw: string[] = [join(canonicalHome, ".claude")];
    if (isAbsoluteNonEmpty(this.#env.CLAUDE_CONFIG_DIR)) {
      claudeRaw.push(this.#env.CLAUDE_CONFIG_DIR);
    }
    claudeRaw.push(...(await listSubdirectories(join(canonicalHome, ".claude-accounts"))));
    for (const instance of instances) {
      if (
        instance.driverKind === "claude" &&
        isAbsoluteNonEmpty(instance.configuration.configDirectory)
      ) {
        claudeRaw.push(instance.configuration.configDirectory);
      }
    }

    const codexRaw: string[] = [join(canonicalHome, ".codex")];
    if (isAbsoluteNonEmpty(this.#env.CODEX_HOME)) {
      codexRaw.push(this.#env.CODEX_HOME);
    }
    codexRaw.push(...(await listSubdirectories(join(canonicalHome, ".codex-accounts"))));
    for (const instance of instances) {
      if (instance.driverKind === "codex" && isAbsoluteNonEmpty(instance.configuration.codexHome)) {
        codexRaw.push(instance.configuration.codexHome);
      }
    }

    const opencodeRaw: string[] = [];
    if (isAbsoluteNonEmpty(this.#env.OPENCODE_DATA)) {
      opencodeRaw.push(this.#env.OPENCODE_DATA);
    }
    if (isAbsoluteNonEmpty(this.#env.XDG_DATA_HOME)) {
      opencodeRaw.push(join(this.#env.XDG_DATA_HOME, "opencode"));
    }
    if (isAbsoluteNonEmpty(this.#env.LOCALAPPDATA)) {
      opencodeRaw.push(join(this.#env.LOCALAPPDATA, "opencode"));
    }
    opencodeRaw.push(join(canonicalHome, ".local", "share", "opencode"));

    const piRaw: string[] = [];
    if (isAbsoluteNonEmpty(this.#env.PI_CODING_AGENT_SESSION_DIR)) {
      piRaw.push(this.#env.PI_CODING_AGENT_SESSION_DIR);
    }
    if (isAbsoluteNonEmpty(this.#env.PI_CODING_AGENT_DIR)) {
      piRaw.push(join(this.#env.PI_CODING_AGENT_DIR, "sessions"));
    }
    piRaw.push(join(canonicalHome, ".pi", "agent", "sessions"));

    return {
      claude: await uniqueExistingDirectories(claudeRaw),
      codex: await uniqueExistingDirectories(codexRaw),
      opencode: await uniqueExistingDirectories(opencodeRaw),
      pi: await uniqueExistingDirectories(piRaw),
    };
  }

  async #scanClaudeHomes(
    homes: ReadonlyArray<string>,
    budget: ScanBudget,
    record: (
      cwd: string,
      provider: DiscoveredFolderProvider,
      sessionKey: string,
      activityMs: number,
    ) => boolean,
  ): Promise<void> {
    for (const claudeHome of homes) {
      if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
      const projectsDir = join(claudeHome, "projects");
      const folders = await safeReaddirWithTypes(projectsDir);
      for (const folder of folders) {
        if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
        if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
        const folderPath = join(projectsDir, folder.name);
        const entries = await safeReaddirWithTypes(folderPath);
        for (const entry of entries) {
          if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
          if (!consumeFileBudget(budget)) return;
          const filePath = join(folderPath, entry.name);
          const read = await readFileHead(filePath, SESSION_HEAD_BYTES);
          if (read === undefined) continue;
          const cwd = extractClaudeCwd(read.text);
          if (cwd === undefined) continue;
          const sessionKey = entry.name.slice(0, -".jsonl".length);
          if (!record(cwd, "claude", sessionKey, read.mtimeMs)) return;
        }
      }
    }
  }

  async #scanCodexHomes(
    homes: ReadonlyArray<string>,
    budget: ScanBudget,
    record: (
      cwd: string,
      provider: DiscoveredFolderProvider,
      sessionKey: string,
      activityMs: number,
    ) => boolean,
  ): Promise<void> {
    const visitRollout = async (filePath: string, fileName: string): Promise<boolean> => {
      if (this.#isHostStrict()) return false;
      if (!consumeFileBudget(budget)) return false;
      const read = await readFileHead(filePath, SESSION_HEAD_BYTES);
      if (read === undefined) return true;
      const meta = extractCodexMeta(read.text);
      if (meta === undefined) return true;
      const activityMs = Math.max(read.mtimeMs, meta.timestampMs ?? 0);
      return record(meta.cwd, "codex", meta.sessionId ?? fileName, activityMs);
    };

    for (const codexHome of homes) {
      if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
      await walkCodexDateTree(
        join(codexHome, "sessions"),
        0,
        budget,
        this.#isHostStrict,
        visitRollout,
      );
      if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
      await walkCodexArchiveTree(
        join(codexHome, "archived_sessions"),
        0,
        budget,
        this.#isHostStrict,
        visitRollout,
      );
    }
  }

  async #scanOpenCodeHomes(
    homes: ReadonlyArray<string>,
    budget: ScanBudget,
    record: (
      cwd: string,
      provider: DiscoveredFolderProvider,
      sessionKey: string,
      activityMs: number,
    ) => boolean,
  ): Promise<void> {
    for (const dataDir of homes) {
      if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
      const names = await safeReaddir(dataDir);
      const channelDbs = names
        .filter(
          (name) => name.startsWith("opencode") && name.endsWith(".db") && name !== "opencode.db",
        )
        .sort();
      const dbNames = [...(names.includes("opencode.db") ? ["opencode.db"] : []), ...channelDbs];
      for (const dbName of dbNames) {
        if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
        const dbPath = join(dataDir, dbName);
        if (!(await isRegularFile(dbPath))) continue;
        scanOpenCodeSqlite(dbPath, budget, this.#isHostStrict, record);
      }

      if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
      const legacySessions = join(dataDir, "storage", "session");
      await scanOpenCodeLegacyJson(legacySessions, budget, this.#isHostStrict, record);
    }
  }

  async #scanPiHomes(
    sessionDirs: ReadonlyArray<string>,
    budget: ScanBudget,
    record: (
      cwd: string,
      provider: DiscoveredFolderProvider,
      sessionKey: string,
      activityMs: number,
    ) => boolean,
  ): Promise<void> {
    for (const sessionsDir of sessionDirs) {
      if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
      const folders = await safeReaddirWithTypes(sessionsDir);
      for (const folder of folders) {
        if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
        if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
        const folderPath = join(sessionsDir, folder.name);
        const entries = await safeReaddirWithTypes(folderPath);
        for (const entry of entries) {
          if (this.#isHostStrict() || isDiscoveryStopped(budget)) return;
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
          if (!consumeFileBudget(budget)) return;
          const filePath = join(folderPath, entry.name);
          const read = await readFileHead(filePath, SESSION_HEAD_BYTES);
          if (read === undefined) continue;
          const header = extractPiHeader(read.text);
          if (header === undefined) continue;
          const activityMs = Math.max(read.mtimeMs, header.timestampMs ?? 0);
          if (!record(header.cwd, "pi", header.id, activityMs)) return;
        }
      }
    }
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

async function walkCodexDateTree(
  directory: string,
  depth: number,
  budget: ScanBudget,
  isStrict: () => boolean,
  visit: (filePath: string, fileName: string) => Promise<boolean>,
): Promise<void> {
  if (isStrict() || isDiscoveryStopped(budget)) return;
  const entries = await safeReaddirWithTypes(directory);
  if (depth < 3) {
    const dirs = entries
      .filter(
        (entry) => entry.isDirectory() && !entry.isSymbolicLink() && DATE_SEGMENT.test(entry.name),
      )
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const dir of dirs) {
      if (isStrict() || isDiscoveryStopped(budget)) return;
      await walkCodexDateTree(join(directory, dir.name), depth + 1, budget, isStrict, visit);
    }
    return;
  }
  const files = entries
    .filter(
      (entry) => entry.isFile() && !entry.isSymbolicLink() && CODEX_ROLLOUT_FILE.test(entry.name),
    )
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const file of files) {
    if (isStrict() || isDiscoveryStopped(budget)) return;
    const keepGoing = await visit(join(directory, file.name), file.name);
    if (!keepGoing) return;
  }
}

/**
 * Walks Codex's `archived_sessions` folder, which may hold flat `rollout-*.jsonl`
 * files or dated subdirectories up to depth 3, newest first.
 */
async function walkCodexArchiveTree(
  directory: string,
  depth: number,
  budget: ScanBudget,
  isStrict: () => boolean,
  visit: (filePath: string, fileName: string) => Promise<boolean>,
): Promise<void> {
  if (isStrict() || isDiscoveryStopped(budget)) return;
  const entries = await safeReaddirWithTypes(directory);
  const files = entries
    .filter(
      (entry) => entry.isFile() && !entry.isSymbolicLink() && CODEX_ROLLOUT_FILE.test(entry.name),
    )
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const file of files) {
    if (isStrict() || isDiscoveryStopped(budget)) return;
    const keepGoing = await visit(join(directory, file.name), file.name);
    if (!keepGoing) return;
  }
  if (depth >= 3) return;
  const dirs = entries
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && DATE_SEGMENT.test(entry.name),
    )
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const dir of dirs) {
    if (isStrict() || isDiscoveryStopped(budget)) return;
    await walkCodexArchiveTree(join(directory, dir.name), depth + 1, budget, isStrict, visit);
  }
}

function scanOpenCodeSqlite(
  dbPath: string,
  budget: ScanBudget,
  isStrict: () => boolean,
  record: (
    cwd: string,
    provider: DiscoveredFolderProvider,
    sessionKey: string,
    activityMs: number,
  ) => boolean,
): void {
  if (isStrict() || isDiscoveryStopped(budget)) return;
  let db;
  try {
    db = openReadOnlySqlite(dbPath);
  } catch {
    return;
  }
  try {
    const tableRow = db.all(
      "SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = 'session'",
    )[0];
    if (!isRecord(tableRow) || tableRow.present !== 1) return;

    const columns = new Set(
      db
        .all("PRAGMA table_info(session)")
        .filter(isRecord)
        .map((row) => (typeof row.name === "string" ? row.name : "")),
    );
    if (!columns.has("directory")) return;

    const selectCols = [
      columns.has("id") ? "id" : "rowid AS id",
      "directory",
      columns.has("time_updated") ? "time_updated" : "NULL AS time_updated",
      columns.has("time_created") ? "time_created" : "NULL AS time_created",
    ];
    const whereClauses = ["directory IS NOT NULL", "directory != ''"];
    if (columns.has("parent_id")) {
      whereClauses.push("(parent_id IS NULL OR parent_id = '')");
    }
    const orderClause = columns.has("time_updated") ? "ORDER BY time_updated DESC" : "";
    const remaining = Math.max(0, budget.limits.maxFiles - budget.filesScanned);
    const limit = remaining + 1;
    const rows = db.all(
      `SELECT ${selectCols.join(", ")} FROM session WHERE ${whereClauses.join(" AND ")} ${orderClause} LIMIT ${String(limit)}`,
    );

    for (const row of rows) {
      if (isStrict()) return;
      if (!isRecord(row) || typeof row.directory !== "string") continue;
      if (!consumeFileBudget(budget)) return;
      const id =
        typeof row.id === "string" || typeof row.id === "number"
          ? String(row.id)
          : `${dbPath}:${String(budget.filesScanned)}`;
      const updatedMs =
        normalizeEpochMs(row.time_updated) ?? normalizeEpochMs(row.time_created) ?? 0;
      if (!record(row.directory, "opencode", id, updatedMs)) return;
    }
  } catch {
    // An unreadable or locked third-party database is skipped read-only.
  } finally {
    db.close();
  }
}

async function scanOpenCodeLegacyJson(
  sessionsRoot: string,
  budget: ScanBudget,
  isStrict: () => boolean,
  record: (
    cwd: string,
    provider: DiscoveredFolderProvider,
    sessionKey: string,
    activityMs: number,
  ) => boolean,
): Promise<void> {
  const top = await safeReaddirWithTypes(sessionsRoot);
  for (const entry of top) {
    if (isStrict() || isDiscoveryStopped(budget)) return;
    if (entry.isSymbolicLink()) continue;
    const entryPath = join(sessionsRoot, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) {
      if (!consumeFileBudget(budget)) return;
      const parsed = await readOpenCodeJsonSession(entryPath);
      if (parsed !== undefined && !record(parsed.cwd, "opencode", parsed.id, parsed.activityMs)) {
        return;
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    const nested = await safeReaddirWithTypes(entryPath);
    for (const file of nested) {
      if (isStrict() || isDiscoveryStopped(budget)) return;
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".json")) continue;
      if (!consumeFileBudget(budget)) return;
      const parsed = await readOpenCodeJsonSession(join(entryPath, file.name));
      if (parsed !== undefined && !record(parsed.cwd, "opencode", parsed.id, parsed.activityMs)) {
        return;
      }
    }
  }
}

async function readOpenCodeJsonSession(
  filePath: string,
): Promise<{ readonly id: string; readonly cwd: string; readonly activityMs: number } | undefined> {
  const read = await readSmallFile(filePath, OPENCODE_JSON_MAX_BYTES);
  if (read === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(read.text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.parentID !== undefined || value.parentId !== undefined) return undefined;
  if (typeof value.directory !== "string" || !isAbsolute(value.directory)) return undefined;
  const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id : filePath;
  const time = isRecord(value.time) ? value.time : undefined;
  const activityMs =
    normalizeEpochMs(time?.updated) ??
    normalizeEpochMs(value.updated) ??
    normalizeEpochMs(time?.created) ??
    read.mtimeMs;
  return { id, cwd: value.directory, activityMs };
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

function extractClaudeCwd(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (record.isSidechain === true) continue;
    if (typeof record.cwd === "string" && isAbsolute(record.cwd)) {
      return record.cwd;
    }
  }
  return undefined;
}

function extractCodexMeta(
  text: string,
):
  | { readonly cwd: string; readonly sessionId?: string; readonly timestampMs?: number }
  | undefined {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "session_meta" || !isRecord(record.payload)) continue;
    const payload = record.payload;
    if (typeof payload.parentThreadId === "string" && payload.parentThreadId !== "")
      return undefined;
    if (payload.source === "subagent") return undefined;
    if (typeof payload.cwd !== "string" || !isAbsolute(payload.cwd)) return undefined;
    const sessionId = typeof payload.id === "string" && payload.id !== "" ? payload.id : undefined;
    const timestampMs =
      typeof payload.timestamp === "string" ? parseIsoMs(payload.timestamp) : undefined;
    return {
      cwd: payload.cwd,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(timestampMs === undefined ? {} : { timestampMs }),
    };
  }
  return undefined;
}

function extractPiHeader(
  text: string,
): { readonly id: string; readonly cwd: string; readonly timestampMs?: number } | undefined {
  const firstLine = text.split("\n")[0];
  if (firstLine === undefined || firstLine.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(firstLine) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    value.type !== "session" ||
    typeof value.id !== "string" ||
    value.id.trim() === "" ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd)
  ) {
    return undefined;
  }
  const timestampMs = typeof value.timestamp === "string" ? parseIsoMs(value.timestamp) : undefined;
  return {
    id: value.id,
    cwd: value.cwd,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
}

async function readFileHead(
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
    if (!info.isFile()) return undefined;
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
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

async function listSubdirectories(parentDir: string): Promise<ReadonlyArray<string>> {
  const entries = await safeReaddirWithTypes(parentDir);
  return entries
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."),
    )
    .map((entry) => join(parentDir, entry.name))
    .sort();
}

async function uniqueExistingDirectories(
  candidates: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const candidate of candidates) {
    let canonical: string;
    try {
      canonical = await realpath(candidate);
      const info = await stat(canonical);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    directories.push(canonical);
  }
  return directories;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function safeReaddir(path: string): Promise<ReadonlyArray<string>> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function safeReaddirWithTypes(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isAbsoluteNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && isAbsolute(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIsoMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === "string") return parseIsoMs(value);
  return undefined;
}

function toUtcTimestamp(ms: number, fallbackClock: () => string): UtcTimestamp {
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toISOString() as UtcTimestamp;
  }
  return fallbackClock() as UtcTimestamp;
}

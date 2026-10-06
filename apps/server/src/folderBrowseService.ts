import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import {
  decodeFolderBrowseRequest,
  decodeFolderCandidateId,
  decodeFolderSelectionRequest,
  type FolderBrowseFailure,
  type FolderBrowseRequest,
  type FolderBrowseResult,
  type FolderCandidate,
  type FolderCandidateId,
  type FolderSelectionRequest,
  type FolderSelectionResult,
} from "@octant/contracts/folder-browse";
import type { BindingReceiptStorePort } from "./bindingReceiptStore";
import type { ProjectRootPort } from "./projectRootPort";
import type { WindowId } from "@octant/contracts";
import { childProcessEnvironment } from "./childProcessEnvironment";

const MAX_CANDIDATES = 200;
const MAX_DEPTH = 20;
const HIDDEN_PREFIX = ".";
const CANDIDATE_TTL_MS = 120_000;

// A cloud-synced or network-mounted entry can block its filesystem call
// indefinitely. Each entry's checks are bounded so one stalled entry delays the
// listing by at most this budget instead of stalling the whole request.
const ENTRY_INSPECTION_TIMEOUT_MS = 2_000;
// The Git probe spawns a process; bound it so a hung checkout cannot outlive the
// per-entry budget as an orphaned process.
const GIT_REV_PARSE_TIMEOUT_MS = 1_500;

const execFileAsync = promisify(nodeExecFile);

/**
 * The outcome of inspecting one directory entry. A folder carries its canonical
 * path and whether it is a Git repository root; every other case is skipped.
 */
export type FolderEntryInspection =
  | { readonly kind: "folder"; readonly canonicalPath: string; readonly isGitRepository: boolean }
  | { readonly kind: "skipped" };

export interface FolderBrowseServiceOptions {
  readonly bindingReceiptStore: Pick<BindingReceiptStorePort, "issue">;
  readonly projectRootPort: Pick<ProjectRootPort, "validate">;
  readonly homeDir: string;
  readonly clock?: () => string;
  readonly now?: () => number;
  /**
   * Resolves one directory entry to a folder or a skip. Defaults to the host
   * filesystem. Substituting an entry that never resolves exercises the
   * per-entry budget.
   */
  readonly inspectEntry?: (entryPath: string) => Promise<FolderEntryInspection>;
  /** Overrides the per-entry budget, in milliseconds. */
  readonly entryInspectionTimeoutMs?: number;
}

export class FolderBrowseServiceError extends Error {
  override readonly name = "FolderBrowseServiceError";
  constructor(readonly failure: FolderBrowseFailure) {
    super(failure.message);
  }
}

interface CandidateRecord {
  readonly candidateId: FolderCandidateId;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly isGitRepository: boolean;
  readonly expiresAt: number;
  readonly windowId: WindowId;
  readonly mode: "work" | "code";
}

export class FolderBrowseService {
  readonly #receipts: Pick<BindingReceiptStorePort, "issue">;
  readonly #roots: Pick<ProjectRootPort, "validate">;
  readonly #homeDir: string;
  readonly #clock: () => string;
  readonly #now: () => number;
  readonly #inspectEntry: (entryPath: string) => Promise<FolderEntryInspection>;
  readonly #entryInspectionTimeoutMs: number;
  readonly #candidates = new Map<string, CandidateRecord>();

  constructor(options: FolderBrowseServiceOptions) {
    this.#receipts = options.bindingReceiptStore;
    this.#roots = options.projectRootPort;
    this.#homeDir = options.homeDir;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#now = options.now ?? Date.now;
    this.#inspectEntry = options.inspectEntry ?? ((entryPath) => this.#inspectHostEntry(entryPath));
    this.#entryInspectionTimeoutMs =
      options.entryInspectionTimeoutMs ?? ENTRY_INSPECTION_TIMEOUT_MS;
  }

  async browse(authenticatedWindowId: WindowId, input: unknown): Promise<FolderBrowseResult> {
    let request: FolderBrowseRequest;
    try {
      request = decodeFolderBrowseRequest(input);
    } catch {
      throw new FolderBrowseServiceError({
        category: "invalid",
        message: "Folder browse request is invalid.",
      });
    }

    this.#purgeExpired();

    const parentRecord =
      request.parentCandidateId === undefined
        ? undefined
        : this.#requireRecord(request.parentCandidateId, authenticatedWindowId, request.mode);

    const canonicalRoot = await this.#canonicalDirectory(
      this.#homeDir,
      "Authorized folder root is not accessible.",
    );

    const parentPath = parentRecord === undefined ? canonicalRoot : parentRecord.canonicalPath;

    const canonicalParent = await this.#canonicalDirectory(
      parentPath,
      "Parent folder is not accessible.",
    );
    this.#assertWithinRoot(canonicalRoot, canonicalParent);

    let entries: string[];
    try {
      entries = await readdir(canonicalParent);
    } catch {
      throw new FolderBrowseServiceError({
        category: "unavailable",
        message: "Cannot read directory contents.",
      });
    }

    const candidates: FolderCandidate[] = [];
    const now = this.#now();
    const expiresAt = now + CANDIDATE_TTL_MS;
    const search = request.search?.toLocaleLowerCase();
    let truncated = false;

    for (const entry of entries) {
      if (candidates.length >= MAX_CANDIDATES) {
        truncated = true;
        break;
      }
      if (entry.startsWith(HIDDEN_PREFIX)) continue;
      if (search !== undefined && !entry.toLocaleLowerCase().includes(search)) continue;

      const fullPath = join(canonicalParent, entry);
      const inspection = await this.#inspectWithinBudget(fullPath);
      if (inspection.kind === "skipped") continue;
      if (!isWithinAuthorizedRoot(canonicalRoot, inspection.canonicalPath)) continue;

      const candidateId = this.#issueCandidate({
        canonicalPath: inspection.canonicalPath,
        displayName: entry,
        isGitRepository: inspection.isGitRepository,
        expiresAt,
        windowId: authenticatedWindowId,
        mode: request.mode,
      });

      candidates.push({
        candidateId,
        displayName: entry,
        isGitRepository: inspection.isGitRepository,
        // Both Work and Code bind any directory; Git status is informational.
        isSelectable: true,
      });
    }

    candidates.sort((a, b) => a.displayName.localeCompare(b.displayName));

    const breadcrumbs = this.#buildBreadcrumbs({
      canonicalParent,
      canonicalRoot,
      windowId: authenticatedWindowId,
      mode: request.mode,
      expiresAt,
    });

    return {
      candidates,
      breadcrumbs,
      hasMore: truncated,
      browsedAt: this.#clock() as FolderBrowseResult["browsedAt"],
    };
  }

  /**
   * The canonical path behind a candidate the host already listed.
   *
   * This is for a person choosing a folder that is not a Project binding — an
   * export destination. The candidate id is the only thing a renderer may
   * send; the path stays here, where it was measured. An expired, foreign
   * window's, or off-mode candidate is refused by the same record check a
   * binding selection uses, so a candidate cannot be replayed into another
   * window or another mode.
   */
  resolveCandidate(windowId: WindowId, input: unknown): string {
    let request: FolderSelectionRequest;
    try {
      request = decodeFolderSelectionRequest(input);
    } catch {
      throw new FolderBrowseServiceError({
        category: "invalid",
        message: "Folder selection request is invalid.",
      });
    }
    this.#purgeExpired();
    const record = this.#requireRecord(request.candidateId, windowId, request.mode);
    return record.canonicalPath;
  }

  async select(authenticatedWindowId: WindowId, input: unknown): Promise<FolderSelectionResult> {
    let request: FolderSelectionRequest;
    try {
      request = decodeFolderSelectionRequest(input);
    } catch {
      throw new FolderBrowseServiceError({
        category: "invalid",
        message: "Folder selection request is invalid.",
      });
    }

    this.#purgeExpired();

    const record = this.#requireRecord(request.candidateId, authenticatedWindowId, request.mode);

    const canonicalRoot = await this.#canonicalDirectory(
      this.#homeDir,
      "Authorized folder root is not accessible.",
    );
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(record.canonicalPath);
    } catch {
      throw new FolderBrowseServiceError({
        category: "unavailable",
        message: "Folder candidate is not accessible.",
      });
    }
    this.#assertWithinRoot(canonicalRoot, canonicalPath);

    const canonicalBinding = await this.#roots.validate(request.mode, canonicalPath);

    const receipt = this.#receipts.issue({
      windowId: authenticatedWindowId,
      projectType: request.mode,
      canonicalBinding,
      now: this.#now(),
    });

    this.#candidates.delete(request.candidateId);

    return {
      receiptId: receipt.receiptId,
      displayName: record.displayName,
      selectedAt: this.#clock() as FolderSelectionResult["selectedAt"],
    };
  }

  #requireRecord(
    candidateId: FolderCandidateId,
    windowId: WindowId,
    mode: "work" | "code",
  ): CandidateRecord {
    const record = this.#candidates.get(candidateId);
    if (record === undefined || this.#now() >= record.expiresAt) {
      if (record !== undefined) this.#candidates.delete(candidateId);
      throw new FolderBrowseServiceError({
        category: "not-found",
        message: "Folder candidate has expired or is invalid.",
      });
    }
    if (String(record.windowId) !== String(windowId)) {
      throw new FolderBrowseServiceError({
        category: "unauthorized",
        message: "Folder candidate belongs to a different window.",
      });
    }
    if (record.mode !== mode) {
      throw new FolderBrowseServiceError({
        category: "invalid",
        message: "Folder candidate mode does not match selection mode.",
      });
    }
    return record;
  }

  #assertWithinRoot(canonicalRoot: string, canonicalPath: string): void {
    if (isWithinAuthorizedRoot(canonicalRoot, canonicalPath)) return;
    throw new FolderBrowseServiceError({
      category: "unauthorized",
      message: "Folder candidate is outside the authorized root.",
    });
  }

  async #canonicalDirectory(path: string, unavailableMessage: string): Promise<string> {
    try {
      const canonical = await realpath(path);
      const details = await stat(canonical);
      if (!details.isDirectory()) {
        throw new FolderBrowseServiceError({
          category: "unavailable",
          message: unavailableMessage,
        });
      }
      return canonical;
    } catch (error) {
      if (error instanceof FolderBrowseServiceError) throw error;
      throw new FolderBrowseServiceError({
        category: "unavailable",
        message: unavailableMessage,
      });
    }
  }

  async #inspectWithinBudget(entryPath: string): Promise<FolderEntryInspection> {
    const outcome = await withinBudget(
      this.#inspectEntry(entryPath),
      this.#entryInspectionTimeoutMs,
    );
    if (outcome.kind === "resolved") return outcome.value;
    if (outcome.kind === "failed") return { kind: "skipped" };
    // A blocked entry is listed as a plain folder rather than stalling the rest
    // of the listing; selection re-canonicalizes and re-validates its path.
    return { kind: "folder", canonicalPath: entryPath, isGitRepository: false };
  }

  async #inspectHostEntry(entryPath: string): Promise<FolderEntryInspection> {
    let entryStat;
    try {
      entryStat = await stat(entryPath);
    } catch {
      return { kind: "skipped" };
    }
    if (!entryStat.isDirectory()) return { kind: "skipped" };

    let canonicalEntry: string;
    try {
      canonicalEntry = await realpath(entryPath);
    } catch {
      return { kind: "skipped" };
    }

    const isGitRepository = await this.#checkGitRepository(canonicalEntry);
    return { kind: "folder", canonicalPath: canonicalEntry, isGitRepository };
  }

  async #checkGitRepository(path: string): Promise<boolean> {
    // Fast path: check for .git before spawning git process
    const gitDir = join(path, ".git");
    try {
      const gitStat = await stat(gitDir);
      if (!gitStat.isDirectory() && !gitStat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
    try {
      const result = await execFileAsync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        env: childProcessEnvironment(process.env),
        shell: false,
        timeout: GIT_REV_PARSE_TIMEOUT_MS,
      });
      const reportedRoot = await realpath(result.stdout.trim());
      const canonicalPath = await realpath(path);
      return reportedRoot === canonicalPath;
    } catch {
      return false;
    }
  }

  #buildBreadcrumbs(input: {
    readonly canonicalParent: string;
    readonly canonicalRoot: string;
    readonly windowId: WindowId;
    readonly mode: "work" | "code";
    readonly expiresAt: number;
  }): FolderBrowseResult["breadcrumbs"] {
    const ancestors: string[] = [];
    let cursor = input.canonicalParent;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      ancestors.unshift(cursor);
      if (cursor === input.canonicalRoot) break;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      if (!isWithinAuthorizedRoot(input.canonicalRoot, parent)) break;
      cursor = parent;
    }

    return ancestors.map((path, index) => {
      const label = folderLabel(path);
      const isCurrent = index === ancestors.length - 1;
      if (isCurrent) return { label };
      return {
        label,
        candidateId: this.#issueCandidate({
          canonicalPath: path,
          displayName: label,
          isGitRepository: false,
          expiresAt: input.expiresAt,
          windowId: input.windowId,
          mode: input.mode,
        }),
      };
    });
  }

  #issueCandidate(input: {
    readonly canonicalPath: string;
    readonly displayName: string;
    readonly isGitRepository: boolean;
    readonly expiresAt: number;
    readonly windowId: WindowId;
    readonly mode: "work" | "code";
  }): FolderCandidateId {
    const existing = this.#findLiveCandidate(input.canonicalPath, input.windowId, input.mode);
    if (existing !== undefined) {
      this.#candidates.set(existing.candidateId, {
        ...existing,
        displayName: input.displayName,
        isGitRepository: input.isGitRepository,
        expiresAt: input.expiresAt,
      });
      return existing.candidateId;
    }
    const candidateId = decodeFolderCandidateId(randomUUID());
    this.#candidates.set(candidateId, {
      candidateId,
      canonicalPath: input.canonicalPath,
      displayName: input.displayName,
      isGitRepository: input.isGitRepository,
      expiresAt: input.expiresAt,
      windowId: input.windowId,
      mode: input.mode,
    });
    return candidateId;
  }

  #findLiveCandidate(
    canonicalPath: string,
    windowId: WindowId,
    mode: "work" | "code",
  ): CandidateRecord | undefined {
    for (const record of this.#candidates.values()) {
      if (record.canonicalPath !== canonicalPath) continue;
      if (String(record.windowId) !== String(windowId)) continue;
      if (record.mode !== mode) continue;
      if (this.#now() >= record.expiresAt) continue;
      return record;
    }
    return undefined;
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [id, record] of this.#candidates) {
      if (now >= record.expiresAt) this.#candidates.delete(id);
    }
  }
}

function isWithinAuthorizedRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

type BudgetOutcome<T> =
  | { readonly kind: "resolved"; readonly value: T }
  | { readonly kind: "expired" }
  | { readonly kind: "failed" };

/**
 * Resolves with the work's value, or reports that its budget expired. The timer
 * is always cleared, and the work's rejection is handled here, so a stalled or
 * failing entry leaves no pending timer or unhandled rejection behind.
 */
async function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<BudgetOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<BudgetOutcome<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "expired" }), budgetMs);
    });
    const settled = work.then(
      (value): BudgetOutcome<T> => ({ kind: "resolved", value }),
      (): BudgetOutcome<T> => ({ kind: "failed" }),
    );
    return await Promise.race([settled, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function folderLabel(canonicalPath: string): string {
  const label = basename(canonicalPath);
  return label === "" ? canonicalPath : label;
}

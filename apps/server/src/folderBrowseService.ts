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

const execFileAsync = promisify(nodeExecFile);

export interface FolderBrowseServiceOptions {
  readonly bindingReceiptStore: Pick<BindingReceiptStorePort, "issue">;
  readonly projectRootPort: Pick<ProjectRootPort, "validate">;
  readonly homeDir: string;
  readonly clock?: () => string;
  readonly now?: () => number;
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
  readonly #candidates = new Map<string, CandidateRecord>();

  constructor(options: FolderBrowseServiceOptions) {
    this.#receipts = options.bindingReceiptStore;
    this.#roots = options.projectRootPort;
    this.#homeDir = options.homeDir;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#now = options.now ?? Date.now;
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
      let entryStat;
      try {
        entryStat = await stat(fullPath);
      } catch {
        continue;
      }
      if (!entryStat.isDirectory()) continue;

      let canonicalEntry: string;
      try {
        canonicalEntry = await realpath(fullPath);
      } catch {
        continue;
      }
      if (!isWithinAuthorizedRoot(canonicalRoot, canonicalEntry)) continue;

      const isGitRepo = await this.#checkGitRepository(canonicalEntry);
      const candidateId = this.#issueCandidate({
        canonicalPath: canonicalEntry,
        displayName: entry,
        isGitRepository: isGitRepo,
        expiresAt,
        windowId: authenticatedWindowId,
        mode: request.mode,
      });

      candidates.push({
        candidateId,
        displayName: entry,
        isGitRepository: isGitRepo,
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

function folderLabel(canonicalPath: string): string {
  const label = basename(canonicalPath);
  return label === "" ? canonicalPath : label;
}

import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import {
  decodeFolderBrowseRequest,
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

    const parentPath =
      request.parentCandidateId !== undefined
        ? this.#resolveCandidatePath(request.parentCandidateId, authenticatedWindowId, request.mode)
        : this.#homeDir;

    if (parentPath === undefined) {
      throw new FolderBrowseServiceError({
        category: "not-found",
        message: "Parent folder candidate has expired or is invalid.",
      });
    }

    let canonicalParent: string;
    try {
      canonicalParent = await realpath(parentPath);
    } catch {
      throw new FolderBrowseServiceError({
        category: "unavailable",
        message: "Parent folder is not accessible.",
      });
    }

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
    const expiresAt = now + 120_000;

    for (const entry of entries) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (entry.startsWith(HIDDEN_PREFIX)) continue;

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

      const isGitRepo = await this.#checkGitRepository(canonicalEntry);
      const candidateId = randomUUID() as FolderCandidateId;

      this.#candidates.set(candidateId, {
        candidateId,
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

    const breadcrumbs = this.#buildBreadcrumbs(canonicalParent);

    return {
      candidates,
      breadcrumbs,
      hasMore: entries.length > MAX_CANDIDATES,
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

    const record = this.#candidates.get(request.candidateId);
    if (record === undefined) {
      throw new FolderBrowseServiceError({
        category: "not-found",
        message: "Folder candidate has expired or is invalid.",
      });
    }
    if (record.windowId !== authenticatedWindowId) {
      throw new FolderBrowseServiceError({
        category: "unauthorized",
        message: "Folder candidate belongs to a different window.",
      });
    }
    if (record.mode !== request.mode) {
      throw new FolderBrowseServiceError({
        category: "invalid",
        message: "Folder candidate mode does not match selection mode.",
      });
    }

    const canonicalBinding = await this.#roots.validate(request.mode, record.canonicalPath);

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

  #resolveCandidatePath(
    candidateId: FolderCandidateId,
    windowId: WindowId,
    mode: "work" | "code",
  ): string | undefined {
    const record = this.#candidates.get(candidateId);
    if (record === undefined) return undefined;
    if (record.windowId !== windowId) return undefined;
    if (record.mode !== mode) return undefined;
    if (this.#now() >= record.expiresAt) {
      this.#candidates.delete(candidateId);
      return undefined;
    }
    return record.canonicalPath;
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

  #buildBreadcrumbs(canonicalPath: string): FolderBrowseResult["breadcrumbs"] {
    const parts = canonicalPath.split(sep).filter(Boolean);
    const crumbs: Array<{
      label: string;
      candidateId?: import("@octant/contracts/folder-browse").FolderCandidateId;
    }> = [{ label: sep === "/" ? "/" : (parts[0] ?? "Home") }];
    let accumulated = "";
    for (let i = 0; i < parts.length; i++) {
      accumulated = join(accumulated, parts[i]!);
      const label = parts[i]!;
      const candidateId = this.#findCandidateByPath(accumulated);
      crumbs.push({
        label,
        ...(candidateId !== undefined ? { candidateId } : {}),
      });
    }
    return crumbs;
  }

  #findCandidateByPath(path: string): FolderCandidateId | undefined {
    for (const record of this.#candidates.values()) {
      if (record.canonicalPath === path) return record.candidateId;
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

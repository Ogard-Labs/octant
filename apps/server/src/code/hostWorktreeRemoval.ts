import { lstat, realpath, rm } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { readWorktreeStatus, parseWorktreeList, runHostGit } from "./hostGitReads";
import { worktreeAdminDirectory } from "./hostWorktreeDiscovery";

/** A worktree changed this recently may have a program working in it now. */
export const RECENT_ACTIVITY_MS = 15 * 60 * 1000;
/**
 * The most commits counted. The person confirms the whole counted set, so a
 * branch with more confirms its newest 200, and the same 200 are checked.
 */
const COUNTED_COMMITS = 200;

export interface UnpushedCommit {
  readonly hash: string;
  readonly subject: string;
}

export type HostWorktreeRemoval =
  | Readonly<{ status: "removed" }>
  | Readonly<{ status: "forgotten" }>
  | Readonly<{
      status: "refused";
      reason:
        | "not-found"
        | "main-worktree"
        | "bare"
        | "locked"
        | "owned-by-octant"
        | "linked-elsewhere"
        | "broken-link"
        | "runs-filters"
        | "unreadable"
        | "dirty"
        | "detached-commits"
        | "git-refused";
      detail?: string;
    }>
  | Readonly<{
      status: "needs-confirmation";
      reason: "unpushed-commits" | "recently-active";
      commits?: ReadonlyArray<UnpushedCommit>;
      commitCount?: number;
    }>;

export interface HostWorktreeRemovalRequest {
  readonly repositoryPath: string;
  readonly worktreePath: string;
  /** The unpushed commits the person saw and confirmed, by full hash. */
  readonly confirmedCommits?: ReadonlyArray<string>;
  readonly confirmedRecentActivity?: boolean;
}

export interface HostWorktreeRemovalDependencies {
  readonly ownedWorktreePaths: () => Promise<ReadonlySet<string>>;
  readonly now: () => number;
}

/**
 * Removes a worktree Octant did not make, with the same care as its own.
 * Everything is worked out again from Git here, not taken from the request:
 * it refuses the repository's own checkout, a bare repository, a worktree Git
 * has locked, one Octant owns, a folder that now belongs to another
 * repository, and uncommitted or untracked changes. Commits only this worktree
 * has are listed and must be confirmed as the same set; a detached HEAD's are
 * refused, since no branch would keep them. The branch always stays, and Git's
 * own `worktree remove` (never forced) checks once more. A worktree whose
 * folder is already gone has only Git's record of it removed.
 */
export async function removeHostWorktree(
  request: HostWorktreeRemovalRequest,
  dependencies: HostWorktreeRemovalDependencies,
  signal: AbortSignal,
): Promise<HostWorktreeRemoval> {
  const common = await commonDirectory(request.repositoryPath, signal);
  if (common === undefined) return refused("not-found");
  const listed = await runHostGit(["-C", common, "worktree", "list", "--porcelain", "-z"], signal);
  if (listed.exitCode !== 0) return refused("unreadable", firstLine(listed.stderr));
  const entries = parseWorktreeList(listed.stdout);
  const wanted = resolve(request.worktreePath);
  const index = entries.findIndex((entry) => resolve(entry.path) === wanted);
  const entry = entries[index];
  if (entry === undefined) return refused("not-found");
  if (index === 0) return refused("main-worktree");
  if (entry.bare) return refused("bare");
  if (entry.locked !== undefined) return refused("locked", entry.locked || undefined);
  const owned = await dependencies.ownedWorktreePaths();
  if ([...owned].some((path) => resolve(path) === wanted)) return refused("owned-by-octant");

  const admin = await worktreeAdminDirectory(common, entry.path);
  const folder = await lstat(entry.path).catch(() => undefined);
  if (folder === undefined) {
    // Git's record of a worktree whose folder is gone: removing that one
    // record is what `git worktree prune` does for it, without touching the
    // repository's other prunable entries.
    if (admin === undefined || !isInside(join(common, "worktrees"), admin)) {
      return refused("broken-link");
    }
    // A detached HEAD's commits may be kept only by this record's HEAD and
    // reflog; removing it leaves them unreachable and Git collects them
    // later. A branch keeps its own commits, so only detached ones count.
    if (entry.branch === undefined) {
      const kept = await commitsOnlyHere(common, entry.head, undefined, signal);
      if (kept === undefined) return refused("unreadable");
      if (kept.length > 0) return refused("detached-commits");
    }
    await rm(admin, { recursive: true, force: true });
    return { status: "forgotten" };
  }
  if (!folder.isDirectory() || folder.isSymbolicLink()) return refused("broken-link");
  if (admin === undefined) return refused("broken-link");
  const own = await commonDirectory(entry.path, signal);
  if (own === undefined || own !== common) return refused("linked-elsewhere");

  const status = await readWorktreeStatus(entry.path, signal);
  if (status.status === "runs-filters") return refused("runs-filters", status.filters.join(", "));
  if (status.status === "failed") return refused("unreadable");
  if (status.changedPaths > 0) return refused("dirty", `${status.changedPaths} changed paths`);

  const unpushed = await commitsOnlyHere(common, entry.head, entry.branch, signal);
  if (unpushed === undefined) return refused("unreadable");
  if (unpushed.length > 0) {
    if (entry.branch === undefined) return refused("detached-commits");
    const confirmed = new Set(request.confirmedCommits ?? []);
    const same =
      confirmed.size === unpushed.length && unpushed.every((commit) => confirmed.has(commit.hash));
    if (!same) {
      return {
        status: "needs-confirmation",
        reason: "unpushed-commits",
        commits: unpushed,
        commitCount: unpushed.length,
      };
    }
  }

  const activity = await newestAdminChange(admin);
  if (
    activity !== undefined &&
    dependencies.now() - activity < RECENT_ACTIVITY_MS &&
    request.confirmedRecentActivity !== true
  ) {
    return { status: "needs-confirmation", reason: "recently-active" };
  }

  const removed = await runHostGit(
    ["-C", common, "worktree", "remove", entry.path],
    signal,
    60_000,
  );
  if (removed.exitCode !== 0) return refused("git-refused", firstLine(removed.stderr));
  return { status: "removed" };
}

async function commonDirectory(path: string, signal: AbortSignal): Promise<string | undefined> {
  const result = await runHostGit(
    ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    signal,
  );
  if (result.exitCode !== 0) return undefined;
  return realpath(result.stdout.trim()).catch(() => undefined);
}

/**
 * The commits HEAD reaches that no other branch, tag, or remote-tracking ref
 * does: what would exist only on this worktree's branch, or nowhere once a
 * detached HEAD's record goes.
 */
async function commitsOnlyHere(
  common: string,
  head: string | undefined,
  branch: string | undefined,
  signal: AbortSignal,
): Promise<ReadonlyArray<UnpushedCommit> | undefined> {
  if (head === undefined || !/^[0-9a-f]{40,64}$/.test(head)) return undefined;
  const result = await runHostGit(
    [
      "-C",
      common,
      "log",
      `--max-count=${COUNTED_COMMITS}`,
      "--format=%H%x00%s",
      head,
      "--not",
      // `--branches` matches its exclusions against the short branch name.
      ...(branch === undefined ? [] : [`--exclude=${branch.replace(/[\\*?[]/g, "\\$&")}`]),
      "--branches",
      "--tags",
      "--remotes",
    ],
    signal,
  );
  if (result.exitCode !== 0) return undefined;
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash = "", subject = ""] = line.split("\0");
      return { hash, subject: subject.slice(0, 200) };
    });
}

async function newestAdminChange(admin: string): Promise<number | undefined> {
  let newest: number | undefined;
  for (const name of ["HEAD", "index", join("logs", "HEAD")]) {
    const modified = await lstat(join(admin, name))
      .then((status) => status.mtimeMs)
      .catch(() => undefined);
    if (modified !== undefined && (newest === undefined || modified > newest)) newest = modified;
  }
  return newest;
}

function isInside(root: string, path: string): boolean {
  const within = relative(resolve(root), resolve(path));
  return within.length > 0 && !within.startsWith("..") && !isAbsolute(within);
}

function refused(
  reason: Extract<HostWorktreeRemoval, { status: "refused" }>["reason"],
  detail?: string,
): HostWorktreeRemoval {
  return detail === undefined
    ? { status: "refused", reason }
    : { status: "refused", reason, detail };
}

function firstLine(text: string): string | undefined {
  const line = text.split("\n").find((entry) => entry.trim() !== "");
  return line?.trim().slice(0, 300);
}

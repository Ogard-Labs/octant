import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { measureFolder, type FolderSize } from "./archivedWorktrees";
import { hostPathKey, sameHostPath } from "./hostPaths";
import { parseWorktreeList, runHostGit, type ListedWorktree } from "./hostGitReads";

/**
 * Folders a scan never enters: package and toolchain caches, the Trash, and
 * the platform's per-user application data. Nothing an agent makes a worktree
 * in lives there, and they hold most of a home folder's files. Agents' own
 * hidden folders (where several keep their worktrees) are walked.
 */
const SKIPPED_NAMES = new Set([
  "node_modules",
  ".Trash",
  ".Trashes",
  "$Recycle.Bin",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".cargo",
  ".rustup",
  ".gradle",
  ".m2",
  ".nvm",
  ".bun",
  ".deno",
  ".docker",
  ".venv",
  "__pycache__",
  "Pods",
  "DerivedData",
]);
/** Skipped only directly under the home folder, where they hold app data. */
const SKIPPED_AT_HOME: Readonly<Partial<Record<NodeJS.Platform, ReadonlySet<string>>>> = {
  darwin: new Set(["Library"]),
  win32: new Set(["AppData"]),
  linux: new Set([".local"]),
};

export interface ScanLimits {
  readonly maxEntries: number;
  readonly maxMs: number;
  readonly maxDepth: number;
  /** Entries one worktree's size walk reads before it reports a partial size. */
  readonly sizeEntries: number;
}

const DEFAULT_LIMITS: ScanLimits = {
  maxEntries: 400_000,
  maxMs: 20_000,
  maxDepth: 10,
  sizeEntries: 50_000,
};

export interface DiscoveredWorktree {
  readonly path: string;
  readonly branch?: string;
  readonly head?: string;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly missing: boolean;
  /** Its commit is on a remote-tracking branch or another local branch. */
  readonly delivered: boolean | undefined;
  /** The newest of Git's own records for it changing, in milliseconds. */
  readonly lastActivityMs: number | undefined;
  readonly size: FolderSize | undefined;
  readonly ownedByOctant: boolean;
}

export interface DiscoveredRepository {
  readonly path: string;
  readonly commonDirectory: string;
  readonly worktrees: ReadonlyArray<DiscoveredWorktree>;
}

export interface HostWorktreeScan {
  readonly repositories: ReadonlyArray<DiscoveredRepository>;
  /** False when the walk stopped at a bound before it read the whole home folder. */
  readonly complete: boolean;
  readonly problems: ReadonlyArray<string>;
}

export interface HostWorktreeDiscoveryDependencies {
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  /** Code Projects' bound folders; their repositories are listed whatever the walk finds. */
  readonly projectFolders: () => ReadonlyArray<string>;
  /** Folders of worktrees Octant made and still owns; those are cleaned up through their threads. */
  readonly ownedWorktreePaths: () => Promise<ReadonlySet<string>>;
  readonly now: () => number;
  readonly limits?: Partial<ScanLimits>;
}

/**
 * Finds the Git worktrees on this computer, whoever made them. A linked
 * worktree's `.git` is a file naming the folder Git keeps for it under its
 * repository's common folder, so each repository is found from its worktrees
 * and asked once, with `git worktree list`, for all of them, wherever they
 * are. The walk reads names only, never file contents beyond those `.git`
 * links, does not enter a repository's working tree once it found it, and
 * stops at a bound. Nothing is fetched, locked, or changed.
 */
export async function scanHostWorktrees(
  dependencies: HostWorktreeDiscoveryDependencies,
  signal: AbortSignal,
): Promise<HostWorktreeScan> {
  const limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
  const problems: string[] = [];
  const commons = new Map<string, string>();
  const remember = async (common: string) => {
    const canonical = await realpath(common).catch(() => undefined);
    if (canonical !== undefined && !commons.has(canonical)) commons.set(canonical, canonical);
  };

  const walk = await walkForGitLinks(dependencies, limits, signal);
  for (const common of walk.commons) await remember(common);
  for (const folder of dependencies.projectFolders()) {
    const result = await runHostGit(
      ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      signal,
    );
    if (result.exitCode === 0) await remember(result.stdout.trim());
  }

  const owned = await dependencies.ownedWorktreePaths();
  const platform = dependencies.platform;
  const ownedCanonical = new Set([...owned].map((path) => hostPathKey(path, platform)));
  const repositories: DiscoveredRepository[] = [];
  for (const common of commons.values()) {
    signal.throwIfAborted();
    const listed = await runHostGit(
      ["-C", common, "worktree", "list", "--porcelain", "-z"],
      signal,
    );
    if (listed.exitCode !== 0) {
      problems.push(
        `${common}: ${firstLine(listed.stderr) ?? "Git could not list its worktrees."}`,
      );
      continue;
    }
    const entries = parseWorktreeList(listed.stdout);
    const main = entries[0];
    if (main === undefined) continue;
    const linked = entries.slice(1).filter((entry) => !entry.bare);
    if (linked.length === 0) continue;
    const worktrees: DiscoveredWorktree[] = [];
    for (const entry of linked) {
      worktrees.push(await describe(common, entry, ownedCanonical, limits, platform, signal));
    }
    repositories.push({ path: main.path, commonDirectory: common, worktrees });
  }
  repositories.sort((a, b) => a.path.localeCompare(b.path));
  return { repositories, complete: walk.complete, problems };
}

async function describe(
  common: string,
  entry: ListedWorktree,
  owned: ReadonlySet<string>,
  limits: ScanLimits,
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<DiscoveredWorktree> {
  const missing = !(await isDirectory(entry.path));
  const admin = await worktreeAdminDirectory(common, entry.path, platform);
  const activity = admin === undefined ? undefined : await newestChange(admin);
  return {
    path: entry.path,
    ...(entry.branch === undefined ? {} : { branch: entry.branch }),
    ...(entry.head === undefined ? {} : { head: entry.head }),
    detached: entry.detached,
    locked: entry.locked !== undefined,
    missing,
    delivered:
      entry.head === undefined
        ? undefined
        : await isDelivered(common, entry.head, entry.branch, signal),
    lastActivityMs: activity,
    size: missing ? undefined : await measureFolder(entry.path, limits.sizeEntries),
    ownedByOctant: owned.has(hostPathKey(entry.path, platform)),
  };
}

/**
 * Whether a commit is safe somewhere other than this worktree's own branch:
 * on a remote-tracking branch (pushed) or another local branch (merged).
 */
export async function isDelivered(
  common: string,
  head: string,
  branch: string | undefined,
  signal: AbortSignal,
): Promise<boolean | undefined> {
  if (!/^[0-9a-f]{40,64}$/.test(head)) return undefined;
  const result = await runHostGit(
    [
      "-C",
      common,
      "for-each-ref",
      "--contains",
      head,
      "--format=%(refname)",
      "refs/remotes",
      "refs/heads",
    ],
    signal,
  );
  if (result.exitCode !== 0) return undefined;
  const own = branch === undefined ? undefined : `refs/heads/${branch}`;
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .some((name) => name.length > 0 && name !== own && !name.endsWith("/HEAD"));
}

/**
 * The folder Git keeps for a linked worktree, `worktrees/<name>` in the common
 * folder: the one whose `gitdir` names this worktree's `.git`. Found from the
 * common folder, so it is known even when the worktree's own folder is gone.
 */
export async function worktreeAdminDirectory(
  common: string,
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const root = join(common, "worktrees");
  let names: ReadonlyArray<string>;
  try {
    names = await readdir(root);
  } catch {
    return undefined;
  }
  const paths = platform === "win32" ? win32 : posix;
  const expected = paths.join(worktreePath, ".git");
  for (const name of names) {
    const admin = join(root, name);
    const gitdir = await readSmall(join(admin, "gitdir"));
    if (gitdir === undefined) continue;
    const named = gitdir.trim();
    const target = paths.isAbsolute(named) ? named : paths.join(admin, named);
    if (sameHostPath(target, expected, platform)) return admin;
  }
  return undefined;
}

async function newestChange(admin: string): Promise<number | undefined> {
  let newest: number | undefined;
  for (const name of ["HEAD", "index", join("logs", "HEAD")]) {
    const modified = await stat(join(admin, name))
      .then((status) => status.mtimeMs)
      .catch(() => undefined);
    if (modified !== undefined && (newest === undefined || modified > newest)) newest = modified;
  }
  return newest;
}

interface WalkResult {
  readonly commons: ReadonlyArray<string>;
  readonly complete: boolean;
}

async function walkForGitLinks(
  dependencies: HostWorktreeDiscoveryDependencies,
  limits: ScanLimits,
  signal: AbortSignal,
): Promise<WalkResult> {
  const started = dependencies.now();
  const home = resolve(dependencies.homeDirectory);
  const skippedAtHome = SKIPPED_AT_HOME[dependencies.platform] ?? new Set<string>();
  const commons: string[] = [];
  const pending: Array<{ readonly path: string; readonly depth: number }> = [
    { path: home, depth: 0 },
  ];
  let entries = 0;
  while (pending.length > 0) {
    signal.throwIfAborted();
    if (entries > limits.maxEntries || dependencies.now() - started > limits.maxMs) {
      return { commons, complete: false };
    }
    const folder = pending.shift();
    if (folder === undefined) break;
    let listing: ReadonlyArray<Dirent>;
    try {
      listing = await readdir(folder.path, { withFileTypes: true });
    } catch {
      continue;
    }
    entries += listing.length;
    const dotGit = listing.find((entry) => entry.name === ".git");
    if (dotGit !== undefined) {
      const path = join(folder.path, ".git");
      // A clone with no linked worktree has no `worktrees` folder; skipping
      // it keeps a home folder of many clones to one git run per repository
      // that actually has worktrees.
      if (dotGit.isDirectory()) {
        if (await hasEntries(join(path, "worktrees"))) commons.push(path);
      } else if (dotGit.isFile()) {
        const common = await commonOfLinkedWorktree(path);
        if (common !== undefined) commons.push(common);
      }
      // A repository's working tree holds its files, not other repositories'
      // worktrees; its own linked worktrees come from `git worktree list`.
      continue;
    }
    if (folder.depth >= limits.maxDepth) continue;
    for (const entry of listing) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIPPED_NAMES.has(entry.name)) continue;
      if (folder.path === home && skippedAtHome.has(entry.name)) continue;
      pending.push({ path: join(folder.path, entry.name), depth: folder.depth + 1 });
    }
  }
  return { commons, complete: true };
}

/**
 * The common Git folder a linked worktree's `.git` file leads to: its
 * `gitdir` names `worktrees/<name>`, whose `commondir` names the common
 * folder. A submodule's `.git` names a folder under `modules` instead, which
 * is not a worktree, and is skipped.
 */
export async function commonOfLinkedWorktree(dotGit: string): Promise<string | undefined> {
  const link = await readSmall(dotGit);
  const match = link === undefined ? null : /^gitdir: (.+)$/m.exec(link);
  if (match?.[1] === undefined) return undefined;
  const named = match[1].trim();
  const admin = isAbsolute(named) ? resolve(named) : resolve(dirname(dotGit), named);
  if (basename(dirname(admin)) !== "worktrees") return undefined;
  const commondir = (await readSmall(join(admin, "commondir")))?.trim();
  if (commondir === undefined || commondir === "") return undefined;
  return isAbsolute(commondir) ? resolve(commondir) : resolve(admin, commondir);
}

/** A link file Git writes is a line or two; anything larger or not a file reads as nothing. */
async function readSmall(path: string): Promise<string | undefined> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.size > 64 * 1024) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function hasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(text: string): string | undefined {
  const line = text.split("\n").find((entry) => entry.trim() !== "");
  return line?.trim().slice(0, 300);
}

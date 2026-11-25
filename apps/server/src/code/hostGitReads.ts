import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGitCommandEnvironment } from "../gitEnvironmentPort";

const execFileAsync = promisify(execFile);

/**
 * The environment the host reads a repository with when it is not inside any
 * sandbox. A repository's own config can make `git status` run programs: a
 * `core.fsmonitor` command on every status, and the clean filter of each file
 * it rehashes. These are pinned off or checked before status runs, the
 * optional index lock is skipped so another git is never blocked, and the
 * global config is left out, as for every other host git read.
 */
export function hostGitReadEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...createGitCommandEnvironment(inherited),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_PAGER: "cat",
  };
}

export interface HostGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git with an argument vector, never a shell, under the read environment. */
export async function runHostGit(
  args: ReadonlyArray<string>,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<HostGitResult> {
  try {
    const result = await execFileAsync("git", ["--no-pager", ...args], {
      encoding: "utf8",
      env: hostGitReadEnvironment(process.env),
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      signal,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (signal.aborted) throw error;
    if (typeof error === "object" && error !== null) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        stderr: typeof failure.stderr === "string" ? failure.stderr : "",
      };
    }
    throw error;
  }
}

/**
 * The filter drivers a repository's own config gives a command to, from
 * `git config --list --show-scope -z`. Only the local and worktree scopes
 * count: those are what the repository's contents, or an agent working in
 * it, can set. Filters from the person's global or system config (Git LFS's)
 * run for every git command they type and are theirs to choose.
 */
export function repositoryFilterCommands(configList: string): ReadonlyArray<string> {
  const drivers = new Set<string>();
  const fields = configList.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index];
    const entry = fields[index + 1] ?? "";
    if (scope !== "local" && scope !== "worktree") continue;
    const newline = entry.indexOf("\n");
    const key = (newline === -1 ? entry : entry.slice(0, newline)).toLowerCase();
    const value = newline === -1 ? "" : entry.slice(newline + 1);
    const match = /^filter\.(.+)\.(clean|process)$/.exec(key);
    if (match?.[1] !== undefined && value.trim() !== "") drivers.add(match[1]);
  }
  return [...drivers];
}

export type WorktreeStatusReading =
  | Readonly<{ status: "observed"; changedPaths: number }>
  | Readonly<{ status: "runs-filters"; filters: ReadonlyArray<string> }>
  | Readonly<{ status: "failed" }>;

/**
 * Counts a worktree's changed and untracked paths without running anything the
 * repository configured. A repository whose own config sets a filter command is
 * not read at all: status would run that command on the host.
 */
export async function readWorktreeStatus(
  worktreePath: string,
  signal: AbortSignal,
): Promise<WorktreeStatusReading> {
  const config = await runHostGit(
    ["-C", worktreePath, "config", "--list", "--show-scope", "-z"],
    signal,
  );
  if (config.exitCode !== 0) return { status: "failed" };
  const filters = repositoryFilterCommands(config.stdout);
  if (filters.length > 0) return { status: "runs-filters", filters };
  const status = await runHostGit(
    [
      "-C",
      worktreePath,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
      "--ignore-submodules=dirty",
    ],
    signal,
  );
  if (status.exitCode !== 0) return { status: "failed" };
  return {
    status: "observed",
    changedPaths: status.stdout.split("\0").filter((entry) => entry.length > 0).length,
  };
}

/**
 * Counts the files a worktree holds that no commit does: untracked files and
 * ignored ones alike, and empty folders, which Git cannot keep. These are what
 * removing the folder would lose for good. Like the status read, it runs
 * nothing the repository configured and refuses a repository whose own config
 * names a filter command.
 */
export async function readUntrackedAndIgnored(
  worktreePath: string,
  signal: AbortSignal,
): Promise<WorktreeStatusReading> {
  const config = await runHostGit(
    ["-C", worktreePath, "config", "--list", "--show-scope", "-z"],
    signal,
  );
  if (config.exitCode !== 0) return { status: "failed" };
  const filters = repositoryFilterCommands(config.stdout);
  if (filters.length > 0) return { status: "runs-filters", filters };
  // With no exclude option nothing is left out, so ignored files are listed
  // with the rest; `--directory` keeps a large ignored folder to one entry.
  const listed = await runHostGit(
    ["-C", worktreePath, "ls-files", "--others", "--directory", "-z"],
    signal,
  );
  if (listed.exitCode !== 0) return { status: "failed" };
  return {
    status: "observed",
    changedPaths: listed.stdout.split("\0").filter((entry) => entry.length > 0).length,
  };
}

export type CleanupHazardReading =
  | Readonly<{
      status: "observed";
      /**
       * `hidden-edits`: Git was told not to look at some files, so an edit to
       * them shows in neither status nor a refusing removal. `unsupported`: a
       * sparse checkout, a submodule or an operation under way, none of which a
       * plain removal and restore can give back whole.
       */
      hazard?: "hidden-edits" | "unsupported";
    }>
  | Readonly<{ status: "failed" }>;

/** Files Git keeps in a worktree's own directory while one of these operations runs. */
const OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "BISECT_START",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
] as const;

/**
 * Finds what makes removing a clean-looking worktree lose work or fail: a file
 * marked skip-worktree or assume-unchanged (an edit to it is invisible to
 * status and to removal), a sparse checkout, a submodule, or a merge, rebase,
 * cherry-pick, revert or bisect under way. Any read that fails, or whose output
 * does not fit the bound, is a failure, never an all clear.
 */
export async function readCleanupHazard(
  worktreePath: string,
  signal: AbortSignal,
): Promise<CleanupHazardReading> {
  const sparse = await runHostGit(
    ["-C", worktreePath, "config", "--type=bool", "--get", "core.sparseCheckout"],
    signal,
  );
  if (sparse.exitCode === 0 && sparse.stdout.trim() === "true") {
    return { status: "observed", hazard: "unsupported" };
  }
  if (sparse.exitCode !== 0 && sparse.exitCode !== 1) return { status: "failed" };

  const tagged = await runHostGit(["-C", worktreePath, "ls-files", "-v", "-z"], signal);
  if (tagged.exitCode !== 0) return { status: "failed" };
  // Each entry is a one-letter tag, a space and the path; `S` is skip-worktree
  // and a lowercase tag is assume-unchanged.
  if (tagged.stdout.split("\0").some((entry) => /^[a-zS] /.test(entry))) {
    return { status: "observed", hazard: "hidden-edits" };
  }

  const staged = await runHostGit(["-C", worktreePath, "ls-files", "-s", "-z"], signal);
  if (staged.exitCode !== 0) return { status: "failed" };
  if (staged.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) {
    return { status: "observed", hazard: "unsupported" };
  }
  const modules = await runHostGit(
    ["-C", worktreePath, "ls-files", "-z", "--", ".gitmodules"],
    signal,
  );
  if (modules.exitCode !== 0) return { status: "failed" };
  if (modules.stdout.length > 0) return { status: "observed", hazard: "unsupported" };

  const directory = await runHostGit(
    ["-C", worktreePath, "rev-parse", "--absolute-git-dir"],
    signal,
  );
  if (directory.exitCode !== 0) return { status: "failed" };
  const gitDirectory = directory.stdout.trim();
  if (gitDirectory.length === 0) return { status: "failed" };
  for (const marker of OPERATION_MARKERS) {
    try {
      await lstat(join(gitDirectory, marker));
      return { status: "observed", hazard: "unsupported" };
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") return { status: "failed" };
    }
  }
  return { status: "observed" };
}

export type RemovalDamageReading =
  | Readonly<{
      status: "observed";
      /** Tracked files gone from the folder and from nothing else: the index still holds them. */
      missingTrackedFiles: number;
      /** Every other change: edits, staged changes, files no commit holds. */
      otherChanges: number;
    }>
  | Readonly<{ status: "runs-filters" | "failed" }>;

/**
 * What a removal that stopped part way left in the folder. Like the status
 * read, it runs nothing the repository configured. Empty folders are not
 * counted, since a removal leaves them behind.
 */
export async function readRemovalDamage(
  worktreePath: string,
  signal: AbortSignal,
): Promise<RemovalDamageReading> {
  const config = await runHostGit(
    ["-C", worktreePath, "config", "--list", "--show-scope", "-z"],
    signal,
  );
  if (config.exitCode !== 0) return { status: "failed" };
  if (repositoryFilterCommands(config.stdout).length > 0) return { status: "runs-filters" };
  const status = await runHostGit(
    [
      "-C",
      worktreePath,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
      "--ignore-submodules=dirty",
    ],
    signal,
  );
  if (status.exitCode !== 0) return { status: "failed" };
  const entries = status.stdout.split("\0").filter((entry) => entry.length > 0);
  const missing = entries.filter((entry) => entry.startsWith(" D ")).length;
  const loose = await runHostGit(
    ["-C", worktreePath, "ls-files", "--others", "--directory", "--no-empty-directory", "-z"],
    signal,
  );
  if (loose.exitCode !== 0) return { status: "failed" };
  const untracked = loose.stdout.split("\0").filter((entry) => entry.length > 0).length;
  return {
    status: "observed",
    missingTrackedFiles: missing,
    otherChanges: entries.length - missing + untracked,
  };
}

export interface ListedWorktree {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked?: string;
  readonly prunable?: string;
}

/** Parses `git worktree list --porcelain -z`; the first entry is the main worktree. */
export function parseWorktreeList(output: string): ReadonlyArray<ListedWorktree> {
  const listed: ListedWorktree[] = [];
  let current: { -readonly [Key in keyof ListedWorktree]: ListedWorktree[Key] } | undefined;
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current !== undefined) listed.push(current);
      current = undefined;
      continue;
    }
    const space = field.indexOf(" ");
    const label = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (label === "worktree") {
      if (current !== undefined) listed.push(current);
      current = { path: value, detached: false, bare: false };
    } else if (current === undefined) {
      continue;
    } else if (label === "HEAD") current.head = value;
    else if (label === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (label === "detached") current.detached = true;
    else if (label === "bare") current.bare = true;
    else if (label === "locked") current.locked = value;
    else if (label === "prunable") current.prunable = value;
  }
  if (current !== undefined) listed.push(current);
  return listed;
}

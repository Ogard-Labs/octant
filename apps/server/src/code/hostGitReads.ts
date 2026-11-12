import { execFile } from "node:child_process";
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

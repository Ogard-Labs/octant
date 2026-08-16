import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import {
  observeRepositoryIdentity,
  type FileSystemIdentity,
  type GitCommandResult,
} from "./repositoryIdentity";
import type {
  ManagedWorktreeFileSystemPort,
  ManagedWorktreeGitPort,
  ManagedWorktreeRepositoryPort,
} from "./managedWorktreeService";

const execFileAsync = promisify(execFile);
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
};

async function statIdentity(path: string): Promise<FileSystemIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink()) throw new Error("filesystem identity is unavailable");
  return { device: metadata.dev.toString(10), inode: metadata.ino.toString(10) };
}

async function run(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync(executable, [...args], {
      encoding: "utf8",
      env: gitEnvironment,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      signal,
    });
    return { exitCode: 0, stdout: result.stdout };
  } catch (error) {
    if (signal.aborted) throw error;
    if (isExecFailure(error)) {
      return {
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
      };
    }
    throw error;
  }
}

export function createManagedWorktreeNodePorts(): {
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly filesystem: ManagedWorktreeFileSystemPort;
  readonly git: ManagedWorktreeGitPort;
} {
  const repository: ManagedWorktreeRepositoryPort = {
    observe: (root, signal) =>
      observeRepositoryIdentity(
        root,
        {
          isMissingError,
          realpath,
          statIdentity,
          runGit: (args, commandSignal) => run("git", args, commandSignal),
        },
        signal,
      ),
  };

  const filesystem: ManagedWorktreeFileSystemPort = {
    observeParent: async (path) => {
      try {
        const canonicalPath = await realpath(path);
        return {
          status: "available",
          parent: { canonicalPath, identity: await statIdentity(canonicalPath) },
        };
      } catch (error) {
        return isMissingError(error) ? { status: "unavailable" } : { status: "failed" };
      }
    },
    pathExists: async (path) => {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if (isMissingError(error)) return false;
        throw error;
      }
    },
  };

  const git: ManagedWorktreeGitPort = {
    resolveRef: async (repositoryRoot, refIntent, signal) => {
      if (!validRefIntent(refIntent)) return { status: "ambiguous" };
      const result = await run(
        "git",
        [
          "-C",
          repositoryRoot,
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${refIntent}^{commit}`,
        ],
        signal,
      );
      if (result.exitCode !== 0)
        return result.exitCode === 128 ? { status: "missing" } : { status: "failed" };
      const oid = result.stdout.trim();
      return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)
        ? { status: "resolved", oid }
        : { status: "ambiguous" };
    },
    branchExists: async (repositoryRoot, branchIntent, signal) => {
      const validation = await run("git", ["check-ref-format", "--branch", branchIntent], signal);
      if (validation.exitCode !== 0) throw new Error("invalid Git branch intent");
      const result = await run(
        "git",
        ["-C", repositoryRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchIntent}`],
        signal,
      );
      if (result.exitCode === 0) return true;
      if (result.exitCode === 1) return false;
      throw new Error("Git branch observation failed");
    },
    addWorktree: async (input, signal) => {
      const result = await run(
        "git",
        [
          "-C",
          input.repositoryRoot,
          "worktree",
          "add",
          "--no-guess-remote",
          "-b",
          input.branchIntent,
          input.targetPath,
          input.startPoint,
        ],
        signal,
      );
      return { status: result.exitCode === 0 ? "created" : "rejected" };
    },
    isDirty: async (targetPath, signal) => {
      const result = await run(
        "git",
        ["-C", targetPath, "status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        signal,
      );
      return result.exitCode === 0
        ? { status: "observed", dirty: result.stdout.length > 0 }
        : { status: "failed" };
    },
    fetchRemote: async (repositoryRoot, remoteName, branchName, signal) => {
      const result = await run(
        "git",
        ["-C", repositoryRoot, "fetch", "--quiet", remoteName],
        signal,
      );
      if (result.exitCode !== 0) {
        return result.exitCode === 128 ? { status: "interrupted" } : { status: "failed" };
      }
      // Resolve the selected remote-tracking branch to the exact fetched commit.
      const headResult = await run(
        "git",
        ["-C", repositoryRoot, "rev-parse", "--verify", `refs/remotes/${remoteName}/${branchName}`],
        signal,
      );
      if (headResult.exitCode !== 0) {
        return { status: "failed" };
      }
      const remoteHead = headResult.stdout.trim();
      if (!/^[a-f0-9]{40}$/.test(remoteHead)) {
        return { status: "failed" };
      }
      return { status: "fetched", remoteHead };
    },
    removeWorktree: async (input, signal) => {
      const result = await run(
        "git",
        ["-C", input.repositoryRoot, "worktree", "remove", "--", input.targetPath],
        signal,
      );
      return { status: result.exitCode === 0 ? "removed" : "rejected" };
    },
  };

  return { repository, filesystem, git };
}

function validRefIntent(value: string): boolean {
  return (
    /^(?:refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+|[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/")
  );
}

export interface WorktreeRefEntry {
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly remoteName?: string;
  readonly isCurrent?: boolean;
  readonly hasWorktree?: boolean;
}

/**
 * Lists local branches and remote-tracking refs for the composer's branch
 * selector, most recently committed first. Fails closed with an empty list.
 */
export async function listWorktreeRefs(
  repositoryRoot: string,
  signal: AbortSignal,
): Promise<ReadonlyArray<WorktreeRefEntry>> {
  const refs = await run(
    "git",
    [
      "-C",
      repositoryRoot,
      "for-each-ref",
      "--format=%(HEAD)%09%(refname:short)%09%(refname)",
      "--sort=-committerdate",
      "refs/heads",
      "refs/remotes",
    ],
    signal,
  );
  if (refs.exitCode !== 0) return [];
  const worktreeBranches = new Set<string>();
  const worktrees = await run(
    "git",
    ["-C", repositoryRoot, "worktree", "list", "--porcelain"],
    signal,
  );
  if (worktrees.exitCode === 0) {
    for (const line of worktrees.stdout.split("\n")) {
      if (line.startsWith("branch refs/heads/")) {
        worktreeBranches.add(line.slice("branch refs/heads/".length).trim());
      }
    }
  }
  const entries: WorktreeRefEntry[] = [];
  for (const line of refs.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [head, short, full] = line.split("\t");
    if (short === undefined || full === undefined || short === "") continue;
    if (full.startsWith("refs/heads/")) {
      entries.push({
        name: short,
        kind: "local",
        ...(head === "*" ? { isCurrent: true } : {}),
        ...(worktreeBranches.has(short) ? { hasWorktree: true } : {}),
      });
    } else if (full.startsWith("refs/remotes/") && !short.endsWith("/HEAD")) {
      const remoteName = short.split("/")[0];
      entries.push({
        name: short,
        kind: "remote",
        ...(remoteName === undefined ? {} : { remoteName }),
      });
    }
    if (entries.length >= 200) break;
  }
  return entries;
}

function isMissingError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isExecFailure(
  error: unknown,
): error is { readonly code?: string | number; readonly stdout?: string } {
  return isRecord(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

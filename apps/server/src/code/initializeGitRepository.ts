import { execFile as nodeExecFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { childProcessEnvironment } from "../childProcessEnvironment";

const execFileAsync = promisify(nodeExecFile);

export type InitializeGitRepositoryResult =
  | { readonly status: "initialized" }
  | { readonly status: "already-repository" }
  | { readonly status: "failed"; readonly message: string };

/**
 * Initialize `root` as a Git repository when the caller explicitly asked.
 *
 * Already-a-repository is success (no-op). Failure is a value so Project
 * creation can refuse before journaling rather than throw through unrelated
 * catch paths.
 */
export async function initializeGitRepository(
  root: string,
): Promise<InitializeGitRepositoryResult> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
    const details = await stat(canonicalRoot);
    if (!details.isDirectory()) {
      return { status: "failed", message: "Project root is not a directory." };
    }
  } catch {
    return { status: "failed", message: "Project root is unavailable." };
  }

  if (await isGitRepositoryTopLevel(canonicalRoot)) {
    return { status: "already-repository" };
  }

  try {
    await execFileAsync("git", ["-C", canonicalRoot, "init", "-b", "main"], {
      encoding: "utf8",
      env: childProcessEnvironment(process.env),
      shell: false,
    });
  } catch {
    return {
      status: "failed",
      message: "Octant could not initialize a Git repository in the chosen folder.",
    };
  }

  if (!(await isGitRepositoryTopLevel(canonicalRoot))) {
    return {
      status: "failed",
      message: "Octant could not initialize a Git repository in the chosen folder.",
    };
  }
  return { status: "initialized" };
}

async function isGitRepositoryTopLevel(canonicalRoot: string): Promise<boolean> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", canonicalRoot, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        env: childProcessEnvironment(process.env),
        shell: false,
      },
    );
    const reportedRoot = await realpath(result.stdout.trim());
    return reportedRoot === canonicalRoot;
  } catch {
    return false;
  }
}

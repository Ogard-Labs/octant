// The Git half of a Code handover: when a thread cannot move, its work is
// committed to its branch with a note and pushed, so the person picks it up on
// any computer that can fetch that branch. Canonical:
// docs/design/hub-and-spokes.md "Handover".
//
// The commit is built from a throwaway index, so the checkout is never
// switched: a thread on the default branch or a detached head gets a new
// `octant/handover/…` branch that the checkout does not move to. A changed
// file the Secret guard finds a secret in stays out of the commit and is
// listed. Ignored files never travel. The push is never forced and never goes
// to the default branch.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { holdsSecret } from "./codeThreadMoveGit";

const run = promisify(execFile);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** What `update-ref` reads as "this ref must not exist yet". */
const NO_OBJECT = "0".repeat(40);

async function git(
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  const { stdout } = await run("git", [...args], {
    cwd,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.trim();
}

/** What the checkout looks like before a handover, for its note and its branch. */
export interface HandoverCheckout {
  readonly head: string;
  /** The checked-out branch; absent for a detached head. */
  readonly branch?: string;
  /** The remote's default branch, or `main` when the remote names none. */
  readonly defaultBranch: string;
  /** Files changed against the branch's base, as Git names them (`M app.ts`). */
  readonly changes: ReadonlyArray<string>;
  readonly ignoredFiles: number;
  /** The remote a push goes to: the one the branch tracks, else `origin`, else the first. */
  readonly remote?: string;
  /** That remote's URL, which a destination matches its own clone against. */
  readonly remoteUrl?: string;
}

export async function readHandoverCheckout(root: string): Promise<HandoverCheckout> {
  const head = await git(root, ["rev-parse", "HEAD"]);
  const branch = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
  const remoteHead = await git(root, [
    "symbolic-ref",
    "--short",
    "-q",
    "refs/remotes/origin/HEAD",
  ]).catch(() => "");
  const defaultBranch = remoteHead.length > 0 ? remoteHead.replace(/^origin\//, "") : "main";
  const changes = (await git(root, ["status", "--porcelain", "-z"]))
    .split("\0")
    .filter((entry) => entry.length > 3 && !entry.startsWith("!!"))
    .map((entry) => `${entry.slice(0, 2).trim() || "?"} ${entry.slice(3)}`);
  const ignoredFiles = (await git(root, ["status", "--porcelain", "--ignored", "-z"]))
    .split("\0")
    .filter((entry) => entry.startsWith("!! ")).length;
  const remote = await pushRemote(root, branch);
  const remoteUrl =
    remote === undefined ? "" : await git(root, ["remote", "get-url", remote]).catch(() => "");
  return {
    head,
    ...(branch.length > 0 ? { branch } : {}),
    defaultBranch,
    changes,
    ignoredFiles,
    ...(remote === undefined ? {} : { remote }),
    ...(remoteUrl.length > 0 ? { remoteUrl } : {}),
  };
}

async function pushRemote(root: string, branch: string): Promise<string | undefined> {
  const tracked =
    branch.length === 0
      ? ""
      : await git(root, ["config", "--get", `branch.${branch}.remote`]).catch(() => "");
  const remotes = (await git(root, ["remote"])).split("\n").filter((name) => name.length > 0);
  if (tracked.length > 0 && remotes.includes(tracked)) return tracked;
  return remotes.includes("origin") ? "origin" : remotes[0];
}

export type HandoverCommitOutcome =
  | {
      readonly status: "committed";
      readonly commit: string;
      readonly refusedFiles: ReadonlyArray<string>;
    }
  | { readonly status: "refused"; readonly reason: "nothing-to-commit" | "commit-failed" };

/**
 * Commits every change Git does not ignore onto `branch`, with `message` as
 * the commit message, without switching the checkout. When `branch` is the
 * one checked out, the checkout's index follows the new commit and its files
 * stay as they are, so only a refused file still reads as changed.
 */
export async function commitHandover(input: {
  readonly checkoutRoot: string;
  readonly branch: string;
  readonly message: string;
}): Promise<HandoverCommitOutcome> {
  const root = input.checkoutRoot;
  const scratch = await mkdtemp(join(tmpdir(), "octant-handover-index-"));
  try {
    const head = await git(root, ["rev-parse", "HEAD"]);
    const checkedOut = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    // Read from a tree, so the index carries no timestamps and every file is
    // compared by content.
    await git(root, ["read-tree", head], env);
    await git(root, ["add", "-A", "--", "."], env);
    const changed = (
      await git(root, ["diff", "--cached", "--name-only", "--no-renames", "-z", head], env)
    )
      .split("\0")
      .filter((path) => path.length > 0);
    const refusedFiles: string[] = [];
    for (const path of changed) {
      if (await holdsSecret(join(root, path))) refusedFiles.push(path);
    }
    for (const path of refusedFiles) await git(root, ["reset", "-q", head, "--", path], env);
    const tree = await git(root, ["write-tree"], env);
    if (tree === (await git(root, ["rev-parse", `${head}^{tree}`]))) {
      return { status: "refused", reason: "nothing-to-commit" };
    }
    const made = await commitWithMessage(root, tree, head, input.message);
    // Guarded by the value the branch must hold: the checked-out branch still
    // at HEAD, or a new handover branch that does not exist yet, so a
    // handover never moves a branch someone else changed meanwhile.
    const expected = input.branch === checkedOut ? head : NO_OBJECT;
    await git(root, ["update-ref", `refs/heads/${input.branch}`, made, expected]);
    if (input.branch === checkedOut) await git(root, ["reset", "-q"]);
    return { status: "committed", commit: made, refusedFiles };
  } catch {
    return { status: "refused", reason: "commit-failed" };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Writes the commit with the message on standard input, under the checkout's own identity. */
async function commitWithMessage(
  root: string,
  tree: string,
  parent: string,
  message: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["commit-tree", tree, "-p", parent, "-F", "-"],
      { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: GIT_MAX_BUFFER },
      (error, stdout) => (error === null ? resolve(stdout.trim()) : reject(error)),
    );
    child.stdin?.end(message);
  });
}

export type HandoverPushOutcome =
  | { readonly status: "pushed"; readonly remote: string }
  | { readonly status: "not-pushed"; readonly shortfall: "push-failed" | "no-remote" };

/**
 * Pushes the handover branch to the remote it tracks, or `origin`. Never
 * forced and never to the default branch: a branch the remote moved past is
 * refused by Git, and the commit then stays on this computer.
 */
export async function pushHandover(input: {
  readonly checkoutRoot: string;
  readonly branch: string;
  readonly defaultBranch: string;
}): Promise<HandoverPushOutcome> {
  const root = input.checkoutRoot;
  if (input.branch === input.defaultBranch)
    return { status: "not-pushed", shortfall: "push-failed" };
  const remote = await pushRemote(root, input.branch);
  if (remote === undefined) return { status: "not-pushed", shortfall: "no-remote" };
  try {
    await git(root, ["push", remote, `refs/heads/${input.branch}:refs/heads/${input.branch}`]);
    return { status: "pushed", remote };
  } catch {
    return { status: "not-pushed", shortfall: "push-failed" };
  }
}

/**
 * Fetches a handover branch into a destination clone with that clone's own
 * Git identity and reads the note from its tip: the commit message, only when
 * its trailer names this handover. Anything else reads as no note.
 */
export async function readHandoverNote(input: {
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly handoverId: string;
}): Promise<string | undefined> {
  const root = input.repositoryRoot;
  try {
    await git(root, [
      "fetch",
      "--quiet",
      "origin",
      `refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`,
    ]);
    const message = await git(root, [
      "log",
      "-1",
      "--format=%B",
      `refs/remotes/origin/${input.branch}`,
    ]);
    return message.includes(`Octant-Handover: ${input.handoverId}`) ? message : undefined;
  } catch {
    return undefined;
  }
}

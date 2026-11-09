// The Git half of moving a Code thread. The source captures the checkout as
// two snapshot commits that never join the branch (the index, then the
// working tree on top of it, so a file staged at one version and edited again
// keeps both), and bundles them with the branch's commits the remote does not
// hold. The destination fetches the bundle into its own clone and reads the
// head and both trees back, ready to lay over a managed worktree.
//
// Files that would travel are read once: one the Secret guard finds a secret
// in stays behind and is listed. Ignored files never travel; the source counts
// them so the worktree that holds them is kept.

import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "@octant/domain";

const run = promisify(execFile);
/** A changed file larger than this is not read for secrets; it travels as it is. */
const SECRET_SCAN_LIMIT_BYTES = 2 * 1024 * 1024;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

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

/** The ref the move's snapshot commits are kept under, on both computers. */
export function moveSnapshotRef(moveId: string): string {
  return `refs/octant/moves/${moveId}/worktree`;
}

export interface CapturedCheckout {
  /** The checked-out commit the snapshots sit on. */
  readonly head: string;
  /** The checked-out branch; absent for a detached head. */
  readonly branch?: string;
  readonly remotes: ReadonlyArray<string>;
  /** Paths whose change the Secret guard refused; they stay behind. */
  readonly refusedFiles: ReadonlyArray<string>;
  /** How many ignored files the checkout holds; none of them travel. */
  readonly ignoredFiles: number;
}

/**
 * Captures a checkout for a move and writes its bundle to `bundlePath`. The
 * checkout itself is not changed: the working-tree snapshot is built in a
 * throwaway index, and the snapshot commits live only under the move's ref.
 */
export async function captureCheckoutForMove(input: {
  readonly checkoutRoot: string;
  readonly moveId: string;
  readonly bundlePath: string;
}): Promise<CapturedCheckout> {
  const root = input.checkoutRoot;
  const head = await git(root, ["rev-parse", "HEAD"]);
  const branch = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
  const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);

  const scratch = await mkdtemp(join(tmpdir(), "octant-move-index-"));
  try {
    // Two throwaway indexes, so the checkout's own index is never changed: one
    // for the staged snapshot, one for the working tree as it stands on disk.
    const stagedIndex = join(scratch, "staged");
    const scratchIndex = join(scratch, "worktree");
    await copyFile(join(gitDir, "index"), stagedIndex).catch(() => undefined);
    const withStagedIndex = { GIT_INDEX_FILE: stagedIndex };
    const withScratchIndex = { GIT_INDEX_FILE: scratchIndex };
    // Everything Git does not ignore, tracked or not, as it stands on disk.
    await indexDisk(root, scratchIndex, await git(root, ["write-tree"], withStagedIndex));
    const changedIn = async (env: Readonly<Record<string, string>>) =>
      (await git(root, ["diff", "--cached", "--name-only", "--no-renames", "-z", head], env))
        .split("\0")
        .filter((path) => path.length > 0);
    const changed = [
      ...new Set([...(await changedIn(withStagedIndex)), ...(await changedIn(withScratchIndex))]),
    ];
    // Both versions of every changed file are read: a secret that is staged
    // and then edited out of the file on disk would otherwise still travel in
    // the staged snapshot.
    const refusedFiles: string[] = [];
    for (const path of changed) {
      if (
        (await holdsSecret(join(root, path))) ||
        holdsSecretText(await stagedText(root, path, withStagedIndex))
      ) {
        refusedFiles.push(path);
      }
    }
    for (const path of refusedFiles) {
      // A refused file keeps its committed version in both snapshots, or none.
      await git(root, ["reset", "-q", head, "--", path], withStagedIndex);
      await git(root, ["reset", "-q", head, "--", path], withScratchIndex);
    }
    const indexTree = await git(root, ["write-tree"], withStagedIndex);
    const worktreeTree = await git(root, ["write-tree"], withScratchIndex);

    const identity = {
      GIT_AUTHOR_NAME: "Octant",
      GIT_AUTHOR_EMAIL: "move@octant.invalid",
      GIT_COMMITTER_NAME: "Octant",
      GIT_COMMITTER_EMAIL: "move@octant.invalid",
    };
    const indexCommit = await git(
      root,
      ["commit-tree", indexTree, "-p", head, "-m", "Octant move: staged changes"],
      identity,
    );
    const worktreeCommit = await git(
      root,
      ["commit-tree", worktreeTree, "-p", indexCommit, "-m", "Octant move: working tree"],
      identity,
    );
    const ref = moveSnapshotRef(input.moveId);
    await git(root, ["update-ref", ref, worktreeCommit]);
    // The branch's commits the remote already holds stay out of the bundle;
    // the destination fetches those with its own identity.
    const remoteTips = (await git(root, ["for-each-ref", "--format=%(objectname)", "refs/remotes"]))
      .split("\n")
      .filter((line) => line.length > 0);
    await git(root, [
      "bundle",
      "create",
      input.bundlePath,
      ref,
      ...remoteTips.map((tip) => `^${tip}`),
    ]);

    const remoteNames = (await git(root, ["remote"])).split("\n").filter((name) => name.length > 0);
    const remotes: string[] = [];
    for (const name of remoteNames) {
      const url = await git(root, ["remote", "get-url", name]).catch(() => "");
      if (url.length > 0) remotes.push(url);
    }
    const ignored = (await git(root, ["status", "--porcelain", "--ignored", "-z"]))
      .split("\0")
      .filter((entry) => entry.startsWith("!! ")).length;
    return {
      head,
      ...(branch.length > 0 ? { branch } : {}),
      remotes,
      refusedFiles,
      ignoredFiles: ignored,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Fills a fresh index with the checkout as it stands on disk, starting from
 * `base`. The index is read from a tree, so it carries no file timestamps and
 * Git compares every file's content. A copy of the checkout's own index
 * carried them, and a file edited again within the same instant as its
 * staging matched by timestamp and size and kept its older content: CI saw a
 * snapshot with the staged version where the edited one belonged.
 */
async function indexDisk(root: string, indexFile: string, base: string): Promise<void> {
  const env = { GIT_INDEX_FILE: indexFile };
  await git(root, ["read-tree", base], env);
  await git(root, ["add", "-A", "--", "."], env);
}

/** Drops the move's snapshot ref from a checkout once the move is settled. */
export async function forgetMoveSnapshot(checkoutRoot: string, moveId: string): Promise<void> {
  await git(checkoutRoot, ["update-ref", "-d", moveSnapshotRef(moveId)]).catch(() => undefined);
}

export interface ReceivedCheckout {
  readonly head: string;
  readonly indexTree: string;
  readonly worktreeTree: string;
}

export type ReceiveCheckoutOutcome =
  | { readonly status: "received"; readonly checkout: ReceivedCheckout }
  /** The bundle's base is not in this clone and could not be fetched, or the bundle is not one. */
  | { readonly status: "refused"; readonly reason: "transfer-failed" };

/**
 * Fetches a move's bundle into the destination's clone and reads back what
 * it carries. A bundle whose base commits this clone lacks is refused after a
 * fetch from the clone's own remotes, with this computer's own identity.
 */
export async function receiveCheckoutFromMove(input: {
  readonly repositoryRoot: string;
  readonly moveId: string;
  readonly bundlePath: string;
}): Promise<ReceiveCheckoutOutcome> {
  const root = input.repositoryRoot;
  const verified = await git(root, ["bundle", "verify", "-q", input.bundlePath]).then(
    () => true,
    () => false,
  );
  if (!verified) {
    await git(root, ["fetch", "-q", "--all"]).catch(() => undefined);
    const again = await git(root, ["bundle", "verify", "-q", input.bundlePath]).then(
      () => true,
      () => false,
    );
    if (!again) return { status: "refused", reason: "transfer-failed" };
  }
  const ref = moveSnapshotRef(input.moveId);
  try {
    await git(root, ["fetch", "-q", input.bundlePath, `${ref}:${ref}`]);
    const worktreeTree = await git(root, ["rev-parse", `${ref}^{tree}`]);
    const indexTree = await git(root, ["rev-parse", `${ref}^1^{tree}`]);
    const head = await git(root, ["rev-parse", `${ref}^1^1`]);
    return { status: "received", checkout: { head, indexTree, worktreeTree } };
  } catch {
    return { status: "refused", reason: "transfer-failed" };
  }
}

async function holdsSecret(path: string): Promise<boolean> {
  let text: string;
  try {
    const bytes = await readFile(path);
    if (bytes.length > SECRET_SCAN_LIMIT_BYTES) return false;
    text = bytes.toString("utf8");
  } catch {
    // A deleted file carries no content to leak.
    return false;
  }
  return redactSecrets(text).redacted;
}

/**
 * Whether a checkout may be removed after its thread moved: its working tree
 * is exactly the snapshot the move carried (nothing was refused, and nothing
 * changed since), and it holds no ignored file. Otherwise it holds the only
 * copy of something, and the source keeps it.
 */
export async function checkoutStillMatchesMove(input: {
  readonly checkoutRoot: string;
  readonly moveId: string;
}): Promise<{ readonly matches: boolean; readonly ignoredFiles: number }> {
  const root = input.checkoutRoot;
  const snapshotTree = await git(root, [
    "rev-parse",
    `${moveSnapshotRef(input.moveId)}^{tree}`,
  ]).catch(() => "");
  const scratch = await mkdtemp(join(tmpdir(), "octant-move-check-"));
  try {
    const scratchIndex = join(scratch, "index");
    await indexDisk(root, scratchIndex, "HEAD");
    const currentTree = await git(root, ["write-tree"], { GIT_INDEX_FILE: scratchIndex });
    const ignoredFiles = (await git(root, ["status", "--porcelain", "--ignored", "-z"]))
      .split("\0")
      .filter((entry) => entry.startsWith("!! ")).length;
    return { matches: snapshotTree.length > 0 && snapshotTree === currentTree, ignoredFiles };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Moves a worktree out of the managed folder, so the purge of its thread
 * leaves it in place. Git keeps tracking it at its new path.
 */
export async function relocateWorktree(input: {
  readonly worktreeRoot: string;
  readonly target: string;
}): Promise<void> {
  await git(input.worktreeRoot, ["worktree", "move", input.worktreeRoot, input.target]);
}

/** Whether a local branch of that name already exists in a clone. */
export async function branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
  return git(repositoryRoot, ["show-ref", "--verify", "-q", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
}

/** The remote URLs a clone has. */
export async function repositoryRemotes(repositoryRoot: string): Promise<ReadonlyArray<string>> {
  const names = (await git(repositoryRoot, ["remote"]).catch(() => ""))
    .split("\n")
    .filter((name) => name.length > 0);
  const urls: string[] = [];
  for (const name of names) {
    const url = await git(repositoryRoot, ["remote", "get-url", name]).catch(() => "");
    if (url.length > 0) urls.push(url);
  }
  return urls;
}

/** The staged version of a file, or nothing when the index holds none or it is too large to read. */
async function stagedText(
  root: string,
  path: string,
  env: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const size = await git(root, ["cat-file", "-s", `:${path}`], env).catch(() => "");
  if (size.length === 0 || Number(size) > SECRET_SCAN_LIMIT_BYTES) return undefined;
  return git(root, ["show", `:${path}`], env).catch(() => undefined);
}

function holdsSecretText(text: string | undefined): boolean {
  return text !== undefined && redactSecrets(text).redacted;
}

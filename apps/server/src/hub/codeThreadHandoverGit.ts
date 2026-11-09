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
import { normalizeRepositoryRemote } from "@octant/domain";
import { branchExists, holdsSecret } from "./codeThreadMoveGit";

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
  const remote = await pushRemote(root, branch);
  // The default branch is the one the remote the work will go to names, not
  // origin's: a clone whose remote is `upstream` with `master` would
  // otherwise read as `main` and let a handover push straight to `master`.
  const remoteHead =
    remote === undefined
      ? ""
      : await git(root, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`]).catch(
          () => "",
        );
  const defaultBranch =
    remoteHead.length > 0
      ? remoteHead.slice(`${remote ?? ""}/`.length)
      : // Unknown: protect whichever conventional name the checkout is on.
        branch === "master"
        ? "master"
        : "main";
  const changes = (await git(root, ["status", "--porcelain", "-z"]))
    .split("\0")
    .filter((entry) => entry.length > 3 && !entry.startsWith("!!"))
    .map((entry) => `${entry.slice(0, 2).trim() || "?"} ${entry.slice(3)}`);
  const ignoredFiles = (await git(root, ["status", "--porcelain", "--ignored", "-z"]))
    .split("\0")
    .filter((entry) => entry.startsWith("!! ")).length;
  // The repository the branch is pushed to, which a separate `pushurl` makes
  // different from the one fetched from; the notice must name where it went.
  const remoteUrl =
    remote === undefined
      ? ""
      : await git(root, ["remote", "get-url", "--push", remote]).catch(() => "");
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
  /**
   * With nothing left to commit, still write a commit carrying the message,
   * so the branch tip holds this handover's note and trailer for the
   * destination to read. Only a branch that already holds the work asks this.
   */
  readonly noteWhenUnchanged?: boolean;
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
    if (
      input.noteWhenUnchanged !== true &&
      tree === (await git(root, ["rev-parse", `${head}^{tree}`]))
    ) {
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
 * Pushes the handover branch to the remote the person saw in the preview.
 * Never forced and never to the default branch: a branch the remote moved
 * past is refused by Git, and the commit then stays on this computer. The
 * remote is passed in, never worked out again here, because a new handover
 * branch tracks nothing and would fall back to `origin`, which can be
 * another repository than the one the preview named.
 */
export async function pushHandover(input: {
  readonly checkoutRoot: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly remote: string | undefined;
}): Promise<HandoverPushOutcome> {
  const root = input.checkoutRoot;
  if (input.branch === input.defaultBranch)
    return { status: "not-pushed", shortfall: "push-failed" };
  const { remote } = input;
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
  /** The remote the clone names the handover's repository by; see {@link remoteNamedFor}. */
  readonly remote: string;
  readonly branch: string;
  readonly handoverId: string;
}): Promise<{ readonly note: string; readonly commit: string } | undefined> {
  const root = input.repositoryRoot;
  try {
    await git(root, [
      "fetch",
      "--quiet",
      input.remote,
      `refs/heads/${input.branch}:refs/remotes/${input.remote}/${input.branch}`,
    ]);
    // The commit is read once and named by its id from here on, so the thread
    // starts from the very commit whose note was checked, even if the branch
    // moves before the thread is made.
    const commit = await git(root, [
      "rev-parse",
      "--verify",
      `refs/remotes/${input.remote}/${input.branch}^{commit}`,
    ]);
    const message = await git(root, ["log", "-1", "--format=%B", commit]);
    return message.includes(`Octant-Handover: ${input.handoverId}`)
      ? { note: message, commit }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The name a clone gives the repository a handover named by URL. A Project
 * whose matching remote is `upstream` rather than `origin` is still offered,
 * so the fetch and the new thread must use that remote, not `origin`.
 */
export async function remoteNamedFor(
  repositoryRoot: string,
  repositoryRemote: string,
): Promise<string | undefined> {
  const wanted = normalizeRepositoryRemote(repositoryRemote);
  if (wanted === undefined) return undefined;
  const names = (await git(repositoryRoot, ["remote"]).catch(() => ""))
    .split("\n")
    .filter((name) => name.length > 0);
  for (const name of names) {
    const url = await git(repositoryRoot, ["remote", "get-url", name]).catch(() => "");
    if (normalizeRepositoryRemote(url) === wanted) return name;
  }
  return undefined;
}

/**
 * A handover branch name the checkout does not have yet. Take back keeps the
 * earlier handover's branch, so a second handover of the same thread takes
 * the next free name instead of failing on the one already there.
 */
export async function unusedHandoverBranch(root: string, wanted: string): Promise<string> {
  if (!(await branchExists(root, wanted))) return wanted;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${wanted}-${String(attempt)}`;
    if (!(await branchExists(root, candidate))) return candidate;
  }
  return `${wanted}-${String(Date.now())}`;
}

/** A handover found on a branch this clone has already fetched, with no notice. */
export interface FoundHandover {
  readonly handoverId: string;
  /** The thread title the note's subject line names. */
  readonly title: string;
  /** The computer name the `Octant-Origin` trailer gives; a claim, never verified. */
  readonly originName: string;
  readonly remote: string;
  /** The repository the remote names, for matching Projects and the report. */
  readonly repositoryRemote: string;
  readonly branch: string;
  readonly commit: string;
  readonly committedAt: string;
}

/** The most handovers one clone lists; a repository full of them shows the newest. */
const FOUND_HANDOVERS_MAX = 64;
const HANDOVER_SUBJECT = "Hand over: ";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Handovers on the branches a clone has already fetched: every remote-tracking
 * tip whose message carries an `Octant-Handover` trailer. Nothing is fetched
 * here, so a branch shows up after the clone's next fetch, whoever runs it.
 * Anyone who can push to the repository can write such a branch, so what this
 * returns is only offered; continuing it is a person's act, and its note stays
 * outside content.
 */
export async function findHandoverBranches(
  repositoryRoot: string,
): Promise<ReadonlyArray<FoundHandover>> {
  // One record per tip, fields split by NUL and records by RS; only the
  // subject and the trailers are read, never a whole message. The trailers
  // are parsed here: older Git ignores a key filter in for-each-ref.
  const format = [
    "%(refname)",
    "%(objectname)",
    "%(committerdate:iso-strict)",
    "%(contents:subject)",
    "%(contents:trailers:unfold)",
  ].join("%00");
  const listed = await git(repositoryRoot, [
    "for-each-ref",
    "--sort=-committerdate",
    `--format=${format}%1e`,
    "refs/remotes",
  ]).catch(() => "");
  const urls = new Map<string, string>();
  const found: FoundHandover[] = [];
  for (const record of listed.split("\x1e")) {
    const [ref, commit, committedAt, subject, trailers] = record.replace(/^\n/, "").split("\0");
    if (ref === undefined || commit === undefined || committedAt === undefined) continue;
    const handoverId = trailerValue(trailers ?? "", "Octant-Handover");
    if (!UUID.test(handoverId)) continue;
    const match = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
    const remote = match?.[1];
    const branch = match?.[2];
    if (remote === undefined || branch === undefined || branch === "HEAD") continue;
    let repositoryRemote = urls.get(remote);
    if (repositoryRemote === undefined) {
      repositoryRemote = await git(repositoryRoot, ["remote", "get-url", remote]).catch(() => "");
      urls.set(remote, repositoryRemote);
    }
    if (repositoryRemote.length === 0) continue;
    const line = (subject ?? "").trim();
    found.push({
      handoverId: handoverId.toLowerCase(),
      title:
        (line.startsWith(HANDOVER_SUBJECT) ? line.slice(HANDOVER_SUBJECT.length) : line)
          .trim()
          .slice(0, 256) || "Untitled thread",
      originName: trailerValue(trailers ?? "", "Octant-Origin").slice(0, 256) || "Unknown",
      remote,
      repositoryRemote,
      branch,
      commit,
      committedAt,
    });
    if (found.length >= FOUND_HANDOVERS_MAX) break;
  }
  return found;
}

/** The first value of one trailer, matched as Git does: key case ignored. */
function trailerValue(trailers: string, key: string): string {
  const wanted = key.toLowerCase();
  for (const line of trailers.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === wanted) {
      return line.slice(colon + 1).trim();
    }
  }
  return "";
}

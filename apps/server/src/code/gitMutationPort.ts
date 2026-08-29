import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ProviderExecutionPolicy } from "@octant/contracts";
import { createGitCommandEnvironment } from "../gitEnvironmentPort";
import {
  createGitSeatbeltConfinement,
  prepareGitSeatbeltLaunch,
  type GitSeatbeltPortOptions,
} from "../process/gitSeatbeltLaunch";
import { SeatbeltConfinementError, type SeatbeltConfinementPort } from "../process/seatbeltProfile";
import type { GitStatusEntry } from "./gitObservationPort";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitMutationDependencies {
  readonly execFile: (
    file: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ) => Promise<CommandResult>;
  readonly pathExists: (path: string) => Promise<boolean>;
  /** Copy the checkout's index so a checkpoint can stage into a throwaway one. */
  readonly copyFile: (from: string, to: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
}

/**
 * A checkout's content at one moment, written as ordinary Git tree objects.
 *
 * `worktree` holds every tracked and untracked-but-not-ignored file; `index`
 * holds what was staged. Recording both is what lets a restore put back the
 * same staged/unstaged split rather than a flattened approximation.
 */
export interface GitTreeSnapshot {
  readonly worktree: string;
  readonly index: string;
  readonly head?: string | undefined;
}

export type GitMutationResult =
  | { readonly status: "applied"; readonly oid?: string }
  | {
      readonly status: "rejected";
      readonly reason:
        | "index-locked"
        | "invalid-paths"
        | "invalid-message"
        | "invalid-commit"
        | "empty-staged-summary"
        | "invalid-remote"
        | "invalid-refspec"
        | "unconfirmed-target"
        | "ignored-path-collision";
    }
  | { readonly status: "failed" };

const liveDependencies: GitMutationDependencies = {
  execFile: (file, args, environment, signal) =>
    new Promise((resolve) => {
      nodeExecFile(
        file,
        [...args],
        {
          encoding: "utf8",
          env: environment,
          shell: false,
          signal,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
            stdout,
            stderr,
          });
        },
      );
    }),
  pathExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch (error) {
      return isRecord(error) && error.code === "ENOENT" ? false : Promise.reject(error);
    }
  },
  copyFile: (from, to) => copyFile(from, to),
  removeFile: (path) => rm(path, { force: true }),
};

type GitMutationPolicy = {
  readonly executionPolicy?: ProviderExecutionPolicy;
};

export class GitMutationPort {
  readonly #dependencies: GitMutationDependencies;
  readonly #commandTimeoutMs: number;
  readonly #confinement: ReturnType<typeof createGitSeatbeltConfinement>;

  constructor(
    dependencies: GitMutationDependencies = liveDependencies,
    options: {
      readonly commandTimeoutMs?: number;
    } & GitSeatbeltPortOptions = {},
  ) {
    this.#dependencies = dependencies;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    // A shared port serves every thread. Plan confinement is applied per
    // mutation from that thread's executionPolicy, not at construction.
    this.#confinement = createGitSeatbeltConfinement(options);
  }

  async stage(
    input: { readonly checkoutRoot: string; readonly paths: readonly string[] } & GitMutationPolicy,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validPaths(input.paths)) return { status: "rejected", reason: "invalid-paths" };
    const lock = await this.#lockState(input.checkoutRoot, signal, input.executionPolicy);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    return this.#apply(
      input.checkoutRoot,
      ["add", "--", ...input.paths],
      signal,
      input.executionPolicy,
    );
  }

  /**
   * Take the listed paths back out of the index without touching the files.
   * The change stays in the working tree exactly as it was, so nothing the
   * user wrote can be lost here.
   */
  async unstage(
    input: { readonly checkoutRoot: string; readonly paths: readonly string[] } & GitMutationPolicy,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validPaths(input.paths)) return { status: "rejected", reason: "invalid-paths" };
    const lock = await this.#lockState(input.checkoutRoot, signal, input.executionPolicy);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    const head = await this.#run(
      ["-C", input.checkoutRoot, "rev-parse", "--verify", "--quiet", "HEAD"],
      signal,
      undefined,
      input.executionPolicy,
    );
    if (head.exitCode === 0) {
      return this.#apply(
        input.checkoutRoot,
        ["restore", "--staged", "--", ...input.paths],
        signal,
        input.executionPolicy,
      );
    }
    // A nonzero probe is not proof of an unborn branch: an aborted run, the
    // command timeout, and an unusable checkout root all report the same way.
    // That matters because the fallback below is only correct when there is no
    // HEAD — against a repository that does have commits, dropping a staged
    // modification from the index leaves the file deleted and untracked rather
    // than merely unstaged. So the unborn case is established positively, by
    // HEAD being a symbolic ref to a branch that has no commit yet, and an
    // indeterminate probe fails instead of guessing.
    const symbolic = await this.#run(
      ["-C", input.checkoutRoot, "symbolic-ref", "--quiet", "HEAD"],
      signal,
      undefined,
      input.executionPolicy,
    );
    if (symbolic.exitCode !== 0) return { status: "failed" };
    // `--cached` never touches the file on disk, and `--force` only waives
    // Git's warning about discarding staged content, which is what unstaging
    // asks for when the content was never committed.
    return this.#apply(
      input.checkoutRoot,
      ["rm", "--cached", "--force", "--", ...input.paths],
      signal,
      input.executionPolicy,
    );
  }

  /**
   * Restore the index and working tree of the given paths from HEAD, throwing
   * away uncommitted work. Tracked paths only: `git restore` cannot remove an
   * untracked file, and deleting one is not something this port will do
   * implicitly, so the caller rejects those before reaching here.
   */
  async discard(
    input: { readonly checkoutRoot: string; readonly paths: readonly string[] } & GitMutationPolicy,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validPaths(input.paths)) return { status: "rejected", reason: "invalid-paths" };
    const lock = await this.#lockState(input.checkoutRoot, signal, input.executionPolicy);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    return this.#apply(
      input.checkoutRoot,
      ["restore", "--staged", "--worktree", "--source=HEAD", "--", ...input.paths],
      signal,
      input.executionPolicy,
    );
  }

  async commit(
    input: {
      readonly checkoutRoot: string;
      readonly message: string;
      readonly stagedSummary: readonly GitStatusEntry[];
    } & GitMutationPolicy,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validMessage(input.message)) return { status: "rejected", reason: "invalid-message" };
    if (input.stagedSummary.length === 0)
      return { status: "rejected", reason: "empty-staged-summary" };
    const lock = await this.#lockState(input.checkoutRoot, signal, input.executionPolicy);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    const result = await this.#run(
      ["-C", input.checkoutRoot, "commit", "--message", input.message],
      signal,
      undefined,
      input.executionPolicy,
    );
    if (result.exitCode !== 0) return { status: "failed" };
    const head = await this.#run(
      ["-C", input.checkoutRoot, "rev-parse", "--verify", "HEAD"],
      signal,
      undefined,
      input.executionPolicy,
    );
    const oid = head.stdout.trim();
    return head.exitCode === 0 && isObjectId(oid)
      ? { status: "applied", oid }
      : { status: "failed" };
  }

  async push(
    input: {
      readonly checkoutRoot: string;
      readonly remote: string;
      readonly localRef: string;
      readonly remoteRef: string;
      readonly confirmation: {
        readonly remote: string;
        readonly refspec: string;
      };
    } & GitMutationPolicy,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!/^[A-Za-z0-9._-]+$/.test(input.remote))
      return { status: "rejected", reason: "invalid-remote" };
    if (!validBranchRef(input.localRef) || !validBranchRef(input.remoteRef))
      return { status: "rejected", reason: "invalid-refspec" };
    const refspec = `${input.localRef}:${input.remoteRef}`;
    if (input.confirmation.remote !== input.remote || input.confirmation.refspec !== refspec)
      return { status: "rejected", reason: "unconfirmed-target" };
    const lock = await this.#lockState(input.checkoutRoot, signal, input.executionPolicy);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    return this.#apply(
      input.checkoutRoot,
      ["push", "--porcelain", "--", input.remote, refspec],
      signal,
      input.executionPolicy,
    );
  }

  /**
   * Merge a run's branch into the branch the checkout is on.
   *
   * `--no-ff` on purpose: bringing a run home should leave a commit that says
   * a run was brought home, not a history that looks like the work happened
   * here. `--no-commit` is deliberately not used — a merge that stops half-done
   * would leave the person's checkout mid-merge, which is exactly the state
   * this operation exists to avoid. A merge that cannot complete is aborted so
   * the checkout is left as it was found.
   */
  async mergeBranch(
    input: { readonly checkoutRoot: string; readonly branch: string } & GitMutationPolicy,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validBranchName(input.branch)) return { status: "rejected", reason: "invalid-refspec" };
    const lock = await this.#lockState(input.checkoutRoot, signal, input.executionPolicy);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    const result = await this.#run(
      ["-C", input.checkoutRoot, "merge", "--no-ff", "--no-edit", "--end-of-options", input.branch],
      signal,
      undefined,
      input.executionPolicy,
    );
    if (result.exitCode !== 0) {
      await this.#run(
        ["-C", input.checkoutRoot, "merge", "--abort"],
        signal,
        undefined,
        input.executionPolicy,
      );
      return { status: "failed" };
    }
    const head = await this.#run(
      ["-C", input.checkoutRoot, "rev-parse", "--verify", "HEAD"],
      signal,
      undefined,
      input.executionPolicy,
    );
    const oid = head.stdout.trim();
    return head.exitCode === 0 && isObjectId(oid)
      ? { status: "applied", oid }
      : { status: "failed" };
  }

  async revertCommit(
    input: { readonly checkoutRoot: string; readonly oid: string } & GitMutationPolicy,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!isObjectId(input.oid)) return { status: "rejected", reason: "invalid-commit" };
    const lock = await this.#lockState(input.checkoutRoot, signal, input.executionPolicy);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    const result = await this.#run(
      ["-C", input.checkoutRoot, "revert", "--no-edit", "--", input.oid],
      signal,
      undefined,
      input.executionPolicy,
    );
    if (result.exitCode !== 0) return { status: "failed" };
    const head = await this.#run(
      ["-C", input.checkoutRoot, "rev-parse", "--verify", "HEAD"],
      signal,
      undefined,
      input.executionPolicy,
    );
    const oid = head.stdout.trim();
    return head.exitCode === 0 && isObjectId(oid)
      ? { status: "applied", oid }
      : { status: "failed" };
  }

  /**
   * Record the checkout's current content as Git tree objects, changing
   * nothing the user can see.
   *
   * Staging happens in a throwaway index copied from the real one, so the
   * user's staged set survives untouched and the copy's stat cache keeps
   * `add -A` cheap on a large repository. Both trees are then anchored under
   * this checkout's checkpoint refs, because a tree nothing points at is
   * precisely what `git gc` and `git maintenance` exist to collect — and a
   * checkpoint the user can still see listed has to still be restorable.
   *
   * A capture that cannot be anchored is reported as failed rather than handed
   * back: a snapshot that outlives the next repack is worse than no snapshot,
   * because the turn it belongs to would advertise a restore point that is not
   * there. The returned `anchorId` names the refs so an unused capture can
   * release exactly its own, never a neighbour's.
   */
  async snapshotWorkingTree(
    input: { readonly checkoutRoot: string; readonly checkoutId: string } & GitMutationPolicy,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly status: "captured";
        readonly snapshot: GitTreeSnapshot;
        readonly anchorId: string;
      }
    | { readonly status: "failed" }
  > {
    if (checkpointRefNamespace(input.checkoutId) === undefined) return { status: "failed" };
    const scratch = await this.#gitPath(
      input.checkoutRoot,
      checkpointIndexName(),
      signal,
      input.executionPolicy,
    );
    if (scratch === undefined) return { status: "failed" };
    const environment = { GIT_INDEX_FILE: scratch };
    try {
      if (!(await this.#copyIndex(input.checkoutRoot, scratch, signal, input.executionPolicy)))
        return { status: "failed" };
      const index = await this.#writeTree(
        input.checkoutRoot,
        environment,
        signal,
        input.executionPolicy,
      );
      if (index === undefined) return { status: "failed" };
      const staged = await this.#run(
        ["-C", input.checkoutRoot, "add", "-A", "--"],
        signal,
        environment,
        input.executionPolicy,
      );
      if (staged.exitCode !== 0) return { status: "failed" };
      const worktree = await this.#writeTree(
        input.checkoutRoot,
        environment,
        signal,
        input.executionPolicy,
      );
      if (worktree === undefined) return { status: "failed" };
      const head = await this.#run(
        ["-C", input.checkoutRoot, "rev-parse", "--verify", "HEAD"],
        signal,
        undefined,
        input.executionPolicy,
      );
      const headOid = head.stdout.trim();
      const snapshot: GitTreeSnapshot = {
        worktree,
        index,
        ...(head.exitCode === 0 && isObjectId(headOid) ? { head: headOid } : {}),
      };
      const anchorId = randomUUID();
      if (
        !(await this.#anchor(
          input.checkoutRoot,
          input.checkoutId,
          anchorId,
          snapshot,
          signal,
          input.executionPolicy,
        ))
      ) {
        await this.releaseCheckpoint({ ...input, anchorId }, signal);
        return { status: "failed" };
      }
      return { status: "captured", snapshot, anchorId };
    } finally {
      await this.#discardScratchIndex(scratch);
    }
  }

  /**
   * Drop one capture's anchors, freeing its trees to be collected again.
   *
   * For a capture no result will ever name — the pre-restore undo point of a
   * restore that was refused before it touched anything. Best effort: a ref
   * that will not delete costs disk, never correctness, and is not worth
   * failing the operation that asked for the release.
   */
  async releaseCheckpoint(
    input: {
      readonly checkoutRoot: string;
      readonly checkoutId: string;
      readonly anchorId: string;
    } & GitMutationPolicy,
    signal?: AbortSignal,
  ): Promise<void> {
    const names = checkpointRefNames(input.checkoutId, input.anchorId);
    if (names === undefined) return;
    for (const name of names) {
      await this.#run(
        ["-C", input.checkoutRoot, "update-ref", "-d", name],
        signal,
        undefined,
        input.executionPolicy,
      );
    }
  }

  /** Point this checkout's checkpoint refs at the trees a capture just wrote. */
  async #anchor(
    checkoutRoot: string,
    checkoutId: string,
    anchorId: string,
    snapshot: GitTreeSnapshot,
    signal: AbortSignal | undefined,
    executionPolicy: ProviderExecutionPolicy | undefined,
  ): Promise<boolean> {
    const names = checkpointRefNames(checkoutId, anchorId);
    if (names === undefined) return false;
    for (const [name, oid] of [
      [names[0], snapshot.worktree],
      [names[1], snapshot.index],
    ] as const) {
      const result = await this.#run(
        ["-C", checkoutRoot, "update-ref", name, oid],
        signal,
        undefined,
        executionPolicy,
      );
      if (result.exitCode !== 0) return false;
    }
    return true;
  }

  /**
   * Put the checkout's files back the way a snapshot recorded them.
   *
   * Both trees are proven to exist before anything is written, and the real
   * index is reset before the working tree. Every realistic failure — an
   * unreadable tree, or the index lock being taken after the initial check —
   * therefore happens while the checkout is still untouched, so a `failed`
   * result never means files were already overwritten.
   *
   * The working tree is then moved through a throwaway index that first records
   * the current content, which is what lets `read-tree -u` remove files the
   * snapshot did not have instead of leaving them behind.
   *
   * A file the checkout ignores today is in neither tree, so the restore leaves
   * it alone — unless the snapshot itself carries that path, which is the one
   * case that would destroy it. See `#wouldOverwriteIgnored`.
   */
  async restoreWorkingTree(
    input: {
      readonly checkoutRoot: string;
      readonly snapshot: GitTreeSnapshot;
    } & GitMutationPolicy,
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!isObjectId(input.snapshot.worktree) || !isObjectId(input.snapshot.index))
      return { status: "rejected", reason: "invalid-commit" };
    const lock = await this.#lockState(input.checkoutRoot, signal, input.executionPolicy);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    const scratch = await this.#gitPath(
      input.checkoutRoot,
      checkpointIndexName(),
      signal,
      input.executionPolicy,
    );
    if (scratch === undefined) return { status: "failed" };
    const environment = { GIT_INDEX_FILE: scratch };
    try {
      if (!(await this.#copyIndex(input.checkoutRoot, scratch, signal, input.executionPolicy)))
        return { status: "failed" };
      const staged = await this.#run(
        ["-C", input.checkoutRoot, "add", "-A", "--"],
        signal,
        environment,
        input.executionPolicy,
      );
      if (staged.exitCode !== 0) return { status: "failed" };
      if (
        !(await this.#treeExists(
          input.checkoutRoot,
          input.snapshot.worktree,
          signal,
          input.executionPolicy,
        )) ||
        !(await this.#treeExists(
          input.checkoutRoot,
          input.snapshot.index,
          signal,
          input.executionPolicy,
        ))
      ) {
        return { status: "rejected", reason: "invalid-commit" };
      }
      // Asked against the real index, which nothing has touched yet.
      const overwrites = await this.#wouldOverwriteIgnored(
        input.checkoutRoot,
        input.snapshot.worktree,
        signal,
        input.executionPolicy,
      );
      if (overwrites === undefined) return { status: "failed" };
      if (overwrites) return { status: "rejected", reason: "ignored-path-collision" };
      const index = await this.#run(
        ["-C", input.checkoutRoot, "read-tree", "--reset", input.snapshot.index],
        signal,
        undefined,
        input.executionPolicy,
      );
      if (index.exitCode !== 0) return { status: "failed" };
      const worktree = await this.#run(
        ["-C", input.checkoutRoot, "read-tree", "-u", "--reset", input.snapshot.worktree],
        signal,
        environment,
        input.executionPolicy,
      );
      return worktree.exitCode === 0 ? { status: "applied" } : { status: "failed" };
    } finally {
      await this.#discardScratchIndex(scratch);
    }
  }

  /**
   * Whether restoring this tree would write over a file the checkout now ignores.
   *
   * A path can be both in a snapshot and ignored today: tracked when the
   * checkpoint was taken, then removed from Git, added to `.gitignore`, and
   * recreated with local content — the ordinary life of a `.env`. Restoring
   * overwrites it, and the pre-restore undo point cannot give it back, because
   * the `git add -A` that builds that point skips ignored files. So the restore
   * is refused while the checkout is still untouched rather than trading a file
   * the user cannot recover for one they can.
   *
   * `undefined` means the question could not be answered, which is not an answer
   * of "no": the caller fails rather than proceeding on an unchecked tree.
   */
  async #wouldOverwriteIgnored(
    checkoutRoot: string,
    tree: string,
    signal: AbortSignal | undefined,
    executionPolicy: ProviderExecutionPolicy | undefined,
  ): Promise<boolean | undefined> {
    const listed = await this.#run(
      ["-C", checkoutRoot, "ls-tree", "-r", "-z", "--name-only", tree],
      signal,
      undefined,
      executionPolicy,
    );
    if (listed.exitCode !== 0) return undefined;
    const tracked = await this.#run(
      ["-C", checkoutRoot, "ls-files", "-z"],
      signal,
      undefined,
      executionPolicy,
    );
    if (tracked.exitCode !== 0) return undefined;
    const indexed = new Set(splitNulPaths(tracked.stdout));
    // A path the checkout still tracks cannot be the case at issue: Git does not
    // ignore tracked paths, and a restore writing over one is exactly what the
    // undo point covers. Only a path that has left the index can be ignored now,
    // and only one that exists holds content the restore would destroy.
    for (const path of splitNulPaths(listed.stdout)) {
      if (indexed.has(path)) continue;
      if (!(await this.#dependencies.pathExists(join(checkoutRoot, path)))) continue;
      // `-q` answers through the exit code alone, so no path has to survive a
      // round trip through a text format that quotes unusual names. It takes one
      // pathname at a time, which is affordable here: the candidates are only
      // the snapshot's untracked files, not the whole tree.
      const checked = await this.#run(
        ["-C", checkoutRoot, "check-ignore", "-q", "--", path],
        signal,
        undefined,
        executionPolicy,
      );
      if (checked.exitCode === 0) return true;
      // Exit 1 is the answer "this one is not ignored"; anything higher is a
      // refusal to answer.
      if (checked.exitCode !== 1) return undefined;
    }
    return false;
  }

  /** Prove a snapshot tree is readable before any part of the checkout moves. */
  async #treeExists(
    checkoutRoot: string,
    oid: string,
    signal: AbortSignal | undefined,
    executionPolicy: ProviderExecutionPolicy | undefined,
  ): Promise<boolean> {
    const result = await this.#run(
      ["-C", checkoutRoot, "rev-parse", "--verify", "--quiet", `${oid}^{tree}`],
      signal,
      undefined,
      executionPolicy,
    );
    return result.exitCode === 0;
  }

  async #writeTree(
    checkoutRoot: string,
    environment: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
    executionPolicy: ProviderExecutionPolicy | undefined,
  ): Promise<string | undefined> {
    const result = await this.#run(
      ["-C", checkoutRoot, "write-tree"],
      signal,
      environment,
      executionPolicy,
    );
    const oid = result.stdout.trim();
    return result.exitCode === 0 && isObjectId(oid) ? oid : undefined;
  }

  /**
   * Seed the throwaway index from the real one. A checkout that has no index
   * file yet is not a failure: the copy is simply skipped and Git starts from
   * an empty index.
   */
  async #copyIndex(
    checkoutRoot: string,
    scratch: string,
    signal: AbortSignal | undefined,
    executionPolicy: ProviderExecutionPolicy | undefined,
  ): Promise<boolean> {
    const index = await this.#gitPath(checkoutRoot, "index", signal, executionPolicy);
    if (index === undefined) return false;
    try {
      if (await this.#dependencies.pathExists(index))
        await this.#dependencies.copyFile(index, scratch);
      else await this.#dependencies.removeFile(scratch);
      return true;
    } catch {
      return false;
    }
  }

  async #discardScratchIndex(scratch: string): Promise<void> {
    try {
      await this.#dependencies.removeFile(scratch);
    } catch {
      // A leftover scratch index is inert: every use overwrites it first.
    }
  }

  async #gitPath(
    checkoutRoot: string,
    name: string,
    signal: AbortSignal | undefined,
    executionPolicy: ProviderExecutionPolicy | undefined,
  ): Promise<string | undefined> {
    const result = await this.#run(
      ["-C", checkoutRoot, "rev-parse", "--path-format=absolute", "--git-path", name],
      signal,
      undefined,
      executionPolicy,
    );
    const path = result.stdout.trim();
    return result.exitCode === 0 && isAbsolute(path) ? path : undefined;
  }

  async #indexLocked(
    checkoutRoot: string,
    signal: AbortSignal | undefined,
    executionPolicy: ProviderExecutionPolicy | undefined,
  ): Promise<boolean> {
    const path = await this.#run(
      ["-C", checkoutRoot, "rev-parse", "--path-format=absolute", "--git-path", "index.lock"],
      signal,
      undefined,
      executionPolicy,
    );
    if (path.exitCode !== 0 || !isAbsolute(path.stdout.trim()))
      throw new Error("Git index lock state is unavailable.");
    return this.#dependencies.pathExists(path.stdout.trim());
  }

  async #lockState(
    checkoutRoot: string,
    signal: AbortSignal | undefined,
    executionPolicy: ProviderExecutionPolicy | undefined,
  ): Promise<"clear" | "locked" | "failed"> {
    try {
      return (await this.#indexLocked(checkoutRoot, signal, executionPolicy)) ? "locked" : "clear";
    } catch {
      return "failed";
    }
  }

  async #apply(
    checkoutRoot: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
    executionPolicy: ProviderExecutionPolicy | undefined,
  ): Promise<GitMutationResult> {
    const result = await this.#run(
      ["-C", checkoutRoot, ...args],
      signal,
      undefined,
      executionPolicy,
    );
    return result.exitCode === 0 ? { status: "applied" } : { status: "failed" };
  }

  async #run(
    args: readonly string[],
    parentSignal?: AbortSignal,
    environment?: Readonly<Record<string, string>>,
    executionPolicy?: ProviderExecutionPolicy,
  ): Promise<CommandResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const timeout = setTimeout(abort, this.#commandTimeoutMs);
    try {
      if (controller.signal.aborted) throw new Error("Git mutation aborted.");
      const checkoutRoot = args[0] === "-C" ? args[1] : undefined;
      if (checkoutRoot === undefined || !isAbsolute(checkoutRoot)) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      const launch = prepareGitSeatbeltLaunch({
        confinement:
          executionPolicy === "plan"
            ? planGitMutationConfinement(this.#confinement.confinement)
            : this.#confinement.confinement,
        gitExecutable: this.#confinement.gitExecutable,
        checkoutRoot,
        args,
        temporaryDirectory: this.#confinement.temporaryDirectory,
        networkEgress: this.#confinement.networkEgress,
      });
      return await this.#dependencies.execFile(
        launch.command,
        launch.args,
        // The overlay is named by this port, never inherited, so widening it
        // cannot leak a caller's environment past the allowlist.
        { ...createGitCommandEnvironment(process.env), ...environment },
        controller.signal,
      );
    } catch (error) {
      if (error instanceof SeatbeltConfinementError) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  }
}

function planGitMutationConfinement(confinement: SeatbeltConfinementPort): SeatbeltConfinementPort {
  return {
    prepare: (input) =>
      confinement.prepare({
        ...input,
        writeBoundRoot: false,
        allowProcessExec: false,
        allowProcessFork: false,
      }),
  };
}

/**
 * The throwaway index a checkpoint stages into, kept inside the Git directory.
 * Each operation gets its own name: forked and ordinary threads can share one
 * checkout, so a fixed path would let concurrent checkpoints overwrite or
 * delete each other's scratch index.
 */
function splitNulPaths(output: string): ReadonlyArray<string> {
  return output.split("\0").filter((path) => path.length > 0);
}

function checkpointIndexName(): string {
  return `octant-checkpoint-index-${randomUUID()}`;
}

/**
 * Where one checkout's checkpoint anchors live, or `undefined` for an id this
 * port will not build a ref name from.
 *
 * Scoping by checkout is what makes removal safe to do wholesale: linked
 * worktrees of the same repository share one ref store, so a namespace shared
 * between them would let one checkout's cleanup prune another's restore points.
 * The id is required to be a host-generated UUID, which is both what every
 * caller has and already a valid Git ref component.
 */
export function checkpointRefNamespace(checkoutId: string): string | undefined {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(checkoutId)
    ? `refs/octant/checkpoints/${checkoutId}`
    : undefined;
}

/**
 * The two refs one capture owns, worktree tree first.
 *
 * Each capture gets its own pair rather than a ref named after the tree it
 * points at. Two checkpoints of an unchanged checkout record the identical
 * tree, and a shared ref would let releasing the newer one silently strip the
 * older one's only anchor.
 */
function checkpointRefNames(
  checkoutId: string,
  anchorId: string,
): readonly [string, string] | undefined {
  const namespace = checkpointRefNamespace(checkoutId);
  if (namespace === undefined || checkpointRefNamespace(anchorId) === undefined) return undefined;
  return [`${namespace}/${anchorId}/worktree`, `${namespace}/${anchorId}/index`];
}

/**
 * A branch name this port will hand to Git. Narrow on purpose: no leading dash,
 * no path traversal, and nothing that could be read as an option.
 */
function validBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !value.includes("//") &&
    /^[A-Za-z0-9._/-]+$/.test(value)
  );
}

function isObjectId(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function validPaths(paths: readonly string[]): boolean {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    paths.every(
      (path) =>
        path.length > 0 &&
        path.length <= 4_096 &&
        !isAbsolute(path) &&
        !path.includes("\0") &&
        !path.includes("\\") &&
        !path.split("/").some((part) => part === "" || part === "." || part === "..") &&
        !path.startsWith("-"),
    )
  );
}

function validMessage(message: string): boolean {
  return (
    message.trim().length > 0 &&
    Buffer.byteLength(message, "utf8") <= 64 * 1024 &&
    !message.includes("\0")
  );
}

function validBranchRef(ref: string): boolean {
  return (
    /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.endsWith("/") &&
    !ref.includes("@{")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

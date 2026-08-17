import { execFile as nodeExecFile } from "node:child_process";
import { access, copyFile, rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createGitCommandEnvironment } from "../gitEnvironmentPort";
import {
  createGitSeatbeltConfinement,
  prepareGitSeatbeltLaunch,
  type GitSeatbeltPortOptions,
} from "../process/gitSeatbeltLaunch";
import { SeatbeltConfinementError } from "../process/seatbeltProfile";
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
        | "unconfirmed-target";
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

export class GitMutationPort {
  readonly #dependencies: GitMutationDependencies;
  readonly #commandTimeoutMs: number;
  readonly #confinement: ReturnType<typeof createGitSeatbeltConfinement>;

  constructor(
    dependencies: GitMutationDependencies = liveDependencies,
    options: { readonly commandTimeoutMs?: number } & GitSeatbeltPortOptions = {},
  ) {
    this.#dependencies = dependencies;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.#confinement = createGitSeatbeltConfinement(options);
  }

  async stage(
    input: { readonly checkoutRoot: string; readonly paths: readonly string[] },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validPaths(input.paths)) return { status: "rejected", reason: "invalid-paths" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    return this.#apply(input.checkoutRoot, ["add", "--", ...input.paths], signal);
  }

  /**
   * Take the listed paths back out of the index without touching the files.
   * The change stays in the working tree exactly as it was, so nothing the
   * user wrote can be lost here.
   */
  async unstage(
    input: { readonly checkoutRoot: string; readonly paths: readonly string[] },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validPaths(input.paths)) return { status: "rejected", reason: "invalid-paths" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    return this.#apply(input.checkoutRoot, ["restore", "--staged", "--", ...input.paths], signal);
  }

  /**
   * Restore the index and working tree of the given paths from HEAD, throwing
   * away uncommitted work. Tracked paths only: `git restore` cannot remove an
   * untracked file, and deleting one is not something this port will do
   * implicitly, so the caller rejects those before reaching here.
   */
  async discard(
    input: { readonly checkoutRoot: string; readonly paths: readonly string[] },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validPaths(input.paths)) return { status: "rejected", reason: "invalid-paths" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    return this.#apply(
      input.checkoutRoot,
      ["restore", "--staged", "--worktree", "--source=HEAD", "--", ...input.paths],
      signal,
    );
  }

  async commit(
    input: {
      readonly checkoutRoot: string;
      readonly message: string;
      readonly stagedSummary: readonly GitStatusEntry[];
    },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validMessage(input.message)) return { status: "rejected", reason: "invalid-message" };
    if (input.stagedSummary.length === 0)
      return { status: "rejected", reason: "empty-staged-summary" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    const result = await this.#run(
      ["-C", input.checkoutRoot, "commit", "--message", input.message],
      signal,
    );
    if (result.exitCode !== 0) return { status: "failed" };
    const head = await this.#run(
      ["-C", input.checkoutRoot, "rev-parse", "--verify", "HEAD"],
      signal,
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
    },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!/^[A-Za-z0-9._-]+$/.test(input.remote))
      return { status: "rejected", reason: "invalid-remote" };
    if (!validBranchRef(input.localRef) || !validBranchRef(input.remoteRef))
      return { status: "rejected", reason: "invalid-refspec" };
    const refspec = `${input.localRef}:${input.remoteRef}`;
    if (input.confirmation.remote !== input.remote || input.confirmation.refspec !== refspec)
      return { status: "rejected", reason: "unconfirmed-target" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    return this.#apply(
      input.checkoutRoot,
      ["push", "--porcelain", "--", input.remote, refspec],
      signal,
    );
  }

  async revertCommit(
    input: { readonly checkoutRoot: string; readonly oid: string },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!isObjectId(input.oid)) return { status: "rejected", reason: "invalid-commit" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    const result = await this.#run(
      ["-C", input.checkoutRoot, "revert", "--no-edit", "--", input.oid],
      signal,
    );
    if (result.exitCode !== 0) return { status: "failed" };
    const head = await this.#run(
      ["-C", input.checkoutRoot, "rev-parse", "--verify", "HEAD"],
      signal,
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
   * `add -A` cheap on a large repository. The trees are written into the
   * object database but referenced by nothing, so a `git gc` that prunes
   * unreachable objects can eventually collect them; that is the intended
   * lifetime for an in-session undo.
   */
  async snapshotWorkingTree(
    input: { readonly checkoutRoot: string },
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "captured"; readonly snapshot: GitTreeSnapshot }
    | { readonly status: "failed" }
  > {
    const scratch = await this.#gitPath(input.checkoutRoot, CHECKPOINT_INDEX_NAME, signal);
    if (scratch === undefined) return { status: "failed" };
    const environment = { GIT_INDEX_FILE: scratch };
    try {
      if (!(await this.#copyIndex(input.checkoutRoot, scratch, signal)))
        return { status: "failed" };
      const index = await this.#writeTree(input.checkoutRoot, environment, signal);
      if (index === undefined) return { status: "failed" };
      const staged = await this.#run(
        ["-C", input.checkoutRoot, "add", "-A", "--"],
        signal,
        environment,
      );
      if (staged.exitCode !== 0) return { status: "failed" };
      const worktree = await this.#writeTree(input.checkoutRoot, environment, signal);
      if (worktree === undefined) return { status: "failed" };
      const head = await this.#run(
        ["-C", input.checkoutRoot, "rev-parse", "--verify", "HEAD"],
        signal,
      );
      const headOid = head.stdout.trim();
      return {
        status: "captured",
        snapshot: {
          worktree,
          index,
          ...(head.exitCode === 0 && isObjectId(headOid) ? { head: headOid } : {}),
        },
      };
    } finally {
      await this.#discardScratchIndex(scratch);
    }
  }

  /**
   * Put the checkout's files back the way a snapshot recorded them.
   *
   * The working tree is moved through a throwaway index that first records the
   * current content, which is what lets `read-tree -u` remove files the
   * snapshot did not have instead of leaving them behind. The real index is
   * then set to the snapshot's staged content, so the checkout comes back with
   * the same staged/unstaged split it had. Ignored files are in neither tree
   * and are never touched.
   */
  async restoreWorkingTree(
    input: { readonly checkoutRoot: string; readonly snapshot: GitTreeSnapshot },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!isObjectId(input.snapshot.worktree) || !isObjectId(input.snapshot.index))
      return { status: "rejected", reason: "invalid-commit" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    const scratch = await this.#gitPath(input.checkoutRoot, CHECKPOINT_INDEX_NAME, signal);
    if (scratch === undefined) return { status: "failed" };
    const environment = { GIT_INDEX_FILE: scratch };
    try {
      if (!(await this.#copyIndex(input.checkoutRoot, scratch, signal)))
        return { status: "failed" };
      const staged = await this.#run(
        ["-C", input.checkoutRoot, "add", "-A", "--"],
        signal,
        environment,
      );
      if (staged.exitCode !== 0) return { status: "failed" };
      const worktree = await this.#run(
        ["-C", input.checkoutRoot, "read-tree", "-u", "--reset", input.snapshot.worktree],
        signal,
        environment,
      );
      if (worktree.exitCode !== 0) return { status: "failed" };
      const index = await this.#run(
        ["-C", input.checkoutRoot, "read-tree", "--reset", input.snapshot.index],
        signal,
      );
      return index.exitCode === 0 ? { status: "applied" } : { status: "failed" };
    } finally {
      await this.#discardScratchIndex(scratch);
    }
  }

  async #writeTree(
    checkoutRoot: string,
    environment: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.#run(["-C", checkoutRoot, "write-tree"], signal, environment);
    const oid = result.stdout.trim();
    return result.exitCode === 0 && isObjectId(oid) ? oid : undefined;
  }

  /**
   * Seed the throwaway index from the real one. A checkout that has no index
   * file yet is not a failure: the copy is simply skipped and Git starts from
   * an empty index.
   */
  async #copyIndex(checkoutRoot: string, scratch: string, signal?: AbortSignal): Promise<boolean> {
    const index = await this.#gitPath(checkoutRoot, "index", signal);
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
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.#run(
      ["-C", checkoutRoot, "rev-parse", "--path-format=absolute", "--git-path", name],
      signal,
    );
    const path = result.stdout.trim();
    return result.exitCode === 0 && isAbsolute(path) ? path : undefined;
  }

  async #indexLocked(checkoutRoot: string, signal?: AbortSignal): Promise<boolean> {
    const path = await this.#run(
      ["-C", checkoutRoot, "rev-parse", "--path-format=absolute", "--git-path", "index.lock"],
      signal,
    );
    if (path.exitCode !== 0 || !isAbsolute(path.stdout.trim()))
      throw new Error("Git index lock state is unavailable.");
    return this.#dependencies.pathExists(path.stdout.trim());
  }

  async #lockState(
    checkoutRoot: string,
    signal?: AbortSignal,
  ): Promise<"clear" | "locked" | "failed"> {
    try {
      return (await this.#indexLocked(checkoutRoot, signal)) ? "locked" : "clear";
    } catch {
      return "failed";
    }
  }

  async #apply(
    checkoutRoot: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    const result = await this.#run(["-C", checkoutRoot, ...args], signal);
    return result.exitCode === 0 ? { status: "applied" } : { status: "failed" };
  }

  async #run(
    args: readonly string[],
    parentSignal?: AbortSignal,
    environment?: Readonly<Record<string, string>>,
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
        confinement: this.#confinement.confinement,
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

/** The throwaway index a checkpoint stages into, kept inside the Git directory. */
const CHECKPOINT_INDEX_NAME = "octant-checkpoint-index";

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

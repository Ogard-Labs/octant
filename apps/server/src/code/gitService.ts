import type { GitMutationPort, GitMutationResult, GitTreeSnapshot } from "./gitMutationPort";
import type {
  GitObservation,
  GitObservationPort,
  GitObservationResult,
  GitScopedDiffResult,
  GitStatusEntry,
} from "./gitObservationPort";

interface ObservationPort {
  observe(root: string, signal?: AbortSignal): Promise<GitObservationResult>;
  /**
   * Optional: an observation fake that only answers `observe` reports no
   * scoped diff rather than being unusable.
   */
  readDiff?: (
    input: Parameters<GitObservationPort["readDiff"]>[0],
    signal?: AbortSignal,
  ) => Promise<GitScopedDiffResult>;
}

interface MutationPort {
  stage(
    input: Parameters<GitMutationPort["stage"]>[0],
    signal?: AbortSignal,
  ): Promise<GitMutationResult>;
  unstage(
    input: Parameters<GitMutationPort["unstage"]>[0],
    signal?: AbortSignal,
  ): Promise<GitMutationResult>;
  discard(
    input: Parameters<GitMutationPort["discard"]>[0],
    signal?: AbortSignal,
  ): Promise<GitMutationResult>;
  commit(
    input: Parameters<GitMutationPort["commit"]>[0],
    signal?: AbortSignal,
  ): Promise<GitMutationResult>;
  push(
    input: Parameters<GitMutationPort["push"]>[0],
    signal?: AbortSignal,
  ): Promise<GitMutationResult>;
  revertCommit(
    input: Parameters<GitMutationPort["revertCommit"]>[0],
    signal?: AbortSignal,
  ): Promise<GitMutationResult>;
  snapshotWorkingTree(
    input: Parameters<GitMutationPort["snapshotWorkingTree"]>[0],
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<GitMutationPort["snapshotWorkingTree"]>>>;
  restoreWorkingTree(
    input: Parameters<GitMutationPort["restoreWorkingTree"]>[0],
    signal?: AbortSignal,
  ): Promise<GitMutationResult>;
  releaseCheckpoint(
    input: Parameters<GitMutationPort["releaseCheckpoint"]>[0],
    signal?: AbortSignal,
  ): Promise<void>;
}

export type GitServiceResult =
  | GitMutationResult
  | {
      readonly status: "rejected";
      readonly reason:
        | "stale-state"
        | "unlisted-path"
        | "untracked-path"
        | "staged-summary-mismatch"
        | "approval-required"
        | "detached-head"
        | "unborn-head"
        | "branch-mismatch"
        | "remote-unavailable"
        | "dirty-checkout";
    }
  | { readonly status: "unavailable" };

export type GitCheckpointResult =
  | { readonly status: "captured"; readonly snapshot: GitTreeSnapshot }
  | { readonly status: "unavailable" };

export class GitService {
  readonly #observation: ObservationPort;
  readonly #mutation: MutationPort;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    observation: ObservationPort | GitObservationPort,
    mutation: MutationPort | GitMutationPort,
  ) {
    this.#observation = observation;
    this.#mutation = mutation;
  }

  observe(root: string, signal?: AbortSignal): Promise<GitObservationResult> {
    return this.#observation.observe(root, signal);
  }

  /** Read one named slice of the checkout's changes. Read-only, so unqueued. */
  async readDiff(
    input: Parameters<GitObservationPort["readDiff"]>[0],
    signal?: AbortSignal,
  ): Promise<GitScopedDiffResult> {
    return (await this.#observation.readDiff?.(input, signal)) ?? { status: "unavailable" };
  }

  stage(
    input: {
      readonly checkoutId: string;
      readonly checkoutRoot: string;
      readonly paths: readonly string[];
      readonly expectedStateToken: string;
    },
    signal?: AbortSignal,
  ): Promise<GitServiceResult> {
    return this.#serialized(input.checkoutId, async () => {
      const current = await this.#ready(input.checkoutRoot, signal);
      if (!current) return { status: "unavailable" };
      if (current.stateToken !== input.expectedStateToken)
        return { status: "rejected", reason: "stale-state" };
      const changed = new Set(current.changedPaths);
      if (input.paths.some((path) => !changed.has(path)))
        return { status: "rejected", reason: "unlisted-path" };
      return this.#mutation.stage(
        { checkoutRoot: current.checkoutRoot, paths: input.paths },
        signal,
      );
    });
  }

  /**
   * Take the listed paths back out of the index. The listing is checked
   * against the staged set the caller saw, so a path that is not actually
   * staged is refused rather than silently doing nothing.
   */
  unstage(
    input: {
      readonly checkoutId: string;
      readonly checkoutRoot: string;
      readonly paths: readonly string[];
      readonly expectedStateToken: string;
    },
    signal?: AbortSignal,
  ): Promise<GitServiceResult> {
    return this.#serialized(input.checkoutId, async () => {
      const current = await this.#ready(input.checkoutRoot, signal);
      if (!current) return { status: "unavailable" };
      if (current.stateToken !== input.expectedStateToken)
        return { status: "rejected", reason: "stale-state" };
      // A staged rename is one entry occupying two paths. Git's pathspec
      // applies only to the paths it is given, so both sides have to be
      // accepted or unstaging a rename is refused as an unlisted path.
      const staged = new Set(
        current.stagedSummary.flatMap((entry) =>
          entry.originalPath === undefined ? [entry.path] : [entry.path, entry.originalPath],
        ),
      );
      if (input.paths.some((path) => !staged.has(path)))
        return { status: "rejected", reason: "unlisted-path" };
      return this.#mutation.unstage(
        { checkoutRoot: current.checkoutRoot, paths: input.paths },
        signal,
      );
    });
  }

  /**
   * Throw away uncommitted changes to the listed paths. The listing is checked
   * against the same observation the caller saw — a stale token, a path the
   * checkout does not report as changed, or an untracked path is refused
   * rather than resolved generously, because the loss cannot be undone.
   */
  discard(
    input: {
      readonly checkoutId: string;
      readonly checkoutRoot: string;
      readonly paths: readonly string[];
      readonly expectedStateToken: string;
    },
    signal?: AbortSignal,
  ): Promise<GitServiceResult> {
    return this.#serialized(input.checkoutId, async () => {
      const current = await this.#ready(input.checkoutRoot, signal);
      if (!current) return { status: "unavailable" };
      if (current.stateToken !== input.expectedStateToken)
        return { status: "rejected", reason: "stale-state" };
      const changed = new Set(current.changedPaths);
      if (input.paths.some((path) => !changed.has(path)))
        return { status: "rejected", reason: "unlisted-path" };
      const untracked = new Set(
        current.statusEntries
          .filter((entry) => entry.index === "?" || entry.worktree === "?")
          .map((entry) => entry.path),
      );
      if (input.paths.some((path) => untracked.has(path)))
        return { status: "rejected", reason: "untracked-path" };
      return this.#mutation.discard(
        { checkoutRoot: current.checkoutRoot, paths: input.paths },
        signal,
      );
    });
  }

  commit(
    input: {
      readonly checkoutId: string;
      readonly checkoutRoot: string;
      readonly message: string;
      readonly expectedStateToken: string;
      readonly stagedSummary: readonly GitStatusEntry[];
    },
    signal?: AbortSignal,
  ): Promise<GitServiceResult> {
    return this.#serialized(input.checkoutId, async () => {
      const current = await this.#ready(input.checkoutRoot, signal);
      if (!current) return { status: "unavailable" };
      if (current.stateToken !== input.expectedStateToken)
        return { status: "rejected", reason: "stale-state" };
      if (!sameSummary(current.stagedSummary, input.stagedSummary))
        return { status: "rejected", reason: "staged-summary-mismatch" };
      return this.#mutation.commit(
        {
          checkoutRoot: current.checkoutRoot,
          message: input.message,
          stagedSummary: input.stagedSummary,
        },
        signal,
      );
    });
  }

  /**
   * Record the checkout's current content so it can be put back later.
   *
   * This writes Git objects and a ref anchoring them, and nothing else: no
   * commit, no branch, no change the user can see. Taking a checkpoint
   * therefore never needs a state token and never fails a turn — a checkout
   * that cannot be read simply produces no checkpoint, and the turn runs
   * without one.
   *
   * The anchor is kept for as long as the checkout is, because every journaled
   * turn stays restorable; only removing the checkout retires them.
   */
  checkpoint(
    input: { readonly checkoutId: string; readonly checkoutRoot: string },
    signal?: AbortSignal,
  ): Promise<GitCheckpointResult> {
    return this.#serialized(input.checkoutId, async () => {
      const snapshot = await this.#mutation.snapshotWorkingTree(
        { checkoutRoot: input.checkoutRoot, checkoutId: input.checkoutId },
        signal,
      );
      return snapshot.status === "captured"
        ? { status: "captured", snapshot: snapshot.snapshot }
        : { status: "unavailable" };
    });
  }

  /**
   * Put the checkout's files back the way a checkpoint recorded them.
   *
   * The state the restore replaces is checkpointed first and returned, so the
   * overwrite is itself undoable. No state token is required: the caller names
   * an exact recorded state to return to rather than a change to apply on top
   * of the one it last saw.
   */
  restoreCheckpoint(
    input: {
      readonly checkoutId: string;
      readonly checkoutRoot: string;
      readonly snapshot: GitTreeSnapshot;
    },
    signal?: AbortSignal,
  ): Promise<GitServiceResult & { readonly undo?: GitTreeSnapshot }> {
    return this.#serialized(input.checkoutId, async () => {
      const current = await this.#ready(input.checkoutRoot, signal);
      if (!current) return { status: "unavailable" };
      const undo = await this.#mutation.snapshotWorkingTree(
        { checkoutRoot: current.checkoutRoot, checkoutId: input.checkoutId },
        signal,
      );
      if (undo.status !== "captured") return { status: "unavailable" };
      const restored = await this.#mutation.restoreWorkingTree(
        { checkoutRoot: current.checkoutRoot, snapshot: input.snapshot },
        signal,
      );
      // A rejection is refused before the checkout is touched, so it alone
      // carries no undo point. Every other outcome — including a command the
      // timeout killed part-way through `read-tree -u` — may have already moved
      // files, and withholding the pre-restore checkpoint there would strand
      // the only way back.
      if (restored.status !== "rejected") return { ...restored, undo: undo.snapshot };
      // Nobody will ever be handed this capture, so its anchor is released
      // rather than left pinning a tree for the life of the checkout.
      await this.#mutation.releaseCheckpoint(
        {
          checkoutRoot: current.checkoutRoot,
          checkoutId: input.checkoutId,
          anchorId: undo.anchorId,
        },
        signal,
      );
      return restored;
    });
  }

  revert(
    input: {
      readonly checkoutId: string;
      readonly checkoutRoot: string;
      readonly oid: string;
      readonly expectedStateToken: string;
    },
    signal?: AbortSignal,
  ): Promise<GitServiceResult> {
    return this.#serialized(input.checkoutId, async () => {
      const current = await this.#ready(input.checkoutRoot, signal);
      if (!current) return { status: "unavailable" };
      if (current.stateToken !== input.expectedStateToken)
        return { status: "rejected", reason: "stale-state" };
      if (current.statusEntries.length > 0) return { status: "rejected", reason: "dirty-checkout" };
      return this.#mutation.revertCommit(
        { checkoutRoot: current.checkoutRoot, oid: input.oid },
        signal,
      );
    });
  }

  push(
    input: {
      readonly checkoutId: string;
      readonly checkoutRoot: string;
      readonly remote: string;
      readonly localRef: string;
      readonly remoteRef: string;
      readonly confirmation: {
        readonly remote: string;
        readonly refspec: string;
      };
      readonly expectedHeadOid: string;
      readonly expectedStateToken: string;
      readonly authority: "plan" | "approval-gated" | "approved" | "full-access";
    },
    signal?: AbortSignal,
  ): Promise<GitServiceResult> {
    return this.#serialized(input.checkoutId, async () => {
      if (input.authority !== "approved" && input.authority !== "full-access")
        return { status: "rejected", reason: "approval-required" };
      const current = await this.#ready(input.checkoutRoot, signal);
      if (!current) return { status: "unavailable" };
      if (current.stateToken !== input.expectedStateToken)
        return { status: "rejected", reason: "stale-state" };
      // An unborn branch has nothing to push, so it is refused before the head
      // comparison rather than reported as a stale observation.
      if (current.head.kind === "unborn") return { status: "rejected", reason: "unborn-head" };
      if (current.head.oid !== input.expectedHeadOid)
        return { status: "rejected", reason: "stale-state" };
      if (current.head.kind === "detached") return { status: "rejected", reason: "detached-head" };
      if (input.localRef !== `refs/heads/${current.head.name}`)
        return { status: "rejected", reason: "branch-mismatch" };
      if (!current.remotes.some((remote) => remote.name === input.remote))
        return { status: "rejected", reason: "remote-unavailable" };
      return this.#mutation.push(
        {
          checkoutRoot: current.checkoutRoot,
          remote: input.remote,
          localRef: input.localRef,
          remoteRef: input.remoteRef,
          confirmation: input.confirmation,
        },
        signal,
      );
    });
  }

  async #ready(root: string, signal?: AbortSignal): Promise<GitObservation | undefined> {
    const result = await this.#observation.observe(root, signal);
    return result.status === "ready" && result.checkoutRoot === root ? result : undefined;
  }

  #serialized<T>(checkoutId: string, operation: () => Promise<T>): Promise<T> {
    if (!checkoutId) return Promise.reject(new Error("Checkout identity is required."));
    const previous = this.#queues.get(checkoutId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => tail);
    this.#queues.set(checkoutId, queued);
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.#queues.get(checkoutId) === queued) this.#queues.delete(checkoutId);
      });
  }
}

function sameSummary(left: readonly GitStatusEntry[], right: readonly GitStatusEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

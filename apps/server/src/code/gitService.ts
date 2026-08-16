import type { GitMutationPort, GitMutationResult, GitTreeSnapshot } from "./gitMutationPort";
import type {
  GitObservation,
  GitObservationPort,
  GitObservationResult,
  GitStatusEntry,
} from "./gitObservationPort";

interface ObservationPort {
  observe(root: string, signal?: AbortSignal): Promise<GitObservationResult>;
}

interface MutationPort {
  stage(
    input: Parameters<GitMutationPort["stage"]>[0],
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
   * This writes Git objects and nothing else: no commit, no branch, no change
   * the user can see. Taking a checkpoint therefore never needs a state token
   * and never fails a turn — a checkout that cannot be read simply produces no
   * checkpoint, and the turn runs without one.
   */
  checkpoint(
    input: { readonly checkoutId: string; readonly checkoutRoot: string },
    signal?: AbortSignal,
  ): Promise<GitCheckpointResult> {
    return this.#serialized(input.checkoutId, async () => {
      const snapshot = await this.#mutation.snapshotWorkingTree(
        { checkoutRoot: input.checkoutRoot },
        signal,
      );
      return snapshot.status === "captured" ? snapshot : { status: "unavailable" };
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
        { checkoutRoot: current.checkoutRoot },
        signal,
      );
      if (undo.status !== "captured") return { status: "unavailable" };
      const restored = await this.#mutation.restoreWorkingTree(
        { checkoutRoot: current.checkoutRoot, snapshot: input.snapshot },
        signal,
      );
      return restored.status === "applied" ? { ...restored, undo: undo.snapshot } : restored;
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
      if (
        current.stateToken !== input.expectedStateToken ||
        current.head.oid !== input.expectedHeadOid
      )
        return { status: "rejected", reason: "stale-state" };
      if (current.head.branch.kind === "detached")
        return { status: "rejected", reason: "detached-head" };
      if (input.localRef !== `refs/heads/${current.head.branch.name}`)
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

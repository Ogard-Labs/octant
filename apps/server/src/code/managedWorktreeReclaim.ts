import { forReceipt, waitForSurvivingGit } from "./boundedGit";
import { deriveManagedWorktreeCheckoutId } from "./managedCodeThreadCreation";
import type { ManagedWorktreeReceipt, ManagedWorktreeReclaim } from "./managedWorktreeReceiptStore";
import {
  branchRef,
  managedTargetPath,
  type ManagedWorktreeAuthorityPort,
  type ManagedWorktreeFileSystemPort,
  type ManagedWorktreeGitPort,
  type ManagedWorktreeRefusalReason,
  type ManagedWorktreeRepositoryPort,
} from "./managedWorktreeService";
import type { ObservedGitWorktree, RepositoryIdentityObservation } from "./repositoryIdentity";

export interface ManagedWorktreeReclaimReceiptPort {
  load(receiptId: string): Promise<ManagedWorktreeReceipt | undefined>;
  transition(
    receiptId: string,
    state: "reclaimed" | "restoring" | "ready",
  ): Promise<ManagedWorktreeReceipt>;
  beginReclaim(receiptId: string, reclaim: ManagedWorktreeReclaim): Promise<ManagedWorktreeReceipt>;
  /** Recorded in the receipt just before Git is asked to remove the folder. */
  markRemovalStarted(receiptId: string): Promise<ManagedWorktreeReceipt>;
  abortReclaim(receiptId: string): Promise<ManagedWorktreeReceipt>;
}

export type ManagedWorktreeReclaimResult =
  | Readonly<{ status: "reclaimed"; receipt: ManagedWorktreeReceipt }>
  | Readonly<{ status: "restored"; receipt: ManagedWorktreeReceipt }>
  | Readonly<{ status: "refused"; reason: ManagedWorktreeRefusalReason }>
  | Readonly<{ status: "waiting" | "interrupted"; receipt?: ManagedWorktreeReceipt }>;

/** Why the host removes a folder it can bring back. */
export type ManagedWorktreeReclaimTrigger = "inactivity" | "delivered";

/**
 * How long one Git removal may run before it is stopped. A removal may take a
 * while on a large folder; one that never ends would hold the receipt, and so
 * every restore and purge of it, for ever. A stopped removal is only
 * interrupted: the receipt stays pending and the next pass settles it.
 */
export const REMOVAL_TIME_LIMIT_MS = 15 * 60 * 1_000;

/** How long a person's restore waits for a cleanup that holds the receipt before it says so. */
export const RESTORE_WAIT_MS = 10_000;

export interface ManagedWorktreeReclaimOptions {
  readonly receipts: ManagedWorktreeReclaimReceiptPort;
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly filesystem: ManagedWorktreeFileSystemPort;
  readonly git: ManagedWorktreeGitPort;
  readonly authority: ManagedWorktreeAuthorityPort;
  readonly removalTimeLimitMs?: number;
  readonly restoreWaitMs?: number;
}

type PresentWorktree = Extract<ObservedGitWorktree, { status: "present" }>;
type AvailableObservation = Extract<RepositoryIdentityObservation, { status: "available" }>;

/**
 * What a settled receipt's own worktrees look like. Only entries about this
 * receipt count: its own folder, or any worktree holding one of its branches.
 * A locked, prunable or missing worktree that belongs to something else in the
 * repository is not this receipt's to refuse over. `leftover` is this
 * receipt's own entry after a removal stopped before Git finished it: the
 * recorded branch and commit at the receipt's folder, listed as prunable
 * because the folder, or its `.git` file, is gone.
 */
type Inventory =
  | Readonly<{ kind: "ambiguous" }>
  | Readonly<{
      kind: "clear";
      leftover?: ObservedGitWorktree;
      /** This service's own `git worktree add` that was killed: locked `initializing`. */
      interruptedAdd?: ObservedGitWorktree;
    }>;

function isZeroHead(head: string | undefined): boolean {
  return head === undefined || /^0+$/.test(head);
}

function pathOf(worktree: ObservedGitWorktree): string {
  return worktree.status === "present" ? worktree.canonicalPath : worktree.reportedPath;
}

/**
 * Removes a managed worktree folder in a way a restore can undo, and brings it
 * back. It never deletes a branch, never touches checkpoint refs, and removes a
 * folder only when it is the one Octant made (it holds the receipt), is clean,
 * has nothing a branch cannot give back, and is verified against the repository,
 * the branch and the commit it recorded. While a receipt is anything but
 * `ready`, the checkout root does not resolve, so the thread takes no turn.
 */
export class ManagedWorktreeReclaimService {
  readonly #receipts: ManagedWorktreeReclaimReceiptPort;
  readonly #repository: ManagedWorktreeRepositoryPort;
  readonly #filesystem: ManagedWorktreeFileSystemPort;
  readonly #git: ManagedWorktreeGitPort;
  readonly #authority: ManagedWorktreeAuthorityPort;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #holders = new Map<string, "cleanup" | "restore">();
  readonly #removalTimeLimitMs: number;
  readonly #restoreWaitMs: number;

  constructor(options: ManagedWorktreeReclaimOptions) {
    this.#removalTimeLimitMs = options.removalTimeLimitMs ?? REMOVAL_TIME_LIMIT_MS;
    this.#restoreWaitMs = options.restoreWaitMs ?? RESTORE_WAIT_MS;
    this.#receipts = options.receipts;
    this.#repository = options.repository;
    this.#filesystem = options.filesystem;
    this.#git = options.git;
    this.#authority = options.authority;
  }

  /**
   * Runs one operation on a receipt at a time. Cleanup, resume, abandon and
   * restore each read the receipt and the folder and then change both, so two
   * overlapping would act on a state the other is about to change; the later
   * one waits and reads what the earlier left. Anything else that changes the
   * same receipt's folder (an archive cleanup) takes the same lock. `kind` says
   * what holds the lock, so a person's Restore that has to wait can say so.
   */
  exclusive<T>(
    receiptId: string,
    run: () => Promise<T>,
    kind: "cleanup" | "restore" = "cleanup",
  ): Promise<T> {
    return this.#enqueue(receiptId, kind, run);
  }

  async #enqueue<T>(
    receiptId: string,
    kind: "cleanup" | "restore",
    run: () => Promise<T>,
    started?: () => void,
  ): Promise<T> {
    const previous = this.#locks.get(receiptId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      this.#holders.set(receiptId, kind);
      try {
        // A Git that was stopped may have left a helper that outlived its kill
        // (see `runBoundedGit`). It could still be writing in a folder, so the
        // receipt is not handed on, nor started on, until every such group of
        // its own is gone; a person's restore that waits on it is told a cleanup holds it.
        await waitForSurvivingGit(receiptId);
        started?.();
        return await forReceipt(receiptId, run);
      } finally {
        await waitForSurvivingGit(receiptId);
        this.#holders.delete(receiptId);
      }
    });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(receiptId, settled);
    try {
      return await operation;
    } finally {
      if (this.#locks.get(receiptId) === settled) this.#locks.delete(receiptId);
    }
  }

  /**
   * The person's own operations wait for the receipt only a little, in all: a
   * cleanup or restore that still holds it is said so, and whatever queued
   * behind it is not left to run later on its own. The wait ends at the limit
   * even when several operations are in line.
   */
  #whenFree(
    receiptId: string,
    run: () => Promise<ManagedWorktreeReclaimResult>,
  ): Promise<ManagedWorktreeReclaimResult> {
    return this.#withinWait(receiptId, this.#restoreWaitMs, run, (holder) => ({
      status: "refused",
      reason: holder === "restore" ? "restore-running" : "cleanup-running",
    }));
  }

  /**
   * Like `exclusive`, but gives up when a cleanup or restore still holds the
   * receipt after `waitMs`: `busy`, and `run` then never runs, not even later
   * when the holder lets go. The lock itself is the same one.
   */
  exclusiveWithin<T>(
    receiptId: string,
    waitMs: number,
    run: () => Promise<T>,
  ): Promise<Readonly<{ status: "ran"; value: T }> | Readonly<{ status: "busy" }>> {
    return this.#withinWait<Readonly<{ status: "ran"; value: T }> | Readonly<{ status: "busy" }>>(
      receiptId,
      waitMs,
      async () => ({ status: "ran", value: await run() }),
      () => ({ status: "busy" }),
    );
  }

  async #withinWait<T>(
    receiptId: string,
    waitMs: number,
    run: () => Promise<T>,
    busy: (holder: "cleanup" | "restore" | undefined) => T,
  ): Promise<T> {
    let begun = false;
    let skipped = false;
    let begin: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const operation = this.#enqueue<T>(
      receiptId,
      "restore",
      async () => {
        if (skipped) return busy(undefined);
        begun = true;
        return run();
      },
      begin,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      reached.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    clearTimeout(timer);
    if (!waited && !begun) {
      skipped = true;
      void operation.catch(() => undefined);
      return busy(this.#holders.get(receiptId));
    }
    return operation;
  }

  reclaim(
    input: Readonly<{
      receiptId: string;
      trigger: ManagedWorktreeReclaimTrigger;
      /** Whether nothing is working in the thread; read fresh each time. */
      isIdle: () => boolean;
    }>,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult> {
    return this.exclusive(input.receiptId, () => this.#reclaim(input, signal));
  }

  async #reclaim(
    input: Readonly<{
      receiptId: string;
      trigger: ManagedWorktreeReclaimTrigger;
      isIdle: () => boolean;
    }>,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult> {
    let receipt: ManagedWorktreeReceipt | undefined;
    try {
      receipt = await this.#receipts.load(input.receiptId);
    } catch {
      return { status: "interrupted" };
    }
    if (receipt === undefined) return { status: "refused", reason: "unowned" };
    if (receipt.state === "reclaimed") return { status: "reclaimed", receipt };
    const resuming = receipt.state === "cleanup-pending" && receipt.reclaim !== undefined;
    if (receipt.state !== "ready" && !resuming) return { status: "refused", reason: "mismatched" };

    const known = await this.#checkAuthority(receipt, signal);
    if (known !== undefined) return known;
    const observed = await this.#observe(receipt, signal, resuming ? "relink" : "refuse");
    if (observed.status !== "available") return observed.result;
    const { observation, targets } = observed;

    if (targets.length === 0) {
      // Only an interrupted restorable cleanup may find its folder already gone.
      if (!resuming) return { status: "refused", reason: "mismatched" };
      return this.#finishReclaim(receipt, observation.repositoryRoot, signal);
    }
    const [target, ...extra] = targets;
    if (target === undefined || extra.length > 0) {
      return { status: "refused", reason: "inventory-ambiguous" };
    }
    if (target.detached || target.locked !== undefined || target.prunable !== undefined) {
      return { status: "refused", reason: "inventory-ambiguous" };
    }
    const branch = receipt.currentBranch ?? receipt.branchIntent;
    if (target.branch !== branchRef(branch)) return { status: "refused", reason: "mismatched" };
    const head = target.head;
    if (
      receipt.reclaim !== undefined &&
      (receipt.reclaim.branch !== branch || receipt.reclaim.head !== head)
    ) {
      // The folder changed after an interrupted cleanup began: it is a working
      // checkout again, so the cleanup gives up and the thread takes turns.
      return this.#giveUp(receipt, "mismatched", signal);
    }

    if (resuming) {
      // A removal cut short may have taken some tracked files: that is not a
      // working checkout to hand back, and the branch holds every one of them.
      const finished = await this.#finishCutShortRemoval(
        receipt,
        observation.repositoryRoot,
        input.isIdle,
        signal,
      );
      if (finished !== undefined) return finished;
    }
    if (!input.isIdle()) return this.#giveUp(receipt, "working", signal);
    const checked = await this.#checkFolder(receipt, input.trigger, branch, signal);
    if (checked !== undefined) return resuming ? this.#giveUpOn(receipt, checked, signal) : checked;

    try {
      receipt = await this.#receipts.beginReclaim(receipt.receiptId, { branch, head });
    } catch {
      return { status: "interrupted", receipt };
    }
    // A turn may have started between the first look and the receipt leaving
    // `ready`; from here none can, so one more look settles it.
    if (!input.isIdle()) return this.#giveUp(receipt, "working", signal);
    // The branch, commit and changes were read before the receipt left `ready`,
    // and a commit or checkout in a terminal outside Octant may have landed
    // since: a recorded commit that no longer matches the folder would leave
    // a receipt Restore refuses for ever. Read once more, right before Git.
    const changed = await this.#changedSince(receipt, observation.repositoryRoot, signal);
    if (changed !== undefined) return this.#giveUp(receipt, changed, signal);

    try {
      // Recorded before Git is asked, so a missing file found later is known to
      // be Git's partial removal and not a file the person deleted while waiting.
      receipt = await this.#receipts.markRemovalStarted(receipt.receiptId);
      const removed = await this.#removeFolder(observation.repositoryRoot, receipt, false);
      if (removed.status !== "removed") {
        return this.#afterRejectedRemoval(receipt, observation.repositoryRoot, signal);
      }
    } catch {
      return { status: "interrupted", receipt };
    }
    return this.#finishReclaim(receipt, observation.repositoryRoot, signal);
  }

  /**
   * What changed in the folder since the cleanup recorded its branch and commit,
   * or what Git must not be asked to delete, or nothing. Anything that cannot be
   * read counts as changed: the worktree stays the thread's.
   */
  async #changedSince(
    receipt: ManagedWorktreeReceipt,
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeRefusalReason | undefined> {
    const reclaim = receipt.reclaim;
    if (reclaim === undefined) return "unverified";
    try {
      if (!(await this.#stillThere(receipt, repositoryRoot, signal))) return "mismatched";
      // Everything Git would not refuse itself is read again too: it deletes
      // ignored files and cannot see an edit it was told to skip.
      const folder = await this.#checkFolder(receipt, "inactivity", reclaim.branch, signal);
      if (folder !== undefined) {
        return folder.status === "refused" ? folder.reason : "unverified";
      }
      return (await this.#stillThere(receipt, repositoryRoot, signal)) ? undefined : "mismatched";
    } catch {
      return "unverified";
    }
  }

  /**
   * Git has started deleting files, so the host stopping must not cut it
   * short: a half-deleted folder is worse than either end. A stop signal is
   * therefore not passed on; only the time limit is, so a removal that never
   * ends is interrupted instead of holding the receipt for ever. A crash or a
   * timeout is settled by the next pass.
   */
  #removeFolder(repositoryRoot: string, receipt: ManagedWorktreeReceipt, force: boolean) {
    return this.#git.removeWorktree(
      {
        repositoryRoot,
        targetPath: receipt.canonicalWorktreePath,
        ...(force ? { force: true } : {}),
      },
      AbortSignal.timeout(this.#removalTimeLimitMs),
    );
  }

  /**
   * Git refused to remove the folder (a submodule, a lock, a file it could not
   * delete). A folder that is still whole goes back to being the thread's
   * working checkout so it can take turns; one Git began deleting stays
   * pending for the next pass to finish.
   */
  async #afterRejectedRemoval(
    receipt: ManagedWorktreeReceipt,
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult> {
    try {
      const damage = await this.#git.readRemovalDamage?.(receipt.canonicalWorktreePath, signal);
      if (
        damage?.status === "observed" &&
        damage.missingTrackedFiles === 0 &&
        (await this.#filesystem.pathExists(receipt.canonicalWorktreePath, signal)) &&
        (await this.#stillThere(receipt, repositoryRoot, signal))
      ) {
        return { status: "waiting", receipt: await this.#receipts.abortReclaim(receipt.receiptId) };
      }
    } catch {
      return { status: "interrupted", receipt };
    }
    return { status: "waiting", receipt };
  }

  /** The folder is still a registered worktree on the recorded branch and commit. */
  async #stillThere(
    receipt: ManagedWorktreeReceipt,
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const reclaim = receipt.reclaim;
    if (reclaim === undefined) return false;
    const seen = await this.#repository.observe(repositoryRoot, signal);
    if (seen.status !== "available" || !this.#settled(seen, receipt)) return false;
    const present = seen.worktrees.filter(
      (worktree): worktree is PresentWorktree =>
        worktree.status === "present" && worktree.canonicalPath === receipt.canonicalWorktreePath,
    );
    const [only] = present;
    return (
      present.length === 1 &&
      only !== undefined &&
      !only.detached &&
      only.branch === branchRef(reclaim.branch) &&
      only.head === reclaim.head
    );
  }

  /**
   * Looks at a folder an interrupted cleanup left. Tracked files gone and
   * nothing else changed means Git was deleting it, and the removal is finished
   * with force: that is the one forced removal here, and it runs only on proof
   * that it loses nothing the recorded branch and commit do not hold. The proof
   * is read fresh, here, for every path that reaches it: the folder is still
   * the one registered on the recorded branch and commit, no hidden flag, sparse
   * checkout, submodule or operation under way is present, nothing but tracked
   * files is missing, and the thread is idle. A folder that fails any of it is
   * given back to the thread whole and the cleanup is dropped. Whole folders are
   * not touched here.
   */
  async #finishCutShortRemoval(
    receipt: ManagedWorktreeReceipt,
    repositoryRoot: string,
    isIdle: () => boolean,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult | undefined> {
    const reclaim = receipt.reclaim;
    try {
      if (reclaim === undefined || this.#git.readRemovalDamage === undefined) {
        return { status: "refused", reason: "unverified" };
      }
      const damage = await this.#git.readRemovalDamage(receipt.canonicalWorktreePath, signal);
      if (damage.status === "unavailable") return { status: "refused", reason: "unverified" };
      if (damage.status !== "observed") return { status: "waiting", receipt };
      if (damage.missingTrackedFiles === 0) return undefined;
      // Other changes beside the missing files are the person's. Nothing is
      // deleted: the missing files are put back and the thread has its folder.
      if (damage.otherChanges > 0) return this.#giveUp(receipt, "dirty", signal);
      // No removal of ours was ever started, so the files were deleted by the
      // person while the cleanup sat pending: their change, not Git's.
      if (reclaim.removalStarted !== true) return this.#giveUp(receipt, "dirty", signal);
      const refused = await this.#removalRefusal(receipt, reclaim, repositoryRoot, signal);
      if (refused !== undefined) return refused;
      if (!isIdle()) return { status: "refused", reason: "working" };
      // The proof is read last, right before the forced removal, so a change
      // made while the checks above ran is seen by it.
      const last = await this.#git.readRemovalDamage(receipt.canonicalWorktreePath, signal);
      if (last.status === "unavailable") return { status: "refused", reason: "unverified" };
      if (last.status !== "observed") return { status: "waiting", receipt };
      if (last.missingTrackedFiles === 0) return undefined;
      if (last.otherChanges > 0) return this.#giveUp(receipt, "dirty", signal);
      const removed = await this.#removeFolder(repositoryRoot, receipt, true);
      if (removed.status !== "removed") return { status: "waiting", receipt };
    } catch {
      return { status: "interrupted", receipt };
    }
    return this.#finishReclaim(receipt, repositoryRoot, signal);
  }

  /** What stands in the way of a forced removal, or undefined when the proof holds. */
  async #removalRefusal(
    receipt: ManagedWorktreeReceipt,
    reclaim: ManagedWorktreeReclaim,
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult | undefined> {
    const seen = await this.#repository.observe(repositoryRoot, signal);
    if (seen.status === "failed") return { status: "waiting", receipt };
    if (
      seen.status !== "available" ||
      seen.repositoryId !== receipt.repositoryId ||
      seen.repositoryRoot !== receipt.canonicalRepositoryPath ||
      !this.#settled(seen, receipt)
    ) {
      return this.#giveUp(receipt, "mismatched", signal);
    }
    const present = seen.worktrees.filter(
      (worktree): worktree is PresentWorktree =>
        worktree.status === "present" && worktree.canonicalPath === receipt.canonicalWorktreePath,
    );
    const [only] = present;
    if (
      present.length !== 1 ||
      only === undefined ||
      only.detached ||
      only.branch !== branchRef(reclaim.branch) ||
      only.head !== reclaim.head
    ) {
      return this.#giveUp(receipt, "mismatched", signal);
    }
    if (this.#git.findCleanupHazard === undefined)
      return { status: "refused", reason: "unverified" };
    const hazard = await this.#git.findCleanupHazard(receipt.canonicalWorktreePath, signal);
    if (hazard.status === "unavailable") return { status: "refused", reason: "unverified" };
    if (hazard.status !== "observed") return { status: "waiting", receipt };
    if (hazard.hazard === "hidden-edits")
      return this.#giveUp(receipt, "unrecoverable-files", signal);
    if (hazard.hazard === "unsupported")
      return this.#giveUp(receipt, "unsupported-checkout", signal);
    return undefined;
  }

  /**
   * Gives up an interrupted cleanup the person no longer wants. A folder still
   * there is given back to the thread whole: whatever the removal took is put
   * back from the folder's own index, and nothing is deleted, so no check of
   * its other contents is needed. One Git already removed becomes a cleaned-up
   * checkout that can be restored.
   */
  abandon(
    input: Readonly<{ receiptId: string }>,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult> {
    return this.#whenFree(input.receiptId, () => this.#abandon(input, signal));
  }

  async #abandon(
    input: Readonly<{ receiptId: string }>,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult> {
    let receipt: ManagedWorktreeReceipt | undefined;
    try {
      receipt = await this.#receipts.load(input.receiptId);
    } catch {
      return { status: "interrupted" };
    }
    if (receipt === undefined) return { status: "refused", reason: "unowned" };
    if (receipt.state === "ready") return { status: "restored", receipt };
    // A cleanup that finished while this waited has nothing left to give up.
    if (receipt.state === "reclaimed" || receipt.state === "restoring") {
      return { status: "reclaimed", receipt };
    }
    if (receipt.state !== "cleanup-pending" || receipt.reclaim === undefined) {
      return { status: "refused", reason: "not-reclaimed" };
    }
    const known = await this.#checkAuthority(receipt, signal);
    if (known !== undefined) return known;
    const observed = await this.#observe(receipt, signal, "relink");
    if (observed.status !== "available") return observed.result;
    if (observed.targets.length === 0) {
      return this.#finishReclaim(receipt, observed.observation.repositoryRoot, signal);
    }
    if (observed.targets.length !== 1) return { status: "refused", reason: "inventory-ambiguous" };
    const back = await this.#returnToThread(receipt, signal);
    if (back.status !== "back") return back.result;
    // The thread has its folder either way; the person is told what to do when
    // Git could not put every file back.
    return back.filesMissing
      ? { status: "refused", reason: "files-missing" }
      : { status: "restored", receipt: back.receipt };
  }

  restore(
    input: Readonly<{ receiptId: string }>,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult> {
    return this.#whenFree(input.receiptId, () => this.#restore(input, signal));
  }

  async #restore(
    input: Readonly<{ receiptId: string }>,
    signal: AbortSignal,
    retried = false,
  ): Promise<ManagedWorktreeReclaimResult> {
    let receipt: ManagedWorktreeReceipt | undefined;
    try {
      receipt = await this.#receipts.load(input.receiptId);
    } catch {
      return { status: "interrupted" };
    }
    if (receipt === undefined) return { status: "refused", reason: "unowned" };
    if (receipt.state === "ready") return { status: "restored", receipt };
    const reclaim = receipt.reclaim;
    if ((receipt.state !== "reclaimed" && receipt.state !== "restoring") || reclaim === undefined) {
      return { status: "refused", reason: "not-reclaimed" };
    }

    const known = await this.#checkAuthority(receipt, signal);
    if (known !== undefined) return known;
    // A registration left for a folder that is gone is dropped first, or Git
    // would refuse to put a worktree at the same path.
    const observed = await this.#observe(receipt, signal, "drop");
    if (observed.status !== "available") return observed.result;
    const { observation, targets } = observed;
    const [placed, ...others] = targets;
    if (others.length > 0) return { status: "refused", reason: "inventory-ambiguous" };

    if (placed !== undefined) {
      // A restore that was interrupted after Git made the folder: it is
      // trusted only once it matches the record, and is otherwise undone.
      if (receipt.state !== "restoring") return { status: "refused", reason: "path-collision" };
      return this.#settleRestored(
        input,
        receipt,
        reclaim,
        placed,
        observation,
        signal,
        retried,
        false,
      );
    }
    try {
      if (await this.#filesystem.pathExists(receipt.canonicalWorktreePath, signal)) {
        return { status: "refused", reason: "path-collision" };
      }
    } catch {
      return { status: "interrupted", receipt };
    }

    const mismatch = await this.#branchMatches(receipt, reclaim, observation, signal);
    if (mismatch !== undefined) return mismatch;
    if (this.#git.restoreWorktree === undefined) {
      return { status: "refused", reason: "unverified" };
    }

    try {
      if (receipt.state === "reclaimed") {
        receipt = await this.#receipts.transition(receipt.receiptId, "restoring");
      }
    } catch {
      return { status: "interrupted", receipt };
    }
    let created: Awaited<ReturnType<NonNullable<ManagedWorktreeGitPort["restoreWorktree"]>>>;
    try {
      created = await this.#git.restoreWorktree(
        {
          repositoryRoot: observation.repositoryRoot,
          targetPath: receipt.canonicalWorktreePath,
          branch: reclaim.branch,
        },
        this.#boundedSignal(signal),
      );
    } catch {
      return { status: "interrupted", receipt };
    }
    let confirmation: RepositoryIdentityObservation;
    try {
      confirmation = await this.#repository.observe(observation.repositoryRoot, signal);
    } catch {
      return { status: "interrupted", receipt };
    }
    if (created.status !== "created") {
      // Git said no, but a folder that is there and matches is the restore;
      // only a checkout that is truly absent goes back to cleaned up.
      const [here] = this.#presentAt(confirmation, receipt);
      if (here !== undefined) {
        return this.#settleRestored(
          input,
          receipt,
          reclaim,
          here,
          observation,
          signal,
          retried,
          false,
        );
      }
      try {
        if (!(await this.#filesystem.pathExists(receipt.canonicalWorktreePath, signal))) {
          await this.#receipts.transition(receipt.receiptId, "reclaimed");
          return { status: "refused", reason: "git-refused" };
        }
      } catch {
        return { status: "interrupted", receipt };
      }
      return { status: "waiting", receipt };
    }
    const present = this.#presentAt(confirmation, receipt);
    const [restored] = present;
    if (
      confirmation.status !== "available" ||
      confirmation.repositoryId !== receipt.repositoryId ||
      present.length !== 1 ||
      restored === undefined
    ) {
      return { status: "waiting", receipt };
    }
    return this.#settleRestored(
      input,
      receipt,
      reclaim,
      restored,
      observation,
      signal,
      retried,
      true,
    );
  }

  /**
   * Trusts the folder Git made, or undoes it. A folder that needed undoing and
   * held only the recorded commit's files is added again once.
   */
  async #settleRestored(
    input: Readonly<{ receiptId: string }>,
    receipt: ManagedWorktreeReceipt,
    reclaim: ManagedWorktreeReclaim,
    target: PresentWorktree,
    observation: AvailableObservation,
    signal: AbortSignal,
    retried: boolean,
    createdHere: boolean,
  ): Promise<ManagedWorktreeReclaimResult> {
    const verified = await this.#verifyRestored(
      receipt,
      reclaim,
      target,
      observation.repositoryRoot,
      signal,
      createdHere,
    );
    if (verified !== "again") return verified;
    return retried ? { status: "waiting", receipt } : this.#restore(input, signal, true);
  }

  #presentAt(
    observation: RepositoryIdentityObservation,
    receipt: ManagedWorktreeReceipt,
  ): ReadonlyArray<PresentWorktree> {
    return observation.status === "available" && this.#settled(observation, receipt)
      ? observation.worktrees.filter(
          (worktree): worktree is PresentWorktree =>
            worktree.status === "present" &&
            worktree.canonicalPath === receipt.canonicalWorktreePath,
        )
      : [];
  }

  /** The thread and repository the receipt names are still the ones the host holds. */
  async #checkAuthority(
    receipt: ManagedWorktreeReceipt,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult | undefined> {
    let authority: Awaited<ReturnType<ManagedWorktreeAuthorityPort["observeCleanupEligibility"]>>;
    try {
      authority = await this.#authority.observeCleanupEligibility(
        {
          repositoryId: receipt.repositoryId,
          threadId: receipt.threadId,
          checkoutId: receipt.checkoutId,
        },
        signal,
      );
    } catch {
      return { status: "interrupted", receipt };
    }
    if (authority.status !== "eligible") return { status: "waiting", receipt };
    if (
      authority.repositoryId !== receipt.repositoryId ||
      authority.checkoutId !== receipt.checkoutId ||
      receipt.checkoutId !==
        deriveManagedWorktreeCheckoutId({
          repositoryId: receipt.repositoryId,
          threadId: receipt.threadId,
        })
    ) {
      return { status: "refused", reason: "mismatched" };
    }
    return undefined;
  }

  /**
   * Reads the repository and finds the receipt's own worktree. `settle` says
   * what to do with a registration a removal left behind for this receipt: no
   * more than refuse it, drop it when its folder is gone, or also link a folder
   * that lost its `.git` file back to the repository.
   */
  async #observe(
    receipt: ManagedWorktreeReceipt,
    signal: AbortSignal,
    settle: "refuse" | "drop" | "relink" = "refuse",
  ): Promise<
    | Readonly<{
        status: "available";
        observation: AvailableObservation;
        targets: ReadonlyArray<PresentWorktree>;
      }>
    | Readonly<{ status: "stopped"; result: ManagedWorktreeReclaimResult }>
  > {
    let observation: RepositoryIdentityObservation;
    try {
      observation = await this.#repository.observe(receipt.canonicalRepositoryPath, signal);
    } catch {
      return { status: "stopped", result: { status: "interrupted", receipt } };
    }
    if (observation.status === "failed") {
      return { status: "stopped", result: { status: "waiting", receipt } };
    }
    if (
      observation.status !== "available" ||
      observation.repositoryId !== receipt.repositoryId ||
      observation.repositoryRoot !== receipt.canonicalRepositoryPath
    ) {
      return { status: "stopped", result: { status: "refused", reason: "mismatched" } };
    }
    // The folder is only ever the one the service derives for this thread.
    if (
      managedTargetPath(observation.repositoryRoot, receipt.repositoryId, receipt.threadId) !==
      receipt.canonicalWorktreePath
    ) {
      return { status: "stopped", result: { status: "refused", reason: "mismatched" } };
    }
    const inventory = this.#inventory(observation, receipt);
    if (inventory.kind === "ambiguous") {
      return { status: "stopped", result: { status: "refused", reason: "inventory-ambiguous" } };
    }
    if (inventory.interruptedAdd !== undefined) {
      // Only the person's Restore, which knows the add was ours, may undo it.
      if (settle !== "drop") {
        return { status: "stopped", result: { status: "refused", reason: "inventory-ambiguous" } };
      }
      const discarded = await this.#discardInterruptedAdd(receipt, observation, signal);
      if (discarded !== undefined) return { status: "stopped", result: discarded };
      return this.#observe(receipt, signal, "refuse");
    }
    if (inventory.leftover !== undefined) {
      if (settle === "refuse") {
        return { status: "stopped", result: { status: "refused", reason: "inventory-ambiguous" } };
      }
      const stopped = await this.#settleLeftover(
        receipt,
        observation,
        inventory.leftover,
        settle === "relink",
        signal,
      );
      if (stopped !== undefined) return { status: "stopped", result: stopped };
      // One more look, which must find it settled.
      return this.#observe(receipt, signal, "refuse");
    }
    return {
      status: "available",
      observation,
      targets: observation.worktrees.filter(
        (worktree): worktree is PresentWorktree =>
          worktree.status === "present" && worktree.canonicalPath === receipt.canonicalWorktreePath,
      ),
    };
  }

  /**
   * Only worktrees about this receipt can make its inventory ambiguous: a lock
   * on, or a registration gone stale for, its own folder or a branch it holds.
   * What other worktrees of the repository look like is not its business. Two
   * entries at the receipt's own folder are this service's own debris and are
   * settled instead of refused: the interrupted `git worktree add` of a restore
   * (locked `initializing`), and the registration a removal left after it
   * stopped while Git deleted its admin directory (prunable, with no branch or
   * an all-zero head, or the recorded branch and commit).
   */
  #inventory(observation: AvailableObservation, receipt: ManagedWorktreeReceipt): Inventory {
    const branches = new Set([branchRef(receipt.branchIntent)]);
    if (receipt.currentBranch !== undefined) branches.add(branchRef(receipt.currentBranch));
    if (receipt.reclaim !== undefined) branches.add(branchRef(receipt.reclaim.branch));
    let leftover: ObservedGitWorktree | undefined;
    let interruptedAdd: ObservedGitWorktree | undefined;
    for (const worktree of observation.worktrees) {
      const here = pathOf(worktree) === receipt.canonicalWorktreePath;
      if (!here && (worktree.branch === undefined || !branches.has(worktree.branch))) continue;
      if (worktree.locked !== undefined) {
        if (interruptedAdd === undefined && here && this.#isInterruptedAdd(worktree, receipt)) {
          interruptedAdd = worktree;
          continue;
        }
        return { kind: "ambiguous" };
      }
      if (worktree.prunable === undefined) continue;
      if (leftover !== undefined || !here || !this.#isOwnLeftover(worktree, receipt)) {
        return { kind: "ambiguous" };
      }
      leftover = worktree;
    }
    return {
      kind: "clear",
      ...(leftover === undefined ? {} : { leftover }),
      ...(interruptedAdd === undefined ? {} : { interruptedAdd }),
    };
  }

  /** Locked `initializing` at the folder of a restore in progress, on the recorded branch. */
  #isInterruptedAdd(worktree: ObservedGitWorktree, receipt: ManagedWorktreeReceipt): boolean {
    const reclaim = receipt.reclaim;
    return (
      receipt.state === "restoring" &&
      reclaim !== undefined &&
      worktree.locked === "initializing" &&
      (worktree.branch === branchRef(reclaim.branch) ||
        // Killed before Git wrote the branch into the new worktree's HEAD.
        (worktree.branch === undefined && isZeroHead(worktree.head)))
    );
  }

  /** A prunable entry at the receipt's folder that a stopped removal of ours could have left. */
  #isOwnLeftover(worktree: ObservedGitWorktree, receipt: ManagedWorktreeReceipt): boolean {
    const reclaim = receipt.reclaim;
    if (reclaim === undefined) return false;
    const exact =
      !worktree.detached &&
      worktree.branch === branchRef(reclaim.branch) &&
      worktree.head === reclaim.head;
    // Git was deleting the entry's own files: what is left may have no HEAD, so
    // it reads as detached, headless or on all-zero commit.
    const broken = worktree.detached || worktree.branch === undefined || isZeroHead(worktree.head);
    return exact || broken;
  }

  /** The receipt's own worktrees are all in order, with no leftover registration. */
  #settled(observation: AvailableObservation, receipt: ManagedWorktreeReceipt): boolean {
    const inventory = this.#inventory(observation, receipt);
    return (
      inventory.kind === "clear" &&
      inventory.leftover === undefined &&
      inventory.interruptedAdd === undefined
    );
  }

  /**
   * A removal stopped after Git deleted the folder's `.git` file, or the folder
   * itself, and left this receipt's registration behind. It is this receipt's
   * own when the path, branch and commit match the record, and Git lists it as
   * prunable.
   *
   * A folder that is gone needs only its registration dropped: `git worktree
   * remove` on that path deletes that one admin entry and nothing else, never
   * the repository-wide `prune` that would also drop other worktrees' entries.
   * A folder that remains is linked back by writing its `.git` file again, so
   * the worktree is whole to Git and any file in it that the commit does not
   * hold is an ordinary change. Nothing in the folder is moved or deleted.
   */
  async #settleLeftover(
    receipt: ManagedWorktreeReceipt,
    observation: AvailableObservation,
    leftover: ObservedGitWorktree,
    relink: boolean,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult | undefined> {
    try {
      const path = receipt.canonicalWorktreePath;
      if (
        leftover.status === "missing-prunable" ||
        !(await this.#filesystem.pathExists(path, signal))
      ) {
        const dropped = await this.#git.removeWorktree(
          { repositoryRoot: observation.repositoryRoot, targetPath: path },
          this.#boundedSignal(signal),
        );
        return dropped.status === "removed"
          ? undefined
          : { status: "refused", reason: "git-refused" };
      }
      // A folder is linked back only when its entry is what the record says;
      // anything else at the folder is not ours to adopt.
      const reclaim = receipt.reclaim;
      const exact =
        reclaim !== undefined &&
        !leftover.detached &&
        leftover.branch === branchRef(reclaim.branch) &&
        leftover.head === reclaim.head;
      if (!relink || !exact || this.#git.relinkWorktree === undefined) {
        return { status: "refused", reason: "path-collision" };
      }
      const linked = await this.#git.relinkWorktree(
        { commonDirectory: observation.commonDirectory, targetPath: path },
        signal,
      );
      return linked.status === "linked"
        ? undefined
        : { status: "refused", reason: "path-collision" };
    } catch {
      return { status: "interrupted", receipt };
    }
  }

  /** The caller's stop signal, and the time limit one Git change may run. */
  #boundedSignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(this.#removalTimeLimitMs)]);
  }

  /**
   * A restore killed during `git worktree add` leaves its entry locked
   * `initializing`, a partial folder, an `index.lock` and no index. It is this
   * service's own attempt, so it is discarded, and only when nothing in the
   * folder can be a person's work: every file in it is the recorded commit's
   * file. A folder with anything else is kept, and the person is told to move
   * it away. The add is then made again by the restore that found this.
   */
  async #discardInterruptedAdd(
    receipt: ManagedWorktreeReceipt,
    observation: AvailableObservation,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult | undefined> {
    const reclaim = receipt.reclaim;
    if (reclaim === undefined) return { status: "refused", reason: "inventory-ambiguous" };
    try {
      const path = receipt.canonicalWorktreePath;
      if (await this.#filesystem.pathExists(path, signal)) {
        if (this.#git.readFolderAgainstCommit === undefined) {
          return { status: "refused", reason: "unverified" };
        }
        const compared = await this.#git.readFolderAgainstCommit(
          { repositoryRoot: observation.repositoryRoot, targetPath: path, head: reclaim.head },
          signal,
        );
        if (compared.status === "unavailable") return { status: "refused", reason: "unverified" };
        if (compared.status !== "observed") return { status: "waiting", receipt };
        if (!compared.matches) return { status: "refused", reason: "partial-folder" };
      }
      const removed = await this.#git.removeWorktree(
        {
          repositoryRoot: observation.repositoryRoot,
          targetPath: path,
          force: true,
          overrideLock: true,
        },
        this.#boundedSignal(signal),
      );
      return removed.status === "removed"
        ? undefined
        : { status: "refused", reason: "git-refused" };
    } catch {
      return { status: "interrupted", receipt };
    }
  }

  /** Clean, nothing a branch cannot give back, and delivered when the trigger asks. */
  async #checkFolder(
    receipt: ManagedWorktreeReceipt,
    trigger: ManagedWorktreeReclaimTrigger,
    branch: string,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult | undefined> {
    try {
      const dirty = await this.#git.isDirty(receipt.canonicalWorktreePath, signal);
      if (dirty.status === "unavailable") return { status: "refused", reason: "unverified" };
      if (dirty.status !== "observed") return { status: "waiting", receipt };
      if (dirty.dirty) return { status: "refused", reason: "dirty" };
      if (this.#git.hasUnrecoverableFiles === undefined) {
        return { status: "refused", reason: "unverified" };
      }
      const files = await this.#git.hasUnrecoverableFiles(receipt.canonicalWorktreePath, signal);
      if (files.status === "unavailable") return { status: "refused", reason: "unverified" };
      if (files.status !== "observed") return { status: "waiting", receipt };
      if (files.found) return { status: "refused", reason: "unrecoverable-files" };
      if (this.#git.findCleanupHazard === undefined) {
        return { status: "refused", reason: "unverified" };
      }
      const hazard = await this.#git.findCleanupHazard(receipt.canonicalWorktreePath, signal);
      if (hazard.status === "unavailable") return { status: "refused", reason: "unverified" };
      if (hazard.status !== "observed") return { status: "waiting", receipt };
      if (hazard.hazard === "hidden-edits") {
        return { status: "refused", reason: "unrecoverable-files" };
      }
      if (hazard.hazard === "unsupported") {
        return { status: "refused", reason: "unsupported-checkout" };
      }
      if (trigger === "delivered") {
        const delivered = (await this.#git.isDelivered?.(
          {
            targetPath: receipt.canonicalWorktreePath,
            branch,
            startPoint: receipt.expectedHead,
          },
          signal,
        )) ?? { status: "observed" as const, delivered: false };
        if (delivered.status !== "observed") return { status: "waiting", receipt };
        if (!delivered.delivered) return { status: "refused", reason: "undelivered" };
      }
    } catch {
      return { status: "interrupted", receipt };
    }
    return undefined;
  }

  async #finishReclaim(
    receipt: ManagedWorktreeReceipt,
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult> {
    let confirmation: RepositoryIdentityObservation;
    try {
      confirmation = await this.#repository.observe(repositoryRoot, signal);
    } catch {
      return { status: "interrupted", receipt };
    }
    if (
      confirmation.status !== "available" ||
      confirmation.repositoryId !== receipt.repositoryId ||
      confirmation.repositoryRoot !== receipt.canonicalRepositoryPath ||
      !this.#settled(confirmation, receipt) ||
      confirmation.worktrees.some(
        (worktree) =>
          worktree.status === "present" && worktree.canonicalPath === receipt.canonicalWorktreePath,
      )
    ) {
      return { status: "waiting", receipt };
    }
    try {
      if (await this.#filesystem.pathExists(receipt.canonicalWorktreePath, signal)) {
        // Git no longer lists it (someone ran `git worktree prune`) yet the
        // folder is there. Waiting would never end: it is the person's to move.
        return { status: "refused", reason: "path-collision" };
      }
      const reclaimed = await this.#receipts.transition(receipt.receiptId, "reclaimed");
      return { status: "reclaimed", receipt: reclaimed };
    } catch {
      return { status: "interrupted", receipt };
    }
  }

  /** The branch is still there and still points where the record says. */
  async #branchMatches(
    receipt: ManagedWorktreeReceipt,
    reclaim: ManagedWorktreeReclaim,
    observation: AvailableObservation,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult | undefined> {
    if (this.#git.resolveBranchHead === undefined)
      return { status: "refused", reason: "unverified" };
    let tip: Awaited<ReturnType<NonNullable<ManagedWorktreeGitPort["resolveBranchHead"]>>>;
    try {
      tip = await this.#git.resolveBranchHead(
        { repositoryRoot: observation.repositoryRoot, branch: reclaim.branch },
        signal,
      );
    } catch {
      return { status: "interrupted", receipt };
    }
    if (tip.status !== "observed") return { status: "waiting", receipt };
    if (tip.head !== reclaim.head) return { status: "refused", reason: "restore-mismatch" };
    // Git would refuse it too, but the answer should say why.
    if (
      observation.worktrees.some(
        (worktree) =>
          worktree.status === "present" && worktree.branch === branchRef(reclaim.branch),
      )
    ) {
      return { status: "refused", reason: "branch-collision" };
    }
    return undefined;
  }

  /**
   * `again`: the folder Git made was not whole (no index, an `index.lock`, or
   * changes against the commit), held nothing but the recorded commit's files,
   * and was taken away; the caller adds it once more.
   */
  async #verifyRestored(
    receipt: ManagedWorktreeReceipt,
    reclaim: ManagedWorktreeReclaim,
    target: PresentWorktree,
    repositoryRoot: string,
    signal: AbortSignal,
    createdHere: boolean,
  ): Promise<ManagedWorktreeReclaimResult | "again"> {
    const listedRight =
      !target.detached &&
      target.locked === undefined &&
      target.prunable === undefined &&
      target.branch === branchRef(reclaim.branch) &&
      target.head === reclaim.head;
    if (listedRight) {
      // Git listing the branch and commit is not enough: a restore killed while
      // checking files out lists the same and has no index, or a lock left.
      if (this.#git.inspectRestoredFolder === undefined) {
        return { status: "refused", reason: "unverified" };
      }
      let inspected: Awaited<
        ReturnType<NonNullable<ManagedWorktreeGitPort["inspectRestoredFolder"]>>
      >;
      try {
        inspected = await this.#git.inspectRestoredFolder(receipt.canonicalWorktreePath, signal);
      } catch {
        return { status: "interrupted", receipt };
      }
      if (inspected.status === "unavailable") return { status: "refused", reason: "unverified" };
      if (inspected.status !== "observed") return { status: "waiting", receipt };
      if (inspected.whole) {
        try {
          return {
            status: "restored",
            receipt: await this.#receipts.transition(receipt.receiptId, "ready"),
          };
        } catch {
          return { status: "interrupted", receipt };
        }
      }
      return this.#discardUnsound(receipt, reclaim, repositoryRoot, signal);
    }
    return this.#keepMismatched(receipt, target, repositoryRoot, signal, createdHere);
  }

  /**
   * A folder that is not on the recorded branch and commit is never removed on
   * sight. Git deletes ignored files even without force, and a folder found
   * here (a restore that was interrupted, then worked in) may hold the
   * person's. Only the folder this very call made, and only when every file in
   * it is the commit it is on, is taken away again; any other stays, the
   * checkout stays cleaned up, and the person is told the folder is in the way.
   */
  async #keepMismatched(
    receipt: ManagedWorktreeReceipt,
    target: PresentWorktree,
    repositoryRoot: string,
    signal: AbortSignal,
    createdHere: boolean,
  ): Promise<ManagedWorktreeReclaimResult> {
    try {
      if (
        createdHere &&
        !target.detached &&
        target.locked === undefined &&
        target.prunable === undefined &&
        !isZeroHead(target.head) &&
        this.#git.readFolderAgainstCommit !== undefined
      ) {
        const compared = await this.#git.readFolderAgainstCommit(
          {
            repositoryRoot,
            targetPath: receipt.canonicalWorktreePath,
            head: target.head,
          },
          signal,
        );
        if (compared.status === "observed" && compared.matches) {
          const removed = await this.#git.removeWorktree(
            { repositoryRoot, targetPath: receipt.canonicalWorktreePath },
            this.#boundedSignal(signal),
          );
          if (removed.status === "removed") {
            await this.#receipts.transition(receipt.receiptId, "reclaimed");
            return { status: "refused", reason: "restore-mismatch" };
          }
          return { status: "waiting", receipt };
        }
      }
      // Kept as found: the cleaned-up checkout stays restorable once the person
      // moves the folder away.
      await this.#receipts.transition(receipt.receiptId, "reclaimed");
      return { status: "refused", reason: "path-collision" };
    } catch {
      return { status: "interrupted", receipt };
    }
  }

  /** The folder is not whole: it goes only when every file in it is the commit's own. */
  async #discardUnsound(
    receipt: ManagedWorktreeReceipt,
    reclaim: ManagedWorktreeReclaim,
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult | "again"> {
    try {
      if (this.#git.readFolderAgainstCommit === undefined) {
        return { status: "refused", reason: "unverified" };
      }
      const compared = await this.#git.readFolderAgainstCommit(
        {
          repositoryRoot,
          targetPath: receipt.canonicalWorktreePath,
          head: reclaim.head,
        },
        signal,
      );
      if (compared.status === "unavailable") return { status: "refused", reason: "unverified" };
      if (compared.status !== "observed") return { status: "waiting", receipt };
      if (!compared.matches) return { status: "refused", reason: "partial-folder" };
      const removed = await this.#git.removeWorktree(
        { repositoryRoot, targetPath: receipt.canonicalWorktreePath, force: true },
        this.#boundedSignal(signal),
      );
      return removed.status === "removed" ? "again" : { status: "waiting", receipt };
    } catch {
      return { status: "interrupted", receipt };
    }
  }

  /**
   * Hands the folder back to the thread and drops the cleanup. Whatever a
   * removal that stopped part way took is put back from the folder's own
   * index first, so the thread resumes on a whole checkout; nothing is deleted
   * or overwritten, and the folder's other contents stay as they are. Files
   * are put back only after this host started a removal: before that a missing
   * file is the person's own deletion and stays deleted. The receipt always
   * returns to `ready`, never stays pending: when Git could not put every file
   * back, `filesMissing` tells the caller to say what to do, and the thread
   * still takes turns on the folder it has.
   */
  async #returnToThread(
    receipt: ManagedWorktreeReceipt,
    signal: AbortSignal,
  ): Promise<
    | Readonly<{ status: "back"; receipt: ManagedWorktreeReceipt; filesMissing: boolean }>
    | Readonly<{ status: "stuck"; result: ManagedWorktreeReclaimResult }>
  > {
    try {
      let filesMissing = false;
      if (receipt.reclaim?.removalStarted === true) {
        const restored = await this.#git.restoreMissingFiles?.(
          receipt.canonicalWorktreePath,
          signal,
        );
        if (restored !== undefined && restored.status !== "observed") {
          // Putting them back failed; whether anything is missing is read again.
          const damage = await this.#git.readRemovalDamage?.(receipt.canonicalWorktreePath, signal);
          filesMissing = !(damage?.status === "observed" && damage.missingTrackedFiles === 0);
        }
      }
      return {
        status: "back",
        receipt: await this.#receipts.abortReclaim(receipt.receiptId),
        filesMissing,
      };
    } catch {
      return { status: "stuck", result: { status: "interrupted", receipt } };
    }
  }

  async #giveUp(
    receipt: ManagedWorktreeReceipt,
    reason: ManagedWorktreeRefusalReason,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult> {
    if (receipt.state === "cleanup-pending") {
      const back = await this.#returnToThread(receipt, signal);
      if (back.status === "stuck") return back.result;
    }
    return { status: "refused", reason };
  }

  /** A resumed cleanup whose folder no longer qualifies stops and lets the thread run. */
  async #giveUpOn(
    receipt: ManagedWorktreeReceipt,
    result: ManagedWorktreeReclaimResult,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult> {
    return result.status === "refused" ? this.#giveUp(receipt, result.reason, signal) : result;
  }
}

import { deriveManagedWorktreeCheckoutId } from "./managedCodeThreadCreation";
import type { ManagedWorktreeReceipt, ManagedWorktreeReclaim } from "./managedWorktreeReceiptStore";
import {
  branchRef,
  hasAmbiguousInventory,
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
  abortReclaim(receiptId: string): Promise<ManagedWorktreeReceipt>;
}

export type ManagedWorktreeReclaimResult =
  | Readonly<{ status: "reclaimed"; receipt: ManagedWorktreeReceipt }>
  | Readonly<{ status: "restored"; receipt: ManagedWorktreeReceipt }>
  | Readonly<{ status: "refused"; reason: ManagedWorktreeRefusalReason }>
  | Readonly<{ status: "waiting" | "interrupted"; receipt?: ManagedWorktreeReceipt }>;

/** Why the host removes a folder it can bring back. */
export type ManagedWorktreeReclaimTrigger = "inactivity" | "delivered";

export interface ManagedWorktreeReclaimOptions {
  readonly receipts: ManagedWorktreeReclaimReceiptPort;
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly filesystem: ManagedWorktreeFileSystemPort;
  readonly git: ManagedWorktreeGitPort;
  readonly authority: ManagedWorktreeAuthorityPort;
}

type PresentWorktree = Extract<ObservedGitWorktree, { status: "present" }>;

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

  constructor(options: ManagedWorktreeReclaimOptions) {
    this.#receipts = options.receipts;
    this.#repository = options.repository;
    this.#filesystem = options.filesystem;
    this.#git = options.git;
    this.#authority = options.authority;
  }

  async reclaim(
    input: Readonly<{
      receiptId: string;
      trigger: ManagedWorktreeReclaimTrigger;
      /** Whether no turn is starting, running, or waiting on the person; read fresh each time. */
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
    const observed = await this.#observe(receipt, signal);
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
      await this.#receipts.abortReclaim(receipt.receiptId).catch(() => undefined);
      return { status: "refused", reason: "mismatched" };
    }

    if (!input.isIdle()) return this.#giveUp(receipt, "working");
    const checked = await this.#checkFolder(receipt, input.trigger, branch, signal);
    if (checked !== undefined) return resuming ? this.#giveUpOn(receipt, checked) : checked;

    try {
      receipt = await this.#receipts.beginReclaim(receipt.receiptId, { branch, head });
    } catch {
      return { status: "interrupted", receipt };
    }
    // A turn may have started between the first look and the receipt leaving
    // `ready`; from here none can, so one more look settles it.
    if (!input.isIdle()) return this.#giveUp(receipt, "working");

    try {
      const removed = await this.#git.removeWorktree(
        { repositoryRoot: observation.repositoryRoot, targetPath: receipt.canonicalWorktreePath },
        signal,
      );
      if (removed.status !== "removed") return { status: "waiting", receipt };
    } catch {
      return { status: "interrupted", receipt };
    }
    return this.#finishReclaim(receipt, observation.repositoryRoot, signal);
  }

  /**
   * Gives up an interrupted cleanup the person no longer wants: a folder still
   * there goes back to being the thread's working checkout, and one Git already
   * removed becomes a cleaned-up checkout that can be restored, since nothing
   * can put the files back.
   */
  async abandon(
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
    if (receipt.state !== "cleanup-pending" || receipt.reclaim === undefined) {
      return { status: "refused", reason: "not-reclaimed" };
    }
    const known = await this.#checkAuthority(receipt, signal);
    if (known !== undefined) return known;
    const observed = await this.#observe(receipt, signal);
    if (observed.status !== "available") return observed.result;
    if (observed.targets.length === 0) {
      return this.#finishReclaim(receipt, observed.observation.repositoryRoot, signal);
    }
    if (observed.targets.length !== 1) return { status: "refused", reason: "inventory-ambiguous" };
    try {
      return { status: "restored", receipt: await this.#receipts.abortReclaim(receipt.receiptId) };
    } catch {
      return { status: "interrupted", receipt };
    }
  }

  async restore(
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
    const reclaim = receipt.reclaim;
    if ((receipt.state !== "reclaimed" && receipt.state !== "restoring") || reclaim === undefined) {
      return { status: "refused", reason: "not-reclaimed" };
    }

    const known = await this.#checkAuthority(receipt, signal);
    if (known !== undefined) return known;
    const observed = await this.#observe(receipt, signal);
    if (observed.status !== "available") return observed.result;
    const { observation, targets } = observed;
    const [placed, ...others] = targets;
    if (others.length > 0) return { status: "refused", reason: "inventory-ambiguous" };

    if (placed !== undefined) {
      // A restore that was interrupted after Git made the folder: it is
      // trusted only once it matches the record, and is otherwise undone.
      if (receipt.state !== "restoring") return { status: "refused", reason: "path-collision" };
      return this.#verifyRestored(receipt, reclaim, placed, observation.repositoryRoot, signal);
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
        signal,
      );
    } catch {
      return { status: "interrupted", receipt };
    }
    if (created.status !== "created") {
      await this.#receipts.transition(receipt.receiptId, "reclaimed").catch(() => undefined);
      return { status: "waiting", receipt };
    }
    let confirmation: RepositoryIdentityObservation;
    try {
      confirmation = await this.#repository.observe(observation.repositoryRoot, signal);
    } catch {
      return { status: "interrupted", receipt };
    }
    const present =
      confirmation.status === "available" && !hasAmbiguousInventory(confirmation)
        ? confirmation.worktrees.filter(
            (worktree): worktree is PresentWorktree =>
              worktree.status === "present" &&
              worktree.canonicalPath === receipt.canonicalWorktreePath,
          )
        : [];
    const [restored] = present;
    if (
      confirmation.status !== "available" ||
      confirmation.repositoryId !== receipt.repositoryId ||
      present.length !== 1 ||
      restored === undefined
    ) {
      return { status: "waiting", receipt };
    }
    return this.#verifyRestored(receipt, reclaim, restored, observation.repositoryRoot, signal);
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

  async #observe(
    receipt: ManagedWorktreeReceipt,
    signal: AbortSignal,
  ): Promise<
    | Readonly<{
        status: "available";
        observation: Extract<RepositoryIdentityObservation, { status: "available" }>;
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
    if (hasAmbiguousInventory(observation)) {
      return { status: "stopped", result: { status: "refused", reason: "inventory-ambiguous" } };
    }
    // The folder is only ever the one the service derives for this thread.
    if (
      managedTargetPath(observation.repositoryRoot, receipt.repositoryId, receipt.threadId) !==
      receipt.canonicalWorktreePath
    ) {
      return { status: "stopped", result: { status: "refused", reason: "mismatched" } };
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
      if (trigger === "delivered") {
        const delivered = (await this.#git.isDelivered?.(
          { targetPath: receipt.canonicalWorktreePath, branch },
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
      hasAmbiguousInventory(confirmation) ||
      confirmation.worktrees.some(
        (worktree) =>
          worktree.status === "present" && worktree.canonicalPath === receipt.canonicalWorktreePath,
      )
    ) {
      return { status: "waiting", receipt };
    }
    try {
      if (await this.#filesystem.pathExists(receipt.canonicalWorktreePath, signal)) {
        return { status: "waiting", receipt };
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
    observation: Extract<RepositoryIdentityObservation, { status: "available" }>,
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

  async #verifyRestored(
    receipt: ManagedWorktreeReceipt,
    reclaim: ManagedWorktreeReclaim,
    target: PresentWorktree,
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeReclaimResult> {
    if (
      !target.detached &&
      target.locked === undefined &&
      target.prunable === undefined &&
      target.branch === branchRef(reclaim.branch) &&
      target.head === reclaim.head
    ) {
      try {
        return {
          status: "restored",
          receipt: await this.#receipts.transition(receipt.receiptId, "ready"),
        };
      } catch {
        return { status: "interrupted", receipt };
      }
    }
    // Not what was recorded: take the fresh, untouched folder away again and
    // leave the checkout reclaimed, so no turn runs on the wrong commit.
    try {
      const removed = await this.#git.removeWorktree(
        { repositoryRoot, targetPath: receipt.canonicalWorktreePath },
        signal,
      );
      if (removed.status === "removed") {
        await this.#receipts.transition(receipt.receiptId, "reclaimed");
        return { status: "refused", reason: "restore-mismatch" };
      }
    } catch {
      return { status: "interrupted", receipt };
    }
    return { status: "waiting", receipt };
  }

  async #giveUp(
    receipt: ManagedWorktreeReceipt,
    reason: ManagedWorktreeRefusalReason,
  ): Promise<ManagedWorktreeReclaimResult> {
    if (receipt.state === "cleanup-pending") {
      await this.#receipts.abortReclaim(receipt.receiptId).catch(() => undefined);
    }
    return { status: "refused", reason };
  }

  /** A resumed cleanup whose folder no longer qualifies stops and lets the thread run. */
  async #giveUpOn(
    receipt: ManagedWorktreeReceipt,
    result: ManagedWorktreeReclaimResult,
  ): Promise<ManagedWorktreeReclaimResult> {
    if (result.status === "refused") {
      await this.#receipts.abortReclaim(receipt.receiptId).catch(() => undefined);
    }
    return result;
  }
}

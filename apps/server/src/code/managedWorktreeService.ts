import { dirname, join } from "node:path";
import type {
  BindingRevisionId,
  CodeCheckoutId,
  CodeRepositoryId,
  CodeThreadId,
  ManagedRootGrantId,
  ProjectId,
  WindowId,
} from "@octant/contracts";
import {
  ManagedRootGrantError,
  type ManagedRootGrant,
  type ManagedRootParent,
  type ManagedRootGrantStore,
} from "./managedRootGrantStore";
import type {
  CreateManagedWorktreeReceiptInput,
  ManagedWorktreeReceipt,
  ManagedWorktreeReceiptLookup,
  ManagedWorktreeReceiptState,
  ManagedWorktreeSourceProvenance,
} from "./managedWorktreeReceiptStore";
import type { RepositoryIdentityObservation } from "./repositoryIdentity";

export type ManagedWorktreeRefObservation =
  | Readonly<{ status: "resolved"; oid: string }>
  | Readonly<{ status: "missing" | "ambiguous" | "failed" }>;

export interface ManagedWorktreeRepositoryPort {
  observe(root: string, signal: AbortSignal): Promise<RepositoryIdentityObservation>;
}

export interface ManagedWorktreeFileSystemPort {
  observeParent(
    path: string,
    signal: AbortSignal,
  ): Promise<
    | Readonly<{ status: "available"; parent: ManagedRootParent }>
    | Readonly<{ status: "unavailable" | "failed" }>
  >;
  pathExists(path: string, signal: AbortSignal): Promise<boolean>;
}

export interface ManagedWorktreeGitPort {
  resolveRef(
    repositoryRoot: string,
    refIntent: string,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeRefObservation>;
  branchExists(repositoryRoot: string, branchIntent: string, signal: AbortSignal): Promise<boolean>;
  fetchRemote(
    repositoryRoot: string,
    remoteName: string,
    branchName: string,
    signal: AbortSignal,
  ): Promise<
    | Readonly<{ status: "fetched"; remoteHead: string }>
    | Readonly<{ status: "failed" | "interrupted" }>
  >;
  addWorktree(
    input: Readonly<{
      repositoryRoot: string;
      targetPath: string;
      branchIntent: string;
      startPoint: string;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ status: "created" | "rejected" }>>;
  isDirty(
    targetPath: string,
    signal: AbortSignal,
  ): Promise<
    | Readonly<{ status: "observed"; dirty: boolean }>
    | Readonly<{ status: "unavailable" | "failed" }>
  >;
  removeWorktree(
    input: Readonly<{ repositoryRoot: string; targetPath: string }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ status: "removed" | "rejected" }>>;
  /**
   * Drop the checkpoint anchors of a checkout that is gone. The anchors live in
   * the repository's shared ref store, not in the worktree, so removing the
   * worktree does not take them with it.
   */
  removeCheckpointRefs(
    input: Readonly<{ repositoryRoot: string; checkoutId: string }>,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface ManagedWorktreeAuthorityPort {
  observeCleanupEligibility(
    input: Readonly<{
      repositoryId: string;
      threadId: string;
      checkoutId: string;
    }>,
    signal: AbortSignal,
  ): Promise<
    | Readonly<{
        status: "eligible";
        active: boolean;
        delivered: boolean;
        checkoutId: CodeCheckoutId;
        repositoryId: CodeRepositoryId;
      }>
    | Readonly<{ status: "unavailable" }>
  >;
}

export interface ManagedWorktreeReceiptPort {
  create(input: CreateManagedWorktreeReceiptInput): Promise<ManagedWorktreeReceipt>;
  load(receiptId: string): Promise<ManagedWorktreeReceipt | undefined>;
  findActive(input: ManagedWorktreeReceiptLookup): Promise<ManagedWorktreeReceipt | undefined>;
  transition(
    receiptId: string,
    state: ManagedWorktreeReceiptState,
  ): Promise<ManagedWorktreeReceipt>;
}

export type ManagedWorktreeRefusalReason =
  | "active-thread"
  | "branch-collision"
  | "confirmation-required"
  | "dirty"
  | "invalid-grant"
  | "invalid-intent"
  | "inventory-ambiguous"
  | "mismatched"
  | "path-collision"
  | "ref-ambiguous"
  | "ref-unavailable"
  | "repository-mismatch"
  | "remote-unavailable"
  | "undelivered"
  | "unowned";

type ManagedWorktreeRefusal = Readonly<{
  status: "refused";
  reason: ManagedWorktreeRefusalReason;
}>;

type ManagedWorktreeDeferred = Readonly<{
  status: "waiting" | "interrupted";
  receipt?: ManagedWorktreeReceipt;
}>;

export interface ManagedWorktreeCreationInput {
  readonly authenticatedWindowId: WindowId;
  readonly projectId: ProjectId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly repositoryId: CodeRepositoryId;
  readonly repositoryRoot: string;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly branchIntent: string;
  readonly startPoint: string;
  readonly startFromOrigin?: boolean;
  readonly remoteName?: string;
  /**
   * Authoritative source provenance from the prepare phase. The commit phase
   * must not reinterpret or refetch these; it threads them through unchanged so
   * the receipt/replay provenance matches the selected source, not the delivery
   * branch.
   */
  readonly sourceBranch: string;
  readonly sourceMode: "origin" | "local";
  readonly fetchedAt?: string;
}

export interface ManagedWorktreeCreationPlan {
  readonly status: "planned";
  readonly repositoryId: CodeRepositoryId;
  readonly targetPath: string;
  readonly parent: ManagedRootParent;
  readonly branchIntent: string;
  readonly startPoint: string;
  readonly grant: ManagedRootGrant;
}

export type ManagedWorktreePlanResult =
  | ManagedWorktreeCreationPlan
  | ManagedWorktreeRefusal
  | Readonly<{ status: "waiting" | "interrupted" | "unavailable" }>;

export type ManagedWorktreeCreateResult =
  | Readonly<{
      status: "ready";
      targetPath: string;
      receipt: ManagedWorktreeReceipt;
    }>
  | ManagedWorktreeRefusal
  | ManagedWorktreeDeferred;

export type ManagedWorktreeCleanupResult =
  | Readonly<{ status: "removed"; receipt: ManagedWorktreeReceipt }>
  | ManagedWorktreeRefusal
  | ManagedWorktreeDeferred;

export type ManagedWorktreeSourcePreviewFailureReason =
  | "remote-unavailable"
  | "fetch-rejected"
  | "cancelled"
  | "ambiguous-ref"
  | "ref-unavailable"
  | "unavailable";

export type ManagedWorktreeSourcePreview =
  | Readonly<{
      status: "origin";
      remoteName: string;
      branch: string;
      resolvedHead: string;
      fetchedAt: string;
    }>
  | Readonly<{ status: "local"; branch: string; resolvedHead: string; remoteName?: string }>
  | Readonly<{
      status: "failed";
      reason: ManagedWorktreeSourcePreviewFailureReason;
    }>;

export interface ManagedWorktreePreviewInput {
  readonly repositoryId: CodeRepositoryId;
  readonly repositoryRoot: string;
  readonly refIntent: string;
  readonly startFromOrigin: boolean;
  readonly remoteName?: string;
}

export type ManagedWorktreeRollbackResult =
  | Readonly<{ status: "removed" }>
  | Readonly<{ status: "waiting" | "interrupted" }>
  | Readonly<{ status: "refused" }>;

export interface ManagedWorktreeServiceOptions {
  readonly grants: ManagedRootGrantStore;
  readonly receipts: ManagedWorktreeReceiptPort;
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly filesystem: ManagedWorktreeFileSystemPort;
  readonly git: ManagedWorktreeGitPort;
  readonly authority: ManagedWorktreeAuthorityPort;
  readonly now?: () => number;
}

interface FreshCreationState {
  readonly repositoryRoot: string;
  readonly targetPath: string;
  readonly parent: ManagedRootParent;
  readonly expectedHead: string;
  readonly source: ManagedWorktreeSourceProvenance;
}

type FreshCreationResult =
  | Readonly<{ status: "available"; state: FreshCreationState }>
  | ManagedWorktreeRefusal
  | Readonly<{ status: "waiting" | "interrupted" }>;

/**
 * Coordinates durable intent with injected filesystem and Git capabilities.
 *
 * Fresh checks narrow the mutation window, while Git remains responsible for
 * rejecting a branch or path race at mutation time. This is intentionally not
 * presented as a compare-and-swap across the filesystem, refs, and receipts.
 */
export class ManagedWorktreeService {
  readonly #grants: ManagedRootGrantStore;
  readonly #receipts: ManagedWorktreeReceiptPort;
  readonly #repository: ManagedWorktreeRepositoryPort;
  readonly #filesystem: ManagedWorktreeFileSystemPort;
  readonly #git: ManagedWorktreeGitPort;
  readonly #authority: ManagedWorktreeAuthorityPort;
  readonly #now: () => number;

  constructor(options: ManagedWorktreeServiceOptions) {
    this.#grants = options.grants;
    this.#receipts = options.receipts;
    this.#repository = options.repository;
    this.#filesystem = options.filesystem;
    this.#git = options.git;
    this.#authority = options.authority;
    this.#now = options.now ?? Date.now;
  }

  async planCreation(
    input: ManagedWorktreeCreationInput,
    signal: AbortSignal,
  ): Promise<ManagedWorktreePlanResult> {
    const fresh = await this.#observeCreationContext(input, signal);
    if (fresh.status !== "available") return fresh;
    let grant: ManagedRootGrant;
    try {
      grant = this.#grants.issue({
        windowId: input.authenticatedWindowId,
        projectId: input.projectId,
        bindingRevisionId: input.bindingRevisionId,
        repositoryId: input.repositoryId,
        parent: fresh.state.parent,
        targetPath: fresh.state.targetPath,
        now: this.#now(),
      });
    } catch (error) {
      if (error instanceof ManagedRootGrantError && error.category === "unavailable") {
        return { status: "unavailable" };
      }
      return { status: "interrupted" };
    }
    return {
      status: "planned",
      repositoryId: input.repositoryId,
      targetPath: fresh.state.targetPath,
      parent: fresh.state.parent,
      branchIntent: input.branchIntent,
      startPoint: input.startPoint,
      grant,
    };
  }

  async create(
    input: ManagedWorktreeCreationInput & Readonly<{ grantId: ManagedRootGrantId }>,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeCreateResult> {
    const resumed = await this.#resumeCreation(input, signal);
    if (resumed !== undefined) return resumed;

    const fresh = await this.#observeCreationContext(input, signal);
    if (fresh.status !== "available") return fresh;

    try {
      this.#grants.consume({
        grantId: input.grantId,
        authenticatedWindowId: input.authenticatedWindowId,
        projectId: input.projectId,
        bindingRevisionId: input.bindingRevisionId,
        repositoryId: input.repositoryId,
        parent: fresh.state.parent,
        targetPath: fresh.state.targetPath,
        now: this.#now(),
      });
    } catch (error) {
      if (error instanceof ManagedRootGrantError) {
        return { status: "refused", reason: "invalid-grant" };
      }
      return { status: "interrupted" };
    }

    let receipt: ManagedWorktreeReceipt;
    try {
      receipt = await this.#receipts.create({
        repositoryId: input.repositoryId,
        threadId: input.threadId,
        checkoutId: input.checkoutId,
        canonicalRepositoryPath: fresh.state.repositoryRoot,
        canonicalWorktreePath: fresh.state.targetPath,
        branchIntent: input.branchIntent,
        refIntent: `refs/heads/${input.branchIntent}`,
        expectedHead: input.startPoint,
        source: fresh.state.source,
      });
    } catch {
      return { status: "interrupted" };
    }

    try {
      const added = await this.#git.addWorktree(
        {
          repositoryRoot: fresh.state.repositoryRoot,
          targetPath: fresh.state.targetPath,
          branchIntent: input.branchIntent,
          startPoint: input.startPoint,
        },
        signal,
      );
      if (added.status !== "created") return { status: "waiting", receipt };
    } catch {
      return { status: "interrupted", receipt };
    }

    const confirmation = await this.#confirmCreatedWorktree(input, fresh.state, signal);
    if (confirmation !== "ready") return { status: confirmation, receipt };

    try {
      receipt = await this.#receipts.transition(receipt.receiptId, "ready");
    } catch {
      return { status: "interrupted", receipt };
    }
    return { status: "ready", targetPath: fresh.state.targetPath, receipt };
  }

  /**
   * Resolves the exact object ID a new managed worktree would start from,
   * without issuing a grant, writing a receipt, or creating a worktree. Origin
   * mode fetches the selected remote first (updating only remote-tracking refs,
   * never the user's checkout or local branch refs); local mode resolves the
   * selected ref. Every ambiguous or failed outcome fails closed with a typed
   * reason and no silent local fallback.
   */
  async previewSource(
    input: ManagedWorktreePreviewInput,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeSourcePreview> {
    if (!validIntent(input.refIntent, 512)) {
      return { status: "failed", reason: "ref-unavailable" };
    }

    let observation: RepositoryIdentityObservation;
    try {
      observation = await this.#repository.observe(input.repositoryRoot, signal);
    } catch {
      return { status: "failed", reason: "unavailable" };
    }
    if (
      observation.status !== "available" ||
      observation.repositoryId !== input.repositoryId ||
      observation.repositoryRoot !== input.repositoryRoot
    ) {
      return { status: "failed", reason: "unavailable" };
    }

    if (input.startFromOrigin) {
      const sourceBranch = branchFromRefIntent(input.refIntent);
      if (input.remoteName === undefined || sourceBranch === undefined) {
        return { status: "failed", reason: "remote-unavailable" };
      }
      let fetchResult: Awaited<ReturnType<ManagedWorktreeGitPort["fetchRemote"]>>;
      try {
        fetchResult = await this.#git.fetchRemote(
          observation.repositoryRoot,
          input.remoteName,
          sourceBranch,
          signal,
        );
      } catch {
        return { status: "failed", reason: "fetch-rejected" };
      }
      if (fetchResult.status === "interrupted") return { status: "failed", reason: "cancelled" };
      if (fetchResult.status !== "fetched") return { status: "failed", reason: "fetch-rejected" };
      return {
        status: "origin",
        remoteName: input.remoteName,
        branch: sourceBranch,
        resolvedHead: fetchResult.remoteHead,
        fetchedAt: new Date(this.#now()).toISOString(),
      };
    }

    let resolved: ManagedWorktreeRefObservation;
    try {
      resolved = await this.#git.resolveRef(observation.repositoryRoot, input.refIntent, signal);
    } catch {
      return { status: "failed", reason: "unavailable" };
    }
    if (resolved.status !== "resolved") {
      if (resolved.status === "missing") return { status: "failed", reason: "ref-unavailable" };
      if (resolved.status === "ambiguous") return { status: "failed", reason: "ambiguous-ref" };
      return { status: "failed", reason: "unavailable" };
    }
    return input.remoteName === undefined
      ? { status: "local", branch: input.refIntent, resolvedHead: resolved.oid }
      : {
          status: "local",
          branch: input.refIntent,
          resolvedHead: resolved.oid,
          remoteName: input.remoteName,
        };
  }

  /**
   * Rolls back a managed worktree whose creation never completed binding to a
   * Code thread (for example a journal failure or cancellation after the
   * worktree became ready). It removes the just-created worktree and marks the
   * receipt removed, without the thread-based cleanup authority check, because
   * no thread owns this worktree yet. A removal that cannot complete leaves the
   * receipt in cleanup-pending as an honest restart-recovery state.
   */
  async rollbackCreation(
    receiptId: string,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeRollbackResult> {
    let receipt: ManagedWorktreeReceipt | undefined;
    try {
      receipt = await this.#receipts.load(receiptId);
    } catch {
      return { status: "interrupted" };
    }
    if (receipt === undefined) return { status: "refused" };
    if (receipt.state === "removed") return { status: "removed" };
    if (receipt.state !== "creating" && receipt.state !== "ready") return { status: "refused" };

    let observation: RepositoryIdentityObservation;
    try {
      observation = await this.#repository.observe(receipt.canonicalRepositoryPath, signal);
    } catch {
      return { status: "interrupted" };
    }
    if (
      observation.status !== "available" ||
      observation.repositoryId !== receipt.repositoryId ||
      observation.repositoryRoot !== receipt.canonicalRepositoryPath
    ) {
      return { status: "waiting" };
    }

    try {
      receipt = await this.#receipts.transition(receiptId, "cleanup-pending");
    } catch {
      return { status: "interrupted" };
    }
    const present = observation.worktrees.some(
      (worktree) =>
        worktree.status === "present" && worktree.canonicalPath === receipt?.canonicalWorktreePath,
    );
    if (present) {
      let removed: Awaited<ReturnType<ManagedWorktreeGitPort["removeWorktree"]>>;
      try {
        removed = await this.#git.removeWorktree(
          { repositoryRoot: observation.repositoryRoot, targetPath: receipt.canonicalWorktreePath },
          signal,
        );
      } catch {
        return { status: "interrupted" };
      }
      if (removed.status !== "removed") return { status: "waiting" };
      await this.#releaseCheckpoints(observation.repositoryRoot, receipt.checkoutId, signal);
    }
    try {
      await this.#receipts.transition(receiptId, "removed");
    } catch {
      return { status: "interrupted" };
    }
    return { status: "removed" };
  }

  /**
   * Retire the checkpoint anchors of a checkout that has just been removed.
   *
   * Best effort, and deliberately after the removal rather than before it: a
   * removal that gets refused leaves the checkout alive, and its checkpoints
   * have to stay restorable. Anchors that survive this cost disk in a
   * repository the user still has; failing an otherwise complete cleanup over
   * them would leave a worktree the user asked to be rid of.
   */
  async #releaseCheckpoints(
    repositoryRoot: string,
    checkoutId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.#git.removeCheckpointRefs({ repositoryRoot, checkoutId }, signal);
    } catch {
      // Nothing the caller can act on: the checkout is already gone.
    }
  }

  async #resumeCreation(
    input: ManagedWorktreeCreationInput,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeCreateResult | undefined> {
    const canonicalWorktreePath = managedTargetPath(
      input.repositoryRoot,
      input.repositoryId,
      input.threadId,
    );
    let receipt: ManagedWorktreeReceipt | undefined;
    try {
      receipt = await this.#receipts.findActive({
        repositoryId: input.repositoryId,
        threadId: input.threadId,
        checkoutId: input.checkoutId,
        canonicalRepositoryPath: input.repositoryRoot,
        canonicalWorktreePath,
        branchIntent: input.branchIntent,
        refIntent: `refs/heads/${input.branchIntent}`,
      });
    } catch {
      return { status: "interrupted" };
    }
    if (receipt === undefined) return undefined;
    if (receipt.state !== "creating" && receipt.state !== "ready") {
      return { status: "refused", reason: "inventory-ambiguous" };
    }
    const activeReceipt = receipt;

    let observation: RepositoryIdentityObservation;
    try {
      observation = await this.#repository.observe(input.repositoryRoot, signal);
    } catch {
      return { status: "interrupted", receipt };
    }
    if (
      observation.status !== "available" ||
      observation.repositoryId !== activeReceipt.repositoryId ||
      observation.repositoryRoot !== activeReceipt.canonicalRepositoryPath ||
      hasAmbiguousInventory(observation)
    ) {
      return { status: "waiting", receipt };
    }
    const targets = observation.worktrees.filter(
      (worktree) =>
        worktree.status === "present" &&
        worktree.canonicalPath === activeReceipt.canonicalWorktreePath,
    );
    if (targets.length !== 1) return { status: "waiting", receipt };
    const target = targets[0]!;
    if (
      target.detached ||
      target.locked !== undefined ||
      target.prunable !== undefined ||
      target.branch !== branchRef(activeReceipt.branchIntent) ||
      target.head !== activeReceipt.expectedHead
    ) {
      return { status: "waiting", receipt };
    }
    if (receipt.state === "ready") {
      return { status: "ready", targetPath: canonicalWorktreePath, receipt };
    }
    try {
      receipt = await this.#receipts.transition(receipt.receiptId, "ready");
    } catch {
      return { status: "interrupted", receipt };
    }
    return { status: "ready", targetPath: receipt.canonicalWorktreePath, receipt };
  }

  async cleanup(
    input: Readonly<{ receiptId: string; confirmedByLocalUser: boolean }>,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeCleanupResult> {
    if (!input.confirmedByLocalUser) {
      return { status: "refused", reason: "confirmation-required" };
    }

    let receipt: ManagedWorktreeReceipt | undefined;
    try {
      receipt = await this.#receipts.load(input.receiptId);
    } catch {
      return { status: "interrupted" };
    }
    if (receipt === undefined) return { status: "refused", reason: "unowned" };
    if (receipt.state === "removed") return { status: "removed", receipt };

    const authority = await this.#observeCleanupAuthority(receipt, signal);
    if (authority !== undefined) return authority;

    let observation: RepositoryIdentityObservation;
    try {
      observation = await this.#repository.observe(receipt.canonicalRepositoryPath, signal);
    } catch {
      return { status: "interrupted", receipt };
    }
    if (observation.status === "failed") return { status: "waiting", receipt };
    if (
      observation.status !== "available" ||
      observation.repositoryId !== receipt.repositoryId ||
      observation.repositoryRoot !== receipt.canonicalRepositoryPath
    ) {
      return { status: "refused", reason: "mismatched" };
    }
    if (hasAmbiguousInventory(observation)) {
      return { status: "refused", reason: "inventory-ambiguous" };
    }

    const expectedTarget = managedTargetPath(
      observation.repositoryRoot,
      receipt.repositoryId,
      receipt.threadId,
    );
    if (expectedTarget !== receipt.canonicalWorktreePath) {
      return { status: "refused", reason: "mismatched" };
    }

    const canonicalWorktreePath = receipt.canonicalWorktreePath;
    const targets = observation.worktrees.filter(
      (worktree) =>
        worktree.status === "present" && worktree.canonicalPath === canonicalWorktreePath,
    );
    if (targets.length === 0) {
      if (receipt.state !== "cleanup-pending") {
        return { status: "refused", reason: "mismatched" };
      }
      try {
        if (await this.#filesystem.pathExists(receipt.canonicalWorktreePath, signal)) {
          return { status: "waiting", receipt };
        }
      } catch {
        return { status: "interrupted", receipt };
      }
      return this.#finishRemovedReceipt(receipt);
    }
    if (targets.length !== 1) {
      return { status: "refused", reason: "inventory-ambiguous" };
    }
    const target = targets[0]!;
    if (target.detached || target.locked !== undefined || target.prunable !== undefined) {
      return { status: "refused", reason: "inventory-ambiguous" };
    }
    if (target.branch !== branchRef(receipt.branchIntent)) {
      return { status: "refused", reason: "mismatched" };
    }

    let dirty: Awaited<ReturnType<ManagedWorktreeGitPort["isDirty"]>>;
    try {
      dirty = await this.#git.isDirty(receipt.canonicalWorktreePath, signal);
    } catch {
      return { status: "interrupted", receipt };
    }
    if (dirty.status !== "observed") return { status: "waiting", receipt };
    if (dirty.dirty) return { status: "refused", reason: "dirty" };

    try {
      receipt = await this.#receipts.transition(receipt.receiptId, "cleanup-pending");
    } catch {
      return { status: "interrupted", receipt };
    }
    try {
      const removed = await this.#git.removeWorktree(
        {
          repositoryRoot: observation.repositoryRoot,
          targetPath: receipt.canonicalWorktreePath,
        },
        signal,
      );
      if (removed.status !== "removed") return { status: "waiting", receipt };
    } catch {
      return { status: "interrupted", receipt };
    }
    await this.#releaseCheckpoints(observation.repositoryRoot, receipt.checkoutId, signal);

    let confirmation: RepositoryIdentityObservation;
    try {
      confirmation = await this.#repository.observe(observation.repositoryRoot, signal);
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
    } catch {
      return { status: "interrupted", receipt };
    }
    return this.#finishRemovedReceipt(receipt);
  }

  /**
   * Validates the repository, parent, target path, and delivery branch without
   * refetching or re-resolving the source. The authoritative `startPoint` (and
   * source provenance) come from the prepare phase; commit must not reinterpret
   * them. This narrows the mutation window to repository/path/branch collision
   * checks only.
   */
  async #observeCreationContext(
    input: ManagedWorktreeCreationInput,
    signal: AbortSignal,
  ): Promise<FreshCreationResult> {
    if (!validIntent(input.branchIntent, 255) || !validOid(input.startPoint)) {
      return { status: "refused", reason: "invalid-intent" };
    }

    let observation: RepositoryIdentityObservation;
    try {
      observation = await this.#repository.observe(input.repositoryRoot, signal);
    } catch {
      return { status: "interrupted" };
    }
    if (observation.status === "failed") return { status: "waiting" };
    if (
      observation.status !== "available" ||
      observation.repositoryId !== input.repositoryId ||
      observation.repositoryRoot !== input.repositoryRoot
    ) {
      return { status: "refused", reason: "repository-mismatch" };
    }
    if (hasAmbiguousInventory(observation)) {
      return { status: "refused", reason: "inventory-ambiguous" };
    }

    const parentPath = dirname(observation.repositoryRoot);
    let parentObservation: Awaited<ReturnType<ManagedWorktreeFileSystemPort["observeParent"]>>;
    try {
      parentObservation = await this.#filesystem.observeParent(parentPath, signal);
    } catch {
      return { status: "interrupted" };
    }
    if (parentObservation.status === "failed") return { status: "waiting" };
    if (
      parentObservation.status !== "available" ||
      parentObservation.parent.canonicalPath !== parentPath
    ) {
      return { status: "refused", reason: "repository-mismatch" };
    }
    const targetPath = managedTargetPath(
      observation.repositoryRoot,
      input.repositoryId,
      input.threadId,
    );
    if (
      observation.worktrees.some(
        (worktree) =>
          (worktree.status === "present" && worktree.canonicalPath === targetPath) ||
          worktree.reportedPath === targetPath,
      )
    ) {
      return { status: "refused", reason: "path-collision" };
    }

    try {
      if (await this.#filesystem.pathExists(targetPath, signal)) {
        return { status: "refused", reason: "path-collision" };
      }
      if (await this.#git.branchExists(observation.repositoryRoot, input.branchIntent, signal)) {
        return { status: "refused", reason: "branch-collision" };
      }
    } catch {
      return { status: "interrupted" };
    }

    // The source provenance is authoritative from prepare; commit does not
    // refetch or reinterpret. The caller threads the exact resolved OID,
    // source mode/branch/remote/fetchedAt through ManagedWorktreeCreationInput.
    // The delivery branch (branchIntent) is distinct from the source branch.
    const source: ManagedWorktreeSourceProvenance =
      input.sourceMode === "origin"
        ? {
            mode: "origin",
            branch: input.sourceBranch,
            ...(input.remoteName === undefined ? {} : { remoteName: input.remoteName }),
            resolvedHead: input.startPoint,
            ...(input.fetchedAt === undefined ? {} : { fetchedAt: input.fetchedAt }),
          }
        : {
            mode: "local",
            branch: input.sourceBranch,
            resolvedHead: input.startPoint,
            ...(input.remoteName === undefined ? {} : { remoteName: input.remoteName }),
          };

    return {
      status: "available",
      state: {
        repositoryRoot: observation.repositoryRoot,
        targetPath,
        parent: parentObservation.parent,
        expectedHead: input.startPoint,
        source,
      },
    };
  }

  async #confirmCreatedWorktree(
    input: ManagedWorktreeCreationInput,
    expected: FreshCreationState,
    signal: AbortSignal,
  ): Promise<"ready" | "waiting" | "interrupted"> {
    let observation: RepositoryIdentityObservation;
    try {
      observation = await this.#repository.observe(expected.repositoryRoot, signal);
    } catch {
      return "interrupted";
    }
    if (
      observation.status !== "available" ||
      observation.repositoryId !== input.repositoryId ||
      observation.repositoryRoot !== expected.repositoryRoot
    ) {
      return "waiting";
    }
    const targets = observation.worktrees.filter(
      (worktree) => worktree.status === "present" && worktree.canonicalPath === expected.targetPath,
    );
    if (targets.length !== 1) return "waiting";
    const target = targets[0]!;
    return !target.detached &&
      target.locked === undefined &&
      target.prunable === undefined &&
      target.branch === branchRef(input.branchIntent) &&
      target.head === expected.expectedHead
      ? "ready"
      : "waiting";
  }

  async #observeCleanupAuthority(
    receipt: ManagedWorktreeReceipt,
    signal: AbortSignal,
  ): Promise<ManagedWorktreeCleanupResult | undefined> {
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
      authority.checkoutId !== receipt.checkoutId
    ) {
      return { status: "refused", reason: "mismatched" };
    }
    if (authority.active) return { status: "refused", reason: "active-thread" };
    if (!authority.delivered) return { status: "refused", reason: "undelivered" };
    return undefined;
  }

  async #finishRemovedReceipt(
    receipt: ManagedWorktreeReceipt,
  ): Promise<ManagedWorktreeCleanupResult> {
    try {
      const removed = await this.#receipts.transition(receipt.receiptId, "removed");
      return { status: "removed", receipt: removed };
    } catch {
      return { status: "interrupted", receipt };
    }
  }
}

function validIntent(value: string, maximumLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !value.includes("\0")
  );
}

function validOid(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function managedTargetPath(repositoryRoot: string, repositoryId: string, threadId: string): string {
  return join(dirname(repositoryRoot), ".octant-worktrees", repositoryId, threadId);
}

function branchRef(branchIntent: string): string {
  return `refs/heads/${branchIntent}`;
}

function branchFromRefIntent(refIntent: string): string | undefined {
  const match = /^refs\/heads\/(.+)$/.exec(refIntent);
  return match?.[1];
}

function hasAmbiguousInventory(
  observation: Extract<RepositoryIdentityObservation, { status: "available" }>,
): boolean {
  return observation.worktrees.some(
    (worktree) => worktree.locked !== undefined || worktree.prunable !== undefined,
  );
}

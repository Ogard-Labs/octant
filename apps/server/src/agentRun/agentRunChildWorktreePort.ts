import { createHash } from "node:crypto";
import {
  decodeBindingRevisionId,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
  type CodeCheckoutIdentity,
} from "@octant/contracts";
import { deriveManagedWorktreeCheckoutId } from "../code/managedCodeThreadCreation";
import type { ManagedWorktreeReceipt } from "../code/managedWorktreeReceiptStore";
import type { ManagedWorktreeService } from "../code/managedWorktreeService";
import type {
  AgentRunChildWorktreeConfirmResult,
  AgentRunChildWorktreePort,
  AgentRunChildWorktreePrepareInput,
  AgentRunChildWorktreePrepareResult,
  AgentRunCodeWorkspaceContext,
} from "./agentRunWorkspaceService";

/**
 * Stable, isolated child worktree identity for one parent Code thread.
 *
 * Distinct from the parent thread id so a parent that already occupies a
 * managed worktree cannot collide with its children, and stable so prepare
 * can reuse the same worktree.
 */
export async function resolveAgentRunCodeWorkspaceContext(input: {
  readonly thread: {
    readonly projectId: string;
    readonly bindingRevisionId: string;
    readonly repositoryId: string;
    readonly checkoutId: string;
  };
  readonly repositoryRoot: string;
  readonly checkout: CodeCheckoutIdentity | undefined;
  readonly loadManagedReceipt: (receiptId: string) => Promise<
    | {
        readonly canonicalRepositoryPath: string;
        readonly canonicalWorktreePath: string;
      }
    | undefined
  >;
}): Promise<AgentRunCodeWorkspaceContext | undefined> {
  const checkout = input.checkout;
  if (checkout === undefined || checkout.availability !== "available") return undefined;
  let parentCheckoutRoot = input.repositoryRoot;
  if (checkout.kind === "managed-worktree") {
    const receipt = await input.loadManagedReceipt(String(checkout.ownershipReceiptId));
    if (receipt === undefined) return undefined;
    parentCheckoutRoot = receipt.canonicalWorktreePath;
  }
  const sourceBranch = checkout.head.kind === "branch" ? checkout.head.name : "HEAD";
  return {
    projectId: input.thread.projectId,
    bindingRevisionId: input.thread.bindingRevisionId,
    repositoryId: input.thread.repositoryId,
    repositoryRoot: input.repositoryRoot,
    parentCheckoutRoot,
    branchIntent: childBranchIntent(input.thread.checkoutId),
    startPoint: checkout.head.oid,
    sourceBranch,
    sourceMode: "local",
  };
}

export function deriveAgentRunChildWorktreeThreadId(parentThreadId: string): string {
  const digest = createHash("sha256")
    .update("octant.agent-run-child-worktree.v1\0")
    .update(parentThreadId)
    .digest("hex")
    .slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
}

function childBranchIntent(parentThreadId: string): string {
  return `octant/agent-run/${parentThreadId.replaceAll("-", "").slice(0, 12)}`;
}

function isolated(receipt: ManagedWorktreeReceipt, parentCheckoutRoot: string): boolean {
  return (
    receipt.canonicalWorktreePath !== parentCheckoutRoot &&
    receipt.canonicalWorktreePath !== receipt.canonicalRepositoryPath
  );
}

function toPrepared(receipt: ManagedWorktreeReceipt): AgentRunChildWorktreePrepareResult {
  return {
    status: "prepared",
    worktreeReceiptId: receipt.receiptId,
    checkoutRoot: receipt.canonicalRepositoryPath,
    worktreeRoot: receipt.canonicalWorktreePath,
    state: receipt.state === "ready" ? "ready" : "creating",
  };
}

/**
 * Create or reuse an Octant-managed worktree for a Code child, never the
 * parent checkout. Confirmation re-checks isolation before admission.
 */
export function createAgentRunChildWorktreePort(input: {
  readonly service: ManagedWorktreeService;
  readonly loadReceipt: (receiptId: string) => Promise<ManagedWorktreeReceipt | undefined>;
  readonly findActive: (lookup: {
    readonly repositoryId: string;
    readonly threadId: string;
    readonly checkoutId: string;
    readonly canonicalRepositoryPath: string;
    readonly canonicalWorktreePath: string;
    readonly branchIntent: string;
    readonly refIntent: string;
  }) => Promise<ManagedWorktreeReceipt | undefined>;
}): AgentRunChildWorktreePort {
  return {
    prepare: async (request: AgentRunChildWorktreePrepareInput) => {
      const childThreadId = decodeCodeThreadId(
        deriveAgentRunChildWorktreeThreadId(request.parentThreadId),
      );
      const checkoutId = deriveManagedWorktreeCheckoutId({
        repositoryId: request.repositoryId,
        threadId: String(childThreadId),
      });
      const branchIntent = request.branchIntent || childBranchIntent(request.parentThreadId);
      const creationInput = {
        authenticatedWindowId: decodeWindowId(request.windowId),
        projectId: decodeProjectId(request.projectId),
        bindingRevisionId: decodeBindingRevisionId(request.bindingRevisionId),
        repositoryId: decodeCodeRepositoryId(request.repositoryId),
        repositoryRoot: request.repositoryRoot,
        threadId: childThreadId,
        checkoutId,
        branchIntent,
        startPoint: request.startPoint,
        sourceBranch: request.sourceBranch,
        sourceMode: request.sourceMode,
        ...(request.remoteName === undefined ? {} : { remoteName: request.remoteName }),
        ...(request.fetchedAt === undefined ? {} : { fetchedAt: request.fetchedAt }),
      };
      const signal = new AbortController().signal;
      const plan = await input.service.planCreation(creationInput, signal);
      if (plan.status !== "planned") {
        if (plan.status === "refused") return { status: "refused", reason: "unavailable" };
        return { status: "refused", reason: "unavailable" };
      }
      const lookup = {
        repositoryId: request.repositoryId,
        threadId: String(childThreadId),
        checkoutId: String(checkoutId),
        canonicalRepositoryPath: request.repositoryRoot,
        canonicalWorktreePath: plan.targetPath,
        branchIntent,
        refIntent: `refs/heads/${branchIntent}`,
      };
      const existing = await input.findActive(lookup);
      if (existing !== undefined && existing.state !== "removed") {
        if (!isolated(existing, request.parentCheckoutRoot)) {
          return { status: "refused", reason: "parent-checkout" };
        }
        return toPrepared(existing);
      }
      const created = await input.service.create(
        { ...creationInput, grantId: plan.grant.grantId },
        signal,
      );
      if (created.status !== "ready" || !("receipt" in created) || created.receipt === undefined) {
        return { status: "refused", reason: "unavailable" };
      }
      if (!isolated(created.receipt, request.parentCheckoutRoot)) {
        return { status: "refused", reason: "parent-checkout" };
      }
      return toPrepared(created.receipt);
    },
    confirm: async (request) => {
      let receipt: ManagedWorktreeReceipt | undefined;
      try {
        receipt = await input.loadReceipt(request.worktreeReceiptId);
      } catch {
        return { status: "refused", reason: "unavailable" };
      }
      if (receipt === undefined) return { status: "refused", reason: "unavailable" };
      if (receipt.state !== "ready") return { status: "refused", reason: "unconfirmed" };
      if (!isolated(receipt, request.parentCheckoutRoot)) {
        return { status: "refused", reason: "parent-checkout" };
      }
      return {
        status: "confirmed",
        worktreeReceiptId: receipt.receiptId,
        checkoutRoot: receipt.canonicalRepositoryPath,
        worktreeRoot: receipt.canonicalWorktreePath,
      };
    },
  };
}

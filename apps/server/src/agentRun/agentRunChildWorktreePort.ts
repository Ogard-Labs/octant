import { createHash } from "node:crypto";
import {
  decodeBindingRevisionId,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
  type AgentRunWorkspaceReceipt,
  type CodeCheckoutIdentity,
  type CodeThreadId,
} from "@octant/contracts";
import { deriveManagedWorktreeCheckoutId } from "../code/managedCodeThreadCreation";
import type { ManagedWorktreeReceipt } from "../code/managedWorktreeReceiptStore";
import {
  managedTargetPath,
  type ManagedWorktreeRepositoryPort,
  type ManagedWorktreeService,
} from "../code/managedWorktreeService";
import type {
  AgentRunChildWorktreePort,
  AgentRunChildWorktreePrepareInput,
  AgentRunChildWorktreePrepareResult,
  AgentRunCodeWorkspaceContext,
} from "./agentRunWorkspaceService";

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
  // A plain folder has no revision to branch a child worktree from.
  if (checkout.head.kind === "none") return undefined;
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

/** The absent request id is only for looking up legacy, parent-owned runs. */
export function deriveAgentRunChildWorktreeThreadId(
  parentThreadId: string,
  requestId?: string,
): string {
  const hash = createHash("sha256")
    .update(
      requestId === undefined
        ? "octant.agent-run-child-worktree.v1\0"
        : "octant.agent-run-child-worktree.v2\0",
    )
    .update(parentThreadId);
  if (requestId !== undefined) hash.update("\0").update(requestId);
  const digest = hash.digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
}

export function resolveAgentRunChildWorktreeThreadId(input: {
  readonly parentThreadId: string;
  readonly requestId: string;
  readonly repositoryId: string;
  readonly workspace: AgentRunWorkspaceReceipt;
}): CodeThreadId | undefined {
  const workspace = input.workspace;
  if (workspace.kind !== "code-worktree" || !workspace.verified) return undefined;
  // Legacy runs also have request ids. Only the recorded workspace distinguishes
  // their parent-owned checkout from the checkout allocated for one request.
  for (const requestId of [input.requestId, undefined]) {
    const childThreadId = deriveAgentRunChildWorktreeThreadId(input.parentThreadId, requestId);
    if (
      workspace.worktreeRoot ===
      managedTargetPath(workspace.checkoutRoot, input.repositoryId, childThreadId)
    ) {
      return decodeCodeThreadId(childThreadId);
    }
  }
  return undefined;
}

function childBranchIntent(childThreadId: string): string {
  return `octant/agent-run/${childThreadId.replaceAll("-", "")}`;
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
  readonly repository: ManagedWorktreeRepositoryPort;
  readonly observeExecutionIdentity: (
    root: string,
    signal: AbortSignal,
  ) => Promise<{ readonly identity: string; readonly branch: string } | undefined>;
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
}): AgentRunChildWorktreePort & {
  readonly verifyExecution: (request: {
    readonly requestId: string;
    readonly parentThreadId: string;
    readonly repositoryId: string;
    readonly repositoryRoot: string;
    readonly parentCheckoutRoot: string;
    readonly worktreeRoot: string;
    readonly signal: AbortSignal;
  }) => Promise<
    | { readonly status: "verified"; readonly identity: string }
    | { readonly status: "refused"; readonly reason: string }
  >;
} {
  async function available(receipt: ManagedWorktreeReceipt): Promise<boolean> {
    const observation = await input.repository
      .observe(receipt.canonicalRepositoryPath, new AbortController().signal)
      .catch(() => undefined);
    if (observation === undefined) return false;
    if (
      observation.status !== "available" ||
      observation.repositoryId !== receipt.repositoryId ||
      observation.repositoryRoot !== receipt.canonicalRepositoryPath
    )
      return false;
    const targets = observation.worktrees.filter(
      (worktree) =>
        worktree.status === "present" && worktree.canonicalPath === receipt.canonicalWorktreePath,
    );
    const target = targets.length === 1 ? targets[0] : undefined;
    return (
      target !== undefined &&
      !target.detached &&
      target.locked === undefined &&
      target.prunable === undefined &&
      target.branch === receipt.refIntent &&
      target.head === receipt.expectedHead
    );
  }
  return {
    verifyExecution: async (request) => {
      const refused = {
        status: "refused",
        reason:
          "The child's registered workspace is unavailable or no longer owned by this run. Restore the original workspace or delegate a new child.",
      } as const;
      try {
        const childThreadId = deriveAgentRunChildWorktreeThreadId(
          request.parentThreadId,
          request.requestId,
        );
        const branchIntent = childBranchIntent(childThreadId);
        const expectedPath = managedTargetPath(
          request.repositoryRoot,
          request.repositoryId,
          childThreadId,
        );
        if (
          request.worktreeRoot !== expectedPath ||
          request.worktreeRoot === request.parentCheckoutRoot ||
          request.worktreeRoot === request.repositoryRoot
        )
          return refused;
        const receipt = await input.findActive({
          repositoryId: request.repositoryId,
          threadId: childThreadId,
          checkoutId: String(
            deriveManagedWorktreeCheckoutId({
              repositoryId: request.repositoryId,
              threadId: childThreadId,
            }),
          ),
          canonicalRepositoryPath: request.repositoryRoot,
          canonicalWorktreePath: expectedPath,
          branchIntent,
          refIntent: `refs/heads/${branchIntent}`,
        });
        if (receipt?.state !== "ready") return refused;
        const observation = await input.repository.observe(request.repositoryRoot, request.signal);
        const child = await input.repository.observe(expectedPath, request.signal);
        if (
          observation.status !== "available" ||
          child.status !== "available" ||
          observation.repositoryRoot !== request.repositoryRoot ||
          child.repositoryRoot !== expectedPath ||
          observation.repositoryId !== request.repositoryId ||
          child.repositoryId !== request.repositoryId ||
          child.commonDirectory !== observation.commonDirectory
        )
          return refused;
        const targets = observation.worktrees.filter(
          (worktree) => worktree.status === "present" && worktree.canonicalPath === expectedPath,
        );
        const target = targets.length === 1 ? targets[0] : undefined;
        if (
          target === undefined ||
          target.detached ||
          target.locked !== undefined ||
          target.prunable !== undefined ||
          target.branch !== receipt.refIntent ||
          child.checkout.branch !== receipt.refIntent ||
          child.checkout.detached ||
          child.checkout.locked !== undefined ||
          child.checkout.prunable !== undefined
        )
          return refused;
        const physical = await input.observeExecutionIdentity(expectedPath, request.signal);
        if (
          physical === undefined ||
          physical.branch !== receipt.refIntent ||
          request.signal.aborted
        )
          return refused;
        return {
          status: "verified",
          identity: createHash("sha256")
            .update(
              JSON.stringify([
                receipt.receiptId,
                request.repositoryId,
                childThreadId,
                physical.identity,
              ]),
            )
            .digest("hex"),
        };
      } catch {
        return refused;
      }
    },
    prepare: async (request: AgentRunChildWorktreePrepareInput) => {
      const childThreadId = decodeCodeThreadId(
        deriveAgentRunChildWorktreeThreadId(request.parentThreadId, request.requestId),
      );
      const checkoutId = deriveManagedWorktreeCheckoutId({
        repositoryId: request.repositoryId,
        threadId: String(childThreadId),
      });
      const branchIntent = childBranchIntent(String(childThreadId));
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
      const lookup = {
        repositoryId: request.repositoryId,
        threadId: String(childThreadId),
        checkoutId: String(checkoutId),
        canonicalRepositoryPath: request.repositoryRoot,
        canonicalWorktreePath: managedTargetPath(
          request.repositoryRoot,
          request.repositoryId,
          String(childThreadId),
        ),
        branchIntent,
        refIntent: `refs/heads/${branchIntent}`,
      };
      let existing: ManagedWorktreeReceipt | undefined;
      try {
        existing = await input.findActive(lookup);
      } catch {
        return { status: "refused", reason: "unavailable" };
      }
      if (existing !== undefined) {
        if (
          !Object.entries(lookup).every(
            ([key, value]) => existing[key as keyof typeof lookup] === value,
          ) ||
          existing.expectedHead !== request.startPoint
        )
          return { status: "refused", reason: "stale" };
        if (!isolated(existing, request.parentCheckoutRoot)) {
          return { status: "refused", reason: "parent-checkout" };
        }
        if (existing.state !== "ready" || !(await available(existing)))
          return { status: "refused", reason: "unavailable" };
        return toPrepared(existing);
      }
      const signal = new AbortController().signal;
      const plan = await input.service.planCreation(creationInput, signal);
      if (plan.status !== "planned") return { status: "refused", reason: "unavailable" };
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
      if (receipt === undefined || receipt.receiptId !== request.worktreeReceiptId)
        return { status: "refused", reason: "unavailable" };
      const childThreadId = deriveAgentRunChildWorktreeThreadId(
        request.parentThreadId,
        request.requestId,
      );
      if (receipt.threadId !== childThreadId)
        return { status: "refused", reason: "foreign-thread" };
      if (
        receipt.repositoryId !== request.repositoryId ||
        receipt.canonicalRepositoryPath !== request.repositoryRoot ||
        receipt.expectedHead !== request.startingRevision ||
        receipt.checkoutId !==
          String(
            deriveManagedWorktreeCheckoutId({
              repositoryId: request.repositoryId,
              threadId: childThreadId,
            }),
          ) ||
        receipt.branchIntent !== childBranchIntent(childThreadId) ||
        receipt.refIntent !== `refs/heads/${childBranchIntent(childThreadId)}` ||
        receipt.canonicalWorktreePath !==
          managedTargetPath(request.repositoryRoot, request.repositoryId, childThreadId)
      )
        return { status: "refused", reason: "stale" };
      if (receipt.state !== "ready") return { status: "refused", reason: "unconfirmed" };
      if (!isolated(receipt, request.parentCheckoutRoot)) {
        return { status: "refused", reason: "parent-checkout" };
      }
      if (!(await available(receipt))) return { status: "refused", reason: "unavailable" };
      return {
        status: "confirmed",
        worktreeReceiptId: receipt.receiptId,
        checkoutRoot: receipt.canonicalRepositoryPath,
        worktreeRoot: receipt.canonicalWorktreePath,
      };
    },
  };
}

import type { AgentRunCreationRequest, WorktreeReceiptId } from "@octant/contracts";
import type { AgentRunWorktreeReceiptPort } from "./agentRunCreationService";

export interface ManagedWorktreeReceiptSnapshot {
  readonly receiptId: string;
  readonly threadId: string;
  readonly state: string;
  readonly canonicalRepositoryPath: string;
  readonly canonicalWorktreePath: string;
  readonly projectId?: string;
}

/**
 * Build a sync worktree receipt port from an already-loaded managed receipt.
 * Missing, non-ready, parent-checkout, or foreign-thread receipts resolve to
 * undefined so Code child creation fails closed.
 */
export function createVerifiedAgentRunWorktreeReceiptPort(input: {
  readonly request: AgentRunCreationRequest;
  readonly receipt: ManagedWorktreeReceiptSnapshot | undefined;
  readonly projectId: string | undefined;
}): AgentRunWorktreeReceiptPort {
  const expectedId =
    input.request.workspace.kind === "code-worktree"
      ? String(input.request.workspace.worktreeReceiptId)
      : undefined;
  const parentThreadId = String(input.request.parentThreadId);
  const resolved =
    input.receipt !== undefined &&
    expectedId !== undefined &&
    input.receipt.receiptId === expectedId &&
    input.receipt.threadId === parentThreadId &&
    input.receipt.state === "ready" &&
    input.projectId !== undefined &&
    input.receipt.canonicalWorktreePath !== input.receipt.canonicalRepositoryPath
      ? {
          projectId: input.projectId,
          checkoutRoot: input.receipt.canonicalRepositoryPath,
          worktreeRoot: input.receipt.canonicalWorktreePath,
        }
      : undefined;

  return {
    resolveVerifiedIsolation: (query: {
      readonly worktreeReceiptId: WorktreeReceiptId;
      readonly parentThreadId: string;
    }) => {
      if (resolved === undefined) return undefined;
      if (String(query.worktreeReceiptId) !== expectedId) return undefined;
      if (query.parentThreadId !== parentThreadId) return undefined;
      return resolved;
    },
  };
}

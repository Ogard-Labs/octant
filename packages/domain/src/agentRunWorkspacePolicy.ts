import {
  decodeBindingRevisionId,
  decodeProjectId,
  type AgentRunCreationWorkspace,
  type AgentRunRole,
  type AgentRunWorkspaceReceipt,
  type AgentRunWorkspaceRefusalReason,
  type OctantMode,
} from "@octant/contracts";

/**
 * Facts the server resolved about the parent thread before child workspace
 * admission. Paths stay on this host-side record; they never come from the
 * renderer.
 */
export interface AgentRunWorkspaceParentFacts {
  readonly threadId: string;
  readonly mode: OctantMode;
  readonly projectId?: string;
  readonly bindingRevisionId?: string;
  readonly canonicalRoot?: string;
  readonly checkoutRoot?: string;
}

/**
 * Server-issued child workspace grant. Chat and Work grants live in the
 * AgentRun workspace receipt store; Code grants wrap a managed worktree
 * receipt and a confirmation bit.
 */
export interface AgentRunIssuedWorkspaceGrant {
  readonly receiptId: string;
  readonly parentThreadId: string;
  readonly mode: OctantMode;
  readonly confirmed: boolean;
  readonly expiresAt: number;
  readonly projectId?: string;
  readonly bindingRevisionId?: string;
  readonly canonicalRoot?: string;
  readonly worktreeReceiptId?: string;
  readonly checkoutRoot?: string;
  readonly worktreeRoot?: string;
  readonly worktreeState?: string;
}

export type AgentRunWorkspaceAdmissionResult =
  | { readonly status: "admitted"; readonly workspace: AgentRunWorkspaceReceipt }
  | { readonly status: "refused"; readonly reason: AgentRunWorkspaceRefusalReason };

function refuse(reason: AgentRunWorkspaceRefusalReason): AgentRunWorkspaceAdmissionResult {
  return { status: "refused", reason };
}

function sameId(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && String(left) === String(right);
}

function isIsolatedWorktree(checkoutRoot: string, worktreeRoot: string): boolean {
  return (
    checkoutRoot.length > 0 &&
    worktreeRoot.length > 0 &&
    !checkoutRoot.includes("\0") &&
    !worktreeRoot.includes("\0") &&
    worktreeRoot !== checkoutRoot
  );
}

/**
 * Decide whether a prepared child workspace may be admitted.
 *
 * Expected failures are values, not throws: stale, expired, foreign, parent
 * checkout, unavailable, and wider-than-parent grants each have a distinct
 * reason the caller must handle. Chat stays research-only; Work is locked to
 * the current binding; Code implementation and review never run in the parent
 * checkout.
 */
export function admitAgentRunWorkspace(input: {
  readonly requested: AgentRunCreationWorkspace;
  readonly role: AgentRunRole;
  readonly parent: AgentRunWorkspaceParentFacts;
  readonly issued: AgentRunIssuedWorkspaceGrant | undefined;
  readonly now: number;
}): AgentRunWorkspaceAdmissionResult {
  if (input.requested.mode !== input.parent.mode) {
    return refuse("unsupported");
  }

  if (input.requested.kind === "chat-virtual") {
    return admitChat(input);
  }
  if (input.requested.kind === "work-root") {
    return admitWork(input);
  }
  return admitCode(input);
}

function admitChat(input: {
  readonly requested: AgentRunCreationWorkspace;
  readonly role: AgentRunRole;
  readonly parent: AgentRunWorkspaceParentFacts;
  readonly issued: AgentRunIssuedWorkspaceGrant | undefined;
  readonly now: number;
}): AgentRunWorkspaceAdmissionResult {
  if (input.parent.mode !== "chat" || input.requested.kind !== "chat-virtual") {
    return refuse("unsupported");
  }
  if (input.role !== "research") {
    return refuse("unsupported");
  }
  if (input.requested.receiptId !== undefined) {
    const issued = requireIssued(input, String(input.requested.receiptId), "chat");
    if (issued.status === "refused") return issued;
  }
  return { status: "admitted", workspace: { kind: "chat-virtual", mode: "chat" } };
}

function admitWork(input: {
  readonly requested: AgentRunCreationWorkspace;
  readonly parent: AgentRunWorkspaceParentFacts;
  readonly issued: AgentRunIssuedWorkspaceGrant | undefined;
  readonly now: number;
}): AgentRunWorkspaceAdmissionResult {
  if (input.parent.mode !== "work" || input.requested.kind !== "work-root") {
    return refuse("unsupported");
  }
  const issued = requireIssued(input, String(input.requested.receiptId), "work");
  if (issued.status === "refused") return issued;
  const grant = issued.grant;
  if (
    input.parent.projectId === undefined ||
    input.parent.bindingRevisionId === undefined ||
    input.parent.canonicalRoot === undefined ||
    grant.projectId === undefined ||
    grant.bindingRevisionId === undefined ||
    grant.canonicalRoot === undefined
  ) {
    return refuse("unavailable");
  }
  if (!sameId(grant.projectId, input.parent.projectId)) {
    return refuse("foreign-project");
  }
  if (!sameId(grant.bindingRevisionId, input.parent.bindingRevisionId)) {
    return refuse("stale");
  }
  if (grant.canonicalRoot !== input.parent.canonicalRoot) {
    return refuse("wider-than-parent");
  }
  return {
    status: "admitted",
    workspace: {
      kind: "work-root",
      mode: "work",
      projectId: decodeProjectId(input.parent.projectId),
      bindingRevisionId: decodeBindingRevisionId(input.parent.bindingRevisionId),
      canonicalRoot: input.parent.canonicalRoot,
    },
  };
}

function admitCode(input: {
  readonly requested: AgentRunCreationWorkspace;
  readonly role: AgentRunRole;
  readonly parent: AgentRunWorkspaceParentFacts;
  readonly issued: AgentRunIssuedWorkspaceGrant | undefined;
  readonly now: number;
}): AgentRunWorkspaceAdmissionResult {
  if (input.parent.mode !== "code" || input.requested.kind !== "code-worktree") {
    return refuse("unsupported");
  }
  if (input.role !== "implementation" && input.role !== "review") {
    return refuse("unsupported");
  }
  const issued = requireIssued(input, String(input.requested.worktreeReceiptId), "code");
  if (issued.status === "refused") return issued;
  const grant = issued.grant;
  if (grant.confirmed !== true || grant.worktreeState !== "ready") {
    return refuse("unconfirmed");
  }
  if (
    input.parent.projectId === undefined ||
    grant.projectId === undefined ||
    grant.checkoutRoot === undefined ||
    grant.worktreeRoot === undefined
  ) {
    return refuse("unavailable");
  }
  if (!sameId(grant.projectId, input.parent.projectId)) {
    return refuse("foreign-project");
  }
  const parentCheckout = input.parent.checkoutRoot ?? grant.checkoutRoot;
  if (grant.worktreeRoot === parentCheckout) {
    return refuse("parent-checkout");
  }
  if (grant.worktreeRoot === grant.checkoutRoot) {
    return refuse(parentCheckout === grant.checkoutRoot ? "parent-checkout" : "wider-than-parent");
  }
  if (!isIsolatedWorktree(grant.checkoutRoot, grant.worktreeRoot)) {
    return refuse("unavailable");
  }
  return {
    status: "admitted",
    workspace: {
      kind: "code-worktree",
      mode: "code",
      projectId: decodeProjectId(grant.projectId),
      checkoutRoot: grant.checkoutRoot,
      worktreeRoot: grant.worktreeRoot,
      verified: true,
    },
  };
}

function requireIssued(
  input: {
    readonly parent: AgentRunWorkspaceParentFacts;
    readonly issued: AgentRunIssuedWorkspaceGrant | undefined;
    readonly now: number;
  },
  expectedId: string,
  mode: OctantMode,
):
  | { readonly status: "admitted"; readonly grant: AgentRunIssuedWorkspaceGrant }
  | { readonly status: "refused"; readonly reason: AgentRunWorkspaceRefusalReason } {
  const grant = input.issued;
  if (grant === undefined) return { status: "refused", reason: "unavailable" };
  const grantId = mode === "code" ? (grant.worktreeReceiptId ?? grant.receiptId) : grant.receiptId;
  if (grantId !== expectedId) return { status: "refused", reason: "unavailable" };
  if (grant.mode !== mode) return { status: "refused", reason: "unsupported" };
  if (input.now >= grant.expiresAt) return { status: "refused", reason: "expired" };
  if (!sameId(grant.parentThreadId, input.parent.threadId)) {
    return { status: "refused", reason: "foreign-thread" };
  }
  return { status: "admitted", grant };
}

/**
 * Re-check a journaled workspace against live parent facts after restart.
 * Chat virtual stays valid. Work must still match the current binding. Code
 * must still be an isolated worktree, never the parent checkout.
 */
export function revalidateAdmittedAgentRunWorkspace(input: {
  readonly workspace: AgentRunWorkspaceReceipt;
  readonly parent: AgentRunWorkspaceParentFacts;
}): AgentRunWorkspaceAdmissionResult {
  if (input.workspace.mode !== input.parent.mode) return refuse("unsupported");
  if (input.workspace.kind === "chat-virtual") {
    return { status: "admitted", workspace: input.workspace };
  }
  if (input.workspace.kind === "work-root") {
    if (
      input.parent.projectId === undefined ||
      input.parent.bindingRevisionId === undefined ||
      input.parent.canonicalRoot === undefined
    ) {
      return refuse("unavailable");
    }
    if (!sameId(String(input.workspace.projectId), input.parent.projectId)) {
      return refuse("foreign-project");
    }
    if (
      !sameId(String(input.workspace.bindingRevisionId), input.parent.bindingRevisionId) ||
      input.workspace.canonicalRoot !== input.parent.canonicalRoot
    ) {
      return refuse("stale");
    }
    return { status: "admitted", workspace: input.workspace };
  }
  if (
    input.parent.checkoutRoot !== undefined &&
    input.workspace.worktreeRoot === input.parent.checkoutRoot
  ) {
    return refuse("parent-checkout");
  }
  if (
    !input.workspace.verified ||
    !isIsolatedWorktree(input.workspace.checkoutRoot, input.workspace.worktreeRoot)
  ) {
    return refuse("unavailable");
  }
  if (
    input.parent.projectId !== undefined &&
    !sameId(String(input.workspace.projectId), input.parent.projectId)
  ) {
    return refuse("foreign-project");
  }
  return { status: "admitted", workspace: input.workspace };
}

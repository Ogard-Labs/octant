import {
  decodeAgentRunWorkspaceReceiptId,
  decodeBindingRevisionId,
  decodeProjectId,
  decodeWorktreeReceiptId,
  type AgentRunCreationWorkspace,
  type AgentRunRole,
  type AgentRunWorkspaceConfirmationResult,
  type AgentRunWorkspaceHandle,
  type AgentRunWorkspacePreparationResult,
  type AgentRunWorkspaceRefusalReason,
  type OctantMode,
} from "@octant/contracts";
import {
  admitAgentRunWorkspace,
  revalidateAdmittedAgentRunWorkspace,
  type AgentRunWorkspaceAdmissionResult,
  type AgentRunWorkspaceParentFacts,
} from "@octant/domain/agent-run-workspace-policy";
import type { AgentRunWorkspaceReceiptStore } from "./agentRunWorkspaceReceiptStore";

export interface AgentRunChildWorktreePrepareInput {
  readonly parentThreadId: string;
  readonly windowId: string;
  readonly projectId: string;
  readonly bindingRevisionId: string;
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly parentCheckoutRoot: string;
  readonly branchIntent: string;
  readonly startPoint: string;
  readonly sourceBranch: string;
  readonly sourceMode: "local" | "origin";
  readonly remoteName?: string;
  readonly fetchedAt?: string;
}

export type AgentRunChildWorktreePrepareResult =
  | {
      readonly status: "prepared";
      readonly worktreeReceiptId: string;
      readonly checkoutRoot: string;
      readonly worktreeRoot: string;
      readonly state: "creating" | "ready";
    }
  | { readonly status: "refused"; readonly reason: AgentRunWorkspaceRefusalReason };

export type AgentRunChildWorktreeConfirmResult =
  | {
      readonly status: "confirmed";
      readonly worktreeReceiptId: string;
      readonly checkoutRoot: string;
      readonly worktreeRoot: string;
    }
  | { readonly status: "refused"; readonly reason: AgentRunWorkspaceRefusalReason };

export interface AgentRunChildWorktreePort {
  readonly prepare: (
    input: AgentRunChildWorktreePrepareInput,
  ) => Promise<AgentRunChildWorktreePrepareResult>;
  readonly confirm: (input: {
    readonly worktreeReceiptId: string;
    readonly parentThreadId: string;
    readonly parentCheckoutRoot: string;
  }) => Promise<AgentRunChildWorktreeConfirmResult>;
}

export interface AgentRunCodeWorkspaceContext {
  readonly projectId: string;
  readonly bindingRevisionId: string;
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly parentCheckoutRoot: string;
  readonly branchIntent: string;
  readonly startPoint: string;
  readonly sourceBranch: string;
  readonly sourceMode: "local" | "origin";
  readonly remoteName?: string;
  readonly fetchedAt?: string;
}

export interface AgentRunWorkspaceServiceOptions {
  readonly receipts: AgentRunWorkspaceReceiptStore;
  readonly childWorktree?: AgentRunChildWorktreePort;
  readonly now?: () => number;
}

function refused(reason: AgentRunWorkspaceRefusalReason): {
  status: "refused";
  reason: AgentRunWorkspaceRefusalReason;
} {
  return { status: "refused", reason };
}

/**
 * Server-owned child workspace preparation, confirmation, and admission.
 *
 * Chat and Work grants are issued here. Code grants wrap a managed worktree
 * the child-worktree port creates or reuses, then confirm isolation before
 * admission. Renderer handles never include absolute paths.
 */
export class AgentRunWorkspaceService {
  readonly #receipts: AgentRunWorkspaceReceiptStore;
  readonly #childWorktree: AgentRunChildWorktreePort | undefined;
  readonly #now: () => number;

  constructor(options: AgentRunWorkspaceServiceOptions) {
    this.#receipts = options.receipts;
    this.#childWorktree = options.childWorktree;
    this.#now = options.now ?? Date.now;
  }

  async prepare(input: {
    readonly windowId: string;
    readonly parent: AgentRunWorkspaceParentFacts;
    readonly code?: AgentRunCodeWorkspaceContext;
  }): Promise<AgentRunWorkspacePreparationResult> {
    const now = this.#now();
    await this.#receipts.forgetExpired(now);
    if (input.parent.mode === "chat") {
      const reused = await this.#receipts.findReusable({
        parentThreadId: input.parent.threadId,
        mode: "chat",
        windowId: input.windowId,
        now,
      });
      const issued =
        reused ??
        (await this.#receipts.issue({
          parentThreadId: input.parent.threadId,
          windowId: input.windowId,
          mode: "chat",
          confirmed: true,
          now,
        }));
      return {
        status: "prepared",
        workspace: {
          kind: "chat-virtual",
          mode: "chat",
          receiptId: decodeAgentRunWorkspaceReceiptId(issued.receiptId),
        },
      };
    }
    if (input.parent.mode === "work") {
      if (
        input.parent.projectId === undefined ||
        input.parent.bindingRevisionId === undefined ||
        input.parent.canonicalRoot === undefined
      ) {
        return refused("unavailable");
      }
      const reused = await this.#receipts.findReusable({
        parentThreadId: input.parent.threadId,
        mode: "work",
        windowId: input.windowId,
        now,
      });
      const issued =
        reused !== undefined &&
        reused.projectId === input.parent.projectId &&
        reused.bindingRevisionId === input.parent.bindingRevisionId &&
        reused.canonicalRoot === input.parent.canonicalRoot
          ? reused
          : await this.#receipts.issue({
              parentThreadId: input.parent.threadId,
              windowId: input.windowId,
              mode: "work",
              confirmed: true,
              now,
              projectId: input.parent.projectId,
              bindingRevisionId: input.parent.bindingRevisionId,
              canonicalRoot: input.parent.canonicalRoot,
            });
      return {
        status: "prepared",
        workspace: {
          kind: "work-root",
          mode: "work",
          receiptId: decodeAgentRunWorkspaceReceiptId(issued.receiptId),
          projectId: decodeProjectId(input.parent.projectId),
          bindingRevisionId: decodeBindingRevisionId(input.parent.bindingRevisionId),
        },
      };
    }
    return this.#prepareCode(input, now);
  }

  async confirm(input: {
    readonly windowId: string;
    readonly parent: AgentRunWorkspaceParentFacts;
    readonly worktreeReceiptId: string;
  }): Promise<AgentRunWorkspaceConfirmationResult> {
    if (input.parent.mode !== "code") return refused("unsupported");
    const now = this.#now();
    const grant = await this.#loadGrant(input.worktreeReceiptId, now);
    if (grant === undefined) return refused("unavailable");
    if (grant.windowId !== input.windowId) return refused("unauthorized");
    if (grant.parentThreadId !== input.parent.threadId) return refused("foreign-thread");
    if (grant.mode !== "code") return refused("unsupported");
    if (this.#childWorktree === undefined) return refused("unavailable");
    const parentCheckout = input.parent.checkoutRoot ?? grant.checkoutRoot;
    if (parentCheckout === undefined) return refused("unavailable");
    const confirmed = await this.#childWorktree.confirm({
      worktreeReceiptId: grant.worktreeReceiptId ?? grant.receiptId,
      parentThreadId: input.parent.threadId,
      parentCheckoutRoot: parentCheckout,
    });
    if (confirmed.status === "refused") return confirmed;
    const saved = await this.#receipts.save({
      ...grant,
      confirmed: true,
      worktreeState: "ready",
      checkoutRoot: confirmed.checkoutRoot,
      worktreeRoot: confirmed.worktreeRoot,
    });
    return {
      status: "confirmed",
      workspace: toHandle(saved),
    };
  }

  async admit(input: {
    readonly windowId: string;
    readonly requested: AgentRunCreationWorkspace;
    readonly role: AgentRunRole;
    readonly parent: AgentRunWorkspaceParentFacts;
  }): Promise<AgentRunWorkspaceAdmissionResult> {
    const now = this.#now();
    const receiptId =
      input.requested.kind === "chat-virtual"
        ? input.requested.receiptId === undefined
          ? undefined
          : String(input.requested.receiptId)
        : input.requested.kind === "work-root"
          ? String(input.requested.receiptId)
          : String(input.requested.worktreeReceiptId);
    const issued = receiptId === undefined ? undefined : await this.#loadGrant(receiptId, now);
    if (issued !== undefined && issued.windowId !== input.windowId) {
      return refused("unauthorized");
    }
    return admitAgentRunWorkspace({
      requested: input.requested,
      role: input.role,
      parent: input.parent,
      issued,
      now,
    });
  }

  revalidate(input: {
    readonly workspace: Parameters<typeof revalidateAdmittedAgentRunWorkspace>[0]["workspace"];
    readonly parent: AgentRunWorkspaceParentFacts;
  }): AgentRunWorkspaceAdmissionResult {
    return revalidateAdmittedAgentRunWorkspace(input);
  }

  async #prepareCode(
    input: {
      readonly windowId: string;
      readonly parent: AgentRunWorkspaceParentFacts;
      readonly code?: AgentRunCodeWorkspaceContext;
    },
    now: number,
  ): Promise<AgentRunWorkspacePreparationResult> {
    if (this.#childWorktree === undefined || input.code === undefined) {
      return refused("unavailable");
    }
    const reused = await this.#receipts.findReusable({
      parentThreadId: input.parent.threadId,
      mode: "code",
      windowId: input.windowId,
      now,
    });
    if (reused !== undefined) {
      return { status: "prepared", workspace: toHandle(reused) };
    }
    const prepared = await this.#childWorktree.prepare({
      parentThreadId: input.parent.threadId,
      windowId: input.windowId,
      projectId: input.code.projectId,
      bindingRevisionId: input.code.bindingRevisionId,
      repositoryId: input.code.repositoryId,
      repositoryRoot: input.code.repositoryRoot,
      parentCheckoutRoot: input.code.parentCheckoutRoot,
      branchIntent: input.code.branchIntent,
      startPoint: input.code.startPoint,
      sourceBranch: input.code.sourceBranch,
      sourceMode: input.code.sourceMode,
      ...(input.code.remoteName === undefined ? {} : { remoteName: input.code.remoteName }),
      ...(input.code.fetchedAt === undefined ? {} : { fetchedAt: input.code.fetchedAt }),
    });
    if (prepared.status === "refused") return prepared;
    const issued = await this.#receipts.issue({
      receiptId: prepared.worktreeReceiptId,
      parentThreadId: input.parent.threadId,
      windowId: input.windowId,
      mode: "code",
      confirmed: false,
      now,
      projectId: input.code.projectId,
      worktreeReceiptId: prepared.worktreeReceiptId,
      checkoutRoot: prepared.checkoutRoot,
      worktreeRoot: prepared.worktreeRoot,
      worktreeState: prepared.state,
    });
    return { status: "prepared", workspace: toHandle(issued) };
  }

  async #loadGrant(receiptId: string, now: number) {
    const grant = await this.#receipts.load(receiptId);
    if (grant === undefined) return undefined;
    if (now >= grant.expiresAt) return grant;
    return grant;
  }
}

function toHandle(grant: {
  readonly receiptId: string;
  readonly mode: OctantMode;
  readonly confirmed: boolean;
  readonly projectId?: string;
  readonly bindingRevisionId?: string;
  readonly worktreeReceiptId?: string;
}): AgentRunWorkspaceHandle {
  if (grant.mode === "chat") {
    return {
      kind: "chat-virtual",
      mode: "chat",
      receiptId: decodeAgentRunWorkspaceReceiptId(grant.receiptId),
    };
  }
  if (grant.mode === "work") {
    return {
      kind: "work-root",
      mode: "work",
      receiptId: decodeAgentRunWorkspaceReceiptId(grant.receiptId),
      projectId: decodeProjectId(grant.projectId ?? ""),
      bindingRevisionId: decodeBindingRevisionId(grant.bindingRevisionId ?? ""),
    };
  }
  return {
    kind: "code-worktree",
    mode: "code",
    worktreeReceiptId: decodeWorktreeReceiptId(grant.worktreeReceiptId ?? grant.receiptId),
    confirmation: grant.confirmed ? "confirmed" : "prepared",
  };
}

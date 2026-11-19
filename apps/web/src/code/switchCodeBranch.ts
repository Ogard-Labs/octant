import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeApprovalId, CodeCheckoutId, CodeThreadId } from "@octant/contracts";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { decidesCodeEffectsByApproval } from "@octant/domain";

export interface SwitchCodeBranchRequest {
  readonly branch: string;
  readonly dirty: "refuse" | "stash";
  /**
   * The token of the observation the person consented against. The host
   * refuses the switch when the checkout has moved on since, so a retry after
   * a stale answer needs a fresh preview and fresh consent, never a token
   * re-read on its own.
   */
  readonly expectedStateToken: string;
}

export type SwitchCodeBranchOutcome =
  | { readonly status: "ok"; readonly branch: string }
  | {
      readonly status: "refused";
      readonly reason?: string | undefined;
      readonly message: string;
    };

export interface CodeBranchStatePreview {
  readonly stateToken: string;
  /** The working-tree entries the person was shown before consenting to stash. */
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly index: string;
    readonly worktree: string;
  }>;
}

export type CodeBranchPreviewOutcome =
  | { readonly status: "ok"; readonly preview: CodeBranchStatePreview }
  | { readonly status: "refused"; readonly message: string };

/**
 * The working-tree reading a branch switch is consented against: the state
 * token the host checks the operation by, and the entries the dialog shows
 * before it lets a stash run. Reading it again after the person says yes
 * would let a switch carry changes nobody saw.
 */
export async function observeCodeBranchState(
  client: Pick<CodeClient, "executeOperation">,
  nextUuid: () => string,
  scope: { readonly threadId: CodeThreadId; readonly checkoutId: CodeCheckoutId },
): Promise<CodeBranchPreviewOutcome> {
  try {
    const observed = await client.executeOperation({
      kind: "observe-git",
      operationId: nextUuid() as never,
      gitOperationId: nextUuid() as never,
      maxDiffBytes: 1,
      ...scope,
    });
    if (observed !== undefined && observed.kind === "git-observed") {
      return {
        status: "ok",
        preview: {
          stateToken: observed.stateToken,
          entries: observed.status.map((entry) => ({
            path: entry.path,
            index: entry.index,
            worktree: entry.worktree,
          })),
        },
      };
    }
    return {
      status: "refused",
      message:
        observed?.kind === "operation-failed"
          ? observed.failure.message
          : "The checkout could not be read; reconnect it before switching branches.",
    };
  } catch {
    return {
      status: "refused",
      message: "The checkout could not be read; reconnect it before switching branches.",
    };
  }
}

/**
 * The Environment's branch switch is one authoritative operation against the
 * checkout state the preview named: the caller passes that preview's token,
 * so a tree that changed since the consent is refused rather than stashed
 * unseen.
 */
export async function switchCodeBranch(
  client: Pick<CodeClient, "executeOperation">,
  nextUuid: () => string,
  scope: { readonly threadId: CodeThreadId; readonly checkoutId: CodeCheckoutId },
  request: SwitchCodeBranchRequest,
  authority?: {
    readonly executionPolicy: ProviderExecutionPolicy;
    /**
     * The shared approval path the Git pane's mutations take. A grant is
     * recorded against the exact command below — its operation ids and the
     * state token the person consented to — so approval can never stand in
     * for a switch that was not the one it named.
     */
    readonly requestApproval?: (
      command: Parameters<CodeClient["executeOperation"]>[0],
    ) => Promise<CodeApprovalId | undefined>;
  },
): Promise<SwitchCodeBranchOutcome> {
  const command: Parameters<CodeClient["executeOperation"]>[0] = {
    kind: "switch-git-branch",
    operationId: nextUuid() as never,
    gitOperationId: nextUuid() as never,
    ...scope,
    branch: request.branch,
    expectedStateToken: request.expectedStateToken,
    dirty: request.dirty,
  };
  if (authority !== undefined) {
    if (authority.executionPolicy === "plan") {
      return { status: "refused", message: "Plan mode is read-only; switching is unavailable." };
    }
    if (decidesCodeEffectsByApproval(authority.executionPolicy)) {
      const approvalId = await authority.requestApproval?.(command);
      if (approvalId === undefined) {
        return { status: "refused", message: "The branch switch was not approved." };
      }
    }
  }
  try {
    const result = await client.executeOperation(command);
    if (result === undefined) {
      return { status: "refused", message: "The host did not answer the switch request." };
    }
    if (result.kind === "operation-failed") {
      return { status: "refused", message: result.failure.message };
    }
    if (result.kind !== "git-mutation-state" || result.mutation !== "switch-branch") {
      return { status: "refused", message: "The host answered a different operation." };
    }
    if (result.state === "completed") {
      return { status: "ok", branch: result.headBranch ?? request.branch };
    }
    return {
      status: "refused",
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      message: result.detail ?? "The branch could not be switched.",
    };
  } catch {
    return {
      status: "refused",
      message: "The branch could not be switched. Reconnect and retry.",
    };
  }
}

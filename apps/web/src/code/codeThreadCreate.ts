import {
  decodeCodeCommand,
  decodeCodeThread,
  type CodeCommand,
  type CodeCommandResult,
} from "@octant/contracts/code";
import type { AgentProfileId } from "@octant/contracts/agent-profile";
import type { CodeNewThreadWorkspace, ProjectId } from "@octant/contracts/projects";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { CodeComposerSubmitInput } from "./composer/CodeComposerAdapter";

/** A provider/model pair the Code create path may start a thread with. */
export interface CodeThreadProviderChoice {
  readonly instanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly label: string;
}

type PreparedCheckout = Extract<CodeCommandResult, { readonly kind: "checkout-prepared" }>;

export interface CodeThreadCreateInput {
  readonly composer: CodeComposerSubmitInput;
  readonly modelId: ProviderModelId;
  readonly prepared: PreparedCheckout;
  readonly projectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: string;
  readonly timestamp: string;
  readonly title: string;
  /**
   * The profile the composer had selected when the thread was started. Carried
   * into the command so the server, not the renderer, narrows the thread's
   * posture to what the profile allows.
   */
  readonly profileId?: AgentProfileId;
}

/**
 * The single decision the reachable Code create path makes about a Project's
 * remembered workspace habit: which journaled command starts the
 * thread. A managed worktree keeps the existing Start-from-origin creation;
 * the current checkout binds exactly the checkout the server just prepared.
 *
 * Rejection is a value, not a throw, because "this checkout has no branch" is
 * an ordinary state the composer must report rather than a defect.
 */
export type CodeThreadCreatePlan =
  | { readonly kind: "command"; readonly command: CodeCommand }
  | { readonly kind: "rejected"; readonly message: string };

export function planCodeThreadCreate(input: CodeThreadCreateInput): CodeThreadCreatePlan {
  const workspace: CodeNewThreadWorkspace = input.composer.workspace;
  const deliveryTarget = { ...input.composer.deliveryTarget, confirmedAt: input.timestamp };

  if (workspace === "managed-worktree") {
    return {
      kind: "command",
      command: decodeCodeCommand({
        kind: "create-managed-code-thread",
        threadId: input.threadId,
        projectId: input.projectId,
        bindingRevisionId: input.prepared.bindingRevisionId,
        title: input.title,
        providerInstanceId: input.providerInstanceId,
        modelId: input.modelId,
        executionPolicy: input.composer.executionPolicy,
        permissionPersistence: input.composer.permissionPersistence,
        deliveryTarget,
        sourceBranch: input.composer.deliveryTarget.proposedBaseBranch,
        startFromOrigin: input.composer.worktreeSource.startFromOrigin,
        ...(input.composer.worktreeSource.remoteName === ""
          ? {}
          : { remoteName: input.composer.worktreeSource.remoteName }),
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        ...(input.composer.issueContext === undefined
          ? {}
          : { issueContext: input.composer.issueContext }),
        ...(input.composer.linearIssueContext === undefined
          ? {}
          : { linearIssueContext: input.composer.linearIssueContext }),
      }),
    };
  }

  // The current checkout is only bindable when the server resolved it to a
  // branch; a detached head has no branch for the thread to deliver onto.
  if (input.prepared.checkout.head.kind !== "branch") {
    return {
      kind: "rejected",
      message: "Create or select a branch before starting a Code thread in the current checkout.",
    };
  }

  return {
    kind: "command",
    command: {
      kind: "create-code-thread",
      thread: decodeCodeThread({
        id: input.threadId,
        projectId: input.projectId,
        bindingRevisionId: input.prepared.bindingRevisionId,
        repositoryId: input.prepared.checkout.repositoryId,
        checkoutId: input.prepared.checkout.id,
        title: input.title,
        lifecycle: "active",
        providerInstanceId: input.providerInstanceId,
        modelId: input.modelId,
        executionPolicy: input.composer.executionPolicy,
        permissionPersistence: input.composer.permissionPersistence,
        // Work in the existing checkout lands on the branch that checkout is
        // already on, never on a branch intent invented for a new worktree.
        deliveryTarget: { ...deliveryTarget, branchIntent: input.prepared.checkout.head.name },
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        version: 1,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      }),
      ...(input.composer.issueContext === undefined
        ? {}
        : { issueContext: input.composer.issueContext }),
      ...(input.composer.linearIssueContext === undefined
        ? {}
        : { linearIssueContext: input.composer.linearIssueContext }),
    },
  };
}

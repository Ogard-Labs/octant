import type { CodeCommandResult } from "@octant/contracts/code";
import { describe, expect, it } from "vitest";
import type { CodeComposerSubmitInput } from "./composer/CodeComposerAdapter";
import { planCodeThreadCreate } from "./codeThreadCreate";

/**
 * The reachable Code create path turns the Project's remembered
 * workspace habit into exactly one journaled command. These assertions
 * previously lived on the never-mounted `CodeThreadCreateDialog`.
 */

const now = "2026-08-15T17:00:00.000Z";
const ids = {
  project: "20000000-0000-4000-8000-000000000001",
  binding: "30000000-0000-4000-8000-000000000001",
  checkout: "40000000-0000-4000-8000-000000000001",
  provider: "50000000-0000-4000-8000-000000000001",
  thread: "10000000-0000-4000-8000-000000000001",
} as const;

function prepared(head?: { readonly kind: "detached"; readonly oid: string }): CodeCommandResult {
  return {
    kind: "checkout-prepared",
    bindingRevisionId: ids.binding as never,
    checkout: {
      id: ids.checkout as never,
      repositoryId: `repo_${"a".repeat(64)}` as never,
      kind: "existing-worktree",
      availability: "available",
      head: head ?? ({ kind: "branch", name: "development", oid: "b".repeat(40) } as never),
      observedAt: now as never,
    },
  } as CodeCommandResult;
}

function composer(
  workspace: CodeComposerSubmitInput["workspace"],
  overrides: Partial<CodeComposerSubmitInput> = {},
): CodeComposerSubmitInput {
  return {
    prompt: "Fix search",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    workspace,
    deliveryTarget: {
      branchIntent: "octant/abcd1234",
      remoteName: "origin",
      proposedBaseRepository: "octocat/octant",
      proposedBaseBranch: "development",
      outcomeKind: "local-implementation",
    },
    worktreeSource: { startFromOrigin: true, remoteName: "origin" },
    ...overrides,
  };
}

function plan(workspace: CodeComposerSubmitInput["workspace"], head?: never) {
  return planCodeThreadCreate({
    composer: composer(workspace),
    modelId: "qwen-3.6" as never,
    prepared: (head ?? prepared()) as never,
    projectId: ids.project as never,
    providerInstanceId: ids.provider as never,
    threadId: ids.thread,
    timestamp: now,
    title: "Fix search",
  });
}

describe("planCodeThreadCreate", () => {
  it("creates a managed worktree for the managed-worktree habit", () => {
    const result = plan("managed-worktree");
    expect(result).toMatchObject({
      kind: "command",
      command: {
        kind: "create-managed-code-thread",
        threadId: ids.thread,
        projectId: ids.project,
        bindingRevisionId: ids.binding,
        title: "Fix search",
        sourceBranch: "development",
        startFromOrigin: true,
        remoteName: "origin",
        deliveryTarget: { branchIntent: "octant/abcd1234", confirmedAt: now },
      },
    });
  });

  it("binds the prepared checkout for the current-checkout habit", () => {
    const result = plan("current-checkout");
    expect(result).toMatchObject({
      kind: "command",
      command: {
        kind: "create-code-thread",
        thread: {
          id: ids.thread,
          projectId: ids.project,
          bindingRevisionId: ids.binding,
          checkoutId: ids.checkout,
          title: "Fix search",
          providerInstanceId: ids.provider,
          modelId: "qwen-3.6",
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
          deliveryTarget: {
            // The existing checkout delivers onto the branch it is already on.
            branchIntent: "development",
            remoteName: "origin",
            proposedBaseRepository: "octocat/octant",
            proposedBaseBranch: "development",
            outcomeKind: "local-implementation",
            confirmedAt: now,
          },
        },
      },
    });
  });

  it("refuses the current checkout when the prepared head is detached", () => {
    const result = planCodeThreadCreate({
      composer: composer("current-checkout"),
      modelId: "qwen-3.6" as never,
      prepared: prepared({ kind: "detached", oid: "c".repeat(40) }) as never,
      projectId: ids.project as never,
      providerInstanceId: ids.provider as never,
      threadId: ids.thread,
      timestamp: now,
      title: "Fix search",
    });
    expect(result).toEqual({
      kind: "rejected",
      message: "Create or select a branch before starting a Code thread in the current checkout.",
    });
  });

  it("carries the user-confirmed delivery outcome and access policy unchanged", () => {
    const result = planCodeThreadCreate({
      composer: composer("current-checkout", {
        executionPolicy: "full-access",
        permissionPersistence: "project-default",
        deliveryTarget: {
          branchIntent: "octant/abcd1234",
          remoteName: "origin",
          proposedBaseRepository: "octocat/octant",
          proposedBaseBranch: "development",
          outcomeKind: "merged-pr",
        },
      }),
      modelId: "qwen-3.6" as never,
      prepared: prepared() as never,
      projectId: ids.project as never,
      providerInstanceId: ids.provider as never,
      threadId: ids.thread,
      timestamp: now,
      title: "Fix search",
    });
    expect(result).toMatchObject({
      kind: "command",
      command: {
        kind: "create-code-thread",
        thread: {
          executionPolicy: "full-access",
          permissionPersistence: "project-default",
          deliveryTarget: { outcomeKind: "merged-pr" },
        },
      },
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  decodeCodeThreadId,
  decodeWorkArtifactRef,
  decodeWorkPromotionProposalId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { createWorkPromotionCodeThreadPort } from "./workPromotionCodeThreadPort";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const proposalId = decodeWorkPromotionProposalId("00000000-0000-4000-8000-000000000902");
const targetProjectId = decodeProjectId("00000000-0000-4000-8000-000000000903");

describe("createWorkPromotionCodeThreadPort", () => {
  it("allows approval-gated creation when delivery branchIntent contains a slash", async () => {
    const execute = vi.fn(
      async (_windowId: unknown, command: { kind: string; thread?: unknown }) => {
        if (command.kind === "prepare-code-project-checkout") {
          return {
            kind: "checkout-prepared",
            bindingRevisionId: "00000000-0000-4000-8000-000000000904",
            checkout: {
              id: "00000000-0000-4000-8000-000000000905",
              repositoryId: `repo_${"a".repeat(64)}`,
              kind: "existing-worktree",
              availability: "available",
              head: { kind: "branch", name: "development", oid: "a".repeat(40) },
              observedAt: "2026-07-23T18:00:00.000Z",
            },
          };
        }
        if (command.kind === "create-code-thread") {
          return {
            kind: "thread-created",
            thread: {
              ...(command.thread as object),
              executionPolicy: "approval-gated",
            },
          };
        }
        throw new Error(`unexpected ${command.kind}`);
      },
    );

    const port = createWorkPromotionCodeThreadPort({
      codeService: {
        execute: execute as never,
        bootstrap: async () => ({ threads: [], checkouts: [], settings: {} }) as never,
      },
      clock: () => "2026-07-23T18:00:00.000Z",
    });

    await expect(
      port.createApprovalGatedThread({
        proposalId,
        targetCodeProjectId: targetProjectId,
        providerInstanceId: "10000000-0000-4000-8000-000000000001" as never,
        modelId: "model-a" as never,
        deliveryTarget: {
          branchIntent: "feature/work-promotion",
          remoteName: "origin",
          proposedBaseRepository: "octocat/octant",
          proposedBaseBranch: "development",
          outcomeKind: "opened-pr",
          confirmedAt: "2026-07-23T18:00:00.000Z" as never,
        },
        permissionPersistence: "current-session",
        originSummary: "Promote selected Work context",
        originArtifactRefs: [decodeWorkArtifactRef("artifact-token-a")],
        authenticatedWindowId: windowId,
      }),
    ).resolves.toEqual({ codeThreadId: decodeCodeThreadId(String(proposalId)) });
  });

  it("still rejects filesystem authority markers in the origin summary", async () => {
    const port = createWorkPromotionCodeThreadPort({
      codeService: {
        execute: async (_windowId, command) => {
          if (command.kind === "prepare-code-project-checkout") {
            return {
              kind: "checkout-prepared",
              bindingRevisionId: "00000000-0000-4000-8000-000000000904",
              checkout: {
                id: "00000000-0000-4000-8000-000000000905",
                repositoryId: `repo_${"a".repeat(64)}`,
                kind: "existing-worktree",
                availability: "available",
                head: { kind: "branch", name: "development", oid: "a".repeat(40) },
                observedAt: "2026-07-23T18:00:00.000Z",
              },
            } as never;
          }
          return { kind: "thread-created", thread: { executionPolicy: "approval-gated" } } as never;
        },
        bootstrap: async () => ({ threads: [], checkouts: [], settings: {} }) as never,
      },
      clock: () => "2026-07-23T18:00:00.000Z",
    });

    await expect(
      port.createApprovalGatedThread({
        proposalId,
        targetCodeProjectId: targetProjectId,
        providerInstanceId: "10000000-0000-4000-8000-000000000001" as never,
        modelId: "model-a" as never,
        deliveryTarget: {
          branchIntent: "feature/ok",
          remoteName: "origin",
          proposedBaseRepository: "octocat/octant",
          proposedBaseBranch: "development",
          outcomeKind: "opened-pr",
          confirmedAt: "2026-07-23T18:00:00.000Z" as never,
        },
        permissionPersistence: "current-session",
        originSummary: "Continue from file:/Users/secret/notes",
        originArtifactRefs: [decodeWorkArtifactRef("artifact-token-a")],
        authenticatedWindowId: windowId,
      }),
    ).rejects.toThrow(/filesystem authority/i);
  });
});

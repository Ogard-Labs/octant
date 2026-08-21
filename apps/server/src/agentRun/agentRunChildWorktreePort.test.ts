import { describe, expect, it } from "vitest";
import {
  createAgentRunChildWorktreePort,
  deriveAgentRunChildWorktreeThreadId,
} from "./agentRunChildWorktreePort";

const parentThreadId = "33333333-3333-4333-8333-333333333333";
const repositoryId = `repo_${"a".repeat(64)}`;

describe("createAgentRunChildWorktreePort", () => {
  it("reuses an isolated ready worktree and refuses the parent checkout", async () => {
    const childThreadId = deriveAgentRunChildWorktreeThreadId(parentThreadId);
    const isolatedPath = `/workspace/.octant-worktrees/${repositoryId}/${childThreadId}`;
    const receipt = {
      version: 1 as const,
      receiptId: "66666666-6666-4666-8666-666666666666",
      repositoryId,
      threadId: childThreadId,
      checkoutId: "60000000-0000-4000-8000-000000000002",
      canonicalRepositoryPath: "/workspace/repository",
      canonicalWorktreePath: isolatedPath,
      branchIntent: "octant/agent-run/child",
      refIntent: "refs/heads/octant/agent-run/child",
      expectedHead: "a".repeat(40),
      state: "ready" as const,
      createdAt: "2026-08-01T15:00:00.000Z",
      updatedAt: "2026-08-01T15:00:00.000Z",
    };
    const port = createAgentRunChildWorktreePort({
      service: {
        planCreation: async () => ({
          status: "planned",
          repositoryId,
          targetPath: isolatedPath,
          parent: { canonicalPath: "/workspace", identity: { device: "1", inode: "2" } },
          branchIntent: "octant/agent-run/child",
          startPoint: "a".repeat(40),
          grant: { grantId: "70000000-0000-4000-8000-000000000007", expiresAt: 1 },
        }),
        create: async () => ({ status: "ready", targetPath: isolatedPath, receipt }),
      } as never,
      loadReceipt: async () => receipt,
      findActive: async () => receipt,
    });
    const prepared = await port.prepare({
      parentThreadId,
      windowId: "11111111-1111-4111-8111-111111111111",
      projectId: "77777777-7777-4777-8777-777777777777",
      bindingRevisionId: "88888888-8888-4888-8888-888888888888",
      repositoryId,
      repositoryRoot: "/workspace/repository",
      parentCheckoutRoot: "/workspace/repository",
      branchIntent: "octant/agent-run/child",
      startPoint: "a".repeat(40),
      sourceBranch: "main",
      sourceMode: "local",
    });
    expect(prepared).toMatchObject({
      status: "prepared",
      worktreeRoot: isolatedPath,
    });
    expect(
      await port.confirm({
        worktreeReceiptId: receipt.receiptId,
        parentThreadId,
        parentCheckoutRoot: isolatedPath,
      }),
    ).toEqual({ status: "refused", reason: "parent-checkout" });
  });
});

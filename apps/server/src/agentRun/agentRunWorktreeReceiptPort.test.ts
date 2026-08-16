import { describe, expect, it } from "vitest";
import { decodeAgentRunCreationRequest } from "@octant/contracts";
import { createVerifiedAgentRunWorktreeReceiptPort } from "./agentRunWorktreeReceiptPort";

const ids = {
  request: "22222222-2222-4222-8222-222222222222",
  thread: "33333333-3333-4333-8333-333333333333",
  provider: "44444444-4444-4444-8444-444444444444",
  receipt: "66666666-6666-4666-8666-666666666666",
  project: "77777777-7777-4777-8777-777777777777",
};

function codeRequest() {
  return decodeAgentRunCreationRequest({
    requestId: ids.request,
    parentThreadId: ids.thread,
    role: "implementation",
    task: "Implement the clamp.",
    mode: "code",
    providerInstanceId: ids.provider,
    modelId: "gpt-4o",
    requestedAuthority: {
      filesystem: true,
      shell: true,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    },
    workspace: {
      kind: "code-worktree",
      mode: "code",
      worktreeReceiptId: ids.receipt,
    },
  });
}

describe("createVerifiedAgentRunWorktreeReceiptPort", () => {
  it("resolves a ready managed receipt bound to the parent thread", () => {
    const port = createVerifiedAgentRunWorktreeReceiptPort({
      request: codeRequest(),
      projectId: ids.project,
      receipt: {
        receiptId: ids.receipt,
        threadId: ids.thread,
        state: "ready",
        canonicalRepositoryPath: "/repo",
        canonicalWorktreePath: "/repo/.octant/worktrees/child-a",
      },
    });
    expect(
      port.resolveVerifiedIsolation({
        worktreeReceiptId: ids.receipt as never,
        parentThreadId: ids.thread,
      }),
    ).toEqual({
      projectId: ids.project,
      checkoutRoot: "/repo",
      worktreeRoot: "/repo/.octant/worktrees/child-a",
    });
  });

  it("refuses non-ready, foreign-thread, and parent-checkout receipts", () => {
    const request = codeRequest();
    expect(
      createVerifiedAgentRunWorktreeReceiptPort({
        request,
        projectId: ids.project,
        receipt: {
          receiptId: ids.receipt,
          threadId: ids.thread,
          state: "creating",
          canonicalRepositoryPath: "/repo",
          canonicalWorktreePath: "/repo/.octant/worktrees/child-a",
        },
      }).resolveVerifiedIsolation({
        worktreeReceiptId: ids.receipt as never,
        parentThreadId: ids.thread,
      }),
    ).toBeUndefined();

    expect(
      createVerifiedAgentRunWorktreeReceiptPort({
        request,
        projectId: ids.project,
        receipt: {
          receiptId: ids.receipt,
          threadId: "99999999-9999-4999-8999-999999999999",
          state: "ready",
          canonicalRepositoryPath: "/repo",
          canonicalWorktreePath: "/repo/.octant/worktrees/child-a",
        },
      }).resolveVerifiedIsolation({
        worktreeReceiptId: ids.receipt as never,
        parentThreadId: ids.thread,
      }),
    ).toBeUndefined();

    expect(
      createVerifiedAgentRunWorktreeReceiptPort({
        request,
        projectId: ids.project,
        receipt: {
          receiptId: ids.receipt,
          threadId: ids.thread,
          state: "ready",
          canonicalRepositoryPath: "/repo",
          canonicalWorktreePath: "/repo",
        },
      }).resolveVerifiedIsolation({
        worktreeReceiptId: ids.receipt as never,
        parentThreadId: ids.thread,
      }),
    ).toBeUndefined();
  });
});

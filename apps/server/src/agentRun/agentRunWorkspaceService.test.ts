import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAgentRunCreationRequest } from "@octant/contracts";
import { AgentRunWorkspaceReceiptStore } from "./agentRunWorkspaceReceiptStore";
import { AgentRunWorkspaceService } from "./agentRunWorkspaceService";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  thread: "33333333-3333-4333-8333-333333333333",
  window: "11111111-1111-4111-8111-111111111111",
  otherWindow: "12121212-1212-4121-8121-121212121212",
  project: "77777777-7777-4777-8777-777777777777",
  binding: "88888888-8888-4888-8888-888888888888",
  receipt: "66666666-6666-4666-8666-666666666666",
  provider: "44444444-4444-4444-8444-444444444444",
};

function createService() {
  const directory = mkdtempSync(join(tmpdir(), "octant-agentrun-ws-svc-"));
  directories.push(directory);
  const receipts = new AgentRunWorkspaceReceiptStore({
    dataDirectory: directory,
    uuid: () => ids.receipt,
  });
  const service = new AgentRunWorkspaceService({
    receipts,
    now: () => 1_700_000_000_000,
    childWorktree: {
      prepare: async () => ({
        status: "prepared",
        worktreeReceiptId: ids.receipt,
        checkoutRoot: "/repo",
        worktreeRoot: "/workspace/.octant-worktrees/child",
        state: "ready",
      }),
      confirm: async (input) =>
        input.parentCheckoutRoot === "/repo"
          ? {
              status: "confirmed",
              worktreeReceiptId: ids.receipt,
              checkoutRoot: "/repo",
              worktreeRoot: "/workspace/.octant-worktrees/child",
            }
          : { status: "refused", reason: "parent-checkout" },
    },
  });
  return service;
}

describe("AgentRunWorkspaceService", () => {
  it("prepares a Chat virtual workspace and admits research children", async () => {
    const service = createService();
    const prepared = await service.prepare({
      windowId: ids.window,
      parent: { threadId: ids.thread, mode: "chat" },
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(prepared.workspace.kind).toBe("chat-virtual");
    const request = decodeAgentRunCreationRequest({
      requestId: "22222222-2222-4222-8222-222222222222",
      parentThreadId: ids.thread,
      role: "research",
      task: "Summarize",
      mode: "chat",
      providerInstanceId: ids.provider,
      modelId: "gpt-4o",
      requestedAuthority: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      },
      workspace: { kind: "chat-virtual", mode: "chat", receiptId: ids.receipt },
    });
    const admitted = await service.admit({
      windowId: ids.window,
      requested: request.workspace,
      role: "research",
      parent: { threadId: ids.thread, mode: "chat" },
    });
    expect(admitted).toEqual({
      status: "admitted",
      workspace: { kind: "chat-virtual", mode: "chat" },
    });
  });

  it("prepares a Work binding receipt without a path and refuses a foreign window", async () => {
    const service = createService();
    const prepared = await service.prepare({
      windowId: ids.window,
      parent: {
        threadId: ids.thread,
        mode: "work",
        projectId: ids.project,
        bindingRevisionId: ids.binding,
        canonicalRoot: "/projects/demo",
      },
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared" || prepared.workspace.kind !== "work-root") return;
    expect("canonicalRoot" in prepared.workspace).toBe(false);
    const request = decodeAgentRunCreationRequest({
      requestId: "22222222-2222-4222-8222-222222222222",
      parentThreadId: ids.thread,
      role: "research",
      task: "Draft",
      mode: "work",
      providerInstanceId: ids.provider,
      modelId: "gpt-4o",
      requestedAuthority: {
        filesystem: true,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
      },
      workspace: { kind: "work-root", mode: "work", receiptId: ids.receipt },
    });
    expect(
      await service.admit({
        windowId: ids.otherWindow,
        requested: request.workspace,
        role: "research",
        parent: {
          threadId: ids.thread,
          mode: "work",
          projectId: ids.project,
          bindingRevisionId: ids.binding,
          canonicalRoot: "/projects/demo",
        },
      }),
    ).toEqual({ status: "refused", reason: "unauthorized" });
  });

  it("prepares then confirms a Code worktree and refuses the parent checkout", async () => {
    const service = createService();
    const parent = {
      threadId: ids.thread,
      mode: "code" as const,
      projectId: ids.project,
      checkoutRoot: "/repo",
    };
    const prepared = await service.prepare({
      windowId: ids.window,
      parent,
      code: {
        projectId: ids.project,
        bindingRevisionId: ids.binding,
        repositoryId: `repo_${"a".repeat(64)}`,
        repositoryRoot: "/repo",
        parentCheckoutRoot: "/repo",
        branchIntent: "octant/agent-run/child",
        startPoint: "a".repeat(40),
        sourceBranch: "main",
        sourceMode: "local",
      },
    });
    expect(prepared.status).toBe("prepared");
    const confirmed = await service.confirm({
      windowId: ids.window,
      parent,
      worktreeReceiptId: ids.receipt,
    });
    expect(confirmed.status).toBe("confirmed");
    const parentCheckout = await service.confirm({
      windowId: ids.window,
      parent: { ...parent, checkoutRoot: "/workspace/.octant-worktrees/child" },
      worktreeReceiptId: ids.receipt,
    });
    expect(parentCheckout).toEqual({ status: "refused", reason: "parent-checkout" });
  });
});

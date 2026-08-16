import { describe, expect, it } from "vitest";
import { decodeAgentRunCreationRequest } from "./agentRunCreationRequest";

const ids = {
  request: "22222222-2222-4222-8222-222222222222",
  thread: "33333333-3333-4333-8333-333333333333",
  provider: "44444444-4444-4444-8444-444444444444",
  receipt: "66666666-6666-4666-8666-666666666666",
  project: "77777777-7777-4777-8777-777777777777",
};

const base = {
  requestId: ids.request,
  parentThreadId: ids.thread,
  role: "implementation",
  task: "Summarize the open PRs in this repository.",
  mode: "chat",
  providerInstanceId: ids.provider,
  modelId: "gpt-4o",
  requestedAuthority: {
    filesystem: false,
    shell: false,
    git: false,
    network: true,
    tools: true,
    subagents: false,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  },
  workspace: { kind: "chat-virtual", mode: "chat" },
};

describe("AgentRunCreationRequest", () => {
  it("decodes a minimal explicit chat child request", () => {
    const decoded = decodeAgentRunCreationRequest(base);
    expect(decoded.mode).toBe("chat");
    expect(decoded.providerInstanceId).toBe(ids.provider);
  });

  it("decodes an optional reasoning label", () => {
    const decoded = decodeAgentRunCreationRequest({ ...base, reasoning: "high" });
    expect(decoded.reasoning).toBe("high");
  });

  it("decodes a Code child request that references a managed worktree receipt id", () => {
    const decoded = decodeAgentRunCreationRequest({
      ...base,
      mode: "code",
      role: "implementation",
      requestedAuthority: {
        filesystem: true,
        shell: true,
        git: true,
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
    expect(decoded.workspace.kind).toBe("code-worktree");
    if (decoded.workspace.kind !== "code-worktree") return;
    expect(decoded.workspace.worktreeReceiptId).toBe(ids.receipt);
  });

  it("rejects client-forged code worktree path/verified claims", () => {
    expect(() =>
      decodeAgentRunCreationRequest({
        ...base,
        mode: "code",
        workspace: {
          kind: "code-worktree",
          mode: "code",
          projectId: ids.project,
          checkoutRoot: "/repo",
          worktreeRoot: "/repo-worktree",
          verified: true,
        },
      }),
    ).toThrow();
  });

  it("rejects work workspaces until authoritative root resolution is wired", () => {
    expect(() =>
      decodeAgentRunCreationRequest({
        ...base,
        mode: "work",
        workspace: {
          kind: "work-root",
          mode: "work",
          projectId: ids.project,
          canonicalRoot: "/projects/demo",
        },
      }),
    ).toThrow();
  });

  it("rejects mismatched mode and workspace kinds", () => {
    expect(() =>
      decodeAgentRunCreationRequest({
        ...base,
        mode: "code",
        workspace: { kind: "chat-virtual", mode: "chat" },
      }),
    ).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() => decodeAgentRunCreationRequest({ ...base, extra: true })).toThrow();
  });

  it("rejects an empty task", () => {
    expect(() => decodeAgentRunCreationRequest({ ...base, task: "" })).toThrow();
  });

  it("decodes an optional multi-model pool selection", () => {
    const decoded = decodeAgentRunCreationRequest({
      ...base,
      pool: {
        candidates: [
          { hostId: "local", providerInstanceId: ids.provider, modelId: "gpt-4o" },
          { hostId: "local", providerInstanceId: ids.provider, modelId: "gpt-4o-mini" },
        ],
        mixedVendorEnabled: false,
        fallbackAllowed: true,
        higherCostFallbackAllowed: false,
      },
    });
    expect(decoded.pool?.candidates).toHaveLength(2);
  });

  it("rejects a pool with fewer than two candidates", () => {
    expect(() =>
      decodeAgentRunCreationRequest({
        ...base,
        pool: {
          candidates: [{ hostId: "local", providerInstanceId: ids.provider, modelId: "gpt-4o" }],
          mixedVendorEnabled: false,
          fallbackAllowed: true,
          higherCostFallbackAllowed: false,
        },
      }),
    ).toThrow();
  });
});

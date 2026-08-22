import { describe, expect, it } from "vitest";
import {
  decodeAgentRunControlRequest,
  decodeAgentRunCreationRequest,
  decodeAgentRunWorkspaceConfirmationRequest,
  decodeAgentRunWorkspaceHandle,
  decodeAgentRunWorkspacePreparationRequest,
  decodeAgentRunWorkspacePreparationResult,
} from "./agentRunCreationRequest";

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

  it("decodes a Work child request that references a server-issued workspace receipt", () => {
    const decoded = decodeAgentRunCreationRequest({
      ...base,
      mode: "work",
      role: "research",
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
      workspace: {
        kind: "work-root",
        mode: "work",
        receiptId: ids.receipt,
      },
    });
    expect(decoded.workspace.kind).toBe("work-root");
    if (decoded.workspace.kind !== "work-root") return;
    expect(decoded.workspace.receiptId).toBe(ids.receipt);
  });

  it("rejects work workspaces that claim an absolute root or project id", () => {
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

  it("decodes a prepared Chat workspace handle without a filesystem path", () => {
    const handle = decodeAgentRunWorkspaceHandle({
      kind: "chat-virtual",
      mode: "chat",
      receiptId: ids.receipt,
    });
    expect(handle.kind).toBe("chat-virtual");
    expect("canonicalRoot" in handle).toBe(false);
  });

  it("decodes a Work workspace handle with project and binding identity only", () => {
    const handle = decodeAgentRunWorkspaceHandle({
      kind: "work-root",
      mode: "work",
      receiptId: ids.receipt,
      projectId: ids.project,
      bindingRevisionId: "88888888-8888-4888-8888-888888888888",
    });
    expect(handle.kind).toBe("work-root");
    if (handle.kind !== "work-root") return;
    expect(handle.bindingRevisionId).toBe("88888888-8888-4888-8888-888888888888");
    expect("canonicalRoot" in handle).toBe(false);
  });

  it("rejects a Code workspace handle that claims paths or verification", () => {
    expect(() =>
      decodeAgentRunWorkspaceHandle({
        kind: "code-worktree",
        mode: "code",
        worktreeReceiptId: ids.receipt,
        confirmation: "confirmed",
        checkoutRoot: "/repo",
        worktreeRoot: "/repo-worktree",
        verified: true,
      }),
    ).toThrow();
  });

  it("decodes prepare and confirm requests that name only ids", () => {
    expect(
      decodeAgentRunWorkspacePreparationRequest({ parentThreadId: ids.thread }).parentThreadId,
    ).toBe(ids.thread);
    expect(
      decodeAgentRunWorkspaceConfirmationRequest({
        parentThreadId: ids.thread,
        worktreeReceiptId: ids.receipt,
      }).worktreeReceiptId,
    ).toBe(ids.receipt);
    expect(() =>
      decodeAgentRunWorkspacePreparationRequest({
        parentThreadId: ids.thread,
        canonicalRoot: "/projects/demo",
      }),
    ).toThrow();
  });

  it("decodes a structured workspace refusal without a path", () => {
    const refused = decodeAgentRunWorkspacePreparationResult({
      status: "refused",
      reason: "parent-checkout",
    });
    expect(refused).toEqual({ status: "refused", reason: "parent-checkout" });
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

  it("decodes a control request that names only a parent, role, and task", () => {
    const decoded = decodeAgentRunControlRequest({
      requestId: ids.request,
      parentThreadId: ids.thread,
      role: "research",
      task: "Summarize the open PRs in this repository.",
    });
    expect(decoded.role).toBe("research");
    expect("providerInstanceId" in decoded).toBe(false);
    expect("requestedAuthority" in decoded).toBe(false);
    expect("workspace" in decoded).toBe(false);
    expect("mode" in decoded).toBe(false);
  });

  it("rejects a control request that smuggles a provider or authority", () => {
    expect(() =>
      decodeAgentRunControlRequest({
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize the open PRs in this repository.",
        providerInstanceId: ids.provider,
      }),
    ).toThrow();
    expect(() =>
      decodeAgentRunControlRequest({
        requestId: ids.request,
        parentThreadId: ids.thread,
        role: "research",
        task: "Summarize the open PRs in this repository.",
        requestedAuthority: {
          filesystem: true,
          shell: true,
          git: true,
          network: true,
          tools: true,
          subagents: true,
          executionPolicy: "full-access",
          permissionPersistence: "project-default",
        },
      }),
    ).toThrow();
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

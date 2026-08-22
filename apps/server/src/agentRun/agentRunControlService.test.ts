import { describe, expect, it } from "vitest";
import {
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type AgentRunAuthority,
  type AgentRunControlRequest,
} from "@octant/contracts";
import type { AgentRunNativeCapabilityEvidence } from "@octant/domain/agent-run-control-policy";
import {
  AgentRunControlRefused,
  buildControlRequestCommand,
  previewAgentRunControl,
  resolveAgentRunControlFacts,
  type AgentRunControlParentFacts,
} from "./agentRunControlService";

const ids = {
  request: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222222"),
  thread: decodeAgentRunParentThreadId("33333333-3333-4333-8333-333333333333"),
  provider: decodeProviderInstanceId("44444444-4444-4444-8444-444444444444"),
  project: "77777777-7777-4777-8777-777777777777",
  binding: "88888888-8888-4888-8888-888888888888",
};

const chatAuthority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: true,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

const workAuthority: AgentRunAuthority = {
  ...chatAuthority,
  filesystem: true,
  executionPolicy: "approval-gated",
};

const codeAuthority: AgentRunAuthority = {
  filesystem: true,
  shell: true,
  git: true,
  network: true,
  tools: true,
  subagents: true,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
};

const ineligibleNative: AgentRunNativeCapabilityEvidence = {
  claimedNativeSupport: "unsupported",
  workspace: false,
  authority: false,
  observability: false,
  cancellation: false,
  steering: false,
  recovery: false,
};

const eligibleNative: AgentRunNativeCapabilityEvidence = {
  claimedNativeSupport: "supported",
  workspace: true,
  authority: true,
  observability: true,
  cancellation: true,
  steering: true,
  recovery: true,
};

function chatParent(): AgentRunControlParentFacts {
  return {
    parentMode: "chat",
    parentAuthority: chatAuthority,
    liveAuthority: chatAuthority,
    workspaceParent: { threadId: String(ids.thread), mode: "chat" },
    parentRoute: {
      providerInstanceId: ids.provider,
      modelId: decodeProviderModelId("gpt-4o"),
      reasoning: "high",
    },
  };
}

function workParent(): AgentRunControlParentFacts {
  return {
    parentMode: "work",
    parentAuthority: workAuthority,
    liveAuthority: workAuthority,
    workspaceParent: {
      threadId: String(ids.thread),
      mode: "work",
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      canonicalRoot: "/projects/demo",
    },
    parentRoute: {
      providerInstanceId: ids.provider,
      modelId: decodeProviderModelId("gpt-4o"),
      projectId: ids.project,
    },
  };
}

function codeParent(): AgentRunControlParentFacts {
  return {
    parentMode: "code",
    parentAuthority: codeAuthority,
    liveAuthority: codeAuthority,
    workspaceParent: {
      threadId: String(ids.thread),
      mode: "code",
      projectId: ids.project,
      checkoutRoot: "/repo",
    },
    parentRoute: {
      providerInstanceId: ids.provider,
      modelId: decodeProviderModelId("gpt-4o"),
      projectId: ids.project,
    },
    codeWorkspace: {
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      repositoryId: "repo-1",
      repositoryRoot: "/repo",
      parentCheckoutRoot: "/repo",
      branchIntent: "agent-run",
      startPoint: "main",
      sourceBranch: "main",
      sourceMode: "local",
    },
  };
}

function control(role: AgentRunControlRequest["role"] = "research"): AgentRunControlRequest {
  return {
    requestId: ids.request,
    parentThreadId: ids.thread,
    role,
    task: "Summarize the open PRs.",
  };
}

describe("server-derived AgentRun control facts", () => {
  it("derives Chat research-only facts from the parent, not from client IDs", () => {
    const facts = resolveAgentRunControlFacts({
      parent: chatParent(),
      role: "research",
      creationPosture: "ask",
      nativeEvidence: ineligibleNative,
    });
    expect(facts.mode).toBe("chat");
    expect(facts.allowedRoles).toEqual(["research"]);
    expect(facts.providerInstanceId).toBe(ids.provider);
    expect(facts.modelId).toBe("gpt-4o");
    expect(facts.reasoning).toBe("high");
    expect(facts.workspaceKind).toBe("chat-virtual");
    expect(facts.authority.executionPolicy).toBe("plan");
    expect(facts.authority.filesystem).toBe(false);
    expect(facts.executionKind).toBe("octant-managed");
    expect(facts.nativeFallbackReason).toBeDefined();
  });

  it("keeps Work children inside the bound Project root", () => {
    const facts = resolveAgentRunControlFacts({
      parent: workParent(),
      role: "implementation",
      creationPosture: "automatic",
      nativeEvidence: ineligibleNative,
    });
    expect(facts.mode).toBe("work");
    expect(facts.workspaceKind).toBe("work-root");
    expect(facts.projectId).toBe(ids.project);
    expect(facts.allowedRoles).toEqual(["research", "implementation", "review"]);
    expect(facts.authority.filesystem).toBe(true);
    expect(facts.authority.shell).toBe(false);
  });

  it("requires Code implementation or review children to use an isolated worktree", () => {
    const facts = resolveAgentRunControlFacts({
      parent: codeParent(),
      role: "review",
      creationPosture: "automatic",
      nativeEvidence: ineligibleNative,
    });
    expect(facts.workspaceKind).toBe("code-worktree");
    expect(facts.allowedRoles).toEqual(["implementation", "review"]);
    expect(() =>
      resolveAgentRunControlFacts({
        parent: codeParent(),
        role: "research",
        creationPosture: "automatic",
        nativeEvidence: ineligibleNative,
      }),
    ).toThrow(AgentRunControlRefused);
  });

  it("selects provider-native only from complete capability evidence", () => {
    const facts = resolveAgentRunControlFacts({
      parent: chatParent(),
      role: "research",
      creationPosture: "automatic",
      nativeEvidence: eligibleNative,
    });
    expect(facts.executionKind).toBe("provider-native");
    expect(facts.nativeFallbackReason).toBeUndefined();
  });

  it("surfaces Octant-managed fallback and its reason when native is ineligible", () => {
    const preview = previewAgentRunControl({
      parent: chatParent(),
      creationPosture: "ask",
      nativeEvidence: ineligibleNative,
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;
    expect(preview.facts.executionKind).toBe("octant-managed");
    expect(preview.facts.nativeFallbackReason).toMatch(/nativeChildAgents/);
  });
});

describe("building a control command from derived facts", () => {
  it("admits a Chat child with parent-derived provider, model, and authority", () => {
    const command = buildControlRequestCommand({
      control: control(),
      parent: chatParent(),
      creationPosture: "automatic",
      nativeEvidence: ineligibleNative,
      admittedWorkspace: { kind: "chat-virtual", mode: "chat" },
      providerReadiness: { isReady: () => true },
      uuid: () => "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
    });
    expect(command.role).toBe("research");
    expect(command.routingReceipt.selectedProviderInstanceId).toBe(ids.provider);
    expect(command.routingReceipt.selectedModelId).toBe("gpt-4o");
    expect(command.routingReceipt.rawReasoning).toBe("high");
    expect(command.routingReceipt.mode).toBe("chat");
    expect(command.workspaceReceipt).toEqual({ kind: "chat-virtual", mode: "chat" });
    expect(command.requestedAuthority.filesystem).toBe(false);
    expect(command.routingReceipt.selectedExecutionKind).toBe("octant-managed");
  });

  it("records native execution when every required guarantee is evidenced", () => {
    const command = buildControlRequestCommand({
      control: control(),
      parent: chatParent(),
      creationPosture: "automatic",
      nativeEvidence: eligibleNative,
      admittedWorkspace: { kind: "chat-virtual", mode: "chat" },
      providerReadiness: { isReady: () => true },
      uuid: () => "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
    });
    expect(command.routingReceipt.selectedExecutionKind).toBe("provider-native");
    expect(command.routingReceipt.capabilityDegradations).toEqual([]);
  });

  it("refuses a Chat implementation child before a command is built", () => {
    expect(() =>
      buildControlRequestCommand({
        control: control("implementation"),
        parent: chatParent(),
        creationPosture: "automatic",
        nativeEvidence: ineligibleNative,
        admittedWorkspace: { kind: "chat-virtual", mode: "chat" },
        providerReadiness: { isReady: () => true },
        uuid: () => "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
      }),
    ).toThrow(AgentRunControlRefused);
  });
});

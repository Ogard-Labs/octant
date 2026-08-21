import { describe, expect, it } from "vitest";
import { decodeAgentRunCreationRequest, type AgentRunCreationWorkspace } from "@octant/contracts";
import {
  admitAgentRunWorkspace,
  revalidateAdmittedAgentRunWorkspace,
  type AgentRunIssuedWorkspaceGrant,
  type AgentRunWorkspaceParentFacts,
} from "./agentRunWorkspacePolicy";

const ids = {
  thread: "33333333-3333-4333-8333-333333333333",
  otherThread: "99999999-9999-4999-8999-999999999999",
  project: "77777777-7777-4777-8777-777777777777",
  otherProject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  receipt: "66666666-6666-4666-8666-666666666666",
  binding: "88888888-8888-4888-8888-888888888888",
  otherBinding: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  provider: "44444444-4444-4444-8444-444444444444",
};

const now = 1_700_000_000_000;
const later = now + 60_000;

function chatRequest(receiptId?: string): AgentRunCreationWorkspace {
  return decodeAgentRunCreationRequest({
    requestId: "22222222-2222-4222-8222-222222222222",
    parentThreadId: ids.thread,
    role: "research",
    task: "Summarize the notes.",
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
    workspace:
      receiptId === undefined
        ? { kind: "chat-virtual", mode: "chat" }
        : { kind: "chat-virtual", mode: "chat", receiptId },
  }).workspace;
}

function workRequest(): AgentRunCreationWorkspace {
  return decodeAgentRunCreationRequest({
    requestId: "22222222-2222-4222-8222-222222222222",
    parentThreadId: ids.thread,
    role: "research",
    task: "Draft the brief.",
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
  }).workspace;
}

function codeRequest(): AgentRunCreationWorkspace {
  return decodeAgentRunCreationRequest({
    requestId: "22222222-2222-4222-8222-222222222222",
    parentThreadId: ids.thread,
    role: "implementation",
    task: "Implement the clamp.",
    mode: "code",
    providerInstanceId: ids.provider,
    modelId: "gpt-4o",
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
    workspace: { kind: "code-worktree", mode: "code", worktreeReceiptId: ids.receipt },
  }).workspace;
}

const chatParent: AgentRunWorkspaceParentFacts = { threadId: ids.thread, mode: "chat" };
const workParent: AgentRunWorkspaceParentFacts = {
  threadId: ids.thread,
  mode: "work",
  projectId: ids.project,
  bindingRevisionId: ids.binding,
  canonicalRoot: "/projects/demo",
};
const codeParent: AgentRunWorkspaceParentFacts = {
  threadId: ids.thread,
  mode: "code",
  projectId: ids.project,
  checkoutRoot: "/repo",
};

function chatGrant(
  overrides: Partial<AgentRunIssuedWorkspaceGrant> = {},
): AgentRunIssuedWorkspaceGrant {
  return {
    receiptId: ids.receipt,
    parentThreadId: ids.thread,
    mode: "chat",
    confirmed: true,
    expiresAt: later,
    ...overrides,
  };
}

function workGrant(
  overrides: Partial<AgentRunIssuedWorkspaceGrant> = {},
): AgentRunIssuedWorkspaceGrant {
  return {
    receiptId: ids.receipt,
    parentThreadId: ids.thread,
    mode: "work",
    confirmed: true,
    expiresAt: later,
    projectId: ids.project,
    bindingRevisionId: ids.binding,
    canonicalRoot: "/projects/demo",
    ...overrides,
  };
}

function codeGrant(
  overrides: Partial<AgentRunIssuedWorkspaceGrant> = {},
): AgentRunIssuedWorkspaceGrant {
  return {
    receiptId: ids.receipt,
    parentThreadId: ids.thread,
    mode: "code",
    confirmed: true,
    expiresAt: later,
    projectId: ids.project,
    worktreeReceiptId: ids.receipt,
    checkoutRoot: "/repo",
    worktreeRoot: "/workspace/.octant-worktrees/repo/child",
    worktreeState: "ready",
    ...overrides,
  };
}

describe("admitAgentRunWorkspace", () => {
  it("admits a research-only Chat virtual workspace", () => {
    const admitted = admitAgentRunWorkspace({
      requested: chatRequest(),
      role: "research",
      parent: chatParent,
      issued: undefined,
      now,
    });
    expect(admitted).toEqual({
      status: "admitted",
      workspace: { kind: "chat-virtual", mode: "chat" },
    });
  });

  it("refuses a Chat child that is not research", () => {
    expect(
      admitAgentRunWorkspace({
        requested: chatRequest(),
        role: "implementation",
        parent: chatParent,
        issued: undefined,
        now,
      }),
    ).toEqual({ status: "refused", reason: "unsupported" });
  });

  it("admits a Work child locked to the current Project root and binding revision", () => {
    const admitted = admitAgentRunWorkspace({
      requested: workRequest(),
      role: "research",
      parent: workParent,
      issued: workGrant(),
      now,
    });
    expect(admitted).toEqual({
      status: "admitted",
      workspace: {
        kind: "work-root",
        mode: "work",
        projectId: ids.project,
        bindingRevisionId: ids.binding,
        canonicalRoot: "/projects/demo",
      },
    });
  });

  it("refuses stale, expired, foreign-thread, and foreign-Project Work receipts", () => {
    expect(
      admitAgentRunWorkspace({
        requested: workRequest(),
        role: "research",
        parent: workParent,
        issued: workGrant({ bindingRevisionId: ids.otherBinding }),
        now,
      }),
    ).toEqual({ status: "refused", reason: "stale" });
    expect(
      admitAgentRunWorkspace({
        requested: workRequest(),
        role: "research",
        parent: workParent,
        issued: workGrant({ expiresAt: now }),
        now,
      }),
    ).toEqual({ status: "refused", reason: "expired" });
    expect(
      admitAgentRunWorkspace({
        requested: workRequest(),
        role: "research",
        parent: workParent,
        issued: workGrant({ parentThreadId: ids.otherThread }),
        now,
      }),
    ).toEqual({ status: "refused", reason: "foreign-thread" });
    expect(
      admitAgentRunWorkspace({
        requested: workRequest(),
        role: "research",
        parent: workParent,
        issued: workGrant({ projectId: ids.otherProject }),
        now,
      }),
    ).toEqual({ status: "refused", reason: "foreign-project" });
  });

  it("refuses a Work child whose bound root is not the current Project root", () => {
    expect(
      admitAgentRunWorkspace({
        requested: workRequest(),
        role: "research",
        parent: workParent,
        issued: workGrant({ canonicalRoot: "/projects/other" }),
        now,
      }),
    ).toEqual({ status: "refused", reason: "wider-than-parent" });
  });

  it("admits a confirmed isolated Code worktree and refuses the parent checkout", () => {
    expect(
      admitAgentRunWorkspace({
        requested: codeRequest(),
        role: "implementation",
        parent: codeParent,
        issued: codeGrant(),
        now,
      }),
    ).toMatchObject({
      status: "admitted",
      workspace: {
        kind: "code-worktree",
        verified: true,
        worktreeRoot: "/workspace/.octant-worktrees/repo/child",
      },
    });
    expect(
      admitAgentRunWorkspace({
        requested: codeRequest(),
        role: "review",
        parent: codeParent,
        issued: codeGrant({ worktreeRoot: "/repo" }),
        now,
      }),
    ).toEqual({ status: "refused", reason: "parent-checkout" });
  });

  it("refuses unconfirmed, unavailable, and wider-than-parent Code receipts", () => {
    expect(
      admitAgentRunWorkspace({
        requested: codeRequest(),
        role: "implementation",
        parent: codeParent,
        issued: codeGrant({ confirmed: false, worktreeState: "creating" }),
        now,
      }),
    ).toEqual({ status: "refused", reason: "unconfirmed" });
    expect(
      admitAgentRunWorkspace({
        requested: codeRequest(),
        role: "implementation",
        parent: codeParent,
        issued: undefined,
        now,
      }),
    ).toEqual({ status: "refused", reason: "unavailable" });
    expect(
      admitAgentRunWorkspace({
        requested: codeRequest(),
        role: "implementation",
        parent: { ...codeParent, checkoutRoot: "/repo/.octant-worktrees/parent" },
        issued: codeGrant({ worktreeRoot: "/repo" }),
        now,
      }),
    ).toEqual({ status: "refused", reason: "wider-than-parent" });
  });
});

describe("revalidateAdmittedAgentRunWorkspace", () => {
  it("refuses a Work child after the Project binding moves", () => {
    expect(
      revalidateAdmittedAgentRunWorkspace({
        workspace: {
          kind: "work-root",
          mode: "work",
          projectId: ids.project as never,
          bindingRevisionId: ids.binding as never,
          canonicalRoot: "/projects/demo",
        },
        parent: { ...workParent, bindingRevisionId: ids.otherBinding },
      }),
    ).toEqual({ status: "refused", reason: "stale" });
  });

  it("refuses a Code child that would restart in the parent checkout", () => {
    expect(
      revalidateAdmittedAgentRunWorkspace({
        workspace: {
          kind: "code-worktree",
          mode: "code",
          projectId: ids.project as never,
          checkoutRoot: "/repo",
          worktreeRoot: "/repo",
          verified: true,
        },
        parent: codeParent,
      }),
    ).toEqual({ status: "refused", reason: "parent-checkout" });
  });
});

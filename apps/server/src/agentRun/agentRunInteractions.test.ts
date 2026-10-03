import { describe, expect, it, vi } from "vitest";
import type { AgentRun, ProviderRuntimeEvent } from "@octant/contracts";
import { createAgentRunInteractions } from "./agentRunInteractions";
import type { NativeHarnessApprovalStore } from "../harness/nativeHarnessApprovals";
import type { NativeHarnessQuestionStore } from "../harness/nativeHarnessQuestions";

const run: AgentRun = {
  id: "11111111-1111-4111-8111-111111111111" as never,
  requestId: "22222222-2222-4222-8222-222222222222" as never,
  parentThreadId: "33333333-3333-4333-8333-333333333333" as never,
  depth: 0,
  role: "implementation",
  task: "Run the focused tests",
  creationPosture: "automatic",
  executionKind: "octant-managed",
  lifecycleStatus: "running",
  authority: {
    filesystem: true,
    shell: true,
    git: true,
    network: false,
    tools: true,
    subagents: false,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
  },
  routingReceipt: {
    executionResolution: {
      providerInstanceId: "55555555-5555-4555-8555-555555555555" as never,
      modelId: "worker-model" as never,
      hostId: "local" as never,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      effectivePermissions: {
        filesystem: true,
        shell: true,
        git: true,
        network: false,
        tools: true,
        subagents: false,
      },
      source: "project-default",
      fallbackChain: ["project-default"],
      downgradeReasons: [],
    },
    selectedExecutionKind: "octant-managed",
    attemptedExecutionKind: "octant-managed",
    selectedProviderInstanceId: "55555555-5555-4555-8555-555555555555" as never,
    selectedModelId: "worker-model" as never,
    fallbackCandidates: [],
    capabilityDegradations: [],
    contextSnapshotId: "66666666-6666-4666-8666-666666666666" as never,
    effectiveAuthorityDigest: "bounded-child",
    usageQuality: "unavailable",
    hostId: "local" as never,
    mode: "code",
  },
  workspaceReceipt: {
    kind: "code-worktree",
    mode: "code",
    projectId: "77777777-7777-4777-8777-777777777777" as never,
    checkoutRoot: "/parent",
    worktreeRoot: "/child",
    verified: true,
  },
  resultAcknowledgement: { required: false, acknowledged: false },
  version: 2 as never,
  createdAt: "2026-10-03T00:00:00.000Z" as never,
  updatedAt: "2026-10-03T00:00:00.000Z" as never,
};
const eventFacts = {
  instanceId: run.routingReceipt.selectedProviderInstanceId,
  sessionId: "99999999-9999-4999-8999-999999999999" as never,
  sequence: 1,
  correlationId: "88888888-8888-4888-8888-888888888888" as never,
  occurredAt: run.createdAt,
};
const event: Extract<ProviderRuntimeEvent, { kind: "approval-request" }> = {
  ...eventFacts,
  kind: "approval-request",
  requestId: "approval-1",
  action: "shell",
  description: "bun run test",
};
const parentLead = () => ({
  hostId: run.routingReceipt.hostId,
  providerInstanceId: run.routingReceipt.selectedProviderInstanceId,
  modelId: run.routingReceipt.selectedModelId,
});

describe("managed child interactions", () => {
  it.each(["provider", "octant"])(
    "refuses a pending %s approval after the parent changes to Plan",
    async (harness) => {
      let parentAuthority = run.authority;
      const ask = vi.fn<NativeHarnessApprovalStore["ask"]>(async () => {
        parentAuthority = { ...run.authority, executionPolicy: "plan", shell: false, git: false };
        return "approved";
      });
      const interactions = createAgentRunInteractions({
        parentLead,
        parentAuthority: () => parentAuthority,
        getById: () => run,
        approvals: { ask },
        questions: { ask: vi.fn() },
      });
      const signal = new AbortController().signal;
      const approve = () =>
        harness === "provider"
          ? interactions.approve({ run, event, signal })
          : interactions.toolsFor(run).approvals?.({
              toolName: "bash",
              summary: "bun run test",
              approvalClass: "shell-commands",
              signal,
            });
      expect(await approve()).toBe(harness === "provider" ? false : "cancelled");
      expect(interactions.isCurrent(run)).toBe(false);
      await approve();
      expect(ask).toHaveBeenCalledOnce();
    },
  );

  it("attributes provider and Octant tool approvals to the same parent without widening the grant", async () => {
    const approval = vi.fn<NativeHarnessApprovalStore["ask"]>(async () => "approved");
    const interactions = createAgentRunInteractions({
      parentLead,
      parentAuthority: () => run.authority,
      getById: () => run,
      approvals: { ask: approval },
      questions: { ask: vi.fn() },
      providerName: () => "Configured provider",
    });
    const signal = new AbortController().signal;
    expect(await interactions.approve({ run, event, signal })).toBe(true);
    expect(
      await interactions.toolsFor(run).approvals?.({
        toolName: "bash",
        summary: "bun run test",
        approvalClass: "shell-commands",
        signal,
      }),
    ).toBe("approved");
    for (const call of approval.mock.calls) {
      expect(call[0]).toMatchObject({
        threadId: run.parentThreadId,
        mode: "code",
        source: {
          runId: run.id,
          providerInstanceId: run.routingReceipt.selectedProviderInstanceId,
          modelId: "worker-model",
        },
        signal,
      });
    }
    expect(approval).toHaveBeenCalledTimes(2);
  });

  it("refuses Plan prompts and does not deliver a decision after cancellation or an authority change", async () => {
    let live: AgentRun | undefined = run;
    const controller = new AbortController();
    const approval = vi.fn(async () => {
      live = { ...run, lifecycleStatus: "cancelled" };
      return "approved" as const;
    });
    const interactions = createAgentRunInteractions({
      parentLead,
      parentAuthority: () => run.authority,
      getById: () => live,
      approvals: { ask: approval },
      questions: { ask: vi.fn() },
    });
    expect(await interactions.approve({ run, event, signal: controller.signal })).toBe(false);
    expect(approval).toHaveBeenCalledTimes(1);
    live = { ...run, authority: { ...run.authority, executionPolicy: "plan" } };
    expect(await interactions.approve({ run: live, event, signal: controller.signal })).toBe(false);
    expect(await interactions.approve({ run, event, signal: controller.signal })).toBe(false);
    controller.abort();
    live = run;
    expect(await interactions.approve({ run, event, signal: controller.signal })).toBe(false);
    expect(approval).toHaveBeenCalledTimes(1);
  });

  it("forwards a child's question and drops an answer when that child no longer runs", async () => {
    let live: AgentRun | undefined = run;
    const question = vi.fn<NativeHarnessQuestionStore["ask"]>(async () => ({
      status: "answered",
      answer: "SQLite",
      questionId: "77777777-7777-4777-8777-777777777778" as never,
    }));
    const interactions = createAgentRunInteractions({
      parentLead,
      parentAuthority: () => run.authority,
      getById: () => live,
      approvals: { ask: vi.fn() },
      questions: { ask: question },
    });
    const input = {
      run,
      signal: new AbortController().signal,
      event: {
        ...eventFacts,
        kind: "user-input-request",
        requestId: "question-1",
        prompt: "Which database?",
        options: [{ label: "SQLite" }],
      } satisfies Extract<ProviderRuntimeEvent, { kind: "user-input-request" }>,
    };
    expect(await interactions.askUser(input)).toBe("SQLite");
    expect(question).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: run.parentThreadId,
        prompt: "Which database?",
        options: ["SQLite"],
      }),
    );
    question.mockImplementationOnce(async () => {
      live = undefined;
      return {
        status: "answered",
        answer: "SQLite",
        questionId: "77777777-7777-4777-8777-777777777778" as never,
      };
    });
    expect(await interactions.askUser(input)).toBeUndefined();
  });
});

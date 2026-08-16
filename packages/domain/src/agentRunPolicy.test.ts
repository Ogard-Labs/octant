import { describe, expect, it } from "vitest";
import { MAX_AGENT_RUN_RESULT_CHARACTERS } from "@octant/contracts";
import type {
  AgentRun,
  AgentRunAuthority,
  AgentRunPoolRoute,
  AgentRunRoutingReceipt,
} from "@octant/contracts";
import {
  AGENT_RUN_MAX_ACTIVE_GLOBAL,
  AGENT_RUN_MAX_ACTIVE_PER_PARENT,
  AGENT_RUN_POOL_WAITING_REASON,
  AgentRunPolicyRejected,
  acknowledgeAgentRunResult,
  agentRunPoolRouteWaitingReason,
  agentRunResultReference,
  applyAgentRunLifecycleTransition,
  assertAgentRunCapacityAvailable,
  assertCreationPostureAllowsAdmission,
  assertAgentRunSandboxEqualOrNarrower,
  clampAgentRunAuthority,
  clampAgentRunAuthorityAgainstLiveGrant,
  createAgentRunFromRequest,
  effectiveAgentRunExecutionTarget,
  validateAgentRunPoolRoute,
  validateFallbackSelection,
} from "./agentRunPolicy";

const now = "2026-08-01T10:00:00.000Z" as const;

const parentAuthority: AgentRunAuthority = {
  filesystem: true,
  shell: true,
  git: true,
  network: true,
  tools: true,
  subagents: true,
  executionPolicy: "approval-gated",
  permissionPersistence: "project-default",
};

const requestedAuthority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: true,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

const routingReceipt: AgentRunRoutingReceipt = {
  executionResolution: {
    providerInstanceId: "44444444-4444-4444-8444-444444444444" as never,
    modelId: "gpt-4o" as never,
    hostId: "local" as never,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
    effectivePermissions: {
      filesystem: false,
      shell: false,
      git: false,
      network: true,
      tools: true,
      subagents: false,
    },
    source: "project-default",
    fallbackChain: ["project-default"],
    downgradeReasons: [],
  },
  selectedExecutionKind: "octant-managed",
  attemptedExecutionKind: "provider-native",
  selectedProviderInstanceId: "44444444-4444-4444-8444-444444444444" as never,
  selectedModelId: "gpt-4o" as never,
  fallbackCandidates: [],
  capabilityDegradations: [],
  contextSnapshotId: "55555555-5555-4555-8555-555555555555" as never,
  effectiveAuthorityDigest: "digest-1",
  usageQuality: "provider-reported",
  hostId: "local" as never,
  mode: "chat",
};

function baseRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "11111111-1111-4111-8111-111111111111" as never,
    requestId: "22222222-2222-4222-8222-222222222222" as never,
    parentThreadId: "33333333-3333-4333-8333-333333333333" as never,
    depth: 0,
    role: "research",
    task: "Summarize the design.",
    creationPosture: "automatic",
    executionKind: "octant-managed",
    lifecycleStatus: "queued",
    authority: requestedAuthority,
    routingReceipt,
    workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 1 as never,
    createdAt: now as never,
    updatedAt: now as never,
    ...overrides,
  };
}

const completedResult = {
  reference: agentRunResultReference(baseRun().id),
  truncated: false,
} as const;
// The reply text is stored beside the run, never on it, so a completion is
// validated against both and the run keeps only the identity.
const completedResultText = "The design summary is ready.";

const requestedCandidate = {
  hostId: "local",
  providerInstanceId: "44444444-4444-4444-8444-444444444444",
  modelId: "gpt-4o",
} as never as {
  hostId: never;
  providerInstanceId: never;
  modelId: never;
};
const fallbackCandidate = {
  hostId: "local",
  providerInstanceId: "77777777-7777-4777-8777-777777777777",
  modelId: "claude-x",
} as never as typeof requestedCandidate;
const pool = {
  candidates: [requestedCandidate, fallbackCandidate],
  mixedVendorEnabled: true,
  fallbackAllowed: true,
  higherCostFallbackAllowed: false,
};

function poolRoute(
  decision: "requested" | "fallback" | "waiting",
): NonNullable<AgentRunRoutingReceipt["poolRoute"]> {
  const shared = {
    request: { pool, requestedCandidate, requiredCapabilities: [] },
    mode: "chat",
    activeHostId: "local",
    parentCandidate: requestedCandidate,
  };
  if (decision === "waiting") {
    return {
      decision: {
        kind: "waiting",
        ...shared,
        eligibility: [
          { candidate: requestedCandidate, eligible: false, reasons: ["model-unavailable"] },
          { candidate: fallbackCandidate, eligible: false, reasons: ["provider-not-ready"] },
        ],
        reason: "no-eligible-candidate",
        message: "No selected model is currently eligible.",
      },
      decidedAt: now,
    } as never as AgentRunPoolRoute;
  }
  return {
    decision: {
      kind: "selected",
      ...shared,
      eligibility:
        decision === "requested"
          ? [
              { candidate: requestedCandidate, eligible: true, reasons: [] },
              { candidate: fallbackCandidate, eligible: true, reasons: [] },
            ]
          : [
              { candidate: requestedCandidate, eligible: false, reasons: ["model-unavailable"] },
              { candidate: fallbackCandidate, eligible: true, reasons: [] },
            ],
      selectedCandidate: decision === "requested" ? requestedCandidate : fallbackCandidate,
      selectionKind: decision,
      reason:
        decision === "requested"
          ? "The requested model is selected and eligible for this execution unit."
          : "The requested model is unavailable; an explicitly permitted pool fallback was selected.",
    },
    decidedAt: now,
  } as never as AgentRunPoolRoute;
}

const recordedFallback = {
  providerInstanceId: fallbackCandidate.providerInstanceId,
  modelId: fallbackCandidate.modelId,
  reason: "The requested model is unavailable; an explicitly permitted pool fallback was selected.",
};

describe("agentRunPolicy", () => {
  it("rejects Off posture and unconfirmed Ask posture", () => {
    expect(() => assertCreationPostureAllowsAdmission("off", { confirmed: true })).toThrow(
      AgentRunPolicyRejected,
    );
    expect(() => assertCreationPostureAllowsAdmission("ask", { confirmed: false })).toThrow(
      AgentRunPolicyRejected,
    );
    expect(() => assertCreationPostureAllowsAdmission("ask", { confirmed: true })).not.toThrow();
    expect(() =>
      assertCreationPostureAllowsAdmission("automatic", { confirmed: false }),
    ).not.toThrow();
  });

  it("clamps authority and rejects widening beyond parent ceilings", () => {
    const clamped = clampAgentRunAuthority({
      parentAuthority,
      requestedAuthority,
    });
    expect(clamped.filesystem).toBe(false);
    expect(clamped.executionPolicy).toBe("plan");

    expect(() =>
      clampAgentRunAuthority({
        parentAuthority: { ...parentAuthority, shell: false, executionPolicy: "plan" },
        requestedAuthority: { ...requestedAuthority, shell: true, executionPolicy: "full-access" },
      }),
    ).toThrow(/shell|execution policy/i);
  });

  it("clamps against the live parent grant, not only the mode ceiling", () => {
    const modeCeiling = parentAuthority;
    const liveParentGrant: AgentRunAuthority = {
      ...parentAuthority,
      network: false,
      shell: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    };

    expect(() =>
      clampAgentRunAuthority({
        parentAuthority: modeCeiling,
        liveParentGrant,
        requestedAuthority: {
          ...requestedAuthority,
          network: true,
          executionPolicy: "plan",
        },
      }),
    ).toThrow(/network|authority-widening/i);

    const clamped = clampAgentRunAuthority({
      parentAuthority: modeCeiling,
      liveParentGrant,
      requestedAuthority: {
        ...requestedAuthority,
        network: false,
        tools: true,
        executionPolicy: "plan",
      },
    });
    expect(clamped.network).toBe(false);
    expect(clamped.shell).toBe(false);
    expect(clamped.executionPolicy).toBe("plan");
  });

  it("rejects a live parent grant that claims wider authority than the mode ceiling", () => {
    expect(() =>
      clampAgentRunAuthorityAgainstLiveGrant({
        modeCeiling: {
          ...parentAuthority,
          shell: false,
          executionPolicy: "plan",
        },
        liveParentGrant: {
          ...parentAuthority,
          shell: true,
          executionPolicy: "approval-gated",
        },
        requestedAuthority: {
          ...requestedAuthority,
          shell: false,
          executionPolicy: "plan",
        },
      }),
    ).toThrow(/live parent grant|mode ceiling|shell|execution/i);
  });

  it("admits a Code child only with a verified isolated worktree sandbox", () => {
    const codeRouting: AgentRunRoutingReceipt = { ...routingReceipt, mode: "code" };
    const verifiedWorktree = {
      kind: "code-worktree" as const,
      mode: "code" as const,
      projectId: "77777777-7777-4777-8777-777777777777" as never,
      checkoutRoot: "/repo",
      worktreeRoot: "/repo/.octant/worktrees/child-a",
      verified: true,
    };

    expect(() =>
      assertAgentRunSandboxEqualOrNarrower({
        childWorkspace: { ...verifiedWorktree, verified: false },
      }),
    ).toThrow(/verified/i);

    expect(() =>
      assertAgentRunSandboxEqualOrNarrower({
        childWorkspace: {
          ...verifiedWorktree,
          worktreeRoot: "/repo",
        },
      }),
    ).toThrow(/parent checkout|isolated|narrower/i);

    expect(() =>
      assertAgentRunSandboxEqualOrNarrower({ childWorkspace: verifiedWorktree }),
    ).not.toThrow();

    expect(() =>
      createAgentRunFromRequest({
        runId: "11111111-1111-4111-8111-111111111111" as never,
        command: {
          kind: "request-agent-run",
          requestId: "22222222-2222-4222-8222-222222222222" as never,
          parentThreadId: "33333333-3333-4333-8333-333333333333" as never,
          role: "implementation",
          task: "Implement the clamp helper.",
          creationPosture: "automatic",
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
          routingReceipt: codeRouting,
          workspaceReceipt: { ...verifiedWorktree, verified: false },
        },
        parentAuthority: {
          ...parentAuthority,
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
        },
        liveParentGrant: {
          ...parentAuthority,
          network: false,
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
        },
        activeGlobal: 0,
        activeForParent: 0,
        confirmed: true,
        now: now as never,
      }),
    ).toThrow(/verified|invalid-workspace/i);
  });

  it("keeps mixed-vendor pool fallbacks inside the live grant clamp", () => {
    const liveParentGrant: AgentRunAuthority = {
      ...parentAuthority,
      shell: false,
      network: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    };
    const mixedVendorReceipt: AgentRunRoutingReceipt = {
      ...routingReceipt,
      selectedFallback: {
        providerInstanceId: "77777777-7777-4777-8777-777777777777" as never,
        modelId: "claude-x" as never,
        reason: "requested vendor unavailable",
      },
      poolRoute: poolRoute("fallback"),
    };

    expect(() =>
      createAgentRunFromRequest({
        runId: "11111111-1111-4111-8111-111111111111" as never,
        command: {
          kind: "request-agent-run",
          requestId: "22222222-2222-4222-8222-222222222222" as never,
          parentThreadId: "33333333-3333-4333-8333-333333333333" as never,
          role: "research",
          task: "Summarize with a fallback vendor.",
          creationPosture: "automatic",
          requestedAuthority: {
            ...requestedAuthority,
            network: true,
            shell: true,
            executionPolicy: "approval-gated",
          },
          routingReceipt: mixedVendorReceipt,
          workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
        },
        parentAuthority,
        liveParentGrant,
        activeGlobal: 0,
        activeForParent: 0,
        confirmed: true,
        now: now as never,
      }),
    ).toThrow(/shell|network|execution policy|authority-widening/i);
  });

  it("enforces global and per-parent active capacity limits", () => {
    expect(() =>
      assertAgentRunCapacityAvailable({
        activeGlobal: AGENT_RUN_MAX_ACTIVE_GLOBAL,
        activeForParent: 0,
      }),
    ).toThrow(/Global active/);
    expect(() =>
      assertAgentRunCapacityAvailable({
        activeGlobal: 0,
        activeForParent: AGENT_RUN_MAX_ACTIVE_PER_PARENT,
      }),
    ).toThrow(/Per-parent active/);
  });

  it("rejects fallback selections that are identical or unreasoned", () => {
    expect(() =>
      validateFallbackSelection({
        ...routingReceipt,
        selectedFallback: {
          providerInstanceId: routingReceipt.selectedProviderInstanceId,
          modelId: routingReceipt.selectedModelId,
          reason: "same",
        },
      }),
    ).toThrow(AgentRunPolicyRejected);

    expect(() =>
      validateFallbackSelection({
        ...routingReceipt,
        selectedFallback: {
          providerInstanceId: "77777777-7777-4777-8777-777777777777" as never,
          modelId: "other-model" as never,
          reason: "   ",
        },
      }),
    ).toThrow(AgentRunPolicyRejected);
  });

  it("applies lifecycle transitions and forbids terminal auto-complete from queued", () => {
    const started = applyAgentRunLifecycleTransition(baseRun(), "starting", now as never, {
      expectedVersion: 1 as never,
    });
    expect(started.lifecycleStatus).toBe("starting");
    expect(started.version).toBe(2);

    const running = applyAgentRunLifecycleTransition(started, "running", now as never, {
      expectedVersion: 2 as never,
    });
    expect(running.lifecycleStatus).toBe("running");

    expect(() =>
      applyAgentRunLifecycleTransition(baseRun(), "completed", now as never, {
        expectedVersion: 1 as never,
        result: completedResult,
        resultText: completedResultText,
      }),
    ).toThrow(AgentRunPolicyRejected);

    const completed = applyAgentRunLifecycleTransition(running, "completed", now as never, {
      expectedVersion: 3 as never,
      result: completedResult,
      resultText: completedResultText,
    });
    expect(completed.resultAcknowledgement.required).toBe(true);
    expect(completed.resultAcknowledgement.acknowledged).toBe(false);
    expect(completed.result).toEqual(completedResult);
  });

  it("refuses a completion whose result is missing, oversized, or references another run", () => {
    const running = applyAgentRunLifecycleTransition(
      applyAgentRunLifecycleTransition(baseRun(), "starting", now as never, {
        expectedVersion: 1 as never,
      }),
      "running",
      now as never,
      { expectedVersion: 2 as never },
    );

    expect(() =>
      applyAgentRunLifecycleTransition(running, "completed", now as never, {
        expectedVersion: 3 as never,
      }),
    ).toThrow(/reply the child produced/);

    // A result identity without the reply it stands for is refused just as a
    // missing one is: Completed still requires the reply the child produced.
    expect(() =>
      applyAgentRunLifecycleTransition(running, "completed", now as never, {
        expectedVersion: 3 as never,
        result: completedResult,
      }),
    ).toThrow(/reply the child produced/);

    expect(() =>
      applyAgentRunLifecycleTransition(running, "completed", now as never, {
        expectedVersion: 3 as never,
        result: completedResult,
        resultText: "x".repeat(MAX_AGENT_RUN_RESULT_CHARACTERS + 1),
      }),
    ).toThrow(/bounded result reply/);

    expect(() =>
      applyAgentRunLifecycleTransition(running, "completed", now as never, {
        expectedVersion: 3 as never,
        result: {
          ...completedResult,
          reference: agentRunResultReference("99999999-9999-4999-8999-999999999999" as never),
        },
        resultText: completedResultText,
      }),
    ).toThrow(/result reference of this run/);
  });

  it("requires acknowledgement only after completion and fails closed on replay", () => {
    const completed = applyAgentRunLifecycleTransition(
      applyAgentRunLifecycleTransition(
        applyAgentRunLifecycleTransition(baseRun(), "starting", now as never, {
          expectedVersion: 1 as never,
        }),
        "running",
        now as never,
        { expectedVersion: 2 as never },
      ),
      "completed",
      now as never,
      { expectedVersion: 3 as never, result: completedResult, resultText: completedResultText },
    );
    const acknowledged = acknowledgeAgentRunResult(completed, now as never, 4 as never);
    expect(acknowledged.resultAcknowledgement.acknowledged).toBe(true);
    expect(() => acknowledgeAgentRunResult(acknowledged, now as never, 5 as never)).toThrow(
      /already acknowledged/,
    );
  });

  it("creates a queued run from a valid request and rejects Off posture requests", () => {
    const run = createAgentRunFromRequest({
      runId: "11111111-1111-4111-8111-111111111111" as never,
      command: {
        kind: "request-agent-run",
        requestId: "22222222-2222-4222-8222-222222222222" as never,
        parentThreadId: "33333333-3333-4333-8333-333333333333" as never,
        role: "research",
        task: "Summarize the design.",
        creationPosture: "automatic",
        requestedAuthority,
        routingReceipt,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      },
      parentAuthority,
      activeGlobal: 0,
      activeForParent: 0,
      confirmed: true,
      now: now as never,
    });
    expect(run.lifecycleStatus).toBe("queued");
    expect(run.authority.network).toBe(true);

    expect(() =>
      createAgentRunFromRequest({
        runId: "11111111-1111-4111-8111-111111111111" as never,
        command: {
          kind: "request-agent-run",
          requestId: "22222222-2222-4222-8222-222222222222" as never,
          parentThreadId: "33333333-3333-4333-8333-333333333333" as never,
          role: "research",
          task: "Summarize the design.",
          creationPosture: "off",
          requestedAuthority,
          routingReceipt,
          workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
        },
        parentAuthority,
        activeGlobal: 0,
        activeForParent: 0,
        confirmed: true,
        now: now as never,
      }),
    ).toThrow(/Off/);
  });
});

describe("agentRun pool routing policy", () => {
  it("resolves the effective execution target through the recorded explicit fallback", () => {
    expect(effectiveAgentRunExecutionTarget(routingReceipt)).toEqual({
      providerInstanceId: routingReceipt.selectedProviderInstanceId,
      modelId: routingReceipt.selectedModelId,
    });
    expect(
      effectiveAgentRunExecutionTarget({
        ...routingReceipt,
        selectedFallback: recordedFallback,
        poolRoute: poolRoute("fallback"),
      }),
    ).toEqual({
      providerInstanceId: fallbackCandidate.providerInstanceId,
      modelId: fallbackCandidate.modelId,
    });
  });

  it("reports a waiting recovery reason only for waiting pool routes", () => {
    expect(agentRunPoolRouteWaitingReason(routingReceipt)).toBeUndefined();
    expect(
      agentRunPoolRouteWaitingReason({ ...routingReceipt, poolRoute: poolRoute("requested") }),
    ).toBeUndefined();
    expect(
      agentRunPoolRouteWaitingReason({ ...routingReceipt, poolRoute: poolRoute("waiting") }),
    ).toBe(AGENT_RUN_POOL_WAITING_REASON);
  });

  it("accepts consistent pool routes for requested, fallback, and waiting decisions", () => {
    expect(() =>
      validateAgentRunPoolRoute({ ...routingReceipt, poolRoute: poolRoute("requested") }),
    ).not.toThrow();
    expect(() =>
      validateAgentRunPoolRoute({
        ...routingReceipt,
        selectedFallback: recordedFallback,
        poolRoute: poolRoute("fallback"),
      }),
    ).not.toThrow();
    expect(() =>
      validateAgentRunPoolRoute({ ...routingReceipt, poolRoute: poolRoute("waiting") }),
    ).not.toThrow();
    expect(() => validateAgentRunPoolRoute(routingReceipt)).not.toThrow();
  });

  it("rejects pool routes re-scoped to another mode, host, or primary selection", () => {
    const requested = poolRoute("requested");
    expect(() =>
      validateAgentRunPoolRoute({
        ...routingReceipt,
        poolRoute: {
          ...requested,
          decision: { ...requested.decision, mode: "work" },
        } as never,
      }),
    ).toThrow(AgentRunPolicyRejected);
    expect(() =>
      validateAgentRunPoolRoute({
        ...routingReceipt,
        poolRoute: {
          ...requested,
          decision: { ...requested.decision, activeHostId: "other-host" },
        } as never,
      }),
    ).toThrow(AgentRunPolicyRejected);
    expect(() =>
      validateAgentRunPoolRoute({
        ...routingReceipt,
        selectedModelId: "some-other-model" as never,
        poolRoute: requested,
      }),
    ).toThrow(AgentRunPolicyRejected);
  });

  it("rejects a pool fallback route that does not surface its explicit fallback", () => {
    expect(() =>
      validateAgentRunPoolRoute({ ...routingReceipt, poolRoute: poolRoute("fallback") }),
    ).toThrow(AgentRunPolicyRejected);
    expect(() =>
      validateAgentRunPoolRoute({
        ...routingReceipt,
        selectedFallback: { ...recordedFallback, modelId: "a-different-model" as never },
        poolRoute: poolRoute("fallback"),
      }),
    ).toThrow(AgentRunPolicyRejected);
  });

  it("rejects requested and waiting pool routes that also record a fallback", () => {
    expect(() =>
      validateAgentRunPoolRoute({
        ...routingReceipt,
        selectedFallback: recordedFallback,
        poolRoute: poolRoute("requested"),
      }),
    ).toThrow(AgentRunPolicyRejected);
    expect(() =>
      validateAgentRunPoolRoute({
        ...routingReceipt,
        selectedFallback: recordedFallback,
        poolRoute: poolRoute("waiting"),
      }),
    ).toThrow(AgentRunPolicyRejected);
  });

  it("admits a pool-routed request and rejects an inconsistent pool route at admission", () => {
    const command = (receipt: AgentRunRoutingReceipt) =>
      ({
        kind: "request-agent-run",
        requestId: "22222222-2222-4222-8222-222222222222",
        parentThreadId: "33333333-3333-4333-8333-333333333333",
        role: "research",
        task: "Summarize the design.",
        creationPosture: "automatic",
        requestedAuthority,
        routingReceipt: receipt,
        workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      }) as never;
    const admitted = createAgentRunFromRequest({
      runId: "11111111-1111-4111-8111-111111111111" as never,
      command: command({ ...routingReceipt, poolRoute: poolRoute("requested") }),
      parentAuthority,
      activeGlobal: 0,
      activeForParent: 0,
      confirmed: true,
      now: now as never,
    });
    expect(admitted.lifecycleStatus).toBe("queued");
    expect(admitted.routingReceipt.poolRoute?.decision.kind).toBe("selected");

    expect(() =>
      createAgentRunFromRequest({
        runId: "11111111-1111-4111-8111-111111111111" as never,
        command: command({ ...routingReceipt, poolRoute: poolRoute("fallback") }),
        parentAuthority,
        activeGlobal: 0,
        activeForParent: 0,
        confirmed: true,
        now: now as never,
      }),
    ).toThrow(AgentRunPolicyRejected);
  });
});

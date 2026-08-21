import { describe, expect, it } from "vitest";
import { decodeAgentRunCreationRequest, type AgentRunCreationRequest } from "@octant/contracts";
import type {
  MultiModelPool,
  MultiModelPoolCandidate,
  MultiModelRoutingVendorId,
} from "@octant/contracts/multi-model-pool";
import type { MultiModelCandidateRuntimeFacts } from "@octant/domain/multi-model-pool-policy";
import { AgentRunCreationRejected, buildAgentRunRequestCommand } from "./agentRunCreationService";

const ids = {
  request: "22222222-2222-4222-8222-222222222222",
  thread: "33333333-3333-4333-8333-333333333333",
  provider: "44444444-4444-4444-8444-444444444444",
  providerB: "77777777-7777-4777-8777-777777777777",
};

function baseRequest(overrides: Partial<AgentRunCreationRequest> = {}): AgentRunCreationRequest {
  return decodeAgentRunCreationRequest({
    requestId: ids.request,
    parentThreadId: ids.thread,
    role: "research",
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
    ...overrides,
  });
}

const readyPort = { isReady: () => true };
const notReadyPort = { isReady: () => false };
let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `bbbbbbbb-bbbb-4bbb-8bbb-${uuidCounter.toString(16).padStart(12, "0")}`;
}

describe("buildAgentRunRequestCommand", () => {
  it("builds a request-agent-run command with an explicit one-off routing receipt", () => {
    const command = buildAgentRunRequestCommand({
      request: baseRequest(),
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
    });
    expect(command.kind).toBe("request-agent-run");
    expect(command.routingReceipt.selectedProviderInstanceId).toBe(ids.provider);
    expect(command.routingReceipt.selectedModelId).toBe("gpt-4o");
    expect(command.routingReceipt.executionResolution.source).toBe("one-off-override");
    expect(command.routingReceipt.usageQuality).toBe("unavailable");
    // execution kind always falls back to the portable managed baseline:
    // provider-native child eligibility is not yet wired into creation.
    expect(command.routingReceipt.selectedExecutionKind).toBe("octant-managed");
  });

  it("journals the parent selection a child was admitted with under its snapshot id", () => {
    const asked: Array<{ parentThreadId: string; mode: string }> = [];
    const command = buildAgentRunRequestCommand({
      request: baseRequest({ includeParentContext: true } as never),
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
      parentContext: {
        resolve: (input) => {
          asked.push({ parentThreadId: String(input.parentThreadId), mode: input.mode });
          return [
            { kind: "user-message", text: "Which service paged first?" },
            { kind: "assistant-message", text: "The ingest worker paged at 02:14." },
          ];
        },
      },
    });

    expect(asked).toEqual([{ parentThreadId: ids.thread, mode: "chat" }]);
    // The selection travels beside the receipt so admission can store it; the
    // receipt itself carries only the id it is stored under and how many blocks
    // it holds, because the receipt is journaled and the blocks are the parent
    // thread's own conversation.
    expect(command.admittedContext).toEqual([
      { kind: "user-message", text: "Which service paged first?" },
      { kind: "assistant-message", text: "The ingest worker paged at 02:14." },
    ]);
    expect(command.routingReceipt.admittedContextBlocks).toBe(2);
    // The selection and the id it is recorded under always travel together.
    expect(command.routingReceipt.contextSnapshotId).toBeDefined();
  });

  it("records nothing when the parent selected no context", () => {
    const command = buildAgentRunRequestCommand({
      request: baseRequest(),
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
      parentContext: { resolve: () => [{ kind: "user-message", text: "Never admitted." }] },
    });

    expect(command.admittedContext).toBeUndefined();
    expect(command.routingReceipt.admittedContextBlocks).toBeUndefined();
  });

  it("refuses a child that asked for parent context this host cannot resolve", () => {
    for (const parentContext of [undefined, { resolve: () => undefined }]) {
      expect(() =>
        buildAgentRunRequestCommand({
          request: baseRequest({ includeParentContext: true } as never),
          creationPosture: "automatic",
          providerReadiness: readyPort,
          uuid,
          ...(parentContext === undefined ? {} : { parentContext }),
        }),
      ).toThrowError(AgentRunCreationRejected);
    }
  });

  it("always uses the server-resolved posture, never one from the client", () => {
    const command = buildAgentRunRequestCommand({
      request: baseRequest(),
      creationPosture: "off",
      providerReadiness: readyPort,
      uuid,
    });
    expect(command.creationPosture).toBe("off");
  });

  it("admits a Work child from a server-resolved Project binding receipt", () => {
    const workRequest = decodeAgentRunCreationRequest({
      ...baseRequest(),
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
        receiptId: "66666666-6666-4666-8666-666666666666",
      },
    });
    const command = buildAgentRunRequestCommand({
      request: workRequest,
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
      admittedWorkspace: {
        kind: "work-root",
        mode: "work",
        projectId: "55555555-5555-4555-8555-555555555555" as never,
        bindingRevisionId: "88888888-8888-4888-8888-888888888888" as never,
        canonicalRoot: "/projects/demo",
      },
    });
    expect(command.workspaceReceipt).toEqual({
      kind: "work-root",
      mode: "work",
      projectId: "55555555-5555-4555-8555-555555555555",
      bindingRevisionId: "88888888-8888-4888-8888-888888888888",
      canonicalRoot: "/projects/demo",
    });
  });

  it("rejects a Work child that claims an absolute root instead of a receipt", () => {
    expect(() =>
      decodeAgentRunCreationRequest({
        ...baseRequest(),
        mode: "work",
        workspace: {
          kind: "work-root",
          mode: "work",
          projectId: "55555555-5555-4555-8555-555555555555",
          canonicalRoot: "/projects/demo",
        },
      }),
    ).toThrow();
  });

  it("rejects Code-mode requests that lack a verified worktree receipt port", () => {
    const codeRequest = decodeAgentRunCreationRequest({
      ...baseRequest(),
      mode: "code",
      role: "implementation",
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
        worktreeReceiptId: "66666666-6666-4666-8666-666666666666",
      },
    });
    expect(() =>
      buildAgentRunRequestCommand({
        request: codeRequest,
        creationPosture: "automatic",
        providerReadiness: readyPort,
        uuid,
      }),
    ).toThrow(/worktree/i);
  });

  it("admits a Code child when the managed worktree receipt verifies isolation", () => {
    const codeRequest = decodeAgentRunCreationRequest({
      ...baseRequest(),
      mode: "code",
      role: "implementation",
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
        worktreeReceiptId: "66666666-6666-4666-8666-666666666666",
      },
    });
    const command = buildAgentRunRequestCommand({
      request: codeRequest,
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
      worktreeReceipts: {
        resolveVerifiedIsolation: () => ({
          projectId: "77777777-7777-4777-8777-777777777777",
          checkoutRoot: "/repo",
          worktreeRoot: "/repo/.octant/worktrees/child-a",
        }),
      },
    });
    expect(command.workspaceReceipt).toEqual({
      kind: "code-worktree",
      mode: "code",
      projectId: "77777777-7777-4777-8777-777777777777",
      checkoutRoot: "/repo",
      worktreeRoot: "/repo/.octant/worktrees/child-a",
      verified: true,
    });
    expect(command.routingReceipt.mode).toBe("code");
  });

  it("refuses a Code child when the worktree receipt cannot be verified", () => {
    const codeRequest = decodeAgentRunCreationRequest({
      ...baseRequest(),
      mode: "code",
      role: "implementation",
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
        kind: "code-worktree",
        mode: "code",
        worktreeReceiptId: "66666666-6666-4666-8666-666666666666",
      },
    });
    expect(() =>
      buildAgentRunRequestCommand({
        request: codeRequest,
        creationPosture: "automatic",
        providerReadiness: readyPort,
        uuid,
        worktreeReceipts: {
          resolveVerifiedIsolation: () => undefined,
        },
      }),
    ).toThrow(/verified isolated worktree/i);
  });

  it("refuses a Code child whose resolved sandbox is the parent checkout", () => {
    const codeRequest = decodeAgentRunCreationRequest({
      ...baseRequest(),
      mode: "code",
      role: "implementation",
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
        kind: "code-worktree",
        mode: "code",
        worktreeReceiptId: "66666666-6666-4666-8666-666666666666",
      },
    });
    expect(() =>
      buildAgentRunRequestCommand({
        request: codeRequest,
        creationPosture: "automatic",
        providerReadiness: readyPort,
        uuid,
        worktreeReceipts: {
          resolveVerifiedIsolation: () => ({
            projectId: "77777777-7777-4777-8777-777777777777",
            checkoutRoot: "/repo",
            worktreeRoot: "/repo",
          }),
        },
      }),
    ).toThrow(/equal-or-narrower|isolated worktree/i);
  });

  it("rejects non-research roles for a Chat child", () => {
    expect(() =>
      buildAgentRunRequestCommand({
        request: baseRequest({ role: "implementation" }),
        creationPosture: "automatic",
        providerReadiness: readyPort,
        uuid,
      }),
    ).toThrow(/research role/i);
  });

  it("rejects a provider/model that is not configured and ready", () => {
    expect(() =>
      buildAgentRunRequestCommand({
        request: baseRequest(),
        creationPosture: "automatic",
        providerReadiness: notReadyPort,
        uuid,
      }),
    ).toThrow(AgentRunCreationRejected);
  });

  it("computes a real digest of the requested authority, not a placeholder", () => {
    const a = buildAgentRunRequestCommand({
      request: baseRequest(),
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
    });
    const b = buildAgentRunRequestCommand({
      request: baseRequest({
        requestedAuthority: {
          filesystem: true,
          shell: false,
          git: false,
          network: true,
          tools: true,
          subagents: false,
          executionPolicy: "plan",
          permissionPersistence: "current-session",
        },
      }),
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
    });
    expect(a.routingReceipt.effectiveAuthorityDigest).not.toBe(
      b.routingReceipt.effectiveAuthorityDigest,
    );
  });

  it("retains raw reasoning while normalizing an unsupported provider label to unknown", () => {
    const command = buildAgentRunRequestCommand({
      request: baseRequest({ reasoning: "xhigh" }),
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
    });

    expect(command.routingReceipt.rawReasoning).toBe("xhigh");
    expect(command.routingReceipt.normalizedReasoning).toBe("unknown");
  });
});

const requestedCandidate = {
  hostId: "local",
  providerInstanceId: ids.provider,
  modelId: "gpt-4o",
} as unknown as MultiModelPoolCandidate;
const fallbackCandidate = {
  hostId: "local",
  providerInstanceId: ids.providerB,
  modelId: "claude-x",
} as unknown as MultiModelPoolCandidate;

function pool(overrides: Partial<MultiModelPool> = {}): MultiModelPool {
  return {
    candidates: [requestedCandidate, fallbackCandidate],
    mixedVendorEnabled: true,
    fallbackAllowed: true,
    higherCostFallbackAllowed: false,
    ...overrides,
  } as MultiModelPool;
}

function facts(
  candidate: MultiModelPoolCandidate,
  overrides: Partial<MultiModelCandidateRuntimeFacts> = {},
): MultiModelCandidateRuntimeFacts {
  return {
    candidate,
    routingVendorId: "openai" as MultiModelRoutingVendorId,
    configured: true,
    readiness: "ready",
    modelAvailable: true,
    compatibleModes: ["chat"],
    projectAllowed: true,
    profileAllowed: true,
    supportedCapabilities: [],
    authorityAllowed: true,
    ...overrides,
  };
}

const decidedAt = "2026-08-11T09:00:00.000Z";

function poolRouting(
  runtimeFacts: ReadonlyArray<MultiModelCandidateRuntimeFacts> = [
    facts(requestedCandidate),
    facts(fallbackCandidate),
  ],
) {
  return {
    parentCandidate: requestedCandidate,
    runtimeFacts,
  };
}

describe("buildAgentRunRequestCommand with a multi-model pool", () => {
  it("embeds exactly one immutable pool-derived route for the requested candidate", () => {
    const command = buildAgentRunRequestCommand({
      request: baseRequest({ pool: pool() }),
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
      clock: () => decidedAt,
      poolRouting: poolRouting(),
    });

    const poolRoute = command.routingReceipt.poolRoute;
    expect(poolRoute?.decision.kind).toBe("selected");
    if (poolRoute?.decision.kind !== "selected") return;
    expect(poolRoute.decision.selectionKind).toBe("requested");
    expect(poolRoute.decidedAt).toBe(decidedAt);
    expect(command.routingReceipt.selectedProviderInstanceId).toBe(ids.provider);
    expect(command.routingReceipt.selectedModelId).toBe("gpt-4o");
    expect(command.routingReceipt.selectedFallback).toBeUndefined();
  });

  it("selects only an explicitly permitted fallback when the requested candidate is unavailable", () => {
    const command = buildAgentRunRequestCommand({
      request: baseRequest({ pool: pool() }),
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
      clock: () => decidedAt,
      poolRouting: poolRouting([
        facts(requestedCandidate, { modelAvailable: false, costRank: 1 }),
        facts(fallbackCandidate, { costRank: 1 }),
      ]),
    });

    const poolRoute = command.routingReceipt.poolRoute;
    expect(poolRoute?.decision.kind).toBe("selected");
    if (poolRoute?.decision.kind !== "selected") return;
    expect(poolRoute.decision.selectionKind).toBe("fallback");
    // The receipt primary remains the requested candidate; the explicit
    // fallback that will execute is surfaced with its routing reason.
    expect(command.routingReceipt.selectedProviderInstanceId).toBe(ids.provider);
    expect(command.routingReceipt.selectedFallback?.providerInstanceId).toBe(ids.providerB);
    expect(command.routingReceipt.selectedFallback?.modelId).toBe("claude-x");
    expect(command.routingReceipt.selectedFallback?.reason).toBe(poolRoute.decision.reason);
  });

  it("records a waiting pool route with its reason when no candidate is eligible", () => {
    const command = buildAgentRunRequestCommand({
      request: baseRequest({ pool: pool() }),
      creationPosture: "automatic",
      // Readiness gating cannot reject a waiting route: nothing executes.
      providerReadiness: notReadyPort,
      uuid,
      clock: () => decidedAt,
      poolRouting: poolRouting([
        facts(requestedCandidate, { readiness: "unavailable" }),
        facts(fallbackCandidate, { readiness: "unavailable" }),
      ]),
    });

    const poolRoute = command.routingReceipt.poolRoute;
    expect(poolRoute?.decision.kind).toBe("waiting");
    if (poolRoute?.decision.kind !== "waiting") return;
    expect(poolRoute.decision.reason).toBe("no-eligible-candidate");
    expect(poolRoute.decision.message.length).toBeGreaterThan(0);
    expect(command.routingReceipt.selectedFallback).toBeUndefined();
  });

  it("waits instead of selecting a candidate the child may not use (authority clamp)", () => {
    const command = buildAgentRunRequestCommand({
      request: baseRequest({ pool: pool() }),
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
      clock: () => decidedAt,
      poolRouting: poolRouting([
        facts(requestedCandidate, { modelAvailable: false }),
        facts(fallbackCandidate, { authorityAllowed: false }),
      ]),
    });

    const poolRoute = command.routingReceipt.poolRoute;
    expect(poolRoute?.decision.kind).toBe("waiting");
    if (poolRoute?.decision.kind !== "waiting") return;
    const fallbackEligibility = poolRoute.decision.eligibility.find(
      (entry) => String(entry.candidate.providerInstanceId) === ids.providerB,
    );
    expect(fallbackEligibility?.reasons).toContain("authority-incompatible");
  });

  it("waits when the requested candidate is unavailable and fallback is not permitted", () => {
    const command = buildAgentRunRequestCommand({
      request: baseRequest({ pool: pool({ fallbackAllowed: false }) }),
      creationPosture: "automatic",
      providerReadiness: readyPort,
      uuid,
      clock: () => decidedAt,
      poolRouting: poolRouting([
        facts(requestedCandidate, { modelAvailable: false }),
        facts(fallbackCandidate),
      ]),
    });

    const poolRoute = command.routingReceipt.poolRoute;
    expect(poolRoute?.decision.kind).toBe("waiting");
  });

  it("rejects a pool that does not contain the requested provider/model", () => {
    expect(() =>
      buildAgentRunRequestCommand({
        request: baseRequest({
          modelId: "not-in-the-pool" as never,
          pool: pool(),
        }),
        creationPosture: "automatic",
        providerReadiness: readyPort,
        uuid,
        clock: () => decidedAt,
        poolRouting: poolRouting(),
      }),
    ).toThrow(AgentRunCreationRejected);
  });

  it("fails closed when a pool is selected but the server cannot resolve pool routing", () => {
    expect(() =>
      buildAgentRunRequestCommand({
        request: baseRequest({ pool: pool() }),
        creationPosture: "automatic",
        providerReadiness: readyPort,
        uuid,
        clock: () => decidedAt,
      }),
    ).toThrow(AgentRunCreationRejected);
  });
});

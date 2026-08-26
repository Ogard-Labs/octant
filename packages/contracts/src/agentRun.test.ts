import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_EVENT_NAMES,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS,
  MAX_AGENT_RUN_CONVERSATION_ENTRIES,
  decodeAgentRun,
  decodeAgentRunAdmittedContext,
  decodeAgentRunAuthority,
  decodeAgentRunCommand,
  decodeAgentRunCenterQuery,
  decodeAgentRunCenterResponse,
  decodeAgentRunConversationResponse,
  decodeAgentRunLifecycleStatus,
  decodeAgentRunRoutingReceipt,
  decodeAgentRunStatusChanged,
  decodeAgentRunWorkspaceReceipt,
} from "./agentRun";

describe("AgentRunConversationResponse", () => {
  it("accepts a bounded live snapshot and rejects oversized entry lists", () => {
    const response = {
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      parentThreadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      executionKind: "octant-managed",
      modelId: "gpt-5.6-luna",
      lifecycleStatus: "running",
      status: "live",
      entries: [
        {
          sequence: 1,
          kind: "assistant",
          text: "Working",
          occurredAt: "2026-08-23T00:00:00.000Z",
        },
      ],
      truncated: false,
    };
    expect(decodeAgentRunConversationResponse(response).status).toBe("live");
    expect(() =>
      decodeAgentRunConversationResponse({
        ...response,
        entries: Array.from({ length: MAX_AGENT_RUN_CONVERSATION_ENTRIES + 1 }, (_, index) => ({
          sequence: index + 1,
          kind: "status",
          text: "x",
          occurredAt: "2026-08-23T00:00:00.000Z",
        })),
      }),
    ).toThrow();
  });

  it("accepts unavailable and stale snapshots with explicit reasons", () => {
    const base = {
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      parentThreadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      executionKind: "provider-native",
      modelId: "gpt-5.6-luna",
      lifecycleStatus: "running",
      entries: [],
      truncated: false,
    };
    expect(
      decodeAgentRunConversationResponse({
        ...base,
        status: "unavailable",
        staleReason: "Provider-native child transcript is not available through this host.",
      }).status,
    ).toBe("unavailable");
    expect(
      decodeAgentRunConversationResponse({
        ...base,
        executionKind: "octant-managed",
        status: "stale",
        staleReason: "The child session is no longer connected to this host.",
      }).status,
    ).toBe("stale");
  });
});

const ids = {
  run: "11111111-1111-4111-8111-111111111111",
  request: "22222222-2222-4222-8222-222222222222",
  thread: "33333333-3333-4333-8333-333333333333",
  provider: "44444444-4444-4444-8444-444444444444",
  providerB: "99999999-9999-4999-8999-999999999999",
  snapshot: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
};

const authority = {
  filesystem: false,
  shell: false,
  git: false,
  network: true,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

const routingReceipt = {
  executionResolution: {
    providerInstanceId: ids.provider,
    modelId: "gpt-4o",
    hostId: "local",
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
  selectedProviderInstanceId: ids.provider,
  selectedModelId: "gpt-4o",
  fallbackCandidates: [],
  capabilityDegradations: ["native-child-agents-unavailable"],
  contextSnapshotId: ids.snapshot,
  effectiveAuthorityDigest: "digest-1",
  usageQuality: "provider-reported",
  hostId: "local",
  mode: "chat",
};

describe("agentRun contracts", () => {
  it("decodes lifecycle statuses and rejects unknown values", () => {
    expect(decodeAgentRunLifecycleStatus("queued")).toBe("queued");
    expect(decodeAgentRunLifecycleStatus("completed")).toBe("completed");
    expect(() => decodeAgentRunLifecycleStatus("done")).toThrow();
  });

  it("decodes authority and rejects excess properties", () => {
    expect(decodeAgentRunAuthority(authority)).toMatchObject({ network: true, tools: true });
    expect(() => decodeAgentRunAuthority({ ...authority, extra: true })).toThrow();
  });

  it("decodes workspace and routing receipts", () => {
    const workspace = decodeAgentRunWorkspaceReceipt({ kind: "chat-virtual", mode: "chat" });
    expect(workspace.kind).toBe("chat-virtual");
    const workRoot = decodeAgentRunWorkspaceReceipt({
      kind: "work-root",
      mode: "work",
      projectId: ids.project,
      bindingRevisionId: "88888888-8888-4888-8888-888888888888",
      canonicalRoot: "/projects/demo",
    });
    expect(workRoot.kind).toBe("work-root");
    if (workRoot.kind !== "work-root") return;
    expect(workRoot.bindingRevisionId).toBe("88888888-8888-4888-8888-888888888888");
    const routing = decodeAgentRunRoutingReceipt(routingReceipt);
    expect(routing.selectedExecutionKind).toBe("octant-managed");
    expect(routing.attemptedExecutionKind).toBe("provider-native");
  });

  it("bounds an admitted selection and keeps text off the journaled receipt", () => {
    const block = { kind: "user-message", text: "Which service paged first?" };
    expect(decodeAgentRunAdmittedContext([block])).toHaveLength(1);
    expect(() => decodeAgentRunAdmittedContext([])).toThrow();
    expect(() =>
      decodeAgentRunAdmittedContext(
        Array.from({ length: MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS + 1 }, () => block),
      ),
    ).toThrow();
    expect(() =>
      decodeAgentRunAdmittedContext([
        {
          kind: "user-message",
          text: "x".repeat(MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS + 1),
        },
      ]),
    ).toThrow();

    // The receipt is journaled, so it may record how many blocks were admitted
    // but never the blocks: the text belongs to the parent thread and has to
    // stay purgeable.
    expect(
      decodeAgentRunRoutingReceipt({ ...routingReceipt, admittedContextBlocks: 2 })
        .admittedContextBlocks,
    ).toBe(2);
    expect(() =>
      decodeAgentRunRoutingReceipt({ ...routingReceipt, contextSnapshot: [block] }),
    ).toThrow();
    expect(() =>
      decodeAgentRunRoutingReceipt({
        ...routingReceipt,
        admittedContextBlocks: MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS + 1,
      }),
    ).toThrow();

    // A completion journals the reply's identity; the reply itself is stored.
    expect(() =>
      decodeAgentRunStatusChanged({
        runId: ids.run,
        fromStatus: "running",
        toStatus: "completed",
        version: 4,
        result: {
          reference: `octant://agent-run/${ids.run}/result`,
          text: "The ingest worker paged at 02:14.",
          truncated: false,
        },
      }),
    ).toThrow();
  });

  it("decodes a complete AgentRun entity", () => {
    const run = decodeAgentRun({
      id: ids.run,
      requestId: ids.request,
      parentThreadId: ids.thread,
      depth: 0,
      role: "research",
      task: "Summarize the latest design decisions.",
      creationPosture: "automatic",
      executionKind: "octant-managed",
      lifecycleStatus: "queued",
      authority,
      routingReceipt,
      workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
      resultAcknowledgement: { required: false, acknowledged: false },
      version: 1,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    });
    expect(run.depth).toBe(0);
    expect(run.routingReceipt.usageQuality).toBe("provider-reported");
  });

  it("decodes request and lifecycle commands", () => {
    const request = decodeAgentRunCommand({
      kind: "request-agent-run",
      requestId: ids.request,
      parentThreadId: ids.thread,
      role: "research",
      task: "Investigate provider fallback behavior.",
      creationPosture: "ask",
      requestedAuthority: authority,
      routingReceipt,
      workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
    });
    expect(request.kind).toBe("request-agent-run");

    const complete = decodeAgentRunCommand({
      kind: "complete-agent-run",
      runId: ids.run,
      expectedVersion: 2,
      result: {
        reference: `octant://agent-run/${String(ids.run)}/result`,
        truncated: false,
      },
      resultText: "The fallback is safe.",
    });
    expect(complete.kind).toBe("complete-agent-run");

    expect(
      decodeAgentRunCommand({
        kind: "retry-agent-run",
        runId: ids.run,
        expectedVersion: 4,
      }).kind,
    ).toBe("retry-agent-run");
    expect(
      decodeAgentRunCommand({
        kind: "resume-agent-run",
        runId: ids.run,
        expectedVersion: 4,
      }).kind,
    ).toBe("resume-agent-run");
  });

  it("decodes status-changed events and exports event names", () => {
    const event = decodeAgentRunStatusChanged({
      runId: ids.run,
      fromStatus: "running",
      toStatus: "completed",
      version: 4,
    });
    expect(event.toStatus).toBe("completed");
    expect(AGENT_RUN_EVENT_NAMES).toContain("agent.run-requested@1");
  });

  it("rejects invalid code worktree receipts that claim chat mode", () => {
    expect(() =>
      decodeAgentRunWorkspaceReceipt({
        kind: "code-worktree",
        mode: "chat",
        projectId: ids.project,
        checkoutRoot: "/repo",
        worktreeRoot: "/repo/.worktrees/a",
        verified: true,
      }),
    ).toThrow();
  });
});

const requestedCandidate = {
  hostId: "local",
  providerInstanceId: ids.provider,
  modelId: "gpt-4o",
};
const fallbackCandidate = {
  hostId: "local",
  providerInstanceId: ids.providerB,
  modelId: "claude-x",
};
const pool = {
  candidates: [requestedCandidate, fallbackCandidate],
  mixedVendorEnabled: true,
  fallbackAllowed: true,
  higherCostFallbackAllowed: false,
};

const selectedRequestedDecision = {
  kind: "selected",
  request: { pool, requestedCandidate, requiredCapabilities: [] },
  mode: "chat",
  activeHostId: "local",
  parentCandidate: requestedCandidate,
  eligibility: [
    { candidate: requestedCandidate, eligible: true, reasons: [] },
    { candidate: fallbackCandidate, eligible: true, reasons: [] },
  ],
  selectedCandidate: requestedCandidate,
  selectionKind: "requested",
  reason: "The requested model is selected and eligible for this execution unit.",
};

const selectedFallbackDecision = {
  kind: "selected",
  request: { pool, requestedCandidate, requiredCapabilities: [] },
  mode: "chat",
  activeHostId: "local",
  parentCandidate: requestedCandidate,
  eligibility: [
    { candidate: requestedCandidate, eligible: false, reasons: ["model-unavailable"], costRank: 1 },
    { candidate: fallbackCandidate, eligible: true, reasons: [], costRank: 1 },
  ],
  selectedCandidate: fallbackCandidate,
  selectionKind: "fallback",
  reason: "The requested model is unavailable; an explicitly permitted pool fallback was selected.",
};

const waitingDecision = {
  kind: "waiting",
  request: { pool, requestedCandidate, requiredCapabilities: [] },
  mode: "chat",
  activeHostId: "local",
  parentCandidate: requestedCandidate,
  eligibility: [
    { candidate: requestedCandidate, eligible: false, reasons: ["model-unavailable"] },
    { candidate: fallbackCandidate, eligible: false, reasons: ["provider-not-ready"] },
  ],
  reason: "no-eligible-candidate",
  message: "No selected model is currently eligible. Check provider readiness and pool policy.",
};

const decidedAt = "2026-08-01T10:00:00.000Z";

describe("agentRun pool-derived route receipts", () => {
  it("decodes a routing receipt carrying a pool-derived requested route", () => {
    const decoded = decodeAgentRunRoutingReceipt({
      ...routingReceipt,
      poolRoute: { decision: selectedRequestedDecision, decidedAt },
    });
    expect(decoded.poolRoute?.decision.kind).toBe("selected");
  });

  it("rejects a pool route whose decision mode disagrees with the receipt mode", () => {
    expect(() =>
      decodeAgentRunRoutingReceipt({
        ...routingReceipt,
        poolRoute: {
          decision: { ...selectedRequestedDecision, mode: "work" },
          decidedAt,
        },
      }),
    ).toThrow();
  });

  it("rejects a pool route whose requested candidate disagrees with the receipt primary selection", () => {
    expect(() =>
      decodeAgentRunRoutingReceipt({
        ...routingReceipt,
        selectedModelId: "some-other-model",
        poolRoute: { decision: selectedRequestedDecision, decidedAt },
      }),
    ).toThrow();
  });

  it("decodes a pool fallback route only when the receipt records the explicit fallback", () => {
    const decoded = decodeAgentRunRoutingReceipt({
      ...routingReceipt,
      selectedFallback: {
        providerInstanceId: ids.providerB,
        modelId: "claude-x",
        reason: selectedFallbackDecision.reason,
      },
      poolRoute: { decision: selectedFallbackDecision, decidedAt },
    });
    expect(decoded.selectedFallback?.modelId).toBe("claude-x");

    expect(() =>
      decodeAgentRunRoutingReceipt({
        ...routingReceipt,
        poolRoute: { decision: selectedFallbackDecision, decidedAt },
      }),
    ).toThrow();

    expect(() =>
      decodeAgentRunRoutingReceipt({
        ...routingReceipt,
        selectedFallback: {
          providerInstanceId: ids.providerB,
          modelId: "a-different-model",
          reason: selectedFallbackDecision.reason,
        },
        poolRoute: { decision: selectedFallbackDecision, decidedAt },
      }),
    ).toThrow();
  });

  it("decodes a waiting pool route and rejects one that also claims a fallback", () => {
    const decoded = decodeAgentRunRoutingReceipt({
      ...routingReceipt,
      poolRoute: { decision: waitingDecision, decidedAt },
    });
    expect(decoded.poolRoute?.decision.kind).toBe("waiting");

    expect(() =>
      decodeAgentRunRoutingReceipt({
        ...routingReceipt,
        selectedFallback: {
          providerInstanceId: ids.providerB,
          modelId: "claude-x",
          reason: "not permitted for a waiting route",
        },
        poolRoute: { decision: waitingDecision, decidedAt },
      }),
    ).toThrow();
  });

  it("rejects a pool route decided for a different host", () => {
    const foreignRequested = { ...requestedCandidate, hostId: "other-host" };
    const foreignFallback = { ...fallbackCandidate, hostId: "other-host" };
    expect(() =>
      decodeAgentRunRoutingReceipt({
        ...routingReceipt,
        poolRoute: {
          decision: {
            ...waitingDecision,
            request: {
              pool: { ...pool, candidates: [foreignRequested, foreignFallback] },
              requestedCandidate: foreignRequested,
              requiredCapabilities: [],
            },
            activeHostId: "other-host",
            parentCandidate: foreignRequested,
            eligibility: [
              { candidate: foreignRequested, eligible: false, reasons: ["model-unavailable"] },
              { candidate: foreignFallback, eligible: false, reasons: ["provider-not-ready"] },
            ],
          },
          decidedAt,
        },
      }),
    ).toThrow();
  });

  it("rejects a selected requested pool route that also records a fallback", () => {
    expect(() =>
      decodeAgentRunRoutingReceipt({
        ...routingReceipt,
        selectedFallback: {
          providerInstanceId: ids.providerB,
          modelId: "claude-x",
          reason: "not permitted for a requested route",
        },
        poolRoute: { decision: selectedRequestedDecision, decidedAt },
      }),
    ).toThrow();
  });

  it("decodes center query and response contracts", () => {
    const query = decodeAgentRunCenterQuery({
      status: "active",
      mode: "work",
      limit: 25,
      search: "implement",
    });
    expect(query.status).toBe("active");
    const response = decodeAgentRunCenterResponse({
      items: [
        {
          runId: ids.run,
          requestId: ids.request,
          parentThreadId: ids.thread,
          parentThreadTitle: "Work thread",
          mode: "work",
          projectId: ids.project,
          role: "implementation",
          task: "Implement feature",
          lifecycleStatus: "running",
          executionKind: "octant-managed",
          authority,
          workspaceKind: "work-root",
          usageQuality: "provider-reported",
          route: {
            requestedProviderInstanceId: ids.provider,
            requestedModelId: "gpt-4o",
            executionProviderInstanceId: ids.provider,
            executionModelId: "gpt-4o",
            poolDerived: false,
          },
          resultAcknowledgement: { required: false, acknowledged: false },
          version: 1,
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    });
    expect(response.items).toHaveLength(1);
  });
});

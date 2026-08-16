import { describe, expect, it } from "vitest";
import {
  decodeAgentRun,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  type EventEnvelope,
  type AgentRun,
  type AgentRunLifecycleStatus,
} from "@octant/contracts";
import { AGENT_RUN_REQUESTED, AGENT_RUN_STATUS_CHANGED } from "./agentRunEventStore";
import { AgentRunProjection } from "./agentRunProjection";

const now = "2026-08-01T10:00:00.000Z";
const later = "2026-08-01T10:01:00.000Z";

const ids = {
  run: decodeAgentRunId("11111111-1111-4111-8111-111111111111"),
  runB: decodeAgentRunId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  request: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222222"),
  requestB: decodeAgentRunRequestId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  thread: decodeAgentRunParentThreadId("33333333-3333-4333-8333-333333333333"),
  threadOther: decodeAgentRunParentThreadId("44444444-4444-4444-8444-444444444444"),
  provider: "55555555-5555-4555-8555-555555555555",
  providerB: "88888888-8888-4888-8888-888888888888",
  snapshot: "66666666-6666-4666-8666-666666666666",
} as const;

const poolRequested = { hostId: "local", providerInstanceId: ids.provider, modelId: "gpt-4o" };
const poolFallback = { hostId: "local", providerInstanceId: ids.providerB, modelId: "claude-x" };
const poolFixture = {
  candidates: [poolRequested, poolFallback],
  mixedVendorEnabled: true,
  fallbackAllowed: true,
  higherCostFallbackAllowed: true,
};
const fallbackReason =
  "The requested model is unavailable; an explicitly permitted pool fallback was selected.";
const waitingMessage =
  "No selected model is currently eligible. Check provider readiness and pool policy.";

function poolRouteFixture(kind: "fallback" | "waiting") {
  const shared = {
    request: { pool: poolFixture, requestedCandidate: poolRequested, requiredCapabilities: [] },
    mode: "chat",
    activeHostId: "local",
    parentCandidate: poolRequested,
  };
  return {
    decidedAt: now,
    decision:
      kind === "fallback"
        ? {
            kind: "selected",
            ...shared,
            eligibility: [
              { candidate: poolRequested, eligible: false, reasons: ["model-unavailable"] },
              { candidate: poolFallback, eligible: true, reasons: [] },
            ],
            selectedCandidate: poolFallback,
            selectionKind: "fallback",
            reason: fallbackReason,
          }
        : {
            kind: "waiting",
            ...shared,
            eligibility: [
              { candidate: poolRequested, eligible: false, reasons: ["model-unavailable"] },
              { candidate: poolFallback, eligible: false, reasons: ["provider-not-ready"] },
            ],
            reason: "no-eligible-candidate",
            message: waitingMessage,
          },
  };
}

function baseRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return decodeAgentRun({
    id: ids.run,
    requestId: ids.request,
    parentThreadId: ids.thread,
    depth: 0,
    role: "research",
    task: "Summarize the design.",
    creationPosture: "automatic",
    executionKind: "octant-managed",
    lifecycleStatus: "queued",
    authority: {
      filesystem: false,
      shell: false,
      git: false,
      network: true,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
    routingReceipt: {
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
    },
    workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function withStatus(
  run: AgentRun,
  status: AgentRunLifecycleStatus,
  version: number,
  extra: Partial<AgentRun> = {},
): AgentRun {
  return decodeAgentRun({
    ...run,
    lifecycleStatus: status,
    version,
    updatedAt: later,
    ...extra,
  });
}

describe("AgentRunProjection", () => {
  it("applies a requested run and looks it up by id and request id", () => {
    const projection = new AgentRunProjection();
    const run = baseRun();
    projection.applyRequested(run);

    expect(projection.getById(ids.run)).toEqual(run);
    expect(projection.getByRequestId(ids.request)).toEqual(run);
  });

  it("applies status changes and preserves routing, authority, usage quality, and acknowledgement", () => {
    const projection = new AgentRunProjection();
    const run = baseRun();
    projection.applyRequested(run);

    const completed = withStatus(run, "completed", 4, {
      resultAcknowledgement: {
        required: true,
        acknowledged: false,
        followUpReason: "unacknowledged-child-result",
      },
      recoveryReason: undefined,
    });
    // simulate intermediate transitions via status apply helpers
    projection.applyStatusChanged({
      runId: ids.run,
      fromStatus: "queued",
      toStatus: "starting",
      version: 2,
      updatedAt: later as never,
    });
    projection.applyStatusChanged({
      runId: ids.run,
      fromStatus: "starting",
      toStatus: "running",
      version: 3,
      updatedAt: later as never,
    });
    projection.applyStatusChanged({
      runId: ids.run,
      fromStatus: "running",
      toStatus: "completed",
      version: 4,
      updatedAt: later as never,
      resultAcknowledgement: completed.resultAcknowledgement,
    });

    const projected = projection.getById(ids.run);
    expect(projected?.lifecycleStatus).toBe("completed");
    expect(projected?.routingReceipt.usageQuality).toBe("provider-reported");
    expect(projected?.authority.network).toBe(true);
    expect(projected?.resultAcknowledgement).toEqual({
      required: true,
      acknowledged: false,
      followUpReason: "unacknowledged-child-result",
    });
  });

  it("clears a recovery reason after the blocked run starts again", () => {
    const projection = new AgentRunProjection();
    const run = baseRun();
    projection.applyRequested(run);
    projection.applyStatusChanged({
      runId: ids.run,
      fromStatus: "queued",
      toStatus: "waiting",
      version: 2,
      updatedAt: later as never,
      recoveryReason: "provider-capacity-saturated",
    });
    projection.applyStatusChanged({
      runId: ids.run,
      fromStatus: "waiting",
      toStatus: "starting",
      version: 3,
      updatedAt: later as never,
    });

    expect(projection.getById(ids.run)?.lifecycleStatus).toBe("starting");
    expect(projection.getById(ids.run)).not.toHaveProperty("recoveryReason");
  });

  it("is idempotent and ignores stale out-of-order versions", () => {
    const projection = new AgentRunProjection();
    const run = baseRun();
    projection.applyRequested(run);
    projection.applyStatusChanged({
      runId: ids.run,
      fromStatus: "queued",
      toStatus: "starting",
      version: 2,
      updatedAt: later as never,
    });
    projection.applyStatusChanged({
      runId: ids.run,
      fromStatus: "starting",
      toStatus: "running",
      version: 3,
      updatedAt: later as never,
    });

    // duplicate / stale
    projection.applyRequested(run);
    projection.applyStatusChanged({
      runId: ids.run,
      fromStatus: "queued",
      toStatus: "starting",
      version: 2,
      updatedAt: later as never,
    });

    expect(projection.getById(ids.run)?.lifecycleStatus).toBe("running");
    expect(projection.getById(ids.run)?.version).toBe(3);
  });

  it("lists parent summary entries for a parent thread only", () => {
    const projection = new AgentRunProjection();
    const runA = baseRun();
    const runB = baseRun({
      id: ids.runB,
      requestId: ids.requestB,
      parentThreadId: ids.threadOther,
      task: "Other parent work",
    });
    projection.applyRequested(runA);
    projection.applyRequested(runB);
    projection.applyStatusChanged({
      runId: ids.run,
      fromStatus: "queued",
      toStatus: "starting",
      version: 2,
      updatedAt: later as never,
    });
    projection.applyStatusChanged({
      runId: ids.run,
      fromStatus: "starting",
      toStatus: "running",
      version: 3,
      updatedAt: later as never,
    });

    const summary = projection.parentSummary(ids.thread);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      runId: ids.run,
      parentThreadId: ids.thread,
      lifecycleStatus: "running",
      usageQuality: "provider-reported",
      resultAcknowledgement: { required: false, acknowledged: false },
    });
  });

  it("surfaces honest route receipt data in the parent summary", () => {
    const projection = new AgentRunProjection();
    const receipt = baseRun().routingReceipt;
    projection.applyRequested(
      baseRun({
        routingReceipt: {
          ...receipt,
          selectedFallback: {
            providerInstanceId: ids.providerB,
            modelId: "claude-x",
            reason: fallbackReason,
          },
          poolRoute: poolRouteFixture("fallback"),
        } as never,
      }),
    );
    projection.applyRequested(
      baseRun({
        id: ids.runB,
        requestId: ids.requestB,
        task: "Waiting pool work",
        routingReceipt: { ...receipt, poolRoute: poolRouteFixture("waiting") } as never,
      }),
    );

    const summary = projection.parentSummary(ids.thread);
    const fallbackEntry = summary.find((entry) => entry.runId === ids.run);
    expect(fallbackEntry?.route).toEqual({
      requestedProviderInstanceId: ids.provider,
      requestedModelId: "gpt-4o",
      executionProviderInstanceId: ids.providerB,
      executionModelId: "claude-x",
      poolDerived: true,
      selectionKind: "fallback",
      routingReason: fallbackReason,
    });
    const waitingEntry = summary.find((entry) => entry.runId === ids.runB);
    expect(waitingEntry?.route).toEqual({
      requestedProviderInstanceId: ids.provider,
      requestedModelId: "gpt-4o",
      executionProviderInstanceId: ids.provider,
      executionModelId: "gpt-4o",
      poolDerived: true,
      routingReason: waitingMessage,
    });
  });

  it("reports a plain single-model route without claiming pool derivation", () => {
    const projection = new AgentRunProjection();
    projection.applyRequested(baseRun());
    const summary = projection.parentSummary(ids.thread);
    expect(summary[0]?.route).toEqual({
      requestedProviderInstanceId: ids.provider,
      requestedModelId: "gpt-4o",
      executionProviderInstanceId: ids.provider,
      executionModelId: "gpt-4o",
      poolDerived: false,
    });
  });

  it("rebuilds identical state from a full event stream", () => {
    const live = new AgentRunProjection();
    const run = baseRun();
    live.applyRequested(run);
    live.applyStatusChanged({
      runId: ids.run,
      fromStatus: "queued",
      toStatus: "starting",
      version: 2,
      updatedAt: later as never,
    });
    live.applyStatusChanged({
      runId: ids.run,
      fromStatus: "starting",
      toStatus: "running",
      version: 3,
      updatedAt: later as never,
    });
    live.applyStatusChanged({
      runId: ids.run,
      fromStatus: "running",
      toStatus: "completed",
      version: 4,
      updatedAt: later as never,
      resultAcknowledgement: {
        required: true,
        acknowledged: false,
        followUpReason: "unacknowledged-child-result",
      },
    });
    live.applyResultAcknowledged({
      runId: ids.run,
      version: 5,
      acknowledgedAt: later as never,
    });

    const rebuilt = new AgentRunProjection();
    rebuilt.applyRequested(run);
    rebuilt.applyStatusChanged({
      runId: ids.run,
      fromStatus: "queued",
      toStatus: "starting",
      version: 2,
      updatedAt: later as never,
    });
    rebuilt.applyStatusChanged({
      runId: ids.run,
      fromStatus: "starting",
      toStatus: "running",
      version: 3,
      updatedAt: later as never,
    });
    rebuilt.applyStatusChanged({
      runId: ids.run,
      fromStatus: "running",
      toStatus: "completed",
      version: 4,
      updatedAt: later as never,
      resultAcknowledgement: {
        required: true,
        acknowledged: false,
        followUpReason: "unacknowledged-child-result",
      },
    });
    rebuilt.applyResultAcknowledged({
      runId: ids.run,
      version: 5,
      acknowledgedAt: later as never,
    });

    expect(rebuilt.getById(ids.run)).toEqual(live.getById(ids.run));
    expect(rebuilt.getByRequestId(ids.request)?.resultAcknowledgement.acknowledged).toBe(true);
  });

  it("applies journal envelopes so the runtime projection can replay after restart", () => {
    const projection = new AgentRunProjection();
    const run = baseRun();
    const requested = {
      eventName: AGENT_RUN_REQUESTED,
      eventVersion: 1,
      occurredAt: now,
      payload: { run },
    } as EventEnvelope;
    const statusChanged = {
      eventName: AGENT_RUN_STATUS_CHANGED,
      eventVersion: 1,
      occurredAt: later,
      payload: {
        runId: ids.run,
        fromStatus: "queued",
        toStatus: "running",
        version: 2,
      },
    } as EventEnvelope;

    projection.apply(undefined as never, requested);
    projection.apply(undefined as never, statusChanged);

    expect(projection.getById(ids.run)).toMatchObject({
      lifecycleStatus: "running",
      version: 2,
      updatedAt: later,
    });
  });
});

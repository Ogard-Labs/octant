import { describe, expect, it, vi } from "vitest";
import {
  decodeAgentRun,
  type AgentRun,
  type CommittedAppend,
  type EventEnvelope,
} from "@octant/contracts";
import {
  AgentResultDeliveryService,
  type AgentResultDeliveryModePort,
} from "./agentResultDeliveryService";

const now = "2026-07-21T10:00:00.000Z";

const finishedRun = (overrides: Record<string, unknown> = {}): AgentRun =>
  decodeAgentRun({
    id: "d8a1b000-0000-4000-8000-000000000001",
    requestId: "d8a1b000-0000-4000-8000-000000000002",
    parentThreadId: "d8a1b000-0000-4000-8000-0000000000aa",
    depth: 0,
    role: "research",
    task: "Summarize the design.",
    creationPosture: "automatic",
    executionKind: "octant-managed",
    lifecycleStatus: "completed",
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
        providerInstanceId: "d8a1b000-0000-4000-8000-000000000003",
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
      selectedProviderInstanceId: "d8a1b000-0000-4000-8000-000000000003",
      selectedModelId: "gpt-4o",
      fallbackCandidates: [],
      capabilityDegradations: [],
      contextSnapshotId: "d8a1b000-0000-4000-8000-000000000004",
      effectiveAuthorityDigest: "digest-1",
      usageQuality: "provider-reported",
      hostId: "local",
      mode: "chat",
    },
    workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 4,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

const settleStatusEvent = (runId: string): CommittedAppend =>
  ({
    events: [
      {
        eventName: "agent.run-status-changed@1",
        aggregateType: "agent-run",
        aggregateId: runId,
        payload: {
          runId,
          fromStatus: "running",
          toStatus: "completed",
          version: 4,
        },
      },
    ],
  }) as unknown as CommittedAppend;

const parentCommit = (aggregateId: string): CommittedAppend =>
  ({
    events: [
      {
        eventName: "chat.turn-updated@1",
        aggregateType: "chat-thread",
        aggregateId,
        payload: {},
      } as EventEnvelope,
    ],
  }) as unknown as CommittedAppend;

function deliveryFixture(
  options: {
    readonly runs?: ReadonlyArray<AgentRun>;
    readonly chat?: Partial<AgentResultDeliveryModePort>;
    readonly applyCommand?: (command: unknown) => unknown;
  } = {},
) {
  const runs = new Map((options.runs ?? []).map((run) => [run.id, run] as const));
  const applyCommand = vi.fn(
    options.applyCommand ??
      ((command: { readonly runId: AgentRun["id"] }) => ({
        kind: "run-updated",
        run: decodeAgentRun({
          ...runs.get(command.runId),
          resultDelivery: { outcome: "delivered", settledAt: now },
          version: 5,
        }),
      })),
  );
  const chat: AgentResultDeliveryModePort = {
    inspect: vi.fn(async () => ({ kind: "ready" as const })),
    dispatch: vi.fn(async () => ({ kind: "dispatched" as const })),
    ...options.chat,
  };
  const timers: Array<{ readonly at: number; readonly fire: () => void }> = [];
  const service = new AgentResultDeliveryService({
    journal: {
      subscribeCommitted: () => () => undefined,
    },
    agentRuns: {
      getById: (runId) => runs.get(runId),
      snapshot: () => runs,
      applyCommand: applyCommand as never,
    },
    ports: { chat, work: chat, code: chat },
    clock: () => new Date(now),
    schedule: (at, fire) => {
      timers.push({ at, fire });
      return timers[timers.length - 1];
    },
    unschedule: () => undefined,
  });
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const emit = (append: CommittedAppend) => service.onCommittedAppend(append);
  return { service, chat, applyCommand, timers, flush, emit };
}

describe("AgentResultDeliveryService", () => {
  it("delivers a finished run's result to its parent and journals the settle", async () => {
    const run = finishedRun();
    const fixture = deliveryFixture({ runs: [run] });
    fixture.emit(settleStatusEvent(String(run.id)));
    await fixture.flush();

    expect(fixture.chat.inspect).toHaveBeenCalledWith(run);
    expect(fixture.chat.dispatch).toHaveBeenCalledWith(run);
    expect(fixture.applyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "settle-agent-run-result-delivery",
        runId: run.id,
        outcome: "delivered",
      }),
    );
  });

  it("arms a run that finished while the host was away when the service starts", async () => {
    const run = finishedRun();
    const fixture = deliveryFixture({ runs: [run] });
    fixture.service.start();
    await fixture.flush();

    expect(fixture.chat.dispatch).toHaveBeenCalledWith(run);
  });

  it("keeps a deferred delivery armed and re-fires when the parent thread commits", async () => {
    const run = finishedRun();
    let dispatches = 0;
    const fixture = deliveryFixture({
      runs: [run],
      chat: {
        dispatch: vi.fn(async () => {
          dispatches += 1;
          return dispatches === 1
            ? { kind: "deferred" as const, detail: "parent mid-turn" }
            : { kind: "dispatched" as const };
        }),
      },
    });
    fixture.emit(settleStatusEvent(String(run.id)));
    await fixture.flush();
    expect(fixture.chat.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.applyCommand).not.toHaveBeenCalled();

    fixture.emit(parentCommit(String(run.parentThreadId)));
    await fixture.flush();
    expect(fixture.chat.dispatch).toHaveBeenCalledTimes(2);
    expect(fixture.applyCommand).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "delivered" }),
    );
  });

  it("settles a parent that no longer exists as invalidated rather than retrying forever", async () => {
    const run = finishedRun();
    const fixture = deliveryFixture({
      runs: [run],
      chat: {
        inspect: vi.fn(async () => ({ kind: "invalid" as const, detail: "thread gone" })),
      },
    });
    fixture.emit(settleStatusEvent(String(run.id)));
    await fixture.flush();

    expect(fixture.chat.dispatch).not.toHaveBeenCalled();
    expect(fixture.applyCommand).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "invalidated", detail: "thread gone" }),
    );
    expect(fixture.timers).toHaveLength(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  decodeAgentRun,
  decodeAggregateVersion,
  decodeProviderModelId,
  type AgentRun,
  type AgentRunResultDeliveryMark,
  type AgentRunResultDeliveryOutcome,
  type CommittedAppend,
  type EventEnvelope,
} from "@octant/contracts";
import {
  AgentResultDeliveryService,
  type AgentResultDeliveryModePort,
} from "./agentResultDeliveryService";

import {
  agentResultDeliveryReceipt,
  agentRunResultGeneration,
  coveredAgentResultDeliveryMembers,
  validateAgentResultDelivery,
} from "./agentResultDeliveryBatch";
import {
  agentResultDeliveryBatchPrompt,
  MAX_AGENT_RESULT_DELIVERY_PROMPT_CHARACTERS,
} from "./agentResultDeliveryPrompt";

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
    readonly recordResultIngestion?: (run: AgentRun) => boolean;
  } = {},
) {
  const runs = new Map((options.runs ?? []).map((run) => [run.id, run] as const));
  const applyCommand = vi.fn(
    options.applyCommand ??
      ((command: {
        readonly runId: AgentRun["id"];
        readonly outcome: AgentRunResultDeliveryOutcome;
      }) => {
        const current = runs.get(command.runId);
        if (current === undefined) throw new Error("Unknown run");
        const run = {
          ...current,
          resultDelivery: { outcome: command.outcome, settledAt: current.updatedAt },
          version: decodeAggregateVersion(current.version + 1),
        };
        runs.set(run.id, run);
        return { kind: "run-updated", run };
      }),
  );
  const chat: AgentResultDeliveryModePort = {
    inspect: vi.fn(async () => ({ kind: "ready" as const })),
    dispatch: vi.fn(async (batch: ReadonlyArray<AgentRun>) => ({
      kind: "dispatched" as const,
      runIds: batch.map((run) => run.id),
      runGenerations: batch.map((run) => ({
        runId: run.id,
        generation: agentRunResultGeneration(run),
      })),
    })),
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
    ...(options.recordResultIngestion === undefined
      ? {}
      : { recordResultIngestion: options.recordResultIngestion }),
  });
  const flush = async () => {
    for (let i = 0; i < 100; i += 1) await Promise.resolve();
  };
  const emit = (append: CommittedAppend) => service.onCommittedAppend(append);
  return { service, chat, applyCommand, timers, flush, emit, runs };
}

describe("AgentResultDeliveryService", () => {
  it.each(["consumed", "replaced", "resumed"] as const)(
    "delivers an unchanged sibling when another result is %s during preparation",
    async (change) => {
      const first = finishedRun();
      const second = finishedRun({ id: "d8a1b000-0000-4000-8000-000000000005" });
      let release: (() => void) | undefined;
      const preparation = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admitted: AgentRunResultDeliveryMark[] = [];
      let preparing = true;
      const fixture = deliveryFixture({
        runs: [first, second],
        chat: {
          dispatch: vi.fn<AgentResultDeliveryModePort["dispatch"]>(async (batch) => {
            const primary = batch[0];
            if (primary === undefined) throw new Error("Empty batch");
            const mark: AgentRunResultDeliveryMark = {
              kind: "agent-result",
              runId: primary.id,
              runIds: batch.map((run) => run.id),
              runGenerations: batch.map((run) => ({
                runId: run.id,
                generation: run.generation ?? 1,
              })),
            };
            if (preparing) {
              preparing = false;
              await preparation;
            }
            // Mode admission rechecks the captured mark after asynchronous preparation.
            const validation = validateAgentResultDelivery({
              delivery: mark,
              threadId: String(first.parentThreadId),
              mode: "chat",
              getById: (id) => fixture.runs.get(id),
            });
            if (validation.kind === "invalid")
              return { kind: "refused", detail: validation.detail };
            if (validation.runs.some((run) => run.resultDelivery !== undefined))
              return { kind: "refused", detail: "A child result already settled." };
            admitted.push(mark);
            return {
              kind: "dispatched",
              runIds: batch.map((run) => run.id),
              runGenerations: mark.runGenerations,
            };
          }),
        },
      });
      fixture.service.start();
      await fixture.flush();
      expect(fixture.chat.dispatch).toHaveBeenCalledWith([first, second]);
      const changed = finishedRun({
        version: 9,
        ...(change === "consumed"
          ? { resultDelivery: { outcome: "consumed", settledAt: now } }
          : change === "replaced"
            ? { generation: 2 }
            : { lifecycleStatus: "running" }),
      });
      fixture.runs.set(first.id, changed);
      expect(fixture.runs.get(second.id)).toEqual(second);
      expect(admitted).toEqual([]);
      release?.();
      await fixture.flush();

      expect(fixture.runs.get(second.id)?.resultDelivery?.outcome).toBe("delivered");
      expect(admitted.map((mark) => mark.runGenerations)).toEqual([
        change === "replaced"
          ? [
              { runId: first.id, generation: 2 },
              { runId: second.id, generation: 1 },
            ]
          : [{ runId: second.id, generation: 1 }],
      ]);
      expect(fixture.applyCommand).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed" }),
      );
      if (change !== "replaced") expect(fixture.runs.get(first.id)).toEqual(changed);
      expect(fixture.timers).toHaveLength(0);
    },
  );

  it("settles an unchanged batch after a fatal parent refusal without retrying", async () => {
    const first = finishedRun();
    const second = finishedRun({ id: "d8a1b000-0000-4000-8000-000000000005" });
    const fixture = deliveryFixture({
      runs: [first, second],
      chat: {
        dispatch: vi.fn(async () => ({ kind: "refused" as const, detail: "Parent revoked" })),
      },
    });
    fixture.service.start();
    await fixture.flush();
    expect(fixture.chat.dispatch).toHaveBeenCalledTimes(1);
    expect([...fixture.runs.values()].map((run) => run.resultDelivery?.outcome)).toEqual([
      "failed",
      "failed",
    ]);
    expect(fixture.timers).toHaveLength(0);
  });

  it("replays a partially settled group after a crash without swallowing a new sibling", async () => {
    const first = finishedRun();
    const second = finishedRun({ id: "d8a1b000-0000-4000-8000-000000000005" });
    const newSibling = finishedRun({ id: "d8a1b000-0000-4000-8000-000000000006" });
    const marks: AgentRunResultDeliveryMark[] = [];
    const dispatch: AgentResultDeliveryModePort["dispatch"] = async (batch) => {
      const primary = batch[0];
      if (primary === undefined) throw new Error("Empty batch");
      const mark: AgentRunResultDeliveryMark = {
        kind: "agent-result",
        runId: primary.id,
        runIds: batch.map((run) => run.id),
      };
      const covered = coveredAgentResultDeliveryMembers(mark, marks);
      if (covered.length > 0)
        return {
          kind: "dispatched",
          runIds: covered.map((member) => member.runId),
          runGenerations: covered,
        };
      marks.push(mark);
      return { kind: "dispatched", runIds: batch.map((run) => run.id) };
    };
    const fixture = deliveryFixture({ runs: [first, second], chat: { dispatch } });
    fixture.applyCommand.mockImplementationOnce(() => {
      const run = {
        ...first,
        resultDelivery: { outcome: "delivered" as const, settledAt: first.updatedAt },
      };
      fixture.runs.set(first.id, run);
      return { kind: "run-updated", run };
    });
    fixture.applyCommand.mockImplementationOnce(() => {
      throw new Error("Host stopped before second settle");
    });
    fixture.service.start();
    await fixture.flush();
    expect(fixture.runs.get(first.id)?.resultDelivery?.outcome).toBe("delivered");
    expect(fixture.runs.get(second.id)?.resultDelivery).toBeUndefined();
    fixture.service.stop();

    const restarted = deliveryFixture({
      runs: [...fixture.runs.values(), newSibling],
      chat: { dispatch: vi.fn(dispatch) },
    });
    restarted.service.start();
    await restarted.flush();
    expect(marks.map((mark) => mark.runIds)).toEqual([[first.id, second.id], [newSibling.id]]);
    expect(restarted.chat.dispatch).toHaveBeenNthCalledWith(1, [second, newSibling]);
    expect(restarted.chat.dispatch).toHaveBeenNthCalledWith(2, [newSibling]);
    expect(restarted.runs.get(second.id)?.resultDelivery?.outcome).toBe("delivered");
    expect(restarted.runs.get(newSibling.id)?.resultDelivery?.outcome).toBe("delivered");
  });

  it("settles a replayed batch that overlaps an earlier wider group by reporting only the requested members", async () => {
    const first = finishedRun();
    const second = finishedRun({ id: "d8a1b000-0000-4000-8000-000000000005" });
    const earlierMark: AgentRunResultDeliveryMark = {
      kind: "agent-result",
      runId: first.id,
      runIds: [first.id, second.id],
    };
    // The earlier group's first member already settled; the parent replays the
    // second alone and the adapter finds the durable mark of the wider group.
    const fixture = deliveryFixture({
      runs: [second],
      chat: {
        dispatch: vi.fn(async (batch: ReadonlyArray<AgentRun>) => {
          const [primary] = batch;
          if (primary === undefined) throw new Error("Empty batch");
          return agentResultDeliveryReceipt(
            { runId: primary.id, runIds: batch.map((run) => run.id) },
            earlierMark,
          );
        }),
      },
    });
    fixture.service.start();
    await fixture.flush();
    expect(fixture.chat.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.runs.get(second.id)?.resultDelivery?.outcome).toBe("delivered");
    expect(fixture.timers).toHaveLength(0);
  });

  it("refuses a delivery receipt when the durable mark covers none of the requested results", () => {
    const first = finishedRun();
    const other = finishedRun({ id: "d8a1b000-0000-4000-8000-000000000005" });
    const mark: AgentRunResultDeliveryMark = {
      kind: "agent-result",
      runId: other.id,
      runIds: [other.id],
    };
    expect(agentResultDeliveryReceipt({ runId: first.id }, mark)).toMatchObject({
      kind: "refused",
    });
    expect(agentResultDeliveryReceipt({ runId: first.id }, undefined)).toMatchObject({
      kind: "refused",
    });
  });

  it("serializes a parent while a child resumes and never settles the new generation with an old receipt", async () => {
    const first = finishedRun();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fixture = deliveryFixture({
      runs: [first],
      chat: {
        dispatch: vi.fn<AgentResultDeliveryModePort["dispatch"]>(async (batch) => {
          calls += 1;
          if (calls === 1) await pending;
          return {
            kind: "dispatched",
            runIds: batch.map((run) => run.id),
            runGenerations: batch.map((run) => ({
              runId: run.id,
              generation: agentRunResultGeneration(run),
            })),
          };
        }),
      },
    });
    fixture.service.start();
    await fixture.flush();
    const resumed = { ...first, generation: 2, version: decodeAggregateVersion(9) };
    fixture.runs.set(first.id, resumed);
    fixture.emit(settleStatusEvent(String(first.id)));
    await fixture.flush();
    expect(fixture.chat.dispatch).toHaveBeenCalledTimes(1);
    release?.();
    await fixture.flush();
    expect(fixture.chat.dispatch).toHaveBeenCalledTimes(2);
    expect(fixture.applyCommand).toHaveBeenCalledTimes(1);
    expect(fixture.applyCommand).toHaveBeenCalledWith(
      expect.objectContaining({ runId: first.id, generation: 2 }),
    );
    expect(fixture.runs.get(first.id)?.resultDelivery?.outcome).toBe("delivered");
  });

  it("bounds group size and refuses a dispatch receipt containing a foreign member", async () => {
    const runs = Array.from({ length: 17 }, (_, index) =>
      finishedRun({ id: `d8a1b000-0000-4000-8000-${String(index + 100).padStart(12, "0")}` }),
    );
    const fixture = deliveryFixture({ runs });
    fixture.service.start();
    await fixture.flush();
    expect(fixture.chat.dispatch).toHaveBeenCalledTimes(2);
    expect(fixture.chat.dispatch).toHaveBeenNthCalledWith(1, runs.slice(0, 16));
    expect(fixture.chat.dispatch).toHaveBeenNthCalledWith(2, runs.slice(16));
    const run = finishedRun();
    const foreign = finishedRun({ id: "d8a1b000-0000-4000-8000-000000000099" });
    const invalid = deliveryFixture({
      runs: [run],
      chat: { dispatch: async () => ({ kind: "dispatched", runIds: [foreign.id] }) },
    });
    invalid.service.start();
    await invalid.flush();
    expect(invalid.applyCommand).not.toHaveBeenCalled();
    expect(invalid.timers).toHaveLength(1);
  });

  it("frames bounded sibling excerpts with the provider and model that actually ran", () => {
    const first = finishedRun();
    const fallback = {
      ...first,
      routingReceipt: {
        ...first.routingReceipt,
        selectedFallback: {
          providerInstanceId: first.routingReceipt.selectedProviderInstanceId,
          modelId: decodeProviderModelId("fallback-model"),
          reason: "primary unavailable",
        },
      },
    };
    const second = finishedRun({ id: "d8a1b000-0000-4000-8000-000000000005" });
    const prompt = agentResultDeliveryBatchPrompt([fallback, second], () => "x".repeat(100_000));
    expect(prompt.length).toBeLessThanOrEqual(MAX_AGENT_RESULT_DELIVERY_PROMPT_CHARACTERS);
    expect(prompt).toContain("not new authorization");
    expect(prompt).toContain("fallback-model");
    expect(prompt).toContain(String(first.id));
    expect(prompt).toContain(String(second.id));
    expect(prompt).toContain("excerpt was truncated");
  });

  it("groups finished siblings while another sibling is still running and separates parents", async () => {
    const first = finishedRun();
    const second = finishedRun({ id: "d8a1b000-0000-4000-8000-000000000005" });
    const running = finishedRun({
      id: "d8a1b000-0000-4000-8000-000000000006",
      lifecycleStatus: "running",
    });
    const otherParent = finishedRun({
      id: "d8a1b000-0000-4000-8000-000000000007",
      parentThreadId: "d8a1b000-0000-4000-8000-0000000000bb",
    });
    const fixture = deliveryFixture({ runs: [first, second, running, otherParent] });
    fixture.service.start();
    await fixture.flush();
    expect(fixture.chat.dispatch).toHaveBeenCalledTimes(2);
    expect(fixture.chat.dispatch).toHaveBeenCalledWith([first, second]);
    expect(fixture.chat.dispatch).toHaveBeenCalledWith([otherParent]);
  });

  it("delivers a finished run's result to its parent and journals the settle", async () => {
    const run = finishedRun();
    const fixture = deliveryFixture({ runs: [run] });
    fixture.emit(settleStatusEvent(String(run.id)));
    await fixture.flush();

    expect(fixture.chat.inspect).toHaveBeenCalledWith(run);
    expect(fixture.chat.dispatch).toHaveBeenCalledWith([run]);
    expect(fixture.applyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "settle-agent-run-result-delivery",
        runId: run.id,
        outcome: "delivered",
      }),
    );
  });

  it("taints the parent with a child's reply before the reply is delivered, and waits when it cannot", async () => {
    const run = finishedRun();
    const order: string[] = [];
    let recordable = false;
    const fixture = deliveryFixture({
      runs: [run],
      recordResultIngestion: (child) => {
        order.push(`taint ${String(child.parentThreadId)}`);
        return recordable;
      },
      chat: {
        dispatch: vi.fn(async (batch: ReadonlyArray<AgentRun>) => {
          order.push("dispatch");
          return { kind: "dispatched" as const, runIds: batch.map((child) => child.id) };
        }),
      },
    });
    fixture.emit(settleStatusEvent(String(run.id)));
    await fixture.flush();
    // An untainted parent never receives the reply.
    expect(order).toEqual([`taint ${String(run.parentThreadId)}`]);
    expect(fixture.applyCommand).not.toHaveBeenCalled();
    expect(fixture.timers).toHaveLength(1);

    recordable = true;
    fixture.timers[0]?.fire();
    await fixture.flush();
    expect(order.slice(1)).toEqual([`taint ${String(run.parentThreadId)}`, "dispatch"]);
    expect(fixture.applyCommand).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "delivered" }),
    );
  });

  it("arms a run that finished while the host was away when the service starts", async () => {
    const run = finishedRun();
    const fixture = deliveryFixture({ runs: [run] });
    fixture.service.start();
    await fixture.flush();

    expect(fixture.chat.dispatch).toHaveBeenCalledWith([run]);
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
            : { kind: "dispatched" as const, runIds: [run.id] };
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

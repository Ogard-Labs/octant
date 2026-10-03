import { describe, expect, it } from "vitest";
import {
  decodeNativeHarnessSlotCandidate,
  decodeProviderContextBlock,
  decodeProjectId,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunCommand,
  type NativeHarnessRouteDecision,
} from "@octant/contracts";
import { createAgentsManagedTools } from "../agentRun/agentRunManagedTools";
import type { AgentRunControlAdmissionDependencies } from "../agentRun/agentRunControlAdmission";
import { NativeHarnessRouter } from "./nativeHarnessRouter";
import { createNativeHarnessDelegatePort } from "./nativeHarnessDelegatePort";

const scope = {
  parentThreadId: "00000000-0000-4000-8000-000000000020",
  windowId: "window-1",
  mode: "code" as const,
  lead: {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    providerInstanceId: "00000000-0000-4000-8000-000000000001",
    modelId: "big",
  } as never,
};

function port(
  posture: "off" | "automatic",
  admitted: unknown[] = [],
  overrides: {
    readonly persistence?: Parameters<typeof createNativeHarnessDelegatePort>[0]["persistence"];
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly sessionStatus?: string;
  } = {},
) {
  return createNativeHarnessDelegatePort(
    {
      admission: {
        persistence: { getByRequestId: () => undefined },
        orchestration: {
          admit: () => {
            throw new Error("admit must not run");
          },
        },
        settings: { current: () => ({ creationPosture: posture }) },
        providerReadiness: { isReady: () => true },
        uuid: () => "00000000-0000-4000-8000-000000000099",
        authorizeCreation: () => {
          admitted.push("authorized");
          return undefined;
        },
        nativeEvidence: () => ({
          claimedNativeSupport: "unsupported",
          workspace: false,
          authority: false,
          observability: false,
          cancellation: false,
          steering: false,
          recovery: false,
        }),
      },
      orchestration: {
        start: () => {
          throw new Error("start must not run");
        },
      },
      persistence: overrides.persistence ?? {
        parentSummary: () => [],
        resultText: () => undefined,
        getById: () => undefined,
      },
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
      ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
      router: { resolve: () => ({ kind: "unroutable" }) as never },
      sessions: {
        ensure: () => ({}) as never,
        recordRouteDecision: () => undefined,
        read: () =>
          overrides.sessionStatus === undefined
            ? undefined
            : ({ session: { status: overrides.sessionStatus } } as never),
      },
      uuid: () => "00000000-0000-4000-8000-000000000098",
    },
    scope,
  );
}

describe("native harness delegate port", () => {
  it("refuses to start a child while children are off, without consulting authority", async () => {
    const touched: unknown[] = [];
    const outcome = await port("off", touched).start({
      role: "research",
      task: "Look",
      includeParentContext: false,
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "creation-posture-off" });
    expect(touched).toEqual([]);
  });

  it("starts no new helper while the run is paused, even with helpers on", async () => {
    for (const sessionStatus of ["paused-by-user", "paused-by-advisor", "recovery-required"]) {
      const outcome = await port("automatic", [], { sessionStatus }).start({
        role: "research",
        task: "Look",
        includeParentContext: false,
      });
      expect(outcome).toMatchObject({ status: "refused", reason: "session-paused" });
    }
  });

  it("admits through the shared path under Automatic and reports its refusal honestly", async () => {
    const touched: unknown[] = [];
    const outcome = await port("automatic", touched).start({
      role: "research",
      task: "Look",
      includeParentContext: false,
    });
    expect(touched).toEqual(["authorized"]);
    expect(outcome).toMatchObject({ status: "refused", reason: "unauthorized" });
  });

  it("only collects a child that belongs to this thread and has finished", async () => {
    const subject = port("automatic");
    expect(await subject.collect("00000000-0000-4000-8000-000000000050")).toEqual({
      status: "refused",
      reason: "run-not-found",
    });
  });

  it("waits until the named children finished, and says where they stand when time runs out", async () => {
    const first = "00000000-0000-4000-8000-000000000061";
    const joined = "00000000-0000-4000-8000-000000000062";
    const statuses: Record<string, string> = { [first]: "running", [joined]: "waiting" };
    let clock = 0;
    const subject = port("automatic", [], {
      persistence: {
        parentSummary: () =>
          [first, joined].map((runId) => ({
            runId,
            role: "research",
            task: "Look",
            lifecycleStatus: statuses[runId],
          })) as never,
        resultText: () => undefined,
        getById: (runId) =>
          (String(runId) === joined
            ? { dependsOn: [first], recoveryReason: "waiting-on-dependencies" }
            : {}) as never,
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        // The dependency finishes after the first poll; the joined run never does here.
        statuses[first] = "completed";
      },
    });

    const firstOnly = await subject.wait({ runIds: [first], timeoutMs: 10_000 });
    expect(firstOnly.finished).toBe(true);
    expect(firstOnly.children.map((child) => child.runId)).toEqual([first]);

    const everything = await subject.wait({ timeoutMs: 1_000 });
    expect(everything.finished).toBe(false);
    expect(everything.children.find((child) => child.runId === joined)).toMatchObject({
      lifecycleStatus: "waiting",
      after: [first],
      reason: "waiting-on-dependencies",
    });
  });
});

const routeLead = decodeNativeHarnessSlotCandidate({
  hostId: "00000000-0000-4000-8000-0000000000aa",
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "direct-model",
});
const routeChild = decodeNativeHarnessSlotCandidate({
  ...routeLead,
  providerInstanceId: "00000000-0000-4000-8000-000000000002",
  modelId: "provider-model",
});
const dependencyId = "00000000-0000-4000-8000-000000000061";
const allowedAuthority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: true,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

function delegationPair(
  options: {
    emptySlot?: boolean;
    excludedChild?: boolean;
    foreignDependency?: boolean;
    tainted?: boolean;
    paused?: boolean;
  } = {},
) {
  const commands: AgentRunCommand[] = [];
  const decisions: NativeHarnessRouteDecision[] = [];
  const projectId = decodeProjectId("00000000-0000-4000-8000-0000000000bb");
  const admitted = {
    id: dependencyId,
    parentThreadId: scope.parentThreadId,
    lifecycleStatus: "waiting",
    version: 1,
    recoveryReason: "waiting-on-dependencies",
  } as AgentRun;
  const admission: AgentRunControlAdmissionDependencies = {
    persistence: { getByRequestId: () => undefined },
    orchestration: {
      admit: (input) => {
        commands.push(input.command);
        return { kind: "run-accepted", run: admitted };
      },
    },
    settings: { current: () => ({ creationPosture: "automatic" }) },
    providerReadiness: { isReady: () => true },
    uuid: () => "00000000-0000-4000-8000-000000000099",
    authorizeCreation: () => ({
      parentMode: "chat",
      parentAuthority: allowedAuthority,
      liveAuthority: allowedAuthority,
      workspaceParent: { threadId: scope.parentThreadId, mode: "chat" },
      parentRoute: {
        providerInstanceId: routeLead.providerInstanceId,
        modelId: routeLead.modelId,
        projectId,
      },
    }),
    nativeEvidence: () => ({
      claimedNativeSupport: "unsupported",
      workspace: false,
      authority: false,
      observability: false,
      cancellation: false,
      steering: false,
      recovery: false,
    }),
    parentContext: {
      resolve: () => [
        decodeProviderContextBlock({ kind: "user-message", text: "bounded parent context" }),
      ],
    },
  };
  const persistence = {
    getById: () =>
      ({
        ...admitted,
        parentThreadId: options.foreignDependency ? "foreign" : scope.parentThreadId,
      }) as AgentRun,
    parentSummary: () => [],
    resultText: () => undefined,
  };
  const router = new NativeHarnessRouter({
    store: {
      host: () =>
        ({
          configuration: {
            slots: options.emptySlot ? [] : [{ id: "default", candidates: [routeLead] }],
            jobSlots: [{ job: "researcher", slotId: "default" }],
          },
          version: 1,
          updatedAt: "2026-10-03T10:00:00.000Z",
        }) as never,
      projectOverride: (id) =>
        String(id) === String(projectId)
          ? ({
              configuration: {
                slots: options.emptySlot
                  ? []
                  : [{ id: "default", candidates: [routeChild, routeLead] }],
                jobSlots: [],
              },
            } as never)
          : undefined,
    },
    isReady: () => true,
    now: () => Date.parse("2026-10-03T10:00:00.000Z"),
  });
  const listTargets = () =>
    [routeLead, ...(options.excludedChild ? [] : [routeChild])].map((candidate) => ({
      providerInstanceId: String(candidate.providerInstanceId),
      modelIds: [String(candidate.modelId)],
      displayName: String(candidate.modelId),
      driverKind: candidate === routeLead ? "openai" : "claude",
      reasoningByModel: { [String(candidate.modelId)]: ["high", "low"] },
    }));
  const common = {
    admission,
    orchestration: {
      start: () => {
        throw new Error("Dependency-parked child must not start");
      },
    },
    persistence,
    uuid: () => "00000000-0000-4000-8000-000000000098",
    listTargets,
    isTainted: () => options.tainted === true,
  };
  const native = createNativeHarnessDelegatePort(
    {
      ...common,
      router,
      sessions: {
        ensure: () => ({}) as never,
        read: () =>
          options.paused ? ({ session: { status: "paused-by-user" } } as never) : undefined,
        recordRouteDecision: (_thread, decision) => {
          decisions.push(decision);
        },
      },
    },
    { ...scope, mode: "chat", lead: routeLead },
  );
  const managed = createAgentsManagedTools({
    ...common,
    orchestration: { ...common.orchestration, cancelLeafFirst: async () => [] },
    mode: "chat",
    parentThreadId: scope.parentThreadId,
    windowId: scope.windowId,
    routing: {
      router,
      recordDecision: (_parent, decision) => {
        decisions.push(decision);
      },
    },
    isPaused: () => options.paused === true,
    authorizeCancel: () => true,
  });
  return {
    commands,
    decisions,
    native,
    managed,
    start: async (transport: "native" | "managed", input: Parameters<typeof native.start>[0]) =>
      transport === "native"
        ? native.start(input)
        : (
            await managed.execute({
              name: "octant_agents",
              inputJson: JSON.stringify({ operation: "delegate", ...input }),
            })
          ).result,
  };
}

describe("delegation parity", () => {
  for (const transport of ["native", "managed"] as const) {
    for (const target of [routeLead, routeChild]) {
      it(`${transport} delegation admits an explicit ${target.modelId} child with reasoning and sibling context`, async () => {
        const pair = delegationPair();
        const result = await pair.start(transport, {
          role: "research",
          task: "Combine the findings",
          providerInstanceId: String(target.providerInstanceId),
          modelId: String(target.modelId),
          reasoning: "high",
          after: [dependencyId],
          includeParentContext: true,
        });
        expect(result).toMatchObject({
          status: "accepted",
          target: {
            providerInstanceId: target.providerInstanceId,
            modelId: target.modelId,
            reasoning: "high",
          },
          lifecycleStatus: "waiting",
        });
        expect(pair.commands).toHaveLength(1);
        expect(pair.commands[0]).toMatchObject({
          dependsOn: [dependencyId],
          routingReceipt: {
            selectedProviderInstanceId: target.providerInstanceId,
            selectedModelId: target.modelId,
            rawReasoning: "high",
            admittedContextBlocks: 1,
          },
          requestedAuthority: { executionPolicy: "plan", filesystem: false, shell: false },
        });
      });
    }
    it(`${transport} delegation uses the authorized Project slot and records its fallback`, async () => {
      const primary = delegationPair();
      expect(await primary.start(transport, { role: "research", task: "Look" })).toMatchObject({
        status: "accepted",
        target: { modelId: routeChild.modelId },
      });
      expect(primary.decisions[0]).toMatchObject({ kind: "primary", candidate: routeChild });
      const fallback = delegationPair({ excludedChild: true });
      expect(await fallback.start(transport, { role: "research", task: "Look" })).toMatchObject({
        status: "accepted",
        target: { modelId: routeLead.modelId },
        route: { kind: "failure-fallback" },
      });
      expect(fallback.decisions[0]).toMatchObject({
        kind: "failure-fallback",
        from: routeChild,
        candidate: routeLead,
      });
    });
    it(`${transport} delegation refuses empty routes, foreign dependencies and a role outside Chat`, async () => {
      for (const [options, input, reason] of [
        [{ emptySlot: true }, { role: "research", task: "Look" }, "delegate-route-slot-empty"],
        [
          { foreignDependency: true },
          { role: "research", task: "Look", after: [dependencyId] },
          "dependency-not-found",
        ],
        [{}, { role: "implementation", task: "Edit code" }, "unsupported"],
        [{ paused: true }, { role: "research", task: "Look" }, "session-paused"],
      ] as const) {
        const pair = delegationPair(options);
        expect(await pair.start(transport, input)).toMatchObject({ status: "refused", reason });
        expect(pair.commands).toEqual([]);
      }
    });
    it(`${transport} delegation cannot create new authority from a tainted parent`, async () => {
      const pair = delegationPair({ tainted: true });
      expect(await pair.start(transport, { role: "research", task: "Look" })).toMatchObject(
        transport === "native"
          ? { status: "refused", reason: "delegate-tainted" }
          : { status: "error", error: "delegate-tainted" },
      );
      expect(pair.commands).toEqual([]);
    });
    it(`${transport} delegation refuses unsupported reasoning and a Project-excluded explicit target`, async () => {
      for (const options of [{}, { excludedChild: true }]) {
        const pair = delegationPair(options);
        const result = await pair.start(transport, {
          role: "research",
          task: "Look",
          providerInstanceId: String(routeChild.providerInstanceId),
          modelId: String(routeChild.modelId),
          reasoning: options.excludedChild ? "high" : "not-supported",
        });
        expect(result).toMatchObject(
          transport === "native"
            ? { status: "refused", reason: "delegate-target-unavailable" }
            : { status: "error", error: "delegate-target-unavailable" },
        );
        expect(pair.commands).toEqual([]);
      }
    });
  }
  it("reports the same bounded context and routing capabilities from both transports", async () => {
    const pair = delegationPair({ paused: true });
    const native = await pair.native.capabilities();
    const managed = await pair.managed.execute({
      name: "octant_agents",
      inputJson: JSON.stringify({ operation: "capabilities" }),
    });
    expect(managed.result).toEqual({ status: "ok", ...native });
    expect(native).toMatchObject({
      delegationBlocked: true,
      reason: "session-paused",
      dependencies: true,
      parentContext: true,
      targetSelection: { explicit: true, roleSlots: true },
    });
  });
});

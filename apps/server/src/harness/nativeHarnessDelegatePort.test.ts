import { describe, expect, it } from "vitest";
import {
  DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS,
  MAX_PROVIDER_TOOL_RESULT_BYTES,
  decodeNativeHarnessSlotCandidate,
  decodeNativeHarnessRouteDecision,
  NATIVE_HARNESS_BUILT_IN_SLOTS,
  type NativeHarnessSlotCandidate,
  decodeAggregateVersion,
  decodeUtcTimestamp,
  decodeProviderContextBlock,
  decodeProjectId,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunCommand,
  type AgentRunCommandResult,
  type NativeHarnessRouteDecision,
} from "@octant/contracts";
import { boundedToolResultJson } from "../providers/toolResultJson";
import { evaluateAgentRunCommand } from "@octant/domain";
import { createAgentsManagedTools } from "../agentRun/agentRunManagedTools";
import type { AgentRunControlAdmissionDependencies } from "../agentRun/agentRunControlAdmission";
import type { AgentRunParentSummaryEntry } from "../agentRun/agentRunProjection";
import type { AgentRunOrchestrationService } from "../agentRun/agentRunOrchestrationService";
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
        parentSummary: (): ReadonlyArray<AgentRunParentSummaryEntry> => [],
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
    configuredChildOnly?: boolean;
    unavailableChild?: boolean;
    unavailableParent?: boolean;
    excludedParent?: boolean;
    circuitOpen?: boolean;
    excludedChild?: boolean;
    foreignDependency?: boolean;
    tainted?: boolean;
    paused?: boolean;
    posture?: "off" | "ask" | "automatic";
    unauthorized?: boolean;
    parentAuthority?: AgentRunAuthority;
    liveAuthority?: AgentRunAuthority;
    run?: Partial<AgentRun>;
    noResume?: boolean;
    resumeResult?: AgentRunCommandResult;
    settlementFailure?: "failed" | "new-generation";
    resultText?: string;
  } = {},
) {
  const commands: AgentRunCommand[] = [];
  let currentParent: NativeHarnessSlotCandidate = routeLead;
  const resumes: Parameters<AgentRunOrchestrationService["resume"]>[] = [];
  const accepted: unknown[] = [];
  const authorizations: unknown[] = [];
  const decisions: NativeHarnessRouteDecision[] = [];
  const projectId = decodeProjectId("00000000-0000-4000-8000-0000000000bb");
  const admitted = {
    id: dependencyId,
    parentThreadId: scope.parentThreadId,
    lifecycleStatus: "waiting",
    version: 1,
    recoveryReason: "waiting-on-dependencies",
    executionKind: "octant-managed",
    role: "research",
    authority: allowedAuthority,
    routingReceipt: {
      mode: "chat",
      projectId,
      selectedProviderInstanceId: routeChild.providerInstanceId,
      selectedModelId: routeChild.modelId,
    },
    ...options.run,
  } as AgentRun;
  let stored = admitted;
  const settlements: AgentRunCommand[] = [];
  const admission: AgentRunControlAdmissionDependencies = {
    persistence: { getByRequestId: () => undefined },
    orchestration: {
      admit: (input) => {
        commands.push(input.command);
        return { kind: "run-accepted", run: admitted };
      },
    },
    settings: { current: () => ({ creationPosture: options.posture ?? "automatic" }) },
    providerReadiness: { isReady: () => true },
    uuid: () => "00000000-0000-4000-8000-000000000099",
    onExecutionAccepted: (input) => {
      accepted.push(input);
    },
    authorizeCreation: (input) => {
      authorizations.push(input);
      return options.unauthorized
        ? undefined
        : {
            parentMode: "chat",
            parentAuthority: options.parentAuthority ?? allowedAuthority,
            liveAuthority: options.liveAuthority ?? allowedAuthority,
            workspaceParent: { threadId: scope.parentThreadId, mode: "chat" },
            parentRoute: {
              providerInstanceId: currentParent.providerInstanceId,
              modelId: currentParent.modelId,
              ...(currentParent.reasoning === undefined
                ? {}
                : { reasoning: currentParent.reasoning }),
              projectId,
            },
          };
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
    parentContext: {
      resolve: () => [
        decodeProviderContextBlock({ kind: "user-message", text: "bounded parent context" }),
      ],
    },
  };
  const persistence = {
    applyCommand: (command: AgentRunCommand): AgentRunCommandResult => {
      settlements.push(command);
      if (options.settlementFailure !== undefined) {
        if (options.settlementFailure === "new-generation")
          stored = {
            ...stored,
            generation: 3,
            resultDelivery: {
              outcome: "delivered",
              settledAt: decodeUtcTimestamp("2026-10-03T12:00:00.000Z"),
            },
          };
        return {
          kind: "run-command-failed",
          reason: "stale-version",
          message: "Result changed before settlement.",
        };
      }
      stored = evaluateAgentRunCommand(
        stored,
        command,
        decodeUtcTimestamp("2026-10-03T12:00:00.000Z"),
      );
      return { kind: "run-updated", run: stored };
    },
    getById: () =>
      ({
        ...stored,
        parentThreadId: options.foreignDependency ? "foreign" : stored.parentThreadId,
      }) as AgentRun,
    parentSummary: (): ReadonlyArray<AgentRunParentSummaryEntry> => [
      {
        runId: stored.id,
        requestId: stored.requestId,
        parentThreadId: stored.parentThreadId,
        executionKind: stored.executionKind,
        usageQuality: "provider-reported",
        resultAcknowledgement: { required: false, acknowledged: false },
        route: {
          requestedProviderInstanceId: routeChild.providerInstanceId,
          requestedModelId: routeChild.modelId,
          executionProviderInstanceId: routeChild.providerInstanceId,
          executionModelId: routeChild.modelId,
          poolDerived: false,
        },
        version: stored.version,
        updatedAt: stored.updatedAt,
        role: stored.role,
        task: "Look",
        ...(stored.result === undefined ? {} : { resultText: "prior reply" }),
        lifecycleStatus: stored.lifecycleStatus,
        ...(stored.result === undefined ? {} : { result: stored.result }),
      },
    ],
    resultText: () => options.resultText ?? "prior reply",
  };
  const router = new NativeHarnessRouter({
    store: {
      host: () =>
        ({
          configuration: {
            slots: options.emptySlot ? [] : [{ id: "default", candidates: [routeLead] }],
            jobSlots: options.emptySlot
              ? DEFAULT_NATIVE_HARNESS_ROUTING_SETTINGS.configuration.jobSlots
              : [{ job: "researcher", slotId: "default" }],
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
                  : [
                      {
                        id: "default",
                        candidates: options.configuredChildOnly
                          ? [routeChild]
                          : [routeChild, routeLead],
                      },
                    ],
                jobSlots: [],
              },
            } as never)
          : undefined,
    },
    isReady: (candidate) =>
      !(
        options.unavailableChild && candidate.providerInstanceId === routeChild.providerInstanceId
      ) &&
      !(options.unavailableParent && candidate.providerInstanceId === routeLead.providerInstanceId),
    now: () => Date.parse("2026-10-03T10:00:00.000Z"),
  });
  if (options.circuitOpen) {
    for (let index = 0; index < 5; index += 1)
      router.reportFailure({
        slotId: NATIVE_HARNESS_BUILT_IN_SLOTS.default,
        candidate: routeChild,
        reason: "server-error",
      });
  }
  const listTargets = () =>
    [
      ...(options.excludedParent ? [] : [routeLead]),
      ...(options.excludedChild ? [] : [routeChild]),
    ].map((candidate) => ({
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
      ...(options.noResume
        ? {}
        : {
            resume: async (
              ...input: Parameters<AgentRunOrchestrationService["resume"]>
            ): Promise<AgentRunCommandResult> => {
              resumes.push(input);
              if (options.resumeResult !== undefined) return options.resumeResult;
              const result: AgentRunCommandResult = {
                kind: "run-updated",
                run: {
                  ...admitted,
                  lifecycleStatus: "starting",
                  version: decodeAggregateVersion(admitted.version + 1),
                  generation: (admitted.generation ?? 1) + 1,
                },
              };
              input[3]?.resolveLiveAuthority?.();
              input[3]?.onExecutionAccepted?.(result.run);
              return result;
            },
          }),
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
    setParentTarget: (candidate: NativeHarnessSlotCandidate) => {
      currentParent = candidate;
    },
    resumes,
    settlements,
    accepted,
    authorizations,
    native,
    managed,
    followUp: async (
      transport: "native" | "managed",
      input: { runId: string; expectedVersion: number; message: string },
    ) =>
      transport === "native"
        ? native.followUp?.(input)
        : (
            await managed.execute({
              name: "octant_agents",
              inputJson: JSON.stringify({ operation: "follow-up", ...input }),
            })
          ).result,
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
    it(`${transport} delegation inherits its authorized parent when no role or default slot is configured`, async () => {
      const pair = delegationPair({ emptySlot: true });
      expect(await pair.start(transport, { role: "research", task: "Look" })).toMatchObject({
        status: "accepted",
        target: { providerInstanceId: routeLead.providerInstanceId, modelId: routeLead.modelId },
        route: {
          kind: "inherited-parent",
          requestedSlotId: "task",
          candidate: {
            hostId: "local",
            providerInstanceId: routeLead.providerInstanceId,
            modelId: routeLead.modelId,
          },
        },
      });
      expect(pair.decisions[0]).toMatchObject({ kind: "inherited-parent", rejected: [] });
      expect(pair.decisions[0]).not.toHaveProperty("slotId");
      expect(decodeNativeHarnessRouteDecision(pair.decisions[0])).toEqual(pair.decisions[0]);
      expect(pair.commands).toHaveLength(1);
    });
    it(`${transport} delegation inherits the current authorized target and reasoning instead of a captured lead`, async () => {
      const pair = delegationPair({ emptySlot: true });
      pair.setParentTarget({ ...routeChild, reasoning: "low" });
      expect(await pair.start(transport, { role: "research", task: "Look" })).toMatchObject({
        status: "accepted",
        target: {
          providerInstanceId: routeChild.providerInstanceId,
          modelId: routeChild.modelId,
          reasoning: "low",
        },
        route: {
          kind: "inherited-parent",
          candidate: { modelId: routeChild.modelId, reasoning: "low" },
        },
      });
      expect(pair.commands[0]).toMatchObject({ routingReceipt: { rawReasoning: "low" } });
      expect(
        await pair.start(transport, { role: "research", task: "Look again", reasoning: "high" }),
      ).toMatchObject({
        status: "accepted",
        target: { modelId: routeChild.modelId, reasoning: "high" },
      });
    });
    it(`${transport} delegation cannot inherit an unavailable or policy-excluded parent or unsupported reasoning`, async () => {
      for (const options of [{ excludedParent: true }, { unavailableParent: true }, {}]) {
        const pair = delegationPair({ ...options, emptySlot: true });
        const input =
          options.excludedParent || options.unavailableParent
            ? { role: "research" as const, task: "Look" }
            : { role: "research" as const, task: "Look", reasoning: "not-supported" };
        expect(await pair.start(transport, input)).toMatchObject({
          status: "refused",
          reason: "delegate-route-no-eligible-candidate",
        });
        expect(pair.decisions[0]).toMatchObject({
          kind: "unroutable",
          rejected: [{ candidate: { modelId: routeLead.modelId } }],
        });
        expect(pair.commands).toEqual([]);
      }
    });
    it(`${transport} delegation never escapes a configured unavailable, denied or circuit-open route through its parent`, async () => {
      for (const options of [
        { unavailableChild: true },
        { excludedChild: true },
        { circuitOpen: true },
      ]) {
        const pair = delegationPair({ ...options, configuredChildOnly: true });
        expect(await pair.start(transport, { role: "research", task: "Look" })).toMatchObject({
          status: "refused",
          reason: options.circuitOpen
            ? "delegate-route-circuit-open"
            : "delegate-route-no-eligible-candidate",
        });
        expect(pair.decisions[0]).toMatchObject({ kind: "unroutable" });
        expect(pair.commands).toEqual([]);
      }
    });
    it(`${transport} delegation refuses foreign dependencies and a role outside Chat`, async () => {
      for (const [options, input, reason] of [
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

describe("completed child follow-up parity", () => {
  for (const transport of ["native", "managed"] as const) {
    it(`${transport} refuses a follow-up outside the current parent policy or child state`, async () => {
      const cases: ReadonlyArray<readonly [Parameters<typeof delegationPair>[0], string]> = [
        [{ posture: "off" }, "creation-posture-off"],
        [{ posture: "ask" }, "creation-posture-off"],
        [{ paused: true }, "session-paused"],
        [{ tainted: true }, "delegate-tainted"],
        [{ unauthorized: true }, "unauthorized"],
        [{ parentAuthority: { ...allowedAuthority, subagents: false } }, "unauthorized"],
        [{ liveAuthority: { ...allowedAuthority, tools: false } }, "authority-widening"],
        [{ excludedChild: true }, "delegate-target-unavailable"],
        [{ run: { parentThreadId: "foreign" as AgentRun["parentThreadId"] } }, "run-not-found"],
        [{ run: { version: 2 as AgentRun["version"] } }, "stale-version"],
        [{ run: { lifecycleStatus: "cancelled" } }, "unsupported-transition"],
        [{ run: { executionKind: "provider-native" } }, "unsupported-transition"],
        [{ noResume: true }, "follow-up-unavailable"],
      ];
      for (const [options, reason] of cases) {
        const pair = delegationPair({
          ...options,
          run: { lifecycleStatus: "completed", ...options?.run },
        });
        expect(
          await pair.followUp(transport, {
            runId: dependencyId,
            expectedVersion: 1,
            message: "Continue",
          }),
        ).toMatchObject({ status: "refused", reason });
        expect(pair.resumes).toEqual([]);
        expect(pair.accepted).toEqual([]);
        expect(pair.commands).toEqual([]);
      }
    });
    it(`${transport} settles the generation it collects and exposes the resulting current version`, async () => {
      const pair = delegationPair({
        run: {
          lifecycleStatus: "completed",
          generation: 2,
          result: { truncated: false } as AgentRun["result"],
        },
      });
      const collect = async () =>
        transport === "native"
          ? pair.native.collect(dependencyId)
          : (
              await pair.managed.execute({
                name: "octant_agents",
                inputJson: JSON.stringify({ operation: "wait", runId: dependencyId }),
              })
            ).result;
      expect(await collect()).toMatchObject({
        status: "completed",
        text: "prior reply",
        version: 2,
        generation: 2,
      });
      expect(pair.settlements).toEqual([
        {
          kind: "settle-agent-run-result-delivery",
          runId: dependencyId,
          expectedVersion: 1,
          generation: 2,
          outcome: "consumed",
        },
      ]);
      expect(await collect()).toMatchObject({ version: 2, generation: 2 });
      expect(pair.settlements).toHaveLength(1);
    });
    it(`${transport} leaves an oversized encoded reply owed and never returns a lossy preview as consumed`, async () => {
      const pair = delegationPair({
        resultText: "\u0000".repeat(16_384),
        run: {
          lifecycleStatus: "completed",
          generation: 2,
          result: { truncated: false } as AgentRun["result"],
        },
      });
      const result =
        transport === "native"
          ? await pair.native.collect(dependencyId)
          : (
              await pair.managed.execute({
                name: "octant_agents",
                inputJson: JSON.stringify({ operation: "wait", runId: dependencyId }),
              })
            ).result;
      expect(pair.settlements).toEqual([]);
      expect(result).toMatchObject(
        transport === "native"
          ? { status: "refused", reason: "result-too-large" }
          : { status: "error", error: "result-too-large" },
      );
      const encoded = boundedToolResultJson(result);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_PROVIDER_TOOL_RESULT_BYTES);
      expect(JSON.parse(encoded)).not.toHaveProperty("preview");
    });
    it(`${transport} includes metadata in the response budget before consuming an escaped reply`, async () => {
      for (const [length, fits] of [
        [10_899, true],
        [10_900, false],
      ] as const) {
        const text = "\u0000".repeat(length);
        const pair = delegationPair({
          resultText: text,
          run: {
            lifecycleStatus: "completed",
            generation: 2,
            result: { truncated: false } as AgentRun["result"],
          },
        });
        const result =
          transport === "native"
            ? await pair.native.collect(dependencyId)
            : (
                await pair.managed.execute({
                  name: "octant_agents",
                  inputJson: JSON.stringify({ operation: "wait", runId: dependencyId }),
                })
              ).result;
        const encoded = boundedToolResultJson(result);
        expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_PROVIDER_TOOL_RESULT_BYTES);
        expect(pair.settlements).toHaveLength(fits ? 1 : 0);
        expect(JSON.parse(encoded)).toMatchObject(
          fits
            ? { status: "completed", text, generation: 2, version: 2 }
            : transport === "native"
              ? { status: "refused", reason: "result-too-large" }
              : { status: "error", error: "result-too-large" },
        );
      }
    });
    it(`${transport} withholds a reply when its delivery cannot be settled for that generation`, async () => {
      for (const settlementFailure of ["failed", "new-generation"] as const) {
        const pair = delegationPair({
          settlementFailure,
          run: {
            lifecycleStatus: "completed",
            generation: 2,
            result: { truncated: false } as AgentRun["result"],
          },
        });
        const result =
          transport === "native"
            ? await pair.native.collect(dependencyId)
            : (
                await pair.managed.execute({
                  name: "octant_agents",
                  inputJson: JSON.stringify({ operation: "wait", runId: dependencyId }),
                })
              ).result;
        expect(result).toMatchObject(
          transport === "native"
            ? { status: "refused", reason: "result-delivery-unavailable" }
            : { status: "error", error: "result-delivery-unavailable" },
        );
        expect(result).not.toHaveProperty("text");
        expect(pair.settlements).toEqual([
          {
            kind: "settle-agent-run-result-delivery",
            runId: dependencyId,
            expectedVersion: 1,
            generation: 2,
            outcome: "consumed",
          },
        ]);
      }
    });
    it(`${transport} returns a resume refusal without binding a new execution`, async () => {
      const pair = delegationPair({
        run: { lifecycleStatus: "completed" },
        resumeResult: {
          kind: "run-command-failed",
          reason: "limit-reached",
          message: "No child slot is available.",
        },
      });
      expect(
        await pair.followUp(transport, {
          runId: dependencyId,
          expectedVersion: 1,
          message: "Continue",
        }),
      ).toEqual({
        status: "refused",
        reason: "limit-reached",
        message: "No child slot is available.",
      });
      expect(pair.resumes).toHaveLength(1);
      expect(pair.accepted).toEqual([]);
      expect(pair.commands).toEqual([]);
    });
    it(`${transport} reports the version and generation attached to the collected result`, async () => {
      const pair = delegationPair({
        run: {
          lifecycleStatus: "completed",
          generation: 2,
          result: { truncated: false } as AgentRun["result"],
        },
      });
      const status =
        transport === "native"
          ? await pair.native.status()
          : (
              await pair.managed.execute({
                name: "octant_agents",
                inputJson: JSON.stringify({ operation: "status" }),
              })
            ).result;
      expect(
        transport === "native" ? status : (status as { children: unknown[] }).children,
      ).toEqual([
        expect.objectContaining({
          runId: dependencyId,
          version: 1,
          generation: 2,
        }),
      ]);
      const collected =
        transport === "native"
          ? await pair.native.collect(dependencyId)
          : (
              await pair.managed.execute({
                name: "octant_agents",
                inputJson: JSON.stringify({ operation: "wait", runId: dependencyId }),
              })
            ).result;
      expect(collected).toMatchObject({
        status: "completed",
        version: 2,
        generation: 2,
        text: "prior reply",
      });
    });
    it(`${transport} continues the same child with an explicit message and current version`, async () => {
      const pair = delegationPair({
        run: {
          lifecycleStatus: "completed",
          resultDelivery: {
            outcome: "consumed",
            settledAt: decodeUtcTimestamp("2026-10-03T12:00:00.000Z"),
          },
        },
      });
      const input = {
        runId: dependencyId,
        expectedVersion: 1,
        message: "Compare that finding with the second source.",
      };
      expect(await pair.followUp(transport, input)).toMatchObject({
        status: "accepted",
        runId: dependencyId,
        lifecycleStatus: "starting",
        generation: 2,
        version: 2,
      });
      expect(pair.resumes).toEqual([
        [dependencyId, 1, allowedAuthority, expect.objectContaining({ message: input.message })],
      ]);
      expect(pair.authorizations).toEqual([
        { parentThreadId: scope.parentThreadId, windowId: scope.windowId },
        { parentThreadId: scope.parentThreadId, windowId: scope.windowId },
      ]);
      expect(pair.accepted).toEqual([
        {
          run: expect.objectContaining({ id: dependencyId, lifecycleStatus: "starting" }),
          windowId: scope.windowId,
          operation: "resume",
        },
      ]);
      expect(pair.commands).toEqual([]);
      expect(pair.decisions).toEqual([]);
    });
  }
});

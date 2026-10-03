import { describe, expect, it } from "vitest";
import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  type AgentRun,
  type AgentRunAuthority,
} from "@octant/contracts";
import type { AgentRunNativeCapabilityEvidence } from "@octant/domain/agent-run-control-policy";
import { createAgentsManagedTools, type AgentsToolTarget } from "./agentRunManagedTools";
import type { AgentRunControlParentFacts } from "./agentRunControlService";
import type { AgentRunOrchestrationService } from "./agentRunOrchestrationService";
import type { AgentRunParentSummaryEntry } from "./agentRunProjection";

const ids = {
  thread: "00000000-0000-4000-8000-000000000020",
  window: "window-1",
  provider: decodeProviderInstanceId("00000000-0000-4000-8000-000000000001"),
  run: "00000000-0000-4000-8000-0000000000a1",
};

const authority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: true,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

const ineligibleNative: AgentRunNativeCapabilityEvidence = {
  claimedNativeSupport: "unsupported",
  workspace: false,
  authority: false,
  observability: false,
  cancellation: false,
  steering: false,
  recovery: false,
};

function parentFacts(): AgentRunControlParentFacts {
  return {
    parentMode: "chat",
    parentAuthority: authority,
    liveAuthority: authority,
    workspaceParent: { threadId: ids.thread, mode: "chat" },
    parentRoute: {
      providerInstanceId: ids.provider,
      modelId: decodeProviderModelId("gpt-4o"),
    },
  };
}

function queuedRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: ids.run,
    parentThreadId: ids.thread,
    lifecycleStatus: "queued",
    version: 1,
    ...overrides,
  } as AgentRun;
}

const TARGETS: ReadonlyArray<AgentsToolTarget> = [
  {
    providerInstanceId: String(ids.provider),
    displayName: "OpenAI",
    driverKind: "openai",
    modelIds: ["gpt-4o", "gpt-4o-mini"],
  },
];

function tool(
  options: {
    posture?: "off" | "automatic";
    noRouting?: boolean;
    tainted?: boolean;
    targets?: ReadonlyArray<AgentsToolTarget>;
    admitted?: {
      admit?: (command: unknown) => ReturnType<AgentRunOrchestrationService["admit"]>;
      start?: () => ReturnType<AgentRunOrchestrationService["start"]>;
    };
    runs?: ReadonlyArray<AgentRun>;
    summary?: ReadonlyArray<AgentRunParentSummaryEntry>;
    authorizeCancel?: (run: AgentRun) => boolean;
  } = {},
) {
  const calls: string[] = [];
  return {
    calls,
    set: createAgentsManagedTools({
      admission: {
        persistence: { getByRequestId: () => undefined },
        orchestration: {
          admit: (input: { command: unknown }) => {
            calls.push("admit");
            const admit = options.admitted?.admit;
            if (admit !== undefined) return admit(input.command);
            return { kind: "run-accepted", run: queuedRun() } as never;
          },
        },
        settings: { current: () => ({ creationPosture: options.posture ?? "automatic" }) },
        providerReadiness: { isReady: () => true },
        uuid: () => "00000000-0000-4000-8000-0000000000ff",
        authorizeCreation: () => {
          calls.push("authorize");
          return parentFacts();
        },
        nativeEvidence: () => ineligibleNative,
      },
      orchestration: {
        start: () => {
          calls.push("start");
          const start = options.admitted?.start;
          if (start !== undefined) return start();
          return {
            kind: "run-updated",
            run: queuedRun({ lifecycleStatus: "running" }),
          } as never;
        },
        cancelLeafFirst: async () => {
          calls.push("cancel");
          return [
            { kind: "run-updated", run: queuedRun({ lifecycleStatus: "cancelled" }) },
          ] as never;
        },
      },
      persistence: {
        parentSummary: () => options.summary ?? [],
        getById: (runId) => options.runs?.find((run) => String(run.id) === String(runId)),
        resultText: (runId) => (String(runId) === ids.run ? "child reply" : undefined),
      },
      mode: "chat",
      windowId: ids.window,
      parentThreadId: ids.thread,
      listTargets: () => options.targets ?? TARGETS,
      isTainted: () => options.tainted ?? false,
      ...(options.noRouting
        ? {}
        : {
            routing: {
              router: {
                resolve: () =>
                  ({
                    kind: "primary",
                    job: "researcher",
                    slotId: "default",
                    decidedAt: "2026-10-03T10:00:00.000Z",
                    rejected: [],
                    candidate: {
                      hostId: "00000000-0000-4000-8000-0000000000aa",
                      providerInstanceId: ids.provider,
                      modelId: "gpt-4o",
                    },
                  }) as never,
              },
              recordDecision: () => undefined,
            },
          }),
      authorizeCancel: options.authorizeCancel ?? (() => true),
      uuid: () => "00000000-0000-4000-8000-0000000000ee",
      sleep: () => Promise.resolve(),
    }),
  };
}

function call(set: ReturnType<typeof tool>["set"], input: unknown) {
  return set.execute({
    name: "octant_agents",
    inputJson: JSON.stringify(input),
  });
}

describe("agents managed tools", () => {
  it("answers capabilities with the posture, allowed roles, and ready targets", async () => {
    const { set } = tool({ posture: "automatic" });
    const outcome = await call(set, { operation: "capabilities" });
    expect(outcome.result).toMatchObject({
      status: "ok",
      posture: "automatic",
      delegationBlocked: false,
      targets: [
        {
          providerInstanceId: String(ids.provider),
          displayName: "OpenAI",
          modelIds: ["gpt-4o", "gpt-4o-mini"],
        },
      ],
    });
    expect((outcome.result as { roles: string[] }).roles.length).toBeGreaterThan(0);
  });

  it("refuses to delegate while subagents are off, without consulting authority", async () => {
    const { set, calls } = tool({ posture: "off" });
    const outcome = await call(set, { operation: "delegate", task: "Look" });
    expect(outcome.result).toMatchObject({
      status: "refused",
      reason: "creation-posture-off",
    });
    expect(calls).toEqual([]);
  });

  it("refuses to delegate from a thread carrying untrusted content", async () => {
    const { set, calls } = tool({ tainted: true });
    const outcome = await call(set, { operation: "delegate", task: "Look" });
    expect(outcome.result).toMatchObject({ status: "error", error: "delegate-tainted" });
    expect(calls).toEqual([]);
  });

  it("refuses a delegation target that is not in the advertised set", async () => {
    const { set, calls } = tool();
    const outcome = await call(set, {
      operation: "delegate",
      task: "Look",
      providerInstanceId: "00000000-0000-4000-8000-000000000009",
      modelId: "gpt-4o",
    });
    expect(outcome.result).toMatchObject({
      status: "error",
      error: "delegate-target-unavailable",
    });
    expect(calls).toEqual([]);
  });

  it("admits a delegation through the shared path and starts the queued child", async () => {
    const { set, calls } = tool();
    const outcome = await call(set, {
      operation: "delegate",
      task: "Summarize the diff",
      role: "research",
    });
    expect(calls).toEqual(["authorize", "admit", "start"]);
    expect(outcome.result).toMatchObject({
      status: "accepted",
      runId: ids.run,
      lifecycleStatus: "running",
    });
  });

  it("refuses an unavailable role route instead of silently inheriting the parent", async () => {
    const { set } = tool({ noRouting: true });
    const outcome = await call(set, {
      operation: "delegate",
      task: "Look",
      reasoning: "high",
    });
    expect(outcome.result).toMatchObject({
      status: "refused",
      reason: "delegate-routing-unavailable",
    });
  });

  it("rejects a foreign dependency before workspace or child admission", async () => {
    const { set, calls } = tool({ runs: [queuedRun({ parentThreadId: "foreign" as never })] });
    const outcome = await call(set, {
      operation: "delegate",
      task: "Look",
      after: [ids.run],
      providerInstanceId: String(ids.provider),
      modelId: "gpt-4o",
    });
    expect(outcome.result).toMatchObject({ status: "refused", reason: "dependency-not-found" });
    expect(calls).not.toContain("admit");
  });

  it("keeps a delegation awaiting person confirmation queued instead of starting it", async () => {
    const { set, calls } = tool({
      admitted: {
        admit: () => ({ kind: "run-accepted", run: queuedRun({ recoveryReason: "x" }) }),
      },
    });
    const outcome = await call(set, { operation: "delegate", task: "Look" });
    expect(calls).toEqual(["authorize", "admit"]);
    expect(outcome.result).toMatchObject({
      status: "accepted",
      runId: ids.run,
      lifecycleStatus: "queued",
    });
  });

  it("reports the admission's refusal instead of inventing a child", async () => {
    const { set } = tool({
      admitted: {
        admit: () => ({ kind: "run-command-failed", reason: "limit-reached", message: "Full." }),
      },
    });
    const outcome = await call(set, { operation: "delegate", task: "Look" });
    expect(outcome.result).toMatchObject({ status: "refused", reason: "limit-reached" });
  });

  it("lists only this thread's children on status", async () => {
    const { set } = tool({
      summary: [
        {
          runId: ids.run as never,
          requestId: "req-1" as never,
          parentThreadId: ids.thread as never,
          role: "research",
          task: "Look",
          lifecycleStatus: "completed",
          executionKind: "octant-managed",
          usageQuality: "provider-reported",
          route: {
            requestedProviderInstanceId: ids.provider,
            requestedModelId: decodeProviderModelId("gpt-4o"),
            executionProviderInstanceId: ids.provider,
            executionModelId: decodeProviderModelId("gpt-4o"),
            poolDerived: false,
          },
          resultAcknowledgement: "pending" as never,
          result: {} as never,
          resultText: "child reply",
          version: 1 as never,
          updatedAt: "2026-07-19T22:10:00.000Z" as never,
        } as AgentRunParentSummaryEntry,
      ],
    });
    const outcome = await call(set, { operation: "status" });
    expect(outcome.result).toMatchObject({
      status: "ok",
      children: [
        {
          runId: ids.run,
          lifecycleStatus: "completed",
          resultAvailable: true,
          resultText: "child reply",
        },
      ],
    });
  });

  it("waits for a completed child and returns its result text", async () => {
    const { set } = tool({
      runs: [queuedRun({ lifecycleStatus: "completed", result: { text: "x" } as never })],
    });
    const outcome = await call(set, { operation: "wait", runId: ids.run, timeoutMs: 10 });
    expect(outcome.result).toMatchObject({
      status: "completed",
      runId: ids.run,
      text: "child reply",
    });
  });

  it("answers a running child's wait with its live status after the timeout", async () => {
    const { set } = tool({ runs: [queuedRun({ lifecycleStatus: "running" })] });
    const outcome = await call(set, { operation: "wait", runId: ids.run, timeoutMs: 0 });
    expect(outcome.result).toMatchObject({
      status: "still-running",
      lifecycleStatus: "running",
    });
  });

  it("reports a child's provider-limit wait on status instead of a pending result", async () => {
    const usageLimit = {
      kind: "exhausted",
      resetsAt: "2026-07-20T00:00:00.000Z",
    } as never;
    const { set } = tool({
      summary: [
        {
          runId: ids.run as never,
          requestId: "req-1" as never,
          parentThreadId: ids.thread as never,
          role: "research",
          task: "Look",
          lifecycleStatus: "waiting",
          executionKind: "octant-managed",
          usageQuality: "provider-reported",
          route: {
            requestedProviderInstanceId: ids.provider,
            requestedModelId: decodeProviderModelId("gpt-4o"),
            executionProviderInstanceId: ids.provider,
            executionModelId: decodeProviderModelId("gpt-4o"),
            poolDerived: false,
          },
          resultAcknowledgement: "pending" as never,
          usageLimit,
          usageResume: { status: "scheduled" } as never,
          version: 3 as never,
          updatedAt: "2026-07-19T22:10:00.000Z" as never,
        } as AgentRunParentSummaryEntry,
      ],
    });
    const outcome = await call(set, { operation: "status" });
    expect(outcome.result).toMatchObject({
      status: "ok",
      children: [
        {
          runId: ids.run,
          lifecycleStatus: "waiting",
          usageLimit,
          usageResume: { status: "scheduled" },
        },
      ],
    });
    expect(
      (outcome.result as { children: Array<{ resultText?: string }> }).children[0],
    ).not.toHaveProperty("resultText");
  });

  it("answers a provider-limit wait immediately instead of blocking to the deadline", async () => {
    const { set } = tool({
      runs: [
        queuedRun({
          lifecycleStatus: "waiting",
          usageLimit: { kind: "exhausted", resetsAt: "2026-07-20T00:00:00.000Z" } as never,
          usageResume: { status: "scheduled" } as never,
        }),
      ],
    });
    const started = Date.now();
    const outcome = await call(set, { operation: "wait", runId: ids.run, timeoutMs: 120_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.result).toMatchObject({
      status: "waiting",
      lifecycleStatus: "waiting",
      usageLimit: { kind: "exhausted" },
      usageResume: { status: "scheduled" },
    });
    expect(outcome.result).not.toHaveProperty("text");
  });

  it("refuses to wait on a child belonging to another parent", async () => {
    const { set } = tool({
      runs: [queuedRun({ parentThreadId: "00000000-0000-4000-8000-000000000099" as never })],
    });
    const outcome = await call(set, { operation: "wait", runId: ids.run, timeoutMs: 0 });
    expect(outcome.result).toMatchObject({ status: "error", error: "run-not-found" });
  });

  it("cancels this thread's child through the leaf-first path", async () => {
    const { set, calls } = tool({ runs: [queuedRun({ lifecycleStatus: "running" })] });
    const outcome = await call(set, { operation: "cancel", runId: ids.run });
    expect(calls).toEqual(["cancel"]);
    expect(outcome.result).toMatchObject({ status: "cancelled", runId: ids.run });
  });

  it("refuses to cancel when the window lacks cancellation authority", async () => {
    const { set, calls } = tool({
      runs: [queuedRun({ lifecycleStatus: "running" })],
      authorizeCancel: () => false,
    });
    const outcome = await call(set, { operation: "cancel", runId: ids.run });
    expect(calls).toEqual([]);
    expect(outcome.result).toMatchObject({ status: "error", error: "cancel-unauthorized" });
  });

  it("rejects malformed input without touching admission", async () => {
    const { set, calls } = tool();
    const outcome = await call(set, { operation: "delegate" });
    expect(outcome.result).toMatchObject({ status: "error", error: "invalid-agents-input" });
    expect(calls).toEqual([]);
  });
});

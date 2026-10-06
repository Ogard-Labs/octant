import {
  AGENT_RUN_TERMINAL_STATUSES,
  type AgentRunParentThreadId,
  type NativeHarnessSlotCandidate,
  type NativeHarnessRouteDecision,
  NATIVE_HARNESS_BUILT_IN_SLOTS,
  type OctantMode,
  type ProjectId,
} from "@octant/contracts";
import { type AgentRunControlAdmissionDependencies } from "../agentRun/agentRunControlAdmission";
import {
  agentRunDelegationCapabilities,
  followUpAgentRunDelegation,
  collectAgentRunResult,
  startAgentRunDelegation,
  type AgentsToolTarget,
} from "../agentRun/agentRunDelegation";
import type { AgentRunControlParentFacts } from "../agentRun/agentRunControlService";
import type { AgentRunOrchestrationService } from "../agentRun/agentRunOrchestrationService";
import type { AgentRunPersistenceService } from "../agentRun/agentRunPersistenceService";
import type { NativeHarnessRouter } from "./nativeHarnessRouter";
import type { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";
import type {
  NativeHarnessDelegateChild,
  NativeHarnessDelegateCollect,
  NativeHarnessDelegatePort,
  NativeHarnessDelegateStart,
} from "./nativeHarnessTools";

export interface NativeHarnessDelegatePortOptions {
  readonly admission: AgentRunControlAdmissionDependencies;
  readonly orchestration: Pick<AgentRunOrchestrationService, "start"> &
    Partial<Pick<AgentRunOrchestrationService, "resume">>;
  readonly persistence: Pick<
    AgentRunPersistenceService,
    "parentSummary" | "resultText" | "getById"
  > &
    Partial<Pick<AgentRunPersistenceService, "applyCommand">>;
  readonly router: Pick<NativeHarnessRouter, "resolve">;
  readonly sessions: Pick<NativeHarnessSessionStore, "ensure" | "recordRouteDecision" | "read">;
  readonly uuid: () => string;
  readonly listTargets?: () => ReadonlyArray<AgentsToolTarget>;
  readonly isTainted?: () => boolean;
  /** Injectable so tests drive `wait` without real time passing. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const WAIT_POLL_MS = 250;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(AGENT_RUN_TERMINAL_STATUSES);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Delegation from a lead model, the only way a subagent starts. The model
 * names a role and a task; the host admits the child from its own records of
 * the parent thread, picks its model from the role's slot, journals that
 * routing decision on the parent's harness session, and starts the run. The
 * child's reply comes back to the model through `collect`. With subagents
 * turned off in Settings nothing starts.
 */
export function createNativeHarnessDelegatePort(
  options: NativeHarnessDelegatePortOptions,
  scope: {
    readonly parentThreadId: string;
    readonly windowId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId | undefined;
    readonly lead: NativeHarnessSlotCandidate;
  },
): NativeHarnessDelegatePort {
  const parentThreadId = scope.parentThreadId as AgentRunParentThreadId;
  const children = (): ReadonlyArray<NativeHarnessDelegateChild> =>
    options.persistence.parentSummary(parentThreadId).map((entry) => {
      const run = options.persistence.getById(entry.runId);
      return {
        runId: String(entry.runId),
        role: entry.role,
        task: entry.task,
        lifecycleStatus: entry.lifecycleStatus,
        resultAvailable: entry.result !== undefined,
        ...(run === undefined ? {} : { version: run.version, generation: run.generation ?? 1 }),
        route: entry.route,
        ...(run?.routingReceipt?.rawReasoning === undefined
          ? {}
          : { reasoning: run.routingReceipt.rawReasoning }),
        ...(run?.dependsOn === undefined ? {} : { after: run.dependsOn.map(String) }),
        ...(run?.recoveryReason === undefined ? {} : { reason: run.recoveryReason }),
      };
    });
  const delegation = {
    ...options,
    ...scope,
    listTargets: options.listTargets ?? (() => []),
    isPaused: () => {
      const status = options.sessions.read(scope.parentThreadId)?.session.status;
      return (
        status === "paused-by-user" ||
        status === "paused-by-advisor" ||
        status === "recovery-required"
      );
    },
    routing: {
      router: options.router,
      recordDecision: (
        _parent: AgentRunControlParentFacts,
        decision: NativeHarnessRouteDecision,
      ) => {
        options.sessions.ensure({
          threadId: scope.parentThreadId,
          mode: scope.mode,
          projectId: scope.projectId,
          leadSlotId: NATIVE_HARNESS_BUILT_IN_SLOTS.default,
          lead: scope.lead,
        });
        options.sessions.recordRouteDecision(scope.parentThreadId, decision);
      },
    },
  };
  return {
    capabilities: async () => agentRunDelegationCapabilities(delegation),
    start: async (input): Promise<NativeHarnessDelegateStart> =>
      startAgentRunDelegation(delegation, input),
    followUp: async (input) => followUpAgentRunDelegation(delegation, input),
    status: async (): Promise<ReadonlyArray<NativeHarnessDelegateChild>> => children(),
    wait: async ({ runIds, timeoutMs, signal }) => {
      const wanted = runIds === undefined ? undefined : new Set(runIds);
      const deadline = (options.now ?? Date.now)() + timeoutMs;
      const sleep = options.sleep ?? defaultSleep;
      for (;;) {
        const watched = children().filter(
          (child) => wanted === undefined || wanted.has(child.runId),
        );
        const finished = watched.every((child) => TERMINAL_STATUSES.has(child.lifecycleStatus));
        const remaining = deadline - (options.now ?? Date.now)();
        if (finished || remaining <= 0 || signal?.aborted === true) {
          return { finished, children: watched };
        }
        await sleep(Math.min(WAIT_POLL_MS, remaining), signal);
      }
    },
    collect: async (runId): Promise<NativeHarnessDelegateCollect> => {
      const run = options.persistence.getById(runId as never);
      if (run === undefined || String(run.parentThreadId) !== scope.parentThreadId) {
        return { status: "refused", reason: "run-not-found" };
      }
      if (run.lifecycleStatus !== "completed" || run.result === undefined) {
        return {
          status: "not-ready",
          lifecycleStatus: run.lifecycleStatus,
          version: run.version,
          generation: run.generation ?? 1,
        };
      }
      const text = options.persistence.resultText(run.id);
      if (text === undefined) return { status: "refused", reason: "result-unavailable" };
      return collectAgentRunResult(options.persistence, run, text);
    },
  };
}

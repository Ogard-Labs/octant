import {
  AGENT_RUN_TERMINAL_STATUSES,
  decodeAgentRunControlRequest,
  type AgentRunControlRequest,
  type AgentRunParentThreadId,
  type NativeHarnessSlotCandidate,
  type OctantMode,
  type ProjectId,
} from "@octant/contracts";
import { nativeHarnessJobForRole } from "@octant/domain";
import {
  admitAgentRunControlRequest,
  type AgentRunControlAdmissionDependencies,
} from "../agentRun/agentRunControlAdmission";
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
  readonly orchestration: Pick<AgentRunOrchestrationService, "start">;
  readonly persistence: Pick<
    AgentRunPersistenceService,
    "parentSummary" | "resultText" | "getById"
  >;
  readonly router: Pick<NativeHarnessRouter, "resolve">;
  readonly sessions: Pick<NativeHarnessSessionStore, "ensure" | "recordRouteDecision">;
  readonly uuid: () => string;
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
        ...(run?.dependsOn === undefined ? {} : { after: run.dependsOn.map(String) }),
        ...(run?.recoveryReason === undefined ? {} : { reason: run.recoveryReason }),
      };
    });
  return {
    start: async (input): Promise<NativeHarnessDelegateStart> => {
      // The settings store never reports Ask (it reads a stored Ask as Off),
      // so anything but Automatic is a person having turned subagents off.
      if (options.admission.settings.current().creationPosture !== "automatic") {
        return {
          status: "refused",
          reason: "creation-posture-off",
          message: "Subagents are turned off in Settings → Octant Harness → Helper agents.",
        };
      }
      let controlRequest: AgentRunControlRequest;
      try {
        controlRequest = decodeAgentRunControlRequest({
          requestId: options.uuid(),
          parentThreadId: scope.parentThreadId,
          role: input.role,
          task: input.task,
          ...(input.includeParentContext ? { includeParentContext: true } : {}),
          ...(input.after === undefined || input.after.length === 0
            ? {}
            : { dependsOn: input.after }),
        });
      } catch {
        return { status: "refused", reason: "invalid-delegation" };
      }
      options.sessions.ensure({
        threadId: scope.parentThreadId,
        mode: scope.mode,
        projectId: scope.projectId,
        leadSlotId: "default" as never,
        lead: scope.lead,
      });
      const admission = await admitAgentRunControlRequest(options.admission, {
        controlRequest,
        windowId: scope.windowId,
        confirmed: false,
        routeOverride: (parent) => {
          const decision = options.router.resolve({
            job: nativeHarnessJobForRole(input.role),
            projectId: scope.projectId,
          });
          options.sessions.recordRouteDecision(scope.parentThreadId, decision);
          if (decision.kind === "unroutable") return undefined;
          return {
            providerInstanceId: decision.candidate.providerInstanceId,
            modelId: decision.candidate.modelId,
            ...(decision.candidate.reasoning === undefined
              ? {}
              : { reasoning: decision.candidate.reasoning }),
            ...(parent.parentRoute.projectId === undefined
              ? {}
              : { projectId: parent.parentRoute.projectId }),
          };
        },
      });
      if (admission.kind === "refused") {
        return { status: "refused", reason: admission.reason };
      }
      if (admission.kind === "invalid") {
        return { status: "refused", reason: "invalid-delegation", message: admission.message };
      }
      const accepted =
        "kind" in admission.result
          ? admission.result
          : ({ kind: "run-accepted", run: admission.result } as const);
      if (accepted.kind === "run-command-failed") {
        return { status: "refused", reason: accepted.reason, message: accepted.message };
      }
      const run = accepted.run;
      if (run.lifecycleStatus === "queued" && run.recoveryReason === undefined) {
        const started = options.orchestration.start(run.id, run.version, admission.liveAuthority);
        if (started.kind === "run-command-failed") {
          return { status: "refused", reason: started.reason, message: started.message };
        }
        return {
          status: "accepted",
          runId: String(run.id),
          lifecycleStatus: started.run.lifecycleStatus,
        };
      }
      return { status: "accepted", runId: String(run.id), lifecycleStatus: run.lifecycleStatus };
    },
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
        return { status: "not-ready", lifecycleStatus: run.lifecycleStatus };
      }
      const text = options.persistence.resultText(run.id);
      if (text === undefined) return { status: "refused", reason: "result-unavailable" };
      return { status: "completed", text, truncated: run.result.truncated };
    },
  };
}

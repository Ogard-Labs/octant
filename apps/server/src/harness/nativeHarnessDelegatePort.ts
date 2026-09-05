import {
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
}

/**
 * Delegation from a lead model. The model names a role and a task; the host
 * admits the child through the same path a person's request takes, picks its
 * model from the role's slot, journals that routing decision on the parent's
 * harness session, and starts the run. Under the Ask posture nothing starts:
 * the model is told the user must create children by hand or set Automatic,
 * because a model asking is not a person confirming.
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
  return {
    start: async (input): Promise<NativeHarnessDelegateStart> => {
      const posture = options.admission.settings.current().creationPosture;
      if (posture === "off") {
        return {
          status: "refused",
          reason: "creation-posture-off",
          message: "Child runs are turned off in Settings → Agents.",
        };
      }
      if (posture === "ask") {
        return {
          status: "refused",
          reason: "creation-posture-ask",
          message:
            "Child runs need a person's confirmation under the Ask posture. Ask the user to start the child, or to set the posture to Automatic.",
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
    status: async (): Promise<ReadonlyArray<NativeHarnessDelegateChild>> =>
      options.persistence.parentSummary(parentThreadId).map((entry) => ({
        runId: String(entry.runId),
        role: entry.role,
        task: entry.task,
        lifecycleStatus: entry.lifecycleStatus,
        resultAvailable: entry.result !== undefined,
      })),
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

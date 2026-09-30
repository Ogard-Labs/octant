import {
  AGENT_RUN_TERMINAL_STATUSES,
  decodeAgentRunControlRequest,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type AgentRun,
  type AgentRunControlRequest,
  type AgentRunId,
  type AgentRunLifecycleStatus,
  type AgentRunRole,
  type OctantMode,
} from "@octant/contracts";
import { allowedAgentRunRolesForMode } from "@octant/domain/agent-run-control-policy";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import {
  admitAgentRunControlRequest,
  type AgentRunControlAdmissionDependencies,
} from "./agentRunControlAdmission";
import type {
  AgentRunControlParentFacts,
  AgentRunParentRouteFacts,
} from "./agentRunControlService";
import type { AgentRunOrchestrationService } from "./agentRunOrchestrationService";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";

/**
 * One provider instance+model the calling thread may target for a child run.
 * The host computes eligibility; the tool only reports what was handed in.
 */
export interface AgentsToolTarget {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly driverKind: string;
  readonly modelIds: ReadonlyArray<string>;
}

export interface AgentsManagedToolsOptions {
  readonly admission: AgentRunControlAdmissionDependencies;
  readonly orchestration: Pick<AgentRunOrchestrationService, "start" | "cancelLeafFirst">;
  readonly persistence: Pick<
    AgentRunPersistenceService,
    "parentSummary" | "getById" | "resultText"
  >;
  readonly mode: OctantMode;
  readonly windowId: string;
  readonly parentThreadId: string;
  readonly listTargets: () => ReadonlyArray<AgentsToolTarget>;
  readonly isTainted: () => boolean;
  /**
   * The host's cancellation authority for this run on this window, in addition
   * to the occurrence-bound parent check the tool always applies first.
   */
  readonly authorizeCancel: (run: AgentRun) => boolean;
  readonly uuid: () => string;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const AGENTS_TOOL_NAME = "octant_agents";

const AGENTS_TOOL_DEFINITION = {
  name: AGENTS_TOOL_NAME,
  description:
    "Delegate part of this task to a child agent run the host owns and supervises. Use capabilities to see which provider models you may target and the current creation posture. delegate creates one child with a bounded task; it runs asynchronously and appears in the Agents surface. status lists this thread's children; wait blocks briefly for one child's terminal state and returns its result when completed; cancel stops one of this thread's children. Child refs from another parent cannot be used here. A delegation can be refused when subagents are off in Settings or need the person's confirmation.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["capabilities", "delegate", "status", "wait", "cancel"],
      },
      task: {
        type: "string",
        maxLength: 8192,
        description: "Bounded task for the child run. Required for delegate.",
      },
      role: {
        type: "string",
        enum: ["research", "implementation", "review", "custom"],
        description: "Child role for delegate; defaults to the first role this mode allows.",
      },
      providerInstanceId: {
        type: "string",
        maxLength: 128,
        description:
          "Delegation target from capabilities. Requires modelId; omit both to use this thread's own provider and model.",
      },
      modelId: {
        type: "string",
        maxLength: 128,
        description: "Model on the target provider instance. Requires providerInstanceId.",
      },
      includeParentContext: {
        type: "boolean",
        description: "Give the child this thread's recent conversation.",
      },
      runId: {
        type: "string",
        maxLength: 128,
        description: "Child run id for wait/cancel, or to narrow status.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 0,
        maximum: 120_000,
        description: "How long wait blocks before returning the current status (max 120000).",
      },
    },
    additionalProperties: false,
    required: ["operation"],
  },
} as const;

type AgentsToolFailure =
  | "tool-unavailable"
  | "tool-interrupted"
  | "invalid-agents-input"
  | "delegate-tainted"
  | "delegate-target-unavailable"
  | "run-not-found"
  | "cancel-unauthorized";

interface AgentsToolInput {
  readonly operation: "capabilities" | "delegate" | "status" | "wait" | "cancel";
  readonly task?: string;
  readonly role?: AgentRunRole;
  readonly providerInstanceId?: string;
  readonly modelId?: string;
  readonly includeParentContext?: boolean;
  readonly runId?: string;
  readonly timeoutMs?: number;
}

function failure(reason: AgentsToolFailure, message?: string) {
  return {
    result: {
      status: "error" as const,
      error: reason,
      ...(message === undefined ? {} : { message }),
    },
    isError: true,
  };
}

function answer(result: unknown) {
  return { result };
}

function parseRole(value: unknown): AgentRunRole | undefined {
  return value === "research" ||
    value === "implementation" ||
    value === "review" ||
    value === "custom"
    ? value
    : undefined;
}

function parseInput(inputJson: string): AgentsToolInput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const operation = record.operation;
  if (
    operation !== "capabilities" &&
    operation !== "delegate" &&
    operation !== "status" &&
    operation !== "wait" &&
    operation !== "cancel"
  )
    return undefined;
  const task = record.task;
  if (task !== undefined && (typeof task !== "string" || task.trim().length === 0))
    return undefined;
  const role = record.role;
  if (role !== undefined && parseRole(role) === undefined) return undefined;
  const parsedRole = role === undefined ? undefined : parseRole(role);
  const providerInstanceId = record.providerInstanceId;
  if (providerInstanceId !== undefined && typeof providerInstanceId !== "string") return undefined;
  const modelId = record.modelId;
  if (modelId !== undefined && typeof modelId !== "string") return undefined;
  const includeParentContext = record.includeParentContext;
  if (includeParentContext !== undefined && typeof includeParentContext !== "boolean")
    return undefined;
  const runId = record.runId;
  if (runId !== undefined && typeof runId !== "string") return undefined;
  const timeoutMs = record.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs)))
    return undefined;
  return {
    operation,
    ...(task === undefined ? {} : { task: task.trim() }),
    ...(parsedRole === undefined ? {} : { role: parsedRole }),
    ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(includeParentContext === undefined ? {} : { includeParentContext }),
    ...(runId === undefined ? {} : { runId }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function isTerminal(status: AgentRunLifecycleStatus): boolean {
  return (AGENT_RUN_TERMINAL_STATUSES as ReadonlyArray<string>).includes(status);
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The agent-facing half of child AgentRun control: one object-shaped tool a
 * turn's provider can call. Every request is admitted through the same
 * `admitAgentRunControlRequest` path the Agents dock uses — posture, parent
 * authority, workspace, idempotency, and capacity are decided by the server
 * from its own records, never from the model's payload. Refs are
 * occurrence-bound to the calling thread: status lists only its children and
 * wait/cancel refuse a run that belongs to another parent.
 */
export function createAgentsManagedTools(options: AgentsManagedToolsOptions): AppManagedToolSet {
  const sleep = options.sleep ?? defaultSleep;
  const childRun = (runId: string): AgentRun | undefined => {
    let run: AgentRun | undefined;
    try {
      run = options.persistence.getById(runId as AgentRunId);
    } catch {
      return undefined;
    }
    return run !== undefined && String(run.parentThreadId) === options.parentThreadId
      ? run
      : undefined;
  };
  return {
    definitions: [AGENTS_TOOL_DEFINITION],
    execute: async ({ name, inputJson, signal }) => {
      if (name !== AGENTS_TOOL_NAME) return failure("tool-unavailable");
      if (signal?.aborted) return failure("tool-interrupted");
      const input = parseInput(inputJson);
      if (input === undefined) return failure("invalid-agents-input");

      if (input.operation === "capabilities") {
        return answer({
          status: "ok",
          posture: options.admission.settings.current().creationPosture,
          delegationBlocked: options.isTainted(),
          roles: [...allowedAgentRunRolesForMode(options.mode)],
          targets: options.listTargets().map((target) => ({
            providerInstanceId: target.providerInstanceId,
            displayName: target.displayName,
            driverKind: target.driverKind,
            modelIds: [...target.modelIds],
          })),
        });
      }

      if (input.operation === "status") {
        const children = options.persistence
          .parentSummary(options.parentThreadId as AgentRun["parentThreadId"])
          .filter((entry) => input.runId === undefined || String(entry.runId) === input.runId);
        return answer({
          status: "ok",
          children: children.map((entry) => ({
            runId: String(entry.runId),
            role: entry.role,
            task: entry.task,
            lifecycleStatus: entry.lifecycleStatus,
            resultAvailable: entry.result !== undefined,
            ...(entry.resultText === undefined ? {} : { resultText: entry.resultText }),
            // A child parked on a provider limit is a blocked dependency the
            // parent must plan around, not a pending result to keep polling.
            ...(entry.usageLimit === undefined ? {} : { usageLimit: entry.usageLimit }),
            ...(entry.usageResume === undefined
              ? {}
              : { usageResume: { status: entry.usageResume.status } }),
          })),
        });
      }

      if (input.operation === "delegate") {
        if (input.task === undefined) return failure("invalid-agents-input");
        // The settings store never reports Ask (it reads a stored Ask as Off),
        // so anything but Automatic is a person having turned subagents off.
        if (options.admission.settings.current().creationPosture !== "automatic") {
          return answer({
            status: "refused",
            reason: "creation-posture-off",
            message: "Subagents are turned off in Settings → Octant Harness → Helper agents.",
          });
        }
        // A thread carrying untrusted content may not widen its reach into a
        // fresh child authority; finer-grained taint scoping is a follow-up.
        if (options.isTainted()) return failure("delegate-tainted");
        const role = input.role ?? allowedAgentRunRolesForMode(options.mode)[0];
        let controlRequest: AgentRunControlRequest;
        try {
          controlRequest = decodeAgentRunControlRequest({
            requestId: options.uuid(),
            parentThreadId: options.parentThreadId,
            role,
            task: input.task,
            ...(input.includeParentContext === true ? { includeParentContext: true } : {}),
          });
        } catch {
          return failure("invalid-agents-input");
        }
        let routeOverride:
          | ((parent: AgentRunControlParentFacts) => AgentRunParentRouteFacts)
          | undefined;
        if (input.providerInstanceId !== undefined || input.modelId !== undefined) {
          const requestedProvider = input.providerInstanceId;
          const requestedModel = input.modelId;
          if (requestedProvider === undefined || requestedModel === undefined)
            return failure("delegate-target-unavailable");
          const target = options
            .listTargets()
            .find(
              (candidate) =>
                candidate.providerInstanceId === requestedProvider &&
                candidate.modelIds.includes(requestedModel),
            );
          if (target === undefined) return failure("delegate-target-unavailable");
          let providerInstanceId;
          let modelId;
          try {
            providerInstanceId = decodeProviderInstanceId(requestedProvider);
            modelId = decodeProviderModelId(requestedModel);
          } catch {
            return failure("delegate-target-unavailable");
          }
          routeOverride = (parent: AgentRunControlParentFacts) => ({
            providerInstanceId,
            modelId,
            ...(parent.parentRoute.projectId === undefined
              ? {}
              : { projectId: parent.parentRoute.projectId }),
          });
        }
        const admission = await admitAgentRunControlRequest(options.admission, {
          controlRequest,
          windowId: options.windowId,
          confirmed: false,
          ...(routeOverride === undefined ? {} : { routeOverride }),
        });
        if (admission.kind === "refused") {
          return answer({ status: "refused", reason: admission.reason });
        }
        if (admission.kind === "invalid") {
          return answer({ status: "refused", reason: "invalid", message: admission.message });
        }
        const accepted =
          "kind" in admission.result
            ? admission.result
            : ({ kind: "run-accepted", run: admission.result } as const);
        if (accepted.kind === "run-command-failed") {
          return answer({
            status: "refused",
            reason: accepted.reason,
            message: accepted.message,
          });
        }
        const run = accepted.run;
        if (run.lifecycleStatus === "queued" && run.recoveryReason === undefined) {
          const started = options.orchestration.start(run.id, run.version, admission.liveAuthority);
          if (started.kind === "run-command-failed") {
            return answer({
              status: "refused",
              reason: started.reason,
              message: started.message,
            });
          }
          return answer({
            status: "accepted",
            runId: String(run.id),
            lifecycleStatus: started.run.lifecycleStatus,
          });
        }
        return answer({
          status: "accepted",
          runId: String(run.id),
          lifecycleStatus: run.lifecycleStatus,
        });
      }

      if (input.operation === "wait") {
        if (input.runId === undefined) return failure("invalid-agents-input");
        const deadline = Date.now() + Math.min(Math.max(input.timeoutMs ?? 30_000, 0), 120_000);
        for (;;) {
          if (signal?.aborted) return failure("tool-interrupted");
          const run = childRun(input.runId);
          if (run === undefined) return failure("run-not-found");
          if (isTerminal(run.lifecycleStatus)) {
            if (run.lifecycleStatus === "completed" && run.result !== undefined) {
              const text = options.persistence.resultText(run.id);
              return answer({
                status: "completed",
                runId: String(run.id),
                ...(text === undefined ? {} : { text }),
                truncated: run.result.truncated,
              });
            }
            return answer({
              status: run.lifecycleStatus,
              runId: String(run.id),
            });
          }
          // A run parked on a disclosed provider limit cannot progress before
          // the reset the opt-in targets, so blocking to the deadline would
          // only stall the parent. Answer with the fact and whether the person
          // armed recovery instead of inventing progress.
          if (run.lifecycleStatus === "waiting" && run.usageLimit !== undefined) {
            return answer({
              status: "waiting",
              lifecycleStatus: run.lifecycleStatus,
              runId: String(run.id),
              usageLimit: run.usageLimit,
              ...(run.usageResume === undefined
                ? {}
                : { usageResume: { status: run.usageResume.status } }),
            });
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return answer({ status: "still-running", lifecycleStatus: run.lifecycleStatus });
          }
          try {
            await sleep(Math.min(250, remaining), signal);
          } catch {
            return failure("tool-interrupted");
          }
        }
      }

      // cancel
      if (input.runId === undefined) return failure("invalid-agents-input");
      const run = childRun(input.runId);
      if (run === undefined) return failure("run-not-found");
      if (!options.authorizeCancel(run)) return failure("cancel-unauthorized");
      const results = await options.orchestration.cancelLeafFirst({
        runId: run.id,
        scope: "self",
      });
      const failed = results.find((result) => result.kind === "run-command-failed");
      if (failed !== undefined) {
        return answer({
          status: "refused",
          reason: failed.reason,
          message: failed.message,
        });
      }
      return answer({ status: "cancelled", runId: String(run.id) });
    },
  };
}

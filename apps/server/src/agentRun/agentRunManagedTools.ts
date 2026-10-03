import {
  AGENT_RUN_TERMINAL_STATUSES,
  MAX_AGENT_RUN_DEPENDENCIES,
  type AgentRun,
  type AgentRunId,
  type AgentRunLifecycleStatus,
  type AgentRunRole,
  type OctantMode,
} from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { AgentRunControlAdmissionDependencies } from "./agentRunControlAdmission";
import {
  agentRunDelegationCapabilities,
  followUpAgentRunDelegation,
  recordAgentRunResultConsumption,
  startAgentRunDelegation,
  type AgentRunDelegationRouting,
  type AgentsToolTarget,
} from "./agentRunDelegation";
import type { AgentRunOrchestrationService } from "./agentRunOrchestrationService";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";

export type { AgentsToolTarget } from "./agentRunDelegation";

export interface AgentsManagedToolsOptions {
  readonly admission: AgentRunControlAdmissionDependencies;
  readonly orchestration: Pick<AgentRunOrchestrationService, "start" | "cancelLeafFirst"> &
    Partial<Pick<AgentRunOrchestrationService, "resume">>;
  readonly persistence: Pick<
    AgentRunPersistenceService,
    "parentSummary" | "getById" | "resultText"
  > &
    Partial<Pick<AgentRunPersistenceService, "applyCommand">>;
  readonly mode: OctantMode;
  readonly windowId: string;
  readonly parentThreadId: string;
  readonly listTargets: () => ReadonlyArray<AgentsToolTarget>;
  readonly isTainted: () => boolean;
  readonly isPaused?: () => boolean;
  readonly routing?: AgentRunDelegationRouting;
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
    "Delegate part of this task to a child agent run the host owns and supervises. Use capabilities to see which provider models you may target and the current creation posture. delegate creates one child with a bounded task; it runs asynchronously and appears in the Agents surface. status lists this thread's children; wait blocks briefly for one child's terminal state and returns its result when completed; cancel stops one of this thread's children. follow-up continues a completed child in its saved session using runId, expectedVersion from status/wait, and an explicit message (at most 4096 characters); unsupported continuity is refused. Child refs from another parent cannot be used here. Use after to wait for existing siblings and receive their results. Omit providerInstanceId and modelId to use the configured role slot. Delegation is refused when subagents are off in Settings or the parent is paused.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["capabilities", "delegate", "status", "wait", "cancel", "follow-up"],
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
          "Delegation target from capabilities. Requires modelId; omit both to resolve the configured role slot.",
      },
      modelId: {
        type: "string",
        maxLength: 128,
        description: "Model on the target provider instance. Requires providerInstanceId.",
      },
      reasoning: {
        type: "string",
        maxLength: 128,
        description: "Supported reasoning value from capabilities for the selected model.",
      },
      after: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_AGENT_RUN_DEPENDENCIES,
        uniqueItems: true,
        description: "Existing sibling run IDs whose successful results this child needs.",
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
      expectedVersion: {
        type: "integer",
        minimum: 1,
        description: "Current child version from status or wait; required for follow-up.",
      },
      message: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Explicit message for the completed child; required for follow-up.",
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
  | "result-unavailable"
  | "result-delivery-unavailable"
  | "run-not-found"
  | "cancel-unauthorized";

interface AgentsToolInput {
  readonly operation: "capabilities" | "delegate" | "status" | "wait" | "cancel" | "follow-up";
  readonly task?: string;
  readonly expectedVersion?: number;
  readonly message?: string;
  readonly role?: AgentRunRole;
  readonly providerInstanceId?: string;
  readonly modelId?: string;
  readonly includeParentContext?: boolean;
  readonly reasoning?: string;
  readonly after?: ReadonlyArray<string>;
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
    operation !== "cancel" &&
    operation !== "follow-up"
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
  const reasoning = record.reasoning;
  if (reasoning !== undefined && typeof reasoning !== "string") return undefined;
  const after = record.after;
  if (
    after !== undefined &&
    (!Array.isArray(after) || !after.every((id): id is string => typeof id === "string"))
  )
    return undefined;
  const includeParentContext = record.includeParentContext;
  if (includeParentContext !== undefined && typeof includeParentContext !== "boolean")
    return undefined;
  const runId = record.runId;
  if (runId !== undefined && typeof runId !== "string") return undefined;
  const expectedVersion = record.expectedVersion;
  const message = record.message;
  if (
    operation === "follow-up" &&
    (typeof runId !== "string" ||
      typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > 4096)
  )
    return undefined;
  if (expectedVersion !== undefined && typeof expectedVersion !== "number") return undefined;
  if (message !== undefined && typeof message !== "string") return undefined;
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
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(after === undefined ? {} : { after }),
    ...(runId === undefined ? {} : { runId }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    ...(message === undefined ? {} : { message }),
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
        return answer({ status: "ok", ...agentRunDelegationCapabilities(options) });
      }

      if (input.operation === "status") {
        const children = options.persistence
          .parentSummary(options.parentThreadId as AgentRun["parentThreadId"])
          .filter((entry) => input.runId === undefined || String(entry.runId) === input.runId);
        return answer({
          status: "ok",
          children: children.map((entry) => {
            const run = options.persistence.getById(entry.runId);
            const consumed =
              entry.resultText !== undefined &&
              run !== undefined &&
              String(run.parentThreadId) === options.parentThreadId &&
              entry.version === run.version
                ? recordAgentRunResultConsumption(options.persistence, run)
                : undefined;
            return {
              runId: String(entry.runId),
              role: entry.role,
              task: entry.task,
              lifecycleStatus: entry.lifecycleStatus,
              resultAvailable: entry.result !== undefined,
              ...(run === undefined
                ? {}
                : {
                    version: consumed?.status === "settled" ? consumed.run.version : run.version,
                    generation: run.generation ?? 1,
                  }),
              ...(entry.resultText === undefined
                ? {}
                : consumed?.status === "settled"
                  ? { resultText: entry.resultText }
                  : { resultUnavailableReason: "result-delivery-unavailable" }),
              ...(run?.dependsOn === undefined ? {} : { after: run.dependsOn.map(String) }),
              ...(run?.routingReceipt?.rawReasoning === undefined
                ? {}
                : { reasoning: run.routingReceipt.rawReasoning }),
              route: entry.route,
              // A child parked on a provider limit is a blocked dependency the
              // parent must plan around, not a pending result to keep polling.
              ...(entry.usageLimit === undefined ? {} : { usageLimit: entry.usageLimit }),
              ...(entry.usageResume === undefined
                ? {}
                : { usageResume: { status: entry.usageResume.status } }),
            };
          }),
        });
      }

      if (input.operation === "delegate") {
        if (input.task === undefined) return failure("invalid-agents-input");
        const result = await startAgentRunDelegation(options, { ...input, task: input.task });
        if (
          result.status === "refused" &&
          (result.reason === "delegate-tainted" || result.reason === "delegate-target-unavailable")
        )
          return failure(result.reason);
        return answer(result);
      }

      if (input.operation === "follow-up") {
        if (
          input.runId === undefined ||
          input.expectedVersion === undefined ||
          input.message === undefined
        )
          return failure("invalid-agents-input");
        return answer(
          await followUpAgentRunDelegation(options, {
            runId: input.runId,
            expectedVersion: input.expectedVersion,
            message: input.message,
          }),
        );
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
              if (text === undefined) return failure("result-unavailable");
              const consumed = recordAgentRunResultConsumption(options.persistence, run);
              if (consumed.status === "refused") return failure("result-delivery-unavailable");
              return answer({
                status: "completed",
                runId: String(run.id),
                version: consumed.run.version,
                generation: run.generation ?? 1,
                text,
                truncated: run.result.truncated,
              });
            }
            return answer({
              status: run.lifecycleStatus,
              runId: String(run.id),
              version: run.version,
              generation: run.generation ?? 1,
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

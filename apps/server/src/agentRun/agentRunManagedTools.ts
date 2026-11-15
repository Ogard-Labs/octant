import type { ConversationInputPolicy } from "@octant/contracts/conversation-inputs";
import {
  MAX_PROVIDER_TOOL_RESULT_BYTES,
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
  agentRunStopReason,
  followUpAgentRunDelegation,
  boundedAgentRunChildren,
  collectAgentRunResult,
  startAgentRunDelegation,
  type AgentRunDelegationRouting,
  type AgentsToolTarget,
  type AgentsToolUnavailableTarget,
  type RemoteDelegationPort,
} from "./agentRunDelegation";
import type { AgentRunOrchestrationService } from "./agentRunOrchestrationService";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";

export type { AgentsToolTarget } from "./agentRunDelegation";

export interface AgentsManagedToolsOptions {
  readonly admission: AgentRunControlAdmissionDependencies;
  readonly orchestration: Pick<AgentRunOrchestrationService, "start" | "cancelLeafFirst"> &
    Partial<Pick<AgentRunOrchestrationService, "resume" | "waitsForProviderSlot">>;
  readonly persistence: Pick<
    AgentRunPersistenceService,
    "parentSummary" | "getById" | "resultText"
  > &
    Partial<Pick<AgentRunPersistenceService, "applyCommand">>;
  readonly mode: OctantMode;
  readonly windowId: string;
  readonly parentThreadId: string;
  readonly listTargets: () => ReadonlyArray<AgentsToolTarget>;
  readonly listUnavailableTargets?: () => ReadonlyArray<AgentsToolUnavailableTarget>;
  readonly isTainted: () => boolean;
  readonly askMarkedDelegation?: (signal?: AbortSignal) => Promise<boolean>;
  readonly isPaused?: () => boolean;
  readonly routing?: AgentRunDelegationRouting;
  readonly projectId?: string | undefined;
  readonly remote?: RemoteDelegationPort;
  /**
   * The host's cancellation authority for this run on this window, in addition
   * to the occurrence-bound parent check the tool always applies first.
   */
  readonly authorizeCancel: (run: AgentRun) => boolean;
  /**
   * Journals that a child's reply is about to enter this thread, which marks
   * it as having read outside content; false when that could not be recorded.
   */
  readonly recordResultIngestion: (run: AgentRun) => boolean;
  readonly uuid: () => string;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const AGENTS_TOOL_NAME = "octant_agents";
/** One wait covers at most a thread's whole concurrency ceiling. */
const MAX_WAIT_RUN_IDS = 16;
/** Room kept for a several-child answer's own fields and one entry's metadata. */
const WAIT_ANSWER_ENVELOPE_BYTES = 1_024;
const WAIT_ENTRY_OVERHEAD_BYTES = 512;

const AGENTS_TOOL_DEFINITION = {
  name: AGENTS_TOOL_NAME,
  description:
    "Delegate parts of this task to child agent runs the host owns and supervises; each appears in the Agents surface, where the person can watch and stop it. capabilities lists the provider models you may target, the enabled providers you may not with why (unavailableTargets), and whether delegation is open; pick a target from it rather than naming one you have not seen. delegate starts one child with a bounded, standalone task (objective, expected output, boundaries) and returns its runId; independent children run in parallel, and after names existing siblings whose results a child needs, so it starts once they all completed and receives their replies. compareGroup gives sibling children the same short label when a person should compare their results side by side; the host only groups them and ranks nothing. status lists this thread's children without consuming their replies. wait blocks up to timeoutMs for one child (runId) and returns its reply once it completed, or for several (runIds) until the first settles (waitFor any) or all have (waitFor all), returning each settled reply and the ids still pending (timeoutMs 0 reads finished replies without waiting). A child's reply counts as outside content, so below Full access this thread cannot delegate again after one until a person reviews it. cancel stops one of this thread's children. follow-up continues a completed child in its saved session using runId, expectedVersion from status or wait, and an explicit message (at most 4096 characters); unsupported continuity is refused. Omit providerInstanceId and modelId to use the configured role slot. Delegation is refused when subagents are off in Settings, the thread has read outside content below Full access, or it is paused.",
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
      compareGroup: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description:
          "Same label on sibling delegate calls whose results the person should compare side by side.",
      },
      includeParentContext: {
        type: "boolean",
        description: "Give the child this thread's recent conversation.",
      },
      contextInputPolicy: {
        type: "string",
        enum: ["preserve", "text-only"],
        description:
          "Preserve original parent inputs by default. Use text-only only when the person explicitly chose to omit the original inputs.",
      },
      targetMemberId: {
        type: "string",
        maxLength: 36,
        description:
          "Run the child on another member of the person's hub instead of this host. Work threads only, task only: no model, after, or parent context. The member's own grant decides what it may do, and its result comes back to this thread as outside content.",
      },
      targetProjectId: {
        type: "string",
        maxLength: 36,
        description:
          "With targetMemberId: that member's own id for the Project to run in. Required there, since each host has its own Project ids; the member refuses one its grant does not cover.",
      },
      runId: {
        type: "string",
        maxLength: 128,
        description: "Child run id for wait/cancel, or to narrow status.",
      },
      runIds: {
        type: "array",
        items: { type: "string", maxLength: 128 },
        minItems: 1,
        maxItems: MAX_WAIT_RUN_IDS,
        uniqueItems: true,
        description:
          "Several child run ids for one wait, in place of runId, so children on different providers can be awaited together.",
      },
      waitFor: {
        type: "string",
        enum: ["any", "all"],
        description:
          "With runIds: return when the first child settles (any) or when every one has (all, the default).",
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
  | "result-too-large"
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
  readonly contextInputPolicy?: ConversationInputPolicy;
  readonly reasoning?: string;
  readonly after?: ReadonlyArray<string>;
  readonly compareGroup?: string;
  readonly targetMemberId?: string;
  readonly targetProjectId?: string;
  readonly runId?: string;
  readonly runIds?: ReadonlyArray<string>;
  readonly waitFor?: "any" | "all";
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
  const compareGroup = record.compareGroup;
  if (
    compareGroup !== undefined &&
    (typeof compareGroup !== "string" ||
      compareGroup.trim().length === 0 ||
      compareGroup.trim().length > 64)
  )
    return undefined;
  const includeParentContext = record.includeParentContext;
  if (includeParentContext !== undefined && typeof includeParentContext !== "boolean")
    return undefined;
  const contextInputPolicy = record.contextInputPolicy;
  if (
    contextInputPolicy !== undefined &&
    contextInputPolicy !== "preserve" &&
    contextInputPolicy !== "text-only"
  )
    return undefined;
  const targetMemberId = record.targetMemberId;
  if (targetMemberId !== undefined && typeof targetMemberId !== "string") return undefined;
  const targetProjectId = record.targetProjectId;
  if (targetProjectId !== undefined && typeof targetProjectId !== "string") return undefined;
  const runId = record.runId;
  if (runId !== undefined && typeof runId !== "string") return undefined;
  const runIds = record.runIds;
  if (
    runIds !== undefined &&
    (operation !== "wait" ||
      runId !== undefined ||
      !Array.isArray(runIds) ||
      runIds.length < 1 ||
      runIds.length > MAX_WAIT_RUN_IDS ||
      new Set(runIds).size !== runIds.length ||
      !runIds.every((id): id is string => typeof id === "string"))
  )
    return undefined;
  const waitFor = record.waitFor;
  if (waitFor !== undefined && (runIds === undefined || (waitFor !== "any" && waitFor !== "all")))
    return undefined;
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
    ...(contextInputPolicy === undefined ? {} : { contextInputPolicy }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(after === undefined ? {} : { after }),
    ...(compareGroup === undefined ? {} : { compareGroup: compareGroup.trim() }),
    ...(targetMemberId === undefined ? {} : { targetMemberId }),
    ...(targetProjectId === undefined ? {} : { targetProjectId }),
    ...(runId === undefined ? {} : { runId }),
    ...(runIds === undefined ? {} : { runIds }),
    ...(waitFor === undefined ? {} : { waitFor }),
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
  /**
   * What `wait` answers for one child now, or undefined while it is still
   * running and worth blocking on.
   */
  const settleWait = (
    runId: string,
  ): { readonly result: Record<string, unknown>; readonly isError?: boolean } | undefined => {
    const run = childRun(runId);
    if (run === undefined) return failure("run-not-found");
    if (isTerminal(run.lifecycleStatus)) {
      if (run.lifecycleStatus === "completed" && run.result !== undefined) {
        const text = options.persistence.resultText(run.id);
        if (text === undefined) return failure("result-unavailable");
        const collected = collectAgentRunResult(
          options.persistence,
          run,
          text,
          options.recordResultIngestion,
        );
        return collected.status === "refused"
          ? failure(collected.reason, collected.message)
          : { result: { ...collected } };
      }
      const reason = agentRunStopReason(run);
      return {
        result: {
          status: run.lifecycleStatus,
          runId: String(run.id),
          version: run.version,
          generation: run.generation ?? 1,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    }
    // A run parked on a disclosed provider limit cannot progress before
    // the reset the opt-in targets, so blocking to the deadline would
    // only stall the parent. Answer with the fact and whether the person
    // armed recovery instead of inventing progress.
    if (run.lifecycleStatus === "waiting" && run.usageLimit !== undefined) {
      return {
        result: {
          status: "waiting",
          lifecycleStatus: run.lifecycleStatus,
          runId: String(run.id),
          usageLimit: run.usageLimit,
          ...(run.usageResume === undefined
            ? {}
            : { usageResume: { status: run.usageResume.status } }),
        },
      };
    }
    // A child waiting for a provider slot starts by itself when one frees,
    // and the slot that may be holding it up is this parent's own while its
    // turn runs. Blocking here until the deadline would pin that slot and
    // keep the child from ever starting, so the parent is told at once and
    // can end its turn; the child's result is delivered when it completes.
    if (options.orchestration.waitsForProviderSlot?.(run) === true) {
      return {
        result: {
          status: "waiting",
          lifecycleStatus: run.lifecycleStatus,
          runId: String(run.id),
          version: run.version,
          reason: run.recoveryReason,
          message:
            "This helper starts by itself when the provider has a free request slot, and its result is delivered to you when it completes. Do not wait for it inside this turn: finish your turn or continue other work.",
        },
      };
    }
    return undefined;
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
        return answer(
          boundedAgentRunChildren(
            children.map((entry) => {
              const run = options.persistence.getById(entry.runId);
              const reason =
                run === undefined
                  ? undefined
                  : (agentRunStopReason(run) ??
                    (options.orchestration.waitsForProviderSlot?.(run) === true
                      ? run.recoveryReason
                      : undefined));
              return {
                runId: String(entry.runId),
                role: entry.role,
                task: entry.task,
                lifecycleStatus: entry.lifecycleStatus,
                ...(reason === undefined ? {} : { reason }),
                resultAvailable: entry.result !== undefined,
                ...(run === undefined
                  ? {}
                  : { version: run.version, generation: run.generation ?? 1 }),
                ...(run?.dependsOn === undefined ? {} : { after: run.dependsOn.map(String) }),
                ...(entry.compareGroup === undefined ? {} : { compareGroup: entry.compareGroup }),
                ...(run?.routingReceipt?.rawReasoning === undefined
                  ? {}
                  : { reasoning: run.routingReceipt.rawReasoning }),
                route: entry.route,
                ...(entry.usageLimit === undefined ? {} : { usageLimit: entry.usageLimit }),
                ...(entry.usageResume === undefined
                  ? {}
                  : { usageResume: { status: entry.usageResume.status } }),
              };
            }),
            { status: "ok" },
          ),
        );
      }

      if (input.operation === "delegate") {
        if (input.task === undefined) return failure("invalid-agents-input");
        const result = await startAgentRunDelegation(
          options,
          { ...input, task: input.task },
          signal,
        );
        if (
          result.status === "refused" &&
          (result.reason === "delegate-tainted" || result.reason === "delegate-target-unavailable")
        )
          return failure(result.reason, result.message);
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
          await followUpAgentRunDelegation(
            options,
            {
              runId: input.runId,
              expectedVersion: input.expectedVersion,
              message: input.message,
            },
            signal,
          ),
        );
      }

      if (input.operation === "wait") {
        const runIds = input.runIds ?? (input.runId === undefined ? undefined : [input.runId]);
        if (runIds === undefined) return failure("invalid-agents-input");
        const deadline = Date.now() + Math.min(Math.max(input.timeoutMs ?? 30_000, 0), 120_000);
        if (input.runIds === undefined) {
          // One child keeps its original answer shape.
          for (;;) {
            if (signal?.aborted) return failure("tool-interrupted");
            const settled = settleWait(runIds[0] ?? "");
            if (settled !== undefined) return settled;
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              const run = childRun(runIds[0] ?? "");
              return answer({ status: "still-running", lifecycleStatus: run?.lifecycleStatus });
            }
            try {
              await sleep(Math.min(250, remaining), signal);
            } catch {
              return failure("tool-interrupted");
            }
          }
        }
        // Several children: answer when the first settles ("any") or when every
        // one has ("all"). A reply is collected once, when its child settles, so
        // a later `wait` on the same child reads it as already handed back.
        //
        // The whole answer must fit one tool response. Collecting a reply
        // settles it as handed back, so a reply that would push the answer past
        // the budget is left uncollected and still owed: the parent receives it
        // from a later wait or from delivery, never as a cut-off preview.
        const waitFor = input.waitFor ?? "all";
        const settledById = new Map<string, unknown>();
        const withheld = new Set<string>();
        let answerBytes = WAIT_ANSWER_ENVELOPE_BYTES;
        for (;;) {
          if (signal?.aborted) return failure("tool-interrupted");
          for (const runId of runIds) {
            if (settledById.has(runId) || withheld.has(runId)) continue;
            const run = childRun(runId);
            const text =
              run?.lifecycleStatus === "completed" && run.result !== undefined
                ? options.persistence.resultText(run.id)
                : undefined;
            if (
              text !== undefined &&
              answerBytes + Buffer.byteLength(text, "utf8") + WAIT_ENTRY_OVERHEAD_BYTES >
                MAX_PROVIDER_TOOL_RESULT_BYTES
            ) {
              withheld.add(runId);
              continue;
            }
            const settled = settleWait(runId);
            if (settled === undefined) continue;
            const entry = { runId, ...settled.result };
            answerBytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
            settledById.set(runId, entry);
          }
          const pending = runIds.filter((runId) => !settledById.has(runId) && !withheld.has(runId));
          const finished = settledById.size + withheld.size;
          const done = waitFor === "any" ? finished > 0 : pending.length === 0;
          const remaining = deadline - Date.now();
          if (done || remaining <= 0) {
            return answer({
              status: done ? "settled" : "still-running",
              waitFor,
              settled: [...settledById.values()],
              pending,
              ...(withheld.size === 0
                ? {}
                : {
                    withheld: [...withheld],
                    message:
                      "These children finished, but their replies did not fit this response. They remain owed: wait on each alone, or let them be delivered.",
                  }),
            });
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

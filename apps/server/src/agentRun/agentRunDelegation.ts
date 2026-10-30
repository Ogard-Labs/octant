import {
  LOCAL_HOST_ID,
  MAX_PROVIDER_TOOL_RESULT_BYTES,
  decodeAgentRunControlRequest,
  decodeAgentRunResumeRequest,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  ProviderFailureCategory,
  type AgentRun,
  type AgentRunRole,
  type AgentRunControlRequest,
  type NativeHarnessRouteDecision,
  type OctantMode,
  type Project,
  type ProviderInstance,
  type ProviderModel,
  type ProviderObservedState,
} from "@octant/contracts";
import {
  AgentRunPolicyRejected,
  clampAgentRunAuthority,
  effectiveAgentRunExecutionTarget,
  allowedAgentRunRolesForMode,
  modelCanTakeDelegatedWork,
  nativeHarnessJobForRole,
  redactDiagnosticText,
} from "@octant/domain";
import type { NativeHarnessRouter } from "../harness/nativeHarnessRouter";
import {
  admitAgentRunControlRequest,
  type AgentRunControlAdmissionDependencies,
} from "./agentRunControlAdmission";
import {
  AgentRunControlRefused,
  resolveAgentRunControlFacts,
  type AgentRunControlParentFacts,
} from "./agentRunControlService";
import {
  AgentRunOrchestrationError,
  type AgentRunOrchestrationService,
} from "./agentRunOrchestrationService";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";

/** Host-filtered targets for this parent, including only supported reasoning values. */
export interface AgentsToolTarget {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly driverKind: string;
  readonly modelIds: ReadonlyArray<string>;
  readonly reasoningByModel?: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface AgentRunDelegationInput {
  readonly role?: AgentRunRole;
  readonly task: string;
  readonly providerInstanceId?: string;
  readonly modelId?: string;
  readonly reasoning?: string;
  readonly includeParentContext?: boolean;
  readonly after?: ReadonlyArray<string>;
  /** A roster member that runs the child on its own host instead of this one. */
  readonly targetMemberId?: string;
  /** The member's own id for the Project to run in; required with a target member. */
  readonly targetProjectId?: string;
}

/**
 * Starts a child on another member of the person's hub. The host behind it
 * applies its own rules to the parent thread and the member's peer grant; this
 * seam only carries the request and its answer.
 */
export interface RemoteDelegationPort {
  readonly start: (input: {
    readonly parentThreadId: string;
    readonly windowId: string;
    readonly mode: OctantMode;
    readonly projectId: string | undefined;
    readonly targetMemberId: string;
    /** The member's id for the Project; `projectId` is this host's, for the parent check alone. */
    readonly targetProjectId: string;
    readonly task: string;
  }) => Promise<AgentRunDelegationResult>;
}

export interface AgentRunDelegationRouting {
  readonly router: Pick<NativeHarnessRouter, "resolve">;
  readonly recordDecision: (
    parent: AgentRunControlParentFacts,
    decision: NativeHarnessRouteDecision,
  ) => void;
}

export interface AgentRunDelegationOptions {
  readonly admission: AgentRunControlAdmissionDependencies;
  readonly orchestration: Pick<AgentRunOrchestrationService, "start"> &
    Partial<Pick<AgentRunOrchestrationService, "resume" | "waitsForProviderSlot">>;
  readonly persistence: Pick<AgentRunPersistenceService, "getById">;
  readonly mode: OctantMode;
  readonly parentThreadId: string;
  readonly windowId: string;
  readonly uuid: () => string;
  readonly listTargets: () => ReadonlyArray<AgentsToolTarget>;
  readonly routing?: AgentRunDelegationRouting;
  readonly isTainted?: () => boolean;
  readonly isPaused?: () => boolean;
  readonly projectId?: string | undefined;
  /** Absent when this host cannot reach other members; a target member is then refused. */
  readonly remote?: RemoteDelegationPort;
}

export type AgentRunDelegationResult =
  /**
   * A child another member runs. Its result is recorded on this host as outside
   * content, so no `runId` exists here to wait on.
   */
  | {
      readonly status: "delegated-remote";
      readonly requestId: string;
      readonly targetMemberId: string;
      readonly state: "accepted" | "pending-acceptance";
      readonly authority?: { readonly mode: string; readonly posture: string };
    }
  | {
      readonly status: "accepted";
      readonly runId: string;
      readonly lifecycleStatus: string;
      /** Why a helper that has not started is waiting: a full provider. */
      readonly reason?: string;
      readonly target: {
        readonly providerInstanceId: string;
        readonly modelId: string;
        readonly reasoning?: string;
      };
      readonly route?: NativeHarnessRouteDecision;
    }
  | { readonly status: "refused"; readonly reason: string; readonly message?: string };

/**
 * A tainted parent cannot start helpers, and a helper's own reply taints its
 * parent, so a lead that delegated once and took the result in meets this on
 * its next delegation. The bare reason code left the model and the person with
 * nothing to act on.
 */
const TAINTED_DELEGATION_MESSAGE =
  "This thread has taken in outside content (a helper's reply counts), so it cannot start more helpers. A person can review what it read and clear that from the notice above the composer, or the work can continue in a new thread.";

export function agentRunDelegationCapabilities(options: AgentRunDelegationOptions) {
  const posture = options.admission.settings.current().creationPosture;
  const tainted = options.isTainted?.() === true;
  const paused = options.isPaused?.() === true;
  return {
    posture,
    delegationBlocked: posture !== "automatic" || tainted || paused,
    ...(paused
      ? { reason: "session-paused" }
      : tainted
        ? { reason: "delegate-tainted" }
        : posture !== "automatic"
          ? { reason: "creation-posture-off" }
          : {}),
    roles: [...allowedAgentRunRolesForMode(options.mode)],
    targetSelection: {
      explicit: true,
      roleSlots: options.routing !== undefined,
      reasoning: "advertised-values-only",
    },
    dependencies: true,
    parentContext: options.admission.parentContext !== undefined,
    // Reported by what this thread can do, so a Chat or Code thread never offers it.
    remoteDelegation:
      options.remote !== undefined && options.mode === "work"
        ? ("target-member" as const)
        : ("unavailable" as const),
    targets: options.listTargets(),
  } as const;
}

/** Both harness transports use the same authorized role route and admission. */
export async function startAgentRunDelegation(
  options: AgentRunDelegationOptions,
  input: AgentRunDelegationInput,
): Promise<AgentRunDelegationResult> {
  if (options.admission.settings.current().creationPosture !== "automatic")
    return {
      status: "refused",
      reason: "creation-posture-off",
      message: "Subagents are turned off in Settings → Octant Harness → Helper agents.",
    };
  if (options.isTainted?.())
    return { status: "refused", reason: "delegate-tainted", message: TAINTED_DELEGATION_MESSAGE };
  if (options.isPaused?.())
    return {
      status: "refused",
      reason: "session-paused",
      message: "This run is paused, so no new helper starts until it is resumed.",
    };
  if (input.targetProjectId !== undefined && input.targetMemberId === undefined)
    return {
      status: "refused",
      reason: "remote-delegation-options-unsupported",
      message: "A target Project only means something together with a target member.",
    };
  if (input.targetMemberId !== undefined) {
    // The child runs on its own host's default model with its own context, so
    // choices that only mean something on this host are refused, not dropped.
    if (
      input.providerInstanceId !== undefined ||
      input.modelId !== undefined ||
      input.reasoning !== undefined ||
      input.after !== undefined ||
      input.includeParentContext === true
    )
      return {
        status: "refused",
        reason: "remote-delegation-options-unsupported",
        message:
          "A helper on another member takes only a task: it cannot name a model, wait on siblings, or receive this thread's conversation.",
      };
    if (options.remote === undefined)
      return {
        status: "refused",
        reason: "remote-delegation-unavailable",
        message: "This host cannot start helpers on other members.",
      };
    if (input.targetProjectId === undefined)
      return {
        status: "refused",
        reason: "remote-delegation-project-required",
        message:
          "Name the Project to run in on that member (targetProjectId): Projects have their own ids on each host.",
      };
    return options.remote.start({
      parentThreadId: options.parentThreadId,
      windowId: options.windowId,
      mode: options.mode,
      projectId: options.projectId,
      targetMemberId: input.targetMemberId,
      targetProjectId: input.targetProjectId,
      task: input.task,
    });
  }
  const role = input.role ?? allowedAgentRunRolesForMode(options.mode)[0];
  let controlRequest: AgentRunControlRequest;
  try {
    controlRequest = decodeAgentRunControlRequest({
      requestId: options.uuid(),
      parentThreadId: options.parentThreadId,
      role,
      task: input.task,
      ...(input.includeParentContext ? { includeParentContext: true } : {}),
      ...(input.after === undefined ? {} : { dependsOn: input.after }),
    });
  } catch {
    return { status: "refused", reason: "invalid-delegation" };
  }
  if (
    input.reasoning !== undefined &&
    (input.reasoning.trim() !== input.reasoning ||
      input.reasoning.length === 0 ||
      input.reasoning.length > 128)
  )
    return { status: "refused", reason: "invalid-delegation" };
  const explicit = input.providerInstanceId !== undefined || input.modelId !== undefined;
  const eligible = (providerId: string, modelId: string, reasoning?: string): boolean =>
    options
      .listTargets()
      .some(
        (target) =>
          target.providerInstanceId === providerId &&
          target.modelIds.includes(modelId) &&
          (reasoning === undefined ||
            target.reasoningByModel?.[modelId]?.includes(reasoning) === true),
      );
  let explicitTarget: AgentRunControlParentFacts["parentRoute"] | undefined;
  if (explicit) {
    if (
      input.providerInstanceId === undefined ||
      input.modelId === undefined ||
      !eligible(input.providerInstanceId, input.modelId, input.reasoning)
    )
      return { status: "refused", reason: "delegate-target-unavailable" };
    try {
      explicitTarget = {
        providerInstanceId: decodeProviderInstanceId(input.providerInstanceId),
        modelId: decodeProviderModelId(input.modelId),
        ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
      };
    } catch {
      return { status: "refused", reason: "delegate-target-unavailable" };
    }
  }
  let refusal: string | undefined;
  let decision: NativeHarnessRouteDecision | undefined;
  let selected: AgentRunControlParentFacts["parentRoute"] | undefined;
  const admission = await admitAgentRunControlRequest(
    {
      ...options.admission,
      authorizeCreation: (request) => {
        const parent = options.admission.authorizeCreation(request);
        if (parent === undefined) return undefined;
        if (!allowedAgentRunRolesForMode(parent.parentMode).includes(controlRequest.role)) {
          refusal = "unsupported";
          return undefined;
        }
        for (const id of controlRequest.dependsOn ?? []) {
          const dependency = options.persistence.getById(id);
          if (
            dependency === undefined ||
            String(dependency.parentThreadId) !== options.parentThreadId
          ) {
            refusal = "dependency-not-found";
            return undefined;
          }
        }
        if (explicitTarget === undefined) {
          if (options.routing === undefined) {
            refusal = "delegate-routing-unavailable";
            return undefined;
          }
          const parentReasoning = input.reasoning ?? parent.parentRoute.reasoning;
          decision = options.routing.router.resolve({
            job: nativeHarnessJobForRole(controlRequest.role),
            inheritParent: {
              hostId: LOCAL_HOST_ID,
              providerInstanceId: parent.parentRoute.providerInstanceId,
              modelId: parent.parentRoute.modelId,
              ...(parentReasoning === undefined ? {} : { reasoning: parentReasoning }),
            },
            ...(parent.parentRoute.projectId === undefined
              ? {}
              : { projectId: decodeProjectId(parent.parentRoute.projectId) }),
            isEligible: (candidate) =>
              eligible(
                String(candidate.providerInstanceId),
                String(candidate.modelId),
                input.reasoning ?? candidate.reasoning,
              ),
          });
          if (decision.kind !== "unroutable" && input.reasoning !== undefined)
            decision = {
              ...decision,
              candidate: { ...decision.candidate, reasoning: input.reasoning },
            };
          options.routing.recordDecision(parent, decision);
          if (decision.kind === "unroutable") {
            refusal = `delegate-route-${decision.reason}`;
            return undefined;
          }
          selected = {
            providerInstanceId: decision.candidate.providerInstanceId,
            modelId: decision.candidate.modelId,
            ...(decision.candidate.reasoning === undefined
              ? {}
              : { reasoning: decision.candidate.reasoning }),
          };
        } else selected = explicitTarget;
        // The resolver's readiness is not the parent's policy. Recheck the
        // host-filtered targets even when an injected router selects a candidate.
        if (
          !eligible(
            String(selected.providerInstanceId),
            String(selected.modelId),
            selected.reasoning,
          )
        ) {
          refusal = "delegate-target-unavailable";
          return undefined;
        }
        return {
          ...parent,
          parentRoute: {
            providerInstanceId: selected.providerInstanceId,
            modelId: selected.modelId,
            ...(selected.reasoning === undefined ? {} : { reasoning: selected.reasoning }),
            ...(parent.parentRoute.projectId === undefined
              ? {}
              : { projectId: parent.parentRoute.projectId }),
          },
        };
      },
    },
    { controlRequest, windowId: options.windowId, confirmed: false },
  );
  if (refusal !== undefined) return { status: "refused", reason: refusal };
  if (admission.kind === "refused") return { status: "refused", reason: admission.reason };
  if (admission.kind === "invalid")
    return { status: "refused", reason: "invalid-delegation", message: admission.message };
  const accepted =
    "kind" in admission.result
      ? admission.result
      : { kind: "run-accepted" as const, run: admission.result };
  if (accepted.kind === "run-command-failed")
    return { status: "refused", reason: accepted.reason, message: accepted.message };
  if (selected === undefined) return { status: "refused", reason: "delegate-routing-unavailable" };
  let run: AgentRun = accepted.run;
  if (run.lifecycleStatus === "queued" && run.recoveryReason === undefined) {
    const started = options.orchestration.start(run.id, run.version, admission.liveAuthority);
    if (started.kind === "run-command-failed")
      return { status: "refused", reason: started.reason, message: started.message };
    run = started.run;
  }
  return {
    status: "accepted",
    runId: String(run.id),
    lifecycleStatus: run.lifecycleStatus,
    ...(options.orchestration.waitsForProviderSlot?.(run) === true &&
    run.recoveryReason !== undefined
      ? { reason: run.recoveryReason }
      : {}),
    target: {
      providerInstanceId: String(selected.providerInstanceId),
      modelId: String(selected.modelId),
      ...(selected.reasoning === undefined ? {} : { reasoning: selected.reasoning }),
    },
    ...(decision === undefined ? {} : { route: decision }),
  };
}

export interface AgentRunFollowUpInput {
  readonly runId: string;
  readonly expectedVersion: number;
  readonly message: string;
}

export type AgentRunFollowUpResult =
  | {
      readonly status: "accepted";
      readonly runId: string;
      readonly version: number;
      readonly generation: number;
      readonly lifecycleStatus: string;
    }
  | { readonly status: "refused"; readonly reason: string; readonly message?: string };

/**
 * The delegate targets a parent in this Project may name.
 *
 * A Work or Code Project's provider policy binds delegate targets too: the
 * same list the tool advertises is the one explicit targets and resumes are
 * revalidated against, so filtering here guards all three. Chat Projects carry
 * no provider policy.
 */
export function agentRunEligibleTargets(input: {
  readonly project: Project | undefined;
  readonly instances: ReadonlyArray<
    Pick<ProviderInstance, "id" | "enabled" | "displayName" | "driverKind">
  >;
  readonly observedState: (
    instanceId: ProviderInstance["id"],
  ) =>
    | (Pick<ProviderObservedState, "readiness" | "models"> &
        Partial<Pick<ProviderObservedState, "capabilities" | "verifiedToolModelIds">>)
    | undefined;
  readonly isTargetAllowed: (
    project: Exclude<Project, { readonly type: "chat" }>,
    providerInstanceId: ProviderInstance["id"],
    modelId: ProviderModel["id"],
  ) => boolean;
}): ReadonlyArray<AgentsToolTarget> {
  const { project } = input;
  return input.instances.flatMap((instance) => {
    if (!instance.enabled) return [];
    const observed = input.observedState(instance.id);
    if (observed === undefined) return [];
    const serving = observed.models.filter((model) =>
      modelCanTakeDelegatedWork(instance.driverKind, observed, model.id),
    );
    const models =
      project === undefined || project.type === "chat"
        ? serving
        : serving.filter((model) => input.isTargetAllowed(project, instance.id, model.id));
    if (models.length === 0) return [];
    return [
      {
        providerInstanceId: String(instance.id),
        displayName: instance.displayName,
        driverKind: String(instance.driverKind),
        modelIds: models.map((model) => String(model.id)),
        reasoningByModel: Object.fromEntries(
          models.map((model) => [
            String(model.id),
            model.options.flatMap((option) =>
              option.kind === "selection" && (option.id === "reasoning" || option.id === "effort")
                ? option.values
                : [],
            ),
          ]),
        ),
      },
    ];
  });
}

export function isAgentRunTargetEligible(
  run: AgentRun,
  targets: ReadonlyArray<AgentsToolTarget>,
): boolean {
  const target = effectiveAgentRunExecutionTarget(run.routingReceipt);
  return targets.some(
    (candidate) =>
      candidate.providerInstanceId === String(target.providerInstanceId) &&
      candidate.modelIds.includes(String(target.modelId)) &&
      (run.routingReceipt.rawReasoning === undefined ||
        candidate.reasoningByModel?.[String(target.modelId)]?.includes(
          run.routingReceipt.rawReasoning,
        ) === true),
  );
}

/** A follow-up keeps the admitted route and workspace; it cannot create a new child. */
export async function followUpAgentRunDelegation(
  options: AgentRunDelegationOptions,
  input: AgentRunFollowUpInput,
): Promise<AgentRunFollowUpResult> {
  let request: ReturnType<typeof decodeAgentRunResumeRequest>;
  try {
    request = decodeAgentRunResumeRequest(input);
  } catch {
    return { status: "refused", reason: "invalid-follow-up" };
  }
  if (request.message === undefined) return { status: "refused", reason: "invalid-follow-up" };
  if (options.admission.settings.current().creationPosture !== "automatic")
    return { status: "refused", reason: "creation-posture-off" };
  if (options.isTainted?.())
    return { status: "refused", reason: "delegate-tainted", message: TAINTED_DELEGATION_MESSAGE };
  if (options.isPaused?.()) return { status: "refused", reason: "session-paused" };
  const run = options.persistence.getById(request.runId);
  if (run === undefined || String(run.parentThreadId) !== options.parentThreadId)
    return { status: "refused", reason: "run-not-found" };
  const parent = options.admission.authorizeCreation({
    parentThreadId: run.parentThreadId,
    windowId: options.windowId,
  });
  if (
    parent === undefined ||
    parent.parentMode !== options.mode ||
    parent.parentMode !== run.routingReceipt.mode ||
    String(parent.workspaceParent.threadId) !== options.parentThreadId ||
    parent.parentRoute.projectId !== run.routingReceipt.projectId ||
    !parent.parentAuthority.subagents ||
    !parent.liveAuthority.subagents
  )
    return { status: "refused", reason: "unauthorized" };
  if (run.version !== request.expectedVersion)
    return { status: "refused", reason: "stale-version" };
  if (run.executionKind !== "octant-managed" || run.lifecycleStatus !== "completed")
    return {
      status: "refused",
      reason: "unsupported-transition",
      message: "Only a completed managed child can receive a follow-up.",
    };
  if (options.orchestration.resume === undefined)
    return {
      status: "refused",
      reason: "follow-up-unavailable",
      message:
        "This host cannot continue saved child sessions. Start a new delegation from the parent.",
    };
  try {
    resolveAgentRunControlFacts({
      parent,
      role: run.role,
      creationPosture: "automatic",
      nativeEvidence: options.admission.nativeEvidence({ parent }),
    });
    clampAgentRunAuthority({
      requestedAuthority: run.authority,
      parentAuthority: parent.parentAuthority,
      liveParentGrant: parent.liveAuthority,
    });
    if (!isAgentRunTargetEligible(run, options.listTargets()))
      return { status: "refused", reason: "delegate-target-unavailable" };
    const result = await options.orchestration.resume(
      run.id,
      request.expectedVersion,
      parent.liveAuthority,
      {
        message: request.message,
        resolveLiveAuthority: () => {
          if (
            options.admission.settings.current().creationPosture !== "automatic" ||
            options.isTainted?.() ||
            options.isPaused?.()
          )
            return undefined;
          const currentParent = options.admission.authorizeCreation({
            parentThreadId: run.parentThreadId,
            windowId: options.windowId,
          });
          if (
            currentParent === undefined ||
            currentParent.parentMode !== parent.parentMode ||
            currentParent.parentRoute.projectId !== parent.parentRoute.projectId ||
            !currentParent.parentAuthority.subagents ||
            !currentParent.liveAuthority.subagents
          )
            return undefined;
          clampAgentRunAuthority({
            requestedAuthority: run.authority,
            parentAuthority: currentParent.parentAuthority,
            liveParentGrant: currentParent.liveAuthority,
          });
          if (!isAgentRunTargetEligible(run, options.listTargets())) return undefined;
          return currentParent.liveAuthority;
        },
        onExecutionAccepted: (accepted) =>
          options.admission.onExecutionAccepted?.({
            run: accepted,
            windowId: options.windowId,
            operation: "resume",
          }),
      },
    );
    if (result.kind === "run-command-failed")
      return { status: "refused", reason: result.reason, message: result.message };
    if (result.kind !== "run-updated" || result.run.lifecycleStatus !== "starting")
      return {
        status: "refused",
        reason: "unsupported-transition",
        message: "The child did not accept the follow-up.",
      };
    return {
      status: "accepted",
      runId: String(result.run.id),
      version: result.run.version,
      generation: result.run.generation ?? 1,
      lifecycleStatus: result.run.lifecycleStatus,
    };
  } catch (error) {
    if (error instanceof AgentRunPolicyRejected)
      return { status: "refused", reason: error.code, message: error.message };
    if (error instanceof AgentRunControlRefused || error instanceof AgentRunOrchestrationError)
      return { status: "refused", reason: error.reason, message: error.message };
    throw error;
  }
}

/** Record exactly the reply generation returned by a parent tool, before disclosing it. */
export function recordAgentRunResultConsumption(
  persistence: Pick<AgentRunPersistenceService, "getById"> &
    Partial<Pick<AgentRunPersistenceService, "applyCommand">>,
  run: AgentRun,
): { readonly status: "settled"; readonly run: AgentRun } | { readonly status: "refused" } {
  if (run.resultDelivery?.outcome === "delivered" || run.resultDelivery?.outcome === "consumed")
    return { status: "settled", run };
  const result = persistence.applyCommand?.({
    kind: "settle-agent-run-result-delivery",
    runId: run.id,
    expectedVersion: run.version,
    generation: run.generation ?? 1,
    outcome: "consumed",
  });
  const current = result?.kind === "run-updated" ? result.run : persistence.getById(run.id);
  if (
    current !== undefined &&
    (current.generation ?? 1) === (run.generation ?? 1) &&
    (current.resultDelivery?.outcome === "delivered" ||
      current.resultDelivery?.outcome === "consumed")
  )
    return { status: "settled", run: current };
  return { status: "refused" };
}

/** Whole child rows fit with their bounds; inspecting them never consumes results. */
export function boundedAgentRunChildren<T, H extends object>(
  children: ReadonlyArray<T>,
  header: Readonly<H>,
): Readonly<H> & {
  readonly children: ReadonlyArray<T>;
  readonly bounds: {
    readonly truncated: boolean;
    readonly returnedChildren: number;
    readonly omittedChildren: number;
  };
} {
  const carried: T[] = [];
  const response = () => ({
    ...header,
    children: carried,
    bounds: {
      truncated: carried.length < children.length,
      returnedChildren: carried.length,
      omittedChildren: children.length - carried.length,
    },
  });
  for (const child of children) {
    carried.push(child);
    if (Buffer.byteLength(JSON.stringify(response()), "utf8") > MAX_PROVIDER_TOOL_RESULT_BYTES) {
      carried.pop();
      break;
    }
  }
  return response();
}

const MAX_AGENT_RUN_STOP_REASON_CHARACTERS = 512;

/**
 * Why a child ended without a reply, in the words the parent model may see.
 *
 * A parent whose `wait` answered only `{"status":"failed"}` could not tell the
 * person that the child was signed out. The journaled reason can carry a
 * provider message or a host path, so it is redacted the way diagnostics are
 * and cut short before it reaches a model.
 */
export function agentRunStopReason(run: AgentRun): string | undefined {
  if (
    run.lifecycleStatus !== "failed" &&
    run.lifecycleStatus !== "interrupted" &&
    run.lifecycleStatus !== "cancelled"
  )
    return undefined;
  if (run.recoveryReason === undefined) return undefined;
  // Orchestration journals a provider failure as `category: message`. The
  // category is for the host; the parent's agent relays the message, which
  // already says what to do, such as signing in from the account directory.
  const separator = run.recoveryReason.indexOf(": ");
  const spoken =
    separator > 0 &&
    (ProviderFailureCategory.literals as ReadonlyArray<string>).includes(
      run.recoveryReason.slice(0, separator),
    )
      ? run.recoveryReason.slice(separator + 2)
      : run.recoveryReason;
  const redacted = redactDiagnosticText(spoken).text.trim();
  if (redacted.length === 0) return undefined;
  return redacted.length <= MAX_AGENT_RUN_STOP_REASON_CHARACTERS
    ? redacted
    : `${redacted.slice(0, MAX_AGENT_RUN_STOP_REASON_CHARACTERS - 1).trimEnd()}…`;
}

/** Do not settle a reply that a provider would replace with a lossy preview. */
export function collectAgentRunResult(
  persistence: Pick<AgentRunPersistenceService, "getById"> &
    Partial<Pick<AgentRunPersistenceService, "applyCommand">>,
  run: AgentRun,
  text: string,
):
  | {
      readonly status: "completed";
      readonly runId: string;
      readonly version: number;
      readonly generation: number;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly status: "refused";
      readonly reason: "result-too-large" | "result-delivery-unavailable";
      readonly message: string;
    } {
  const reply = {
    status: "completed" as const,
    runId: String(run.id),
    version: run.version,
    generation: run.generation ?? 1,
    text,
    truncated: run.result?.truncated === true,
  };
  // Settlement increments the version. Budget the largest safe version before
  // journaling so metadata cannot push a carried reply past the encoder limit.
  if (
    Buffer.byteLength(JSON.stringify({ ...reply, version: Number.MAX_SAFE_INTEGER }), "utf8") >
    MAX_PROVIDER_TOOL_RESULT_BYTES
  )
    return {
      status: "refused",
      reason: "result-too-large",
      message:
        "This result exceeds the tool response budget. It remains owed; wait for delivery to the parent before following up.",
    };
  const consumed = recordAgentRunResultConsumption(persistence, run);
  if (consumed.status === "refused")
    return {
      status: "refused",
      reason: "result-delivery-unavailable",
      message: "The result could not be recorded as received by the parent.",
    };
  return { ...reply, version: consumed.run.version };
}

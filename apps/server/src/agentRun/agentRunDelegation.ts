import {
  LOCAL_HOST_ID,
  decodeAgentRunControlRequest,
  decodeAgentRunResumeRequest,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type AgentRun,
  type AgentRunRole,
  type AgentRunControlRequest,
  type NativeHarnessRouteDecision,
  type OctantMode,
} from "@octant/contracts";
import {
  AgentRunPolicyRejected,
  clampAgentRunAuthority,
  effectiveAgentRunExecutionTarget,
  allowedAgentRunRolesForMode,
  nativeHarnessJobForRole,
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
    Partial<Pick<AgentRunOrchestrationService, "resume">>;
  readonly persistence: Pick<AgentRunPersistenceService, "getById">;
  readonly mode: OctantMode;
  readonly parentThreadId: string;
  readonly windowId: string;
  readonly uuid: () => string;
  readonly listTargets: () => ReadonlyArray<AgentsToolTarget>;
  readonly routing?: AgentRunDelegationRouting;
  readonly isTainted?: () => boolean;
  readonly isPaused?: () => boolean;
}

export type AgentRunDelegationResult =
  | {
      readonly status: "accepted";
      readonly runId: string;
      readonly lifecycleStatus: string;
      readonly target: {
        readonly providerInstanceId: string;
        readonly modelId: string;
        readonly reasoning?: string;
      };
      readonly route?: NativeHarnessRouteDecision;
    }
  | { readonly status: "refused"; readonly reason: string; readonly message?: string };

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
  if (options.isTainted?.()) return { status: "refused", reason: "delegate-tainted" };
  if (options.isPaused?.())
    return {
      status: "refused",
      reason: "session-paused",
      message: "This run is paused, so no new helper starts until it is resumed.",
    };
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
  if (options.isTainted?.()) return { status: "refused", reason: "delegate-tainted" };
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
    const target = effectiveAgentRunExecutionTarget(run.routingReceipt);
    if (
      !options
        .listTargets()
        .some(
          (candidate) =>
            candidate.providerInstanceId === String(target.providerInstanceId) &&
            candidate.modelIds.includes(String(target.modelId)) &&
            (run.routingReceipt.rawReasoning === undefined ||
              candidate.reasoningByModel?.[String(target.modelId)]?.includes(
                run.routingReceipt.rawReasoning,
              ) === true),
        )
    )
      return { status: "refused", reason: "delegate-target-unavailable" };
    // resume is synchronous today. Bind the accepted execution before yielding,
    // so the runtime's asynchronous workspace check cannot outrun its window grant.
    const result = options.orchestration.resume(
      run.id,
      request.expectedVersion,
      parent.liveAuthority,
      { message: request.message },
    );
    if (result.kind === "run-command-failed")
      return { status: "refused", reason: result.reason, message: result.message };
    if (result.kind !== "run-updated" || result.run.lifecycleStatus !== "starting")
      return {
        status: "refused",
        reason: "unsupported-transition",
        message: "The child did not accept the follow-up.",
      };
    options.admission.onExecutionAccepted?.({
      run: result.run,
      windowId: options.windowId,
      operation: "resume",
    });
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
  if (run.resultDelivery !== undefined) return { status: "settled", run };
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
    current.resultDelivery !== undefined
  )
    return { status: "settled", run: current };
  return { status: "refused" };
}

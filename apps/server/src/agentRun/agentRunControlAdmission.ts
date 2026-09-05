import {
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunControlRequest,
  type AgentRunCreationRequest,
  type AgentRunWorkspaceReceipt,
  type AgentRunWorkspaceRefusalReason,
  type MultiModelPool,
} from "@octant/contracts";
import {
  AgentRunControlRefused,
  buildControlCreationRequest,
  buildControlRequestCommand,
  prepareAdmittedControlWorkspace,
  requestWorkspaceFor,
  resolveAgentRunControlFacts,
  type AgentRunControlParentFacts,
  type AgentRunControlWorkspacePort,
  type AgentRunParentRouteFacts,
} from "./agentRunControlService";
import {
  AgentRunCreationRejected,
  type AgentRunParentContextPort,
  type AgentRunPoolRoutingContext,
  type ProviderReadinessPort,
} from "./agentRunCreationService";
import type { AgentRunNativeCapabilityEvidence } from "@octant/domain/agent-run-control-policy";
import type { AgentRunOrchestrationService } from "./agentRunOrchestrationService";
import { AgentRunOrchestrationError } from "./agentRunOrchestrationService";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";

export interface AgentRunControlAdmissionDependencies {
  readonly persistence: Pick<AgentRunPersistenceService, "getByRequestId">;
  readonly orchestration: Pick<AgentRunOrchestrationService, "admit">;
  readonly settings: {
    readonly current: () => { readonly creationPosture: "off" | "ask" | "automatic" };
  };
  readonly providerReadiness: ProviderReadinessPort;
  readonly uuid: () => string;
  readonly authorizeCreation: (input: {
    readonly parentThreadId: AgentRunControlRequest["parentThreadId"];
    readonly windowId: string;
  }) => AgentRunControlParentFacts | undefined;
  readonly nativeEvidence: (input: {
    readonly parent: AgentRunControlParentFacts;
  }) => AgentRunNativeCapabilityEvidence;
  readonly workspace?: AgentRunControlWorkspacePort;
  readonly poolRouting?: (input: {
    readonly request: AgentRunCreationRequest;
  }) => AgentRunPoolRoutingContext | undefined | Promise<AgentRunPoolRoutingContext | undefined>;
  readonly parentContext?: AgentRunParentContextPort;
}

export type AgentRunControlAdmission =
  | {
      readonly kind: "admitted";
      readonly result: ReturnType<AgentRunOrchestrationService["admit"]> | AgentRun;
      readonly liveAuthority: AgentRunAuthority;
    }
  | {
      readonly kind: "refused";
      readonly reason: AgentRunWorkspaceRefusalReason;
      readonly status: number;
    }
  | { readonly kind: "invalid"; readonly message: string; readonly status: number };

/**
 * The one path that turns a control request into an admitted child, whether
 * a person asked from a surface or a lead model asked through the delegate
 * tool. Parent authority, workspace admission, routing, and posture are all
 * decided here from the server's own records; the request supplies a role, a
 * task, and an idempotency key.
 *
 * `routeOverride` lets slot routing choose the child's model in place of the
 * parent's when the request carries no one-off pool. It never widens: the
 * child's authority is derived from the parent exactly as before.
 */
export async function admitAgentRunControlRequest(
  dependencies: AgentRunControlAdmissionDependencies,
  input: {
    readonly controlRequest: AgentRunControlRequest;
    readonly windowId: string;
    readonly confirmed: boolean;
    readonly routeOverride?: (
      parent: AgentRunControlParentFacts,
    ) => AgentRunParentRouteFacts | undefined;
  },
): Promise<AgentRunControlAdmission> {
  const { controlRequest } = input;
  const posture = dependencies.settings.current().creationPosture;
  const authorized = dependencies.authorizeCreation({
    parentThreadId: controlRequest.parentThreadId,
    windowId: input.windowId,
  });
  if (authorized === undefined) return { kind: "refused", reason: "unauthorized", status: 403 };
  const override =
    controlRequest.pool === undefined ? input.routeOverride?.(authorized) : undefined;
  const creationAuthority: AgentRunControlParentFacts =
    override === undefined ? authorized : { ...authorized, parentRoute: override };
  const nativeEvidence = dependencies.nativeEvidence({ parent: creationAuthority });
  try {
    resolveAgentRunControlFacts({
      parent: creationAuthority,
      role: controlRequest.role,
      creationPosture: posture,
      nativeEvidence,
    });
  } catch (error) {
    if (error instanceof AgentRunControlRefused) {
      return { kind: "refused", reason: error.reason, status: 400 };
    }
    throw error;
  }
  // An idempotent receipt is only reusable for the exact authorized request;
  // an opaque request id cannot be used to read or start another thread's
  // child.
  const existing = dependencies.persistence.getByRequestId(controlRequest.requestId);
  if (existing !== undefined) {
    if (!matchesIdempotentControlRequest(existing, controlRequest, creationAuthority)) {
      return {
        kind: "invalid",
        message: "AgentRun request ID cannot be reused for a different authorized request.",
        status: 409,
      };
    }
    return { kind: "admitted", result: existing, liveAuthority: creationAuthority.liveAuthority };
  }
  let admittedWorkspace: AgentRunWorkspaceReceipt | undefined;
  if (dependencies.workspace !== undefined) {
    const admitted = await prepareAdmittedControlWorkspace({
      windowId: input.windowId,
      parent: creationAuthority,
      role: controlRequest.role,
      workspace: dependencies.workspace,
    });
    if (admitted.status === "refused")
      return { kind: "refused", reason: admitted.reason, status: 400 };
    admittedWorkspace = admitted.workspace;
  } else if (creationAuthority.parentMode === "chat") {
    admittedWorkspace = { kind: "chat-virtual", mode: "chat" };
  } else {
    return { kind: "refused", reason: "unavailable", status: 400 };
  }
  let command: ReturnType<typeof buildControlRequestCommand>;
  try {
    const facts = resolveAgentRunControlFacts({
      parent: creationAuthority,
      role: controlRequest.role,
      creationPosture: posture,
      nativeEvidence,
    });
    const creationRequest = buildControlCreationRequest({
      control: controlRequest,
      facts,
      workspace: requestWorkspaceFor(admittedWorkspace),
    });
    const poolRoutingContext =
      controlRequest.pool === undefined
        ? undefined
        : await dependencies.poolRouting?.({ request: creationRequest });
    command = buildControlRequestCommand({
      control: controlRequest,
      parent: creationAuthority,
      creationPosture: posture,
      nativeEvidence,
      admittedWorkspace,
      providerReadiness: dependencies.providerReadiness,
      uuid: dependencies.uuid,
      ...(poolRoutingContext === undefined ? {} : { poolRouting: poolRoutingContext }),
      ...(dependencies.parentContext === undefined
        ? {}
        : { parentContext: dependencies.parentContext }),
    });
  } catch (error) {
    if (error instanceof AgentRunControlRefused) {
      return { kind: "refused", reason: error.reason, status: 400 };
    }
    if (error instanceof AgentRunCreationRejected) {
      if (isWorkspaceRefusal(error.reason)) {
        return { kind: "refused", reason: error.reason, status: 400 };
      }
      return { kind: "invalid", message: error.message, status: 400 };
    }
    throw error;
  }
  try {
    const result = dependencies.orchestration.admit({
      command,
      parentAuthority: creationAuthority.parentAuthority,
      liveAuthority: creationAuthority.liveAuthority,
      confirmed: input.confirmed,
    });
    return { kind: "admitted", result, liveAuthority: creationAuthority.liveAuthority };
  } catch (error) {
    if (error instanceof AgentRunOrchestrationError) {
      if (error.reason === "workspace-denied") {
        return {
          kind: "refused",
          reason: error.message.includes("parent checkout")
            ? "parent-checkout"
            : error.message.includes("binding")
              ? "stale"
              : "unavailable",
          status: 400,
        };
      }
      return { kind: "invalid", message: error.message, status: 400 };
    }
    throw error;
  }
}

export function isWorkspaceRefusal(reason: string): reason is AgentRunWorkspaceRefusalReason {
  return (
    reason === "unauthorized" ||
    reason === "unavailable" ||
    reason === "stale" ||
    reason === "expired" ||
    reason === "foreign-thread" ||
    reason === "foreign-project" ||
    reason === "parent-checkout" ||
    reason === "wider-than-parent" ||
    reason === "unconfirmed" ||
    reason === "unsupported"
  );
}

function matchesIdempotentControlRequest(
  existing: AgentRun,
  request: AgentRunControlRequest,
  parent: AgentRunControlParentFacts,
): boolean {
  return (
    existing.parentThreadId === request.parentThreadId &&
    existing.parentRunId === request.parentRunId &&
    existing.role === request.role &&
    existing.task === request.task &&
    existing.routingReceipt.mode === parent.parentMode &&
    existing.routingReceipt.selectedProviderInstanceId === parent.parentRoute.providerInstanceId &&
    existing.routingReceipt.selectedModelId === parent.parentRoute.modelId &&
    existing.routingReceipt.rawReasoning === parent.parentRoute.reasoning &&
    matchesIdempotentPool(existing.routingReceipt.poolRoute?.decision.request.pool, request.pool) &&
    (existing.routingReceipt.admittedContextBlocks !== undefined) ===
      (request.includeParentContext === true) &&
    authorityIsWithin(existing.authority, parent.parentAuthority) &&
    authorityIsWithin(existing.authority, parent.liveAuthority)
  );
}

function matchesIdempotentPool(
  decided: MultiModelPool | undefined,
  requested: MultiModelPool | undefined,
): boolean {
  if (decided === undefined || requested === undefined) {
    return decided === undefined && requested === undefined;
  }
  return (
    decided.mixedVendorEnabled === requested.mixedVendorEnabled &&
    decided.fallbackAllowed === requested.fallbackAllowed &&
    decided.higherCostFallbackAllowed === requested.higherCostFallbackAllowed &&
    decided.candidates.length === requested.candidates.length &&
    decided.candidates.every(
      (candidate, index) =>
        String(candidate.hostId) === String(requested.candidates[index]!.hostId) &&
        candidate.providerInstanceId === requested.candidates[index]!.providerInstanceId &&
        candidate.modelId === requested.candidates[index]!.modelId,
    )
  );
}

function authorityIsWithin(effective: AgentRunAuthority, ceiling: AgentRunAuthority): boolean {
  const booleanKeys = ["filesystem", "shell", "git", "network", "tools", "subagents"] as const;
  if (booleanKeys.some((key) => effective[key] && !ceiling[key])) return false;
  const executionRank: Record<AgentRunAuthority["executionPolicy"], number> = {
    plan: 0,
    "approval-gated": 1,
    "auto-accept-edits": 2,
    "full-access": 3,
  };
  return (
    executionRank[effective.executionPolicy] <= executionRank[ceiling.executionPolicy] &&
    (effective.permissionPersistence !== "project-default" ||
      ceiling.permissionPersistence === "project-default")
  );
}

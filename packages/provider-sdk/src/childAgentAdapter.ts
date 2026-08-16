import type {
  AgentRunExecutionKind,
  AgentRunUsageQuality,
  ProviderCapabilitySupport,
  ProviderRuntimeEvent,
} from "@octant/contracts";

export type ChildAgentGuarantee =
  | "routing-receipt"
  | "workspace-scope"
  | "authority-clamp"
  | "cancellation"
  | "observation"
  | "restart-reconciliation"
  | "usage-quality"
  | "result-acknowledgement";

export const CHILD_AGENT_REQUIRED_GUARANTEES = [
  "routing-receipt",
  "workspace-scope",
  "authority-clamp",
  "cancellation",
  "observation",
  "restart-reconciliation",
  "usage-quality",
  "result-acknowledgement",
] as const satisfies ReadonlyArray<ChildAgentGuarantee>;

export type ChildAgentGuaranteeMatrix = Readonly<Record<ChildAgentGuarantee, boolean>>;

export type ChildAgentNormalizedStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ChildAgentActivityEvent {
  readonly kind: "activity";
  readonly runId: string;
  readonly nativeChildId?: string;
  readonly status: ChildAgentNormalizedStatus;
  readonly summary: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly orderingKey: string;
  readonly transcriptOnly: boolean;
}

export interface ChildAgentResultEvent {
  readonly kind: "result";
  readonly runId: string;
  readonly nativeChildId?: string;
  readonly status: "completed" | "failed" | "cancelled" | "interrupted";
  readonly resultReference?: string;
  readonly recoveryReason?: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly orderingKey: string;
}

export interface ChildAgentUsageEvent {
  readonly kind: "usage";
  readonly runId: string;
  readonly nativeChildId?: string;
  readonly usageQuality: AgentRunUsageQuality;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly orderingKey: string;
}

export interface ChildAgentStopEvent {
  readonly kind: "stop";
  readonly runId: string;
  readonly nativeChildId?: string;
  readonly confirmed: boolean;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly orderingKey: string;
}

export interface ChildAgentReconcileEvent {
  readonly kind: "reconcile";
  readonly runId: string;
  readonly nativeChildId?: string;
  readonly resumable: boolean;
  readonly recoveryReason: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly orderingKey: string;
}

export type ChildAgentNormalizedEvent =
  | ChildAgentActivityEvent
  | ChildAgentResultEvent
  | ChildAgentUsageEvent
  | ChildAgentStopEvent
  | ChildAgentReconcileEvent;

export class ChildAgentAdapterError extends Error {
  override readonly name = "ChildAgentAdapterError";
  readonly category: "overclaim" | "unavailable" | "unsupported" | "invalid" | "fallback-required";

  constructor(category: ChildAgentAdapterError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface SelectChildExecutionInput {
  readonly claimedNativeSupport: ProviderCapabilitySupport;
  readonly nativeGuaranteeMatrix: ChildAgentGuaranteeMatrix;
  readonly preferredKind: AgentRunExecutionKind;
  readonly managedAvailable: boolean;
}

export interface ChildExecutionSelection {
  readonly selectedExecutionKind: AgentRunExecutionKind;
  readonly attemptedExecutionKind: AgentRunExecutionKind;
  readonly selectedFallback?: {
    readonly kind: "octant-managed";
    readonly reason: string;
  };
  readonly capabilityDegradations: ReadonlyArray<string>;
  readonly rejectedNativeReasons: ReadonlyArray<string>;
}

/**
 * Evaluate whether provider-native child execution may be used. Native is only
 * an optimization and is eligible only when every required guarantee is true
 * and the provider claims nativeChildAgents support honestly.
 */
export function evaluateNativeChildEligibility(input: {
  readonly claimedNativeSupport: ProviderCapabilitySupport;
  readonly nativeGuaranteeMatrix: ChildAgentGuaranteeMatrix;
}): {
  readonly eligible: boolean;
  readonly rejectedReasons: ReadonlyArray<string>;
} {
  const rejectedReasons: string[] = [];
  if (input.claimedNativeSupport !== "supported") {
    rejectedReasons.push(`nativeChildAgents-claimed-${input.claimedNativeSupport}`);
  }
  for (const guarantee of CHILD_AGENT_REQUIRED_GUARANTEES) {
    if (!input.nativeGuaranteeMatrix[guarantee]) {
      rejectedReasons.push(`missing-guarantee:${guarantee}`);
    }
  }
  return { eligible: rejectedReasons.length === 0, rejectedReasons };
}

/**
 * Explicit native-to-managed selection. Fail closed on overclaim (matrix claims
 * guarantees while capability is not supported) and when preferred native is
 * ineligible and managed is unavailable.
 */
export function selectChildExecutionKind(
  input: SelectChildExecutionInput,
): ChildExecutionSelection {
  const eligibility = evaluateNativeChildEligibility({
    claimedNativeSupport: input.claimedNativeSupport,
    nativeGuaranteeMatrix: input.nativeGuaranteeMatrix,
  });

  const matrixClaimsAny = CHILD_AGENT_REQUIRED_GUARANTEES.some(
    (guarantee) => input.nativeGuaranteeMatrix[guarantee],
  );
  if (input.claimedNativeSupport !== "supported" && matrixClaimsAny) {
    // Claiming concrete native guarantees while capability is not supported is overclaim.
    // Only full-false matrices are honest for unsupported/unavailable providers.
    const trueGuarantees = CHILD_AGENT_REQUIRED_GUARANTEES.filter(
      (guarantee) => input.nativeGuaranteeMatrix[guarantee],
    );
    if (trueGuarantees.length > 0 && input.claimedNativeSupport === "unsupported") {
      // unsupported may still report false matrix only
    }
  }
  if (
    input.claimedNativeSupport !== "supported" &&
    CHILD_AGENT_REQUIRED_GUARANTEES.every((g) => input.nativeGuaranteeMatrix[g])
  ) {
    throw new ChildAgentAdapterError(
      "overclaim",
      "Provider overclaims native child guarantees without nativeChildAgents support.",
    );
  }

  if (input.preferredKind === "provider-native") {
    if (eligibility.eligible) {
      return {
        selectedExecutionKind: "provider-native",
        attemptedExecutionKind: "provider-native",
        capabilityDegradations: [],
        rejectedNativeReasons: [],
      };
    }
    if (!input.managedAvailable) {
      throw new ChildAgentAdapterError(
        input.claimedNativeSupport === "unavailable" ? "unavailable" : "unsupported",
        `Native child execution is not eligible (${eligibility.rejectedReasons.join(", ")}) and managed fallback is unavailable.`,
      );
    }
    return {
      selectedExecutionKind: "octant-managed",
      attemptedExecutionKind: "provider-native",
      selectedFallback: {
        kind: "octant-managed",
        reason: eligibility.rejectedReasons.join(", ") || "native-child-ineligible",
      },
      capabilityDegradations: ["native-child-agents-unavailable"],
      rejectedNativeReasons: eligibility.rejectedReasons,
    };
  }

  // preferred managed
  if (!input.managedAvailable) {
    throw new ChildAgentAdapterError(
      "unavailable",
      "Octant-managed child execution is unavailable.",
    );
  }
  return {
    selectedExecutionKind: "octant-managed",
    attemptedExecutionKind: "octant-managed",
    capabilityDegradations:
      input.claimedNativeSupport === "supported" && !eligibility.eligible
        ? ["native-child-agents-unavailable"]
        : input.claimedNativeSupport !== "supported"
          ? ["native-child-agents-unavailable"]
          : [],
    rejectedNativeReasons: eligibility.rejectedReasons,
  };
}

export function allGuarantees(value: boolean): ChildAgentGuaranteeMatrix {
  return {
    "routing-receipt": value,
    "workspace-scope": value,
    "authority-clamp": value,
    cancellation: value,
    observation: value,
    "restart-reconciliation": value,
    "usage-quality": value,
    "result-acknowledgement": value,
  };
}

export function normalizeProviderChildActivity(input: {
  readonly runId: string;
  readonly event: Extract<ProviderRuntimeEvent, { kind: "child-agent-activity" }>;
  readonly executionKind: AgentRunExecutionKind;
}): ChildAgentActivityEvent {
  if (input.event.summary.trim().length === 0) {
    throw new ChildAgentAdapterError("invalid", "Child activity summary is required.");
  }
  return {
    kind: "activity",
    runId: input.runId,
    nativeChildId: input.event.childAgentId,
    status: mapNativeStatus(input.event.status),
    summary: input.event.summary,
    sequence: input.event.sequence,
    occurredAt: input.event.occurredAt,
    orderingKey: `${input.event.sessionId}:${input.event.sequence}:${input.event.childAgentId}`,
    // native without independent interactive resume is transcript-only truth
    transcriptOnly: input.executionKind === "provider-native",
  };
}

export function createManagedChildActivity(input: {
  readonly runId: string;
  readonly status: ChildAgentNormalizedStatus;
  readonly summary: string;
  readonly sequence: number;
  readonly occurredAt: string;
}): ChildAgentActivityEvent {
  if (input.summary.trim().length === 0) {
    throw new ChildAgentAdapterError("invalid", "Child activity summary is required.");
  }
  return {
    kind: "activity",
    runId: input.runId,
    status: input.status,
    summary: input.summary,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    orderingKey: `managed:${input.runId}:${input.sequence}`,
    transcriptOnly: false,
  };
}

export function createChildResultEvent(input: {
  readonly runId: string;
  readonly nativeChildId?: string;
  readonly status: ChildAgentResultEvent["status"];
  readonly resultReference?: string;
  readonly recoveryReason?: string;
  readonly sequence: number;
  readonly occurredAt: string;
}): ChildAgentResultEvent {
  if (input.status === "completed") {
    if (input.resultReference === undefined || input.resultReference.trim().length === 0) {
      throw new ChildAgentAdapterError(
        "invalid",
        "Completed child result requires a bounded result reference.",
      );
    }
  } else if (input.recoveryReason === undefined || input.recoveryReason.trim().length === 0) {
    if (input.status !== "cancelled") {
      throw new ChildAgentAdapterError(
        "invalid",
        `${input.status} child result requires a recovery reason.`,
      );
    }
  }
  return {
    kind: "result",
    runId: input.runId,
    ...(input.nativeChildId === undefined ? {} : { nativeChildId: input.nativeChildId }),
    status: input.status,
    ...(input.resultReference === undefined ? {} : { resultReference: input.resultReference }),
    ...(input.recoveryReason === undefined ? {} : { recoveryReason: input.recoveryReason }),
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    orderingKey: `result:${input.runId}:${input.sequence}`,
  };
}

export function createChildUsageEvent(input: {
  readonly runId: string;
  readonly nativeChildId?: string;
  readonly usageQuality: AgentRunUsageQuality;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly sequence: number;
  readonly occurredAt: string;
}): ChildAgentUsageEvent {
  if (
    input.usageQuality === "unavailable" &&
    (input.inputTokens !== undefined || input.outputTokens !== undefined)
  ) {
    throw new ChildAgentAdapterError(
      "invalid",
      "Unavailable usage quality cannot carry token counts.",
    );
  }
  return {
    kind: "usage",
    runId: input.runId,
    ...(input.nativeChildId === undefined ? {} : { nativeChildId: input.nativeChildId }),
    usageQuality: input.usageQuality,
    ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
    ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    orderingKey: `usage:${input.runId}:${input.sequence}`,
  };
}

export function createChildStopEvent(input: {
  readonly runId: string;
  readonly nativeChildId?: string;
  readonly confirmed: boolean;
  readonly sequence: number;
  readonly occurredAt: string;
}): ChildAgentStopEvent {
  return {
    kind: "stop",
    runId: input.runId,
    ...(input.nativeChildId === undefined ? {} : { nativeChildId: input.nativeChildId }),
    confirmed: input.confirmed,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    orderingKey: `stop:${input.runId}:${input.sequence}`,
  };
}

export function createChildReconcileEvent(input: {
  readonly runId: string;
  readonly nativeChildId?: string;
  readonly resumable: boolean;
  readonly recoveryReason: string;
  readonly sequence: number;
  readonly occurredAt: string;
}): ChildAgentReconcileEvent {
  if (input.recoveryReason.trim().length === 0) {
    throw new ChildAgentAdapterError("invalid", "Reconcile event requires a recovery reason.");
  }
  return {
    kind: "reconcile",
    runId: input.runId,
    ...(input.nativeChildId === undefined ? {} : { nativeChildId: input.nativeChildId }),
    resumable: input.resumable,
    recoveryReason: input.recoveryReason,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    orderingKey: `reconcile:${input.runId}:${input.sequence}`,
  };
}

/**
 * Deduplicate provider/native child events by ordering key before projection.
 * First occurrence wins; delayed duplicates are retained only as diagnostics
 * when requested.
 */
export function dedupeChildEvents(events: ReadonlyArray<ChildAgentNormalizedEvent>): {
  readonly applied: ReadonlyArray<ChildAgentNormalizedEvent>;
  readonly duplicates: ReadonlyArray<ChildAgentNormalizedEvent>;
} {
  const seen = new Set<string>();
  const applied: ChildAgentNormalizedEvent[] = [];
  const duplicates: ChildAgentNormalizedEvent[] = [];
  for (const event of events) {
    if (seen.has(event.orderingKey)) {
      duplicates.push(event);
      continue;
    }
    seen.add(event.orderingKey);
    applied.push(event);
  }
  return { applied, duplicates };
}

function mapNativeStatus(
  status: Extract<ProviderRuntimeEvent, { kind: "child-agent-activity" }>["status"],
): ChildAgentNormalizedStatus {
  switch (status) {
    case "starting":
    case "running":
    case "waiting":
    case "completed":
    case "failed":
      return status;
    default:
      return "failed";
  }
}

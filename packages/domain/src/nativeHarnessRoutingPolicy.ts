import {
  DEFAULT_NATIVE_HARNESS_JOB_SLOTS,
  NATIVE_HARNESS_BUILT_IN_SLOTS,
  nativeHarnessSlotCandidateKey,
  type AgentRunRole,
  type MultiModelCandidateRejectionReason,
  type NativeHarnessJob,
  type NativeHarnessRejectedCandidate,
  type NativeHarnessRouteDecision,
  type NativeHarnessRouteFailureReason,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessSlot,
  type NativeHarnessSlotCandidate,
  type NativeHarnessSlotId,
  type UtcTimestamp,
} from "@octant/contracts";

/** What the resolver may know about one candidate before it is chosen. */
export interface NativeHarnessCandidateFacts {
  readonly ready: boolean;
  /** A recent failure that keeps this candidate out of the chain until then. */
  readonly coolingDown?: {
    readonly reason: NativeHarnessRouteFailureReason;
    readonly until: UtcTimestamp;
  };
}

export interface ResolveNativeHarnessRouteInput {
  readonly job: NativeHarnessJob;
  readonly host: NativeHarnessRoutingConfiguration;
  /** A Project's own configuration, consulted before the host's. */
  readonly project?: NativeHarnessRoutingConfiguration;
  readonly facts: (candidate: NativeHarnessSlotCandidate) => NativeHarnessCandidateFacts;
  /** Whether a slot's circuit breaker is open, which refuses the whole slot. */
  readonly circuitOpen?: (slotId: NativeHarnessSlotId) => boolean;
  readonly now: UtcTimestamp;
}

/** The harness job a child of this role performs. */
export function nativeHarnessJobForRole(role: AgentRunRole): NativeHarnessJob {
  switch (role) {
    case "research":
      return "researcher";
    case "implementation":
      return "implementer";
    case "review":
      return "reviewer";
    case "custom":
      return "custom";
  }
}

/**
 * Where one job's model call goes, and why.
 *
 * Resolution is a pure function of configuration and observed facts: the
 * job's binding names a slot, the slot's primary is used when it is ready and
 * not cooling down, and otherwise the first ready fallback is used and the
 * decision says so. A binding to a slot nobody configured routes to `default`
 * with a visible warning. No decision ever falls back to a vendor list the
 * user did not write.
 */
export function resolveNativeHarnessRoute(
  input: ResolveNativeHarnessRouteInput,
): NativeHarnessRouteDecision {
  const requestedSlotId = bindingFor(input.job, input.project) ?? bindingFor(input.job, input.host);
  const base = { job: input.job, decidedAt: input.now } as const;
  let slot = requestedSlotId === undefined ? undefined : slotFor(requestedSlotId, input);
  let unconfigured = false;
  if (slot === undefined) {
    unconfigured = true;
    slot = slotFor(NATIVE_HARNESS_BUILT_IN_SLOTS.default, input);
    if (slot === undefined) {
      return {
        ...base,
        kind: "unroutable",
        slotId: requestedSlotId ?? NATIVE_HARNESS_BUILT_IN_SLOTS.default,
        reason: "slot-empty",
        rejected: [],
      };
    }
  }
  if (input.circuitOpen?.(slot.id) === true) {
    return { ...base, kind: "unroutable", slotId: slot.id, reason: "circuit-open", rejected: [] };
  }
  const rejected: NativeHarnessRejectedCandidate[] = [];
  let primaryFailure: NativeHarnessCandidateFacts["coolingDown"] | undefined;
  for (const [index, candidate] of slot.candidates.entries()) {
    const facts = input.facts(candidate);
    const reasons: MultiModelCandidateRejectionReason[] = [];
    if (!facts.ready) reasons.push("provider-not-ready");
    if (facts.coolingDown !== undefined && facts.coolingDown.until > input.now) {
      reasons.push("provider-not-ready");
      if (index === 0) primaryFailure = facts.coolingDown;
    }
    if (reasons.length > 0) {
      rejected.push({ candidate, reasons: [...new Set(reasons)] });
      continue;
    }
    if (unconfigured) {
      return {
        ...base,
        kind: "unconfigured-slot",
        requestedSlotId: requestedSlotId ?? slot.id,
        slotId: slot.id,
        candidate,
        rejected,
      };
    }
    if (index === 0) {
      return { ...base, kind: "primary", slotId: slot.id, candidate, rejected };
    }
    const primary = slot.candidates[0]!;
    return {
      ...base,
      kind: "failure-fallback",
      slotId: slot.id,
      candidate,
      from: primary,
      reason: primaryFailure?.reason ?? "endpoint-unavailable",
      cooldownUntil: primaryFailure?.until ?? input.now,
      rejected,
    };
  }
  return {
    ...base,
    kind: "unroutable",
    slotId: slot.id,
    reason: "no-eligible-candidate",
    rejected,
  };
}

function bindingFor(
  job: NativeHarnessJob,
  configuration: NativeHarnessRoutingConfiguration | undefined,
): NativeHarnessSlotId | undefined {
  const explicit = configuration?.jobSlots.find((binding) => binding.job === job)?.slotId;
  if (explicit !== undefined) return explicit;
  if (configuration === undefined) return undefined;
  return DEFAULT_NATIVE_HARNESS_JOB_SLOTS.find((binding) => binding.job === job)?.slotId;
}

function slotFor(
  slotId: NativeHarnessSlotId,
  input: ResolveNativeHarnessRouteInput,
): NativeHarnessSlot | undefined {
  return (
    input.project?.slots.find((slot) => slot.id === slotId) ??
    input.host.slots.find((slot) => slot.id === slotId)
  );
}

export function sameNativeHarnessCandidate(
  left: NativeHarnessSlotCandidate,
  right: NativeHarnessSlotCandidate,
): boolean {
  return nativeHarnessSlotCandidateKey(left) === nativeHarnessSlotCandidateKey(right);
}

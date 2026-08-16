import type { OctantMode } from "@octant/contracts/modes";
import type {
  MultiModelCandidateEligibility,
  MultiModelCandidateRejectionReason,
  MultiModelPoolCandidate,
  MultiModelRoutingVendorId,
  MultiModelRouteDecisionReceipt,
  MultiModelRouteSelectionRequest,
} from "@octant/contracts/multi-model-pool";
import type { ProviderModelCapability, ProviderReadiness } from "@octant/contracts/providers";
import type { HostId } from "@octant/contracts/shell";

export interface MultiModelCandidateRuntimeFacts {
  readonly candidate: MultiModelPoolCandidate;
  readonly routingVendorId: MultiModelRoutingVendorId;
  readonly configured: boolean;
  readonly readiness: ProviderReadiness;
  /** Whether the candidate's pooled model is present in the probed catalog. */
  readonly modelAvailable: boolean;
  readonly compatibleModes: ReadonlyArray<OctantMode>;
  readonly projectAllowed: boolean;
  readonly profileAllowed: boolean;
  readonly supportedCapabilities: ReadonlyArray<ProviderModelCapability>;
  readonly authorityAllowed: boolean;
  /** Relative rank within policy-controlled accounting; a larger value is more expensive. */
  readonly costRank?: number;
}

export interface ResolveMultiModelRouteInput {
  readonly request: MultiModelRouteSelectionRequest;
  readonly activeHostId: HostId;
  readonly mode: OctantMode;
  readonly parentRoutingVendorId: MultiModelRoutingVendorId;
  readonly parentCandidate: MultiModelPoolCandidate;
  readonly runtimeFacts: ReadonlyArray<MultiModelCandidateRuntimeFacts>;
}

export function resolveMultiModelRoute(
  input: ResolveMultiModelRouteInput,
): MultiModelRouteDecisionReceipt {
  const factsByCandidate = new Map(
    input.runtimeFacts.map((facts) => [candidateKey(facts.candidate), facts]),
  );
  const requestedCandidate = input.request.requestedCandidate ?? input.request.pool.candidates[0]!;
  const requestedFacts = factsByCandidate.get(candidateKey(requestedCandidate));

  const eligibility = input.request.pool.candidates.map((candidate) => {
    const facts = factsByCandidate.get(candidateKey(candidate));
    const reasons = baseRejectionReasons(candidate, facts, input);
    if (candidateKey(candidate) !== candidateKey(requestedCandidate)) {
      appendFallbackRejectionReasons(reasons, facts, requestedFacts, input);
    }
    const costRank = facts?.costRank;
    return {
      candidate,
      eligible: reasons.length === 0,
      reasons,
      ...(costRank !== undefined && isValidCostRank(costRank) ? { costRank } : {}),
    } satisfies MultiModelCandidateEligibility;
  });

  const requestedEligibility = eligibility.find(
    (entry) => candidateKey(entry.candidate) === candidateKey(requestedCandidate),
  );
  if (requestedEligibility?.eligible === true) {
    return {
      kind: "selected",
      request: input.request,
      mode: input.mode,
      activeHostId: input.activeHostId,
      parentCandidate: input.parentCandidate,
      eligibility,
      selectedCandidate: requestedCandidate,
      selectionKind: "requested",
      reason: "The requested model is selected and eligible for this execution unit.",
    };
  }

  const fallback = eligibility.find((entry) => entry.eligible);
  if (fallback !== undefined) {
    return {
      kind: "selected",
      request: input.request,
      mode: input.mode,
      activeHostId: input.activeHostId,
      parentCandidate: input.parentCandidate,
      eligibility,
      selectedCandidate: fallback.candidate,
      selectionKind: "fallback",
      reason:
        "The requested model is unavailable; an explicitly permitted pool fallback was selected.",
    };
  }

  return {
    kind: "waiting",
    request: input.request,
    mode: input.mode,
    activeHostId: input.activeHostId,
    parentCandidate: input.parentCandidate,
    eligibility,
    reason: "no-eligible-candidate",
    message: "No selected model is currently eligible. Check provider readiness and pool policy.",
  };
}

function baseRejectionReasons(
  candidate: MultiModelPoolCandidate,
  facts: MultiModelCandidateRuntimeFacts | undefined,
  input: ResolveMultiModelRouteInput,
): MultiModelCandidateRejectionReason[] {
  const reasons: MultiModelCandidateRejectionReason[] = [];
  if (candidate.hostId !== input.activeHostId) reasons.push("host-mismatch");
  if (facts === undefined || !facts.configured) {
    reasons.push("provider-unconfigured");
    return reasons;
  }
  if (facts.readiness !== "ready" && facts.readiness !== "degraded") {
    reasons.push("provider-not-ready");
  }
  if (!facts.modelAvailable) {
    reasons.push("model-unavailable");
  }
  if (!facts.compatibleModes.includes(input.mode)) reasons.push("mode-incompatible");
  if (!facts.projectAllowed) reasons.push("project-incompatible");
  if (!facts.profileAllowed) reasons.push("profile-disallowed");
  if (
    input.request.requiredCapabilities.some(
      (capability) => !facts.supportedCapabilities.includes(capability),
    )
  ) {
    reasons.push("capability-incompatible");
  }
  if (!facts.authorityAllowed) reasons.push("authority-incompatible");
  if (
    !input.request.pool.mixedVendorEnabled &&
    (facts.routingVendorId !== input.parentRoutingVendorId ||
      candidateKey(candidate) !== candidateKey(input.parentCandidate))
  ) {
    reasons.push("mixed-vendor-disabled");
  }
  return reasons;
}

function appendFallbackRejectionReasons(
  reasons: MultiModelCandidateRejectionReason[],
  facts: MultiModelCandidateRuntimeFacts | undefined,
  requestedFacts: MultiModelCandidateRuntimeFacts | undefined,
  input: ResolveMultiModelRouteInput,
): void {
  if (!input.request.pool.fallbackAllowed) {
    reasons.push("fallback-not-permitted");
    return;
  }
  if (input.request.pool.higherCostFallbackAllowed || facts === undefined) return;
  if (!isValidCostRank(requestedFacts?.costRank) || !isValidCostRank(facts.costRank)) {
    reasons.push("cost-not-comparable");
    return;
  }
  if (facts.costRank > requestedFacts.costRank) reasons.push("cost-increase-not-permitted");
}

function isValidCostRank(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function candidateKey(candidate: MultiModelPoolCandidate): string {
  return `${candidate.hostId}:${candidate.providerInstanceId}:${candidate.modelId}`;
}

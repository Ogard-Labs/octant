import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProviderInstanceId, ProviderModelCapability, ProviderModelId } from "./providers";

const MAX_POOL_CANDIDATES = 16;

export const MultiModelPoolCandidate = Schema.Struct({
  hostId: HostId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
});
export type MultiModelPoolCandidate = typeof MultiModelPoolCandidate.Type;

export const MultiModelRoutingVendorId = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  Schema.brand("MultiModelRoutingVendorId"),
);
export type MultiModelRoutingVendorId = typeof MultiModelRoutingVendorId.Type;

function candidateKey(candidate: MultiModelPoolCandidate): string {
  return `${candidate.hostId}:${candidate.providerInstanceId}:${candidate.modelId}`;
}

const UniquePoolCandidates = Schema.Array(MultiModelPoolCandidate).check(
  Schema.makeFilter(
    (candidates) =>
      candidates.length >= 2 &&
      candidates.length <= MAX_POOL_CANDIDATES &&
      new Set(candidates.map(candidateKey)).size === candidates.length,
  ),
);

export const MultiModelPool = Schema.Struct({
  candidates: UniquePoolCandidates,
  mixedVendorEnabled: Schema.Boolean,
  fallbackAllowed: Schema.Boolean,
  higherCostFallbackAllowed: Schema.Boolean,
});
export type MultiModelPool = typeof MultiModelPool.Type;

const UniqueRequiredCapabilities = Schema.Array(ProviderModelCapability).check(
  Schema.makeFilter(
    (capabilities) =>
      capabilities.length <= 8 && new Set(capabilities).size === capabilities.length,
  ),
);

export const MultiModelRouteSelectionRequest = Schema.Struct({
  pool: MultiModelPool,
  requestedCandidate: Schema.optional(MultiModelPoolCandidate),
  requiredCapabilities: UniqueRequiredCapabilities,
}).check(
  Schema.makeFilter(
    (request) =>
      request.requestedCandidate === undefined ||
      request.pool.candidates.some(
        (candidate) => candidateKey(candidate) === candidateKey(request.requestedCandidate!),
      ),
  ),
);
export type MultiModelRouteSelectionRequest = typeof MultiModelRouteSelectionRequest.Type;

export const MultiModelCandidateRejectionReason = Schema.Literals([
  "provider-unconfigured",
  "provider-not-ready",
  "model-unavailable",
  "host-mismatch",
  "mode-incompatible",
  "project-incompatible",
  "profile-disallowed",
  "capability-incompatible",
  "authority-incompatible",
  "mixed-vendor-disabled",
  "fallback-not-permitted",
  "cost-not-comparable",
  "cost-increase-not-permitted",
]);
export type MultiModelCandidateRejectionReason = typeof MultiModelCandidateRejectionReason.Type;

export const MultiModelCandidateEligibility = Schema.Struct({
  candidate: MultiModelPoolCandidate,
  eligible: Schema.Boolean,
  reasons: Schema.Array(MultiModelCandidateRejectionReason),
  costRank: Schema.optional(NonNegativeInt),
}).check(
  Schema.makeFilter((result) =>
    result.eligible ? result.reasons.length === 0 : result.reasons.length > 0,
  ),
);
export type MultiModelCandidateEligibility = typeof MultiModelCandidateEligibility.Type;

const MultiModelEligibilityResults = Schema.Array(MultiModelCandidateEligibility).check(
  Schema.makeFilter(
    (results) =>
      new Set(results.map((result) => candidateKey(result.candidate))).size === results.length,
  ),
);

const MultiModelEvaluationReceipt = {
  request: MultiModelRouteSelectionRequest,
  mode: OctantMode,
  activeHostId: HostId,
  parentCandidate: MultiModelPoolCandidate,
  eligibility: MultiModelEligibilityResults,
};

export const MultiModelRouteDecisionReceipt = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("selected"),
    ...MultiModelEvaluationReceipt,
    selectedCandidate: MultiModelPoolCandidate,
    selectionKind: Schema.Literals(["requested", "fallback"]),
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }).check(
    Schema.makeFilter((receipt) => {
      const requestedCandidate =
        receipt.request.requestedCandidate ?? receipt.request.pool.candidates[0]!;
      const selectedMatchesRequested =
        candidateKey(receipt.selectedCandidate) === candidateKey(requestedCandidate);
      const requestedCandidateEligibility = receipt.eligibility.find(
        (result) => candidateKey(result.candidate) === candidateKey(requestedCandidate),
      );
      const selectedEligibility = receipt.eligibility.find(
        (result) =>
          result.eligible &&
          candidateKey(result.candidate) === candidateKey(receipt.selectedCandidate),
      );
      const mixedVendorBindingHonored =
        receipt.request.pool.mixedVendorEnabled ||
        candidateKey(receipt.selectedCandidate) === candidateKey(receipt.parentCandidate);
      const requestedCostRank = requestedCandidateEligibility?.costRank;
      const selectedCostRank = selectedEligibility?.costRank;
      const fallbackCostEvidenceHonored =
        receipt.selectionKind === "requested" ||
        receipt.request.pool.higherCostFallbackAllowed ||
        (requestedCostRank !== undefined &&
          selectedCostRank !== undefined &&
          selectedCostRank <= requestedCostRank);
      return (
        receiptCoversPool(receipt) &&
        receipt.selectedCandidate.hostId === receipt.activeHostId &&
        mixedVendorBindingHonored &&
        fallbackCostEvidenceHonored &&
        (receipt.selectionKind === "requested"
          ? selectedMatchesRequested
          : receipt.request.pool.fallbackAllowed &&
            !selectedMatchesRequested &&
            requestedCandidateEligibility?.eligible === false) &&
        selectedEligibility !== undefined
      );
    }),
  ),
  Schema.Struct({
    kind: Schema.Literal("waiting"),
    ...MultiModelEvaluationReceipt,
    reason: Schema.Literal("no-eligible-candidate"),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }).check(
    Schema.makeFilter(
      (receipt) =>
        receiptCoversPool(receipt) && receipt.eligibility.every((result) => !result.eligible),
    ),
  ),
]);
export type MultiModelRouteDecisionReceipt = typeof MultiModelRouteDecisionReceipt.Type;

export const decodeMultiModelPoolCandidate = Schema.decodeUnknownSync(
  MultiModelPoolCandidate,
  STRICT_DECODE_OPTIONS,
);
export const decodeMultiModelRoutingVendorId = Schema.decodeUnknownSync(
  MultiModelRoutingVendorId,
  STRICT_DECODE_OPTIONS,
);
export const decodeMultiModelPool = Schema.decodeUnknownSync(MultiModelPool, STRICT_DECODE_OPTIONS);
export const decodeMultiModelRouteSelectionRequest = Schema.decodeUnknownSync(
  MultiModelRouteSelectionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeMultiModelCandidateEligibility = Schema.decodeUnknownSync(
  MultiModelCandidateEligibility,
  STRICT_DECODE_OPTIONS,
);
export const decodeMultiModelRouteDecisionReceipt = Schema.decodeUnknownSync(
  MultiModelRouteDecisionReceipt,
  STRICT_DECODE_OPTIONS,
);

function receiptCoversPool(receipt: {
  readonly request: MultiModelRouteSelectionRequest;
  readonly eligibility: ReadonlyArray<MultiModelCandidateEligibility>;
}): boolean {
  if (receipt.eligibility.length !== receipt.request.pool.candidates.length) return false;
  const eligibilityKeys = new Set(
    receipt.eligibility.map((result) => candidateKey(result.candidate)),
  );
  return receipt.request.pool.candidates.every((candidate) =>
    eligibilityKeys.has(candidateKey(candidate)),
  );
}

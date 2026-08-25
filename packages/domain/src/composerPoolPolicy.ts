import type { OctantMode } from "@octant/contracts/modes";
import type {
  MultiModelCandidateRejectionReason,
  MultiModelPoolCandidate,
  MultiModelRoutingVendorId,
} from "@octant/contracts/multi-model-pool";
import { decodeMultiModelRoutingVendorId } from "@octant/contracts/multi-model-pool";
import type {
  ProviderInstanceId,
  ProviderModelId,
  ProviderRegistrySnapshot,
} from "@octant/contracts/providers";
import type { HostId } from "@octant/contracts/shell";
import {
  resolveMultiModelRoute,
  type MultiModelCandidateRuntimeFacts,
} from "./multiModelPoolPolicy";

/**
 * Composer-facing projection of the Settings-defined agent-eligible default
 * pool. The composer can only narrow this pool, so every candidate here
 * comes from `ProviderDefaults.agentEligibleModels`; effective eligibility is
 * computed by the same `resolveMultiModelRoute` policy the server uses at
 * turn time — this module builds display facts but never forks the policy.
 */
export interface ComposerPoolCandidateView {
  readonly candidate: MultiModelPoolCandidate;
  readonly providerName: string;
  readonly modelName: string;
  /** Baseline eligibility (configured, ready, model present, mode, authority). */
  readonly selectable: boolean;
  readonly unavailableReason?: string;
  /** True when routing to this candidate crosses vendors from the current route. */
  readonly requiresMixedVendor: boolean;
  readonly isCurrent: boolean;
}

export type ComposerPoolModel =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly candidates: ReadonlyArray<ComposerPoolCandidateView>;
      readonly mixedVendorRequired: boolean;
    };

export interface BuildComposerPoolModelInput {
  readonly snapshot: ProviderRegistrySnapshot | undefined;
  readonly hostId: HostId;
  readonly mode: OctantMode;
  readonly current?:
    | {
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelId: ProviderModelId;
      }
    | undefined;
}

export function buildComposerPoolModel(input: BuildComposerPoolModelInput): ComposerPoolModel {
  if (input.snapshot === undefined) return { kind: "loading" };
  const eligibleDefaults = input.snapshot.defaults.agentEligibleModels ?? [];
  if (eligibleDefaults.length === 0) {
    return {
      kind: "unavailable",
      reason:
        "No agent-eligible models are defined in Provider Settings. Define a default pool there first.",
    };
  }
  if (eligibleDefaults.length < 2) {
    return {
      kind: "unavailable",
      reason:
        "Define at least two agent-eligible models in Provider Settings to route across a pool.",
    };
  }

  const candidates = eligibleDefaults.map(
    (ref): MultiModelPoolCandidate =>
      ({
        hostId: input.hostId,
        providerInstanceId: ref.providerInstanceId,
        modelId: ref.modelId,
      }) as MultiModelPoolCandidate,
  );
  const runtimeFacts = candidates.map((candidate) => candidateFacts(candidate, input));
  const currentCandidate =
    input.current === undefined
      ? undefined
      : ({
          hostId: input.hostId,
          providerInstanceId: input.current.providerInstanceId,
          modelId: input.current.modelId,
        } as MultiModelPoolCandidate);
  const parentCandidate =
    (currentCandidate !== undefined &&
      candidates.find((candidate) => candidateKey(candidate) === candidateKey(currentCandidate))) ||
    candidates[0]!;
  const parentVendor = vendorOf(parentCandidate.providerInstanceId, input.snapshot);

  // Mixed-vendor is enabled in the display request so baseline eligibility is
  // shown per candidate; the composer gates cross-vendor candidates behind the
  // separate explicit opt-in using `requiresMixedVendor` below. Fallback and
  // cost policy are turn-time concerns, so they are permissive here.
  const receipt = resolveMultiModelRoute({
    request: {
      pool: {
        candidates,
        mixedVendorEnabled: true,
        fallbackAllowed: true,
        higherCostFallbackAllowed: true,
      },
      requestedCandidate: parentCandidate,
      requiredCapabilities: [],
    },
    activeHostId: input.hostId,
    mode: input.mode,
    parentRoutingVendorId: parentVendor,
    parentCandidate,
    runtimeFacts,
  });
  const eligibilityByKey = new Map(
    receipt.eligibility.map((entry) => [candidateKey(entry.candidate), entry]),
  );

  const views = candidates.map((candidate): ComposerPoolCandidateView => {
    const eligibility = eligibilityByKey.get(candidateKey(candidate));
    const selectable = eligibility?.eligible === true;
    const firstReason = eligibility?.reasons[0];
    const vendor = vendorOf(candidate.providerInstanceId, input.snapshot!);
    return {
      candidate,
      providerName: providerNameOf(candidate.providerInstanceId, input.snapshot!),
      modelName: modelNameOf(candidate, input.snapshot!),
      selectable,
      ...(selectable || firstReason === undefined
        ? {}
        : { unavailableReason: poolRejectionLabel(firstReason) }),
      requiresMixedVendor: String(vendor) !== String(parentVendor),
      isCurrent:
        currentCandidate !== undefined &&
        candidateKey(candidate) === candidateKey(currentCandidate),
    };
  });

  return {
    kind: "ready",
    candidates: views,
    mixedVendorRequired: views.some((view) => view.selectable && view.requiresMixedVendor),
  };
}

export function poolRejectionLabel(reason: MultiModelCandidateRejectionReason): string {
  switch (reason) {
    case "provider-unconfigured":
      return "Provider is not configured.";
    case "provider-not-ready":
      return "Provider is not ready. Check its connection in Settings.";
    case "model-unavailable":
      return "Model is no longer listed by the provider.";
    case "host-mismatch":
      return "Model belongs to another host.";
    case "mode-incompatible":
      return "Model is not compatible with this mode.";
    case "project-incompatible":
      return "Model is not allowed for this Project.";
    case "profile-disallowed":
      return "Model is disallowed by the active agent profile.";
    case "capability-incompatible":
      return "Model lacks a required capability.";
    case "authority-incompatible":
      return "Provider is disabled.";
    case "mixed-vendor-disabled":
      return "Requires the explicit mixed-vendor opt-in.";
    case "fallback-not-permitted":
      return "Fallback routing is not permitted for this pool.";
    case "cost-not-comparable":
      return "Cost cannot be compared with the requested model.";
    case "cost-increase-not-permitted":
      return "Routing here would increase cost, which this pool does not permit.";
  }
}

function candidateFacts(
  candidate: MultiModelPoolCandidate,
  input: BuildComposerPoolModelInput,
): MultiModelCandidateRuntimeFacts {
  const snapshot = input.snapshot!;
  const instance = snapshot.instances.find(
    (entry) => String(entry.id) === String(candidate.providerInstanceId),
  );
  if (instance === undefined) {
    return {
      candidate,
      routingVendorId: decodeMultiModelRoutingVendorId("unconfigured"),
      configured: false,
      readiness: "unavailable",
      modelAvailable: false,
      compatibleModes: [],
      projectAllowed: true,
      profileAllowed: true,
      supportedCapabilities: [],
      authorityAllowed: false,
    };
  }
  const observed = snapshot.observedStates.find(
    (entry) => String(entry.instanceId) === String(candidate.providerInstanceId),
  );
  return {
    candidate,
    routingVendorId: decodeMultiModelRoutingVendorId(instance.driverKind),
    configured: true,
    readiness: observed?.readiness ?? "unavailable",
    modelAvailable:
      observed?.models.some((model) => String(model.id) === String(candidate.modelId)) ?? false,
    compatibleModes: observed === undefined ? [] : [input.mode],
    projectAllowed: true,
    profileAllowed: true,
    supportedCapabilities: [],
    authorityAllowed: instance.enabled,
  };
}

function vendorOf(
  providerInstanceId: ProviderInstanceId,
  snapshot: ProviderRegistrySnapshot,
): MultiModelRoutingVendorId {
  const instance = snapshot.instances.find(
    (entry) => String(entry.id) === String(providerInstanceId),
  );
  return decodeMultiModelRoutingVendorId(instance?.driverKind ?? "unconfigured");
}

function providerNameOf(
  providerInstanceId: ProviderInstanceId,
  snapshot: ProviderRegistrySnapshot,
): string {
  return (
    snapshot.instances.find((entry) => String(entry.id) === String(providerInstanceId))
      ?.displayName ?? String(providerInstanceId)
  );
}

function modelNameOf(
  candidate: MultiModelPoolCandidate,
  snapshot: ProviderRegistrySnapshot,
): string {
  const observed = snapshot.observedStates.find(
    (entry) => String(entry.instanceId) === String(candidate.providerInstanceId),
  );
  return (
    observed?.models.find((model) => String(model.id) === String(candidate.modelId))?.displayName ??
    String(candidate.modelId)
  );
}

function candidateKey(candidate: MultiModelPoolCandidate): string {
  return `${candidate.hostId}:${candidate.providerInstanceId}:${candidate.modelId}`;
}

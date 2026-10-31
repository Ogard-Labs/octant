import type {
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import type { AutoReviewer } from "@octant/contracts/shield";
import {
  resolveAutoReviewer,
  SHIELD_UNAVAILABLE_REASON,
  shieldRoutesApprovals,
} from "@octant/domain/guardrail-policy";

/** Who answers a thread's prompts at Auto, or why nobody can. */
export type AutoReview =
  | { readonly status: "reviewer"; readonly reviewer: AutoReviewer }
  | { readonly status: "none"; readonly reason: string };

/**
 * Who would answer a thread's prompts at Auto on this provider: the
 * provider's own reviewer where it has one and the person did not choose
 * Octant Shield, else Shield when the runtime sends its prompts to Octant and
 * is enabled. The host decides again on every prompt; this only says what the
 * picker shows.
 */
export function autoReviewFor(input: {
  readonly providerInstanceId: ProviderInstanceId | undefined;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly chosen?: AutoReviewer | undefined;
}): AutoReview | undefined {
  if (input.providerInstanceId === undefined) return undefined;
  const id = String(input.providerInstanceId);
  const instance = input.instances.find((candidate) => String(candidate.id) === id);
  const providerReview =
    input.observedByInstance.get(input.providerInstanceId)?.capabilities.harnessAutoReview ===
    "supported";
  const routes =
    instance !== undefined && instance.enabled && shieldRoutesApprovals(instance.driverKind);
  return resolveAutoReviewer({
    chosen: input.chosen,
    providerReview,
    shield: routes ? { available: true } : { available: false, reason: SHIELD_UNAVAILABLE_REASON },
  });
}

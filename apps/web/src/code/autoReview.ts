import type {
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import type { AutoReviewer, ShieldModelChoice } from "@octant/contracts/shield";
import {
  resolveAutoReviewer,
  SHIELD_UNAVAILABLE_REASON,
  shieldRoutesApprovals,
} from "@octant/domain/guardrail-policy";

export const SHIELD_MODEL_UNAVAILABLE_REASON =
  "The chosen Shield model's provider is turned off or removed, so this thread asks first.";

/** Who answers a thread's prompts at Auto, or why nobody can. */
export type AutoReview =
  | { readonly status: "reviewer"; readonly reviewer: AutoReviewer }
  | { readonly status: "none"; readonly reason: string };

/**
 * Who would answer a thread's prompts at Auto on this provider: the
 * provider's own reviewer where it has one and the person did not choose
 * Octant Shield, else Shield when the runtime sends its prompts to Octant and
 * is enabled, and the provider Shield judges with (the chosen Shield model's,
 * else the thread's own) is still configured and enabled. The host decides
 * again on every prompt; this only says what the picker shows.
 */
export function autoReviewFor(input: {
  readonly providerInstanceId: ProviderInstanceId | undefined;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly chosen?: AutoReviewer | undefined;
  /** The person's chosen Shield model; absent means the thread's own provider. */
  readonly shieldModel?: ShieldModelChoice | undefined;
}): AutoReview | undefined {
  if (input.providerInstanceId === undefined) return undefined;
  const id = String(input.providerInstanceId);
  const instance = input.instances.find((candidate) => String(candidate.id) === id);
  const providerReview =
    input.observedByInstance.get(input.providerInstanceId)?.capabilities.harnessAutoReview ===
    "supported";
  const routes =
    instance !== undefined && instance.enabled && shieldRoutesApprovals(instance.driverKind);
  const modelProviderId = input.shieldModel?.providerInstanceId;
  const modelProvider =
    modelProviderId === undefined
      ? instance
      : input.instances.find((candidate) => String(candidate.id) === String(modelProviderId));
  const shield = !routes
    ? { available: false as const, reason: SHIELD_UNAVAILABLE_REASON }
    : modelProvider === undefined || !modelProvider.enabled
      ? { available: false as const, reason: SHIELD_MODEL_UNAVAILABLE_REASON }
      : { available: true as const };
  return resolveAutoReviewer({ chosen: input.chosen, providerReview, shield });
}

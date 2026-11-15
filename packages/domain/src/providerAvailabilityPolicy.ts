import type { ProviderFailure } from "@octant/contracts";

/** How long a provider whose request failed for availability counts as down. */
export const PROVIDER_DOWN_MS = 5 * 60_000;

/**
 * What a failed provider request says about whether the provider can take
 * new work (docs/design/coordinator-threads.md, Starting workers). A usage
 * limit is the provider's own signal and lasts until the reset it names; an
 * unavailable endpoint (refused connection, 5xx, timeout) or an overloaded
 * one (a rate limit that is not a spent allowance) counts as down for a
 * while. Anything else (a rejected credential, a bad request, a tool error)
 * says nothing about availability.
 */
export function providerAvailabilityFromFailure(
  failure: Pick<ProviderFailure, "category" | "usageLimit">,
):
  | { readonly kind: "usage-limit"; readonly until?: string }
  | { readonly kind: "down" }
  | undefined {
  if (failure.usageLimit !== undefined) {
    return failure.usageLimit.resetsAt === undefined
      ? { kind: "usage-limit" }
      : { kind: "usage-limit", until: String(failure.usageLimit.resetsAt) };
  }
  switch (failure.category) {
    case "unavailable":
    case "rate-limited":
      return { kind: "down" };
    default:
      return undefined;
  }
}

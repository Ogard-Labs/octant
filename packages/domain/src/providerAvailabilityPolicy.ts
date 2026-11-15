import type { ProviderFailure, ProviderUsageLimitsEntry } from "@octant/contracts";

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

/**
 * Whether the host's last plan-usage reading for an account says its limit
 * is reached: a window the provider flagged exhausted, or one at 100%, whose
 * reset has not come yet. The account counts as at its limit until the
 * latest such reset; a reached window with no reset named holds while the
 * reading says so. A window below its limit never counts, and a window whose
 * reset has passed says nothing about the account now.
 */
export function usageLimitFromReading(
  entry: ProviderUsageLimitsEntry | undefined,
  now: number,
): { readonly until?: string } | undefined {
  const limits =
    entry?.status === "available"
      ? entry.limits
      : entry?.status === "failed"
        ? entry.staleLimits
        : undefined;
  const reached = (limits?.rateLimitWindows ?? []).filter(
    (window) =>
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > now) &&
      (window.status === "exhausted" ||
        (window.utilization !== undefined && window.utilization >= 1)),
  );
  if (reached.length === 0) return undefined;
  const resets = reached
    .flatMap((window) => (window.resetsAt === undefined ? [] : [String(window.resetsAt)]))
    .toSorted((a, b) => Date.parse(a) - Date.parse(b));
  const until = resets.at(-1);
  return until === undefined ? {} : { until };
}

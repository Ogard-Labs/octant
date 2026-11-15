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
 * reset has not come yet; the account's quota flagged exhausted with no
 * window; or a request or token bucket with nothing left before its reset.
 * The account counts as at its limit until the latest such reset. A reached
 * limit with no reset named holds for {@link PROVIDER_DOWN_MS} from the
 * reading's own time, like an availability mark, and then the next start
 * tries the account again: a reading the host keeps for hours must not keep a
 * model out for hours. A window below its limit never counts, and a window
 * whose reset has passed says nothing about the account now.
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
  if (limits === undefined || entry === undefined) return undefined;
  // A failed refresh keeps the last good reading; its time is that reading's,
  // not the failed refresh's, or refreshes that keep failing would hold it.
  const readAt = entry.status === "failed" ? entry.lastSuccessfulAt : entry.observedAt;
  const unnamedHolds = readAt !== undefined && now < Date.parse(String(readAt)) + PROVIDER_DOWN_MS;
  const future = (resetsAt: string | undefined) =>
    resetsAt === undefined || Date.parse(resetsAt) > now;
  const windows = limits.rateLimitWindows ?? [];
  const reached: Array<{ readonly resetsAt?: string | undefined }> = windows.filter(
    (window) =>
      future(window.resetsAt) &&
      (window.status === "exhausted" ||
        (window.utilization !== undefined && window.utilization >= 1)),
  );
  // The same signals the automatic-model account check counts: the
  // aggregate quota flag when no window explains it, and an HTTP bucket
  // with nothing left before its reset.
  if (windows.length === 0 && limits.quota === "exhausted") reached.push({});
  for (const bucket of [limits.requests, limits.tokens]) {
    if (bucket.status === "available" && bucket.remaining === 0 && future(bucket.resetsAt)) {
      reached.push({ resetsAt: bucket.resetsAt });
    }
  }
  const holding = reached.filter((limit) => limit.resetsAt !== undefined || unnamedHolds);
  if (holding.length === 0) return undefined;
  const resets = holding
    .flatMap((limit) => (limit.resetsAt === undefined ? [] : [String(limit.resetsAt)]))
    .toSorted((a, b) => Date.parse(a) - Date.parse(b));
  const until = resets.at(-1);
  return until === undefined ? {} : { until };
}

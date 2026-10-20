import {
  decodeProviderServiceLimits,
  type ProviderFailure,
  type ProviderFailureCategory,
  type ProviderInstanceId,
  type ProviderRateLimitWindow,
  type ProviderServiceLimits,
  type UtcTimestamp,
} from "@octant/contracts";
import { parseRetryAfter } from "@octant/provider-sdk/image-generation";
import { Effect } from "effect";

/**
 * Shared shape of the account usage endpoints a CLI's own sign-in can read.
 * The key travels only in the request; every failure here carries a fixed
 * message, so neither the key nor the response body reaches a log, the
 * journal, or an error a surface shows.
 */
export type AccountUsageFetch = (input: string, init: RequestInit) => Promise<Response>;

export function accountUsageFailure(
  category: ProviderFailureCategory,
  message: string,
  retryAfterMs?: number,
): ProviderFailure {
  return { category, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

export function requestAccountUsage(
  fetch: AccountUsageFetch,
  name: string,
  url: string,
  init: RequestInit,
  now: () => number,
): Effect.Effect<unknown, ProviderFailure> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(url, { ...init, signal, redirect: "error" }),
      catch: () => accountUsageFailure("provider-failed", `${name} usage could not be reached.`),
    });
    if (response.status === 401 || response.status === 403) {
      return yield* Effect.fail(
        accountUsageFailure("unauthenticated", `${name} refused the saved sign-in.`),
      );
    }
    if (response.status === 429) {
      return yield* Effect.fail(
        accountUsageFailure(
          "rate-limited",
          `${name} usage is rate limited.`,
          parseRetryAfter(response.headers.get("retry-after"), now()),
        ),
      );
    }
    if (!response.ok) {
      return yield* Effect.fail(
        accountUsageFailure(
          "provider-failed",
          `${name} usage failed with HTTP ${String(response.status)}.`,
        ),
      );
    }
    return yield* Effect.tryPromise({
      try: async () => JSON.parse(await response.text()) as unknown,
      catch: () => accountUsageFailure("protocol", `${name} returned unreadable usage.`),
    });
  });
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON number, or a decimal string as ProtoJSON writes 64-bit integers. */
export function numberField(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

/** Seconds or milliseconds since the epoch, or an ISO-8601 instant. */
export function resetTimestamp(value: unknown): UtcTimestamp | undefined {
  const epoch = numberField(value);
  let milliseconds = Number.NaN;
  if (epoch !== undefined) {
    if (epoch > 0) milliseconds = epoch < 10_000_000_000 ? epoch * 1_000 : epoch;
  } else if (typeof value === "string") {
    milliseconds = Date.parse(value);
  }
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString() as UtcTimestamp;
}

/**
 * One rolling window from the share of it already used, in percent. A figure
 * outside 0–100 means the endpoint changed what it reports, so it is refused
 * rather than clamped into a plausible bar.
 */
export function usedPercentWindow(
  window: string,
  usedPercent: number,
  resetsAt: UtcTimestamp | undefined,
  observedAt: UtcTimestamp,
): ProviderRateLimitWindow | undefined {
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;
  const utilization = usedPercent / 100;
  return {
    window,
    status: utilization >= 1 ? "exhausted" : utilization >= 0.8 ? "warning" : "allowed",
    utilization,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    observedAt,
  };
}

export function accountWindowLimits(
  providerInstanceId: ProviderInstanceId,
  windows: ReadonlyArray<ProviderRateLimitWindow>,
  updatedAt: UtcTimestamp,
): ProviderServiceLimits {
  return decodeProviderServiceLimits({
    providerInstanceId,
    scope: "account",
    requests: { status: "unavailable" },
    tokens: { status: "unavailable" },
    concurrency: { status: "unavailable" },
    retry: { status: "inactive" },
    quota: windows.some((window) => window.status === "exhausted") ? "exhausted" : "available",
    source: "runtime-reported",
    confidence: "high",
    updatedAt,
    rateLimitWindows: windows,
  });
}

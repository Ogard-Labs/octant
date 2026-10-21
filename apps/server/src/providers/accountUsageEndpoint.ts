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
import { Effect, Either } from "effect";

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

const BACKGROUND_READ_INTERVAL_MS = 5 * 60_000;

interface AccountUsageReadingState {
  outcome?: Either.Either<ProviderServiceLimits, ProviderFailure>;
  attemptedAt?: number;
  inFlight?: Promise<void> | undefined;
}

/**
 * The last reading of each account, kept in the host process. Drivers are
 * built afresh for every call, so the readings outlive any one driver.
 */
export type AccountUsageReadings = Map<string, AccountUsageReadingState>;

export const sharedAccountUsageReadings: AccountUsageReadings = new Map();

/**
 * Only a refresh a person asked for waits on the endpoint. Every other caller
 * gets the last reading at once: a Chat turn asks for service limits before
 * every prompt, through a path with no timeout, so a live call there would
 * hold the prompt behind the endpoint and spend its rate limit. Those callers
 * start a background read at most once per five minutes, which the limits
 * service's next pass picks up.
 */
export function readAccountUsage(
  readings: AccountUsageReadings,
  key: string,
  read: Effect.Effect<ProviderServiceLimits, ProviderFailure>,
  onDemand: boolean,
  now: () => number,
): Effect.Effect<ProviderServiceLimits, ProviderFailure> {
  const state = readings.get(key) ?? {};
  readings.set(key, state);
  const settle = (outcome: Either.Either<ProviderServiceLimits, ProviderFailure>) => {
    state.outcome = outcome;
  };
  if (onDemand) {
    return Effect.either(read).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          state.attemptedAt = now();
          settle(outcome);
        }),
      ),
      Effect.flatMap((outcome) => outcome),
    );
  }
  return Effect.suspend(() => {
    const due =
      state.attemptedAt === undefined || now() - state.attemptedAt >= BACKGROUND_READ_INTERVAL_MS;
    if (due && state.inFlight === undefined) {
      state.attemptedAt = now();
      state.inFlight = Effect.runPromise(Effect.either(read))
        .then(settle)
        .finally(() => {
          state.inFlight = undefined;
        });
    }
    return (
      state.outcome ??
      Either.left(accountUsageFailure("unavailable", "Account usage has not been read yet."))
    );
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

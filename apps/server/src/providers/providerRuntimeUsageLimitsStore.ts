import {
  decodeProviderServiceLimits,
  type ProviderInstanceId,
  type ProviderRateLimitWindow,
  type ProviderRuntimeEvent,
  type ProviderServiceLimits,
  type ServiceLimitBucket,
  type UtcTimestamp,
} from "@octant/contracts";

const DEFAULT_MAX_WINDOWS_PER_PROVIDER = 32;
const DEFAULT_MAX_PROVIDERS = 128;
const MAX_OPEN_SESSIONS_PER_PROVIDER = 256;

type BucketName = "requests" | "tokens";

interface ObservedBucket {
  readonly limit: number;
  readonly remaining: number;
  readonly resetsAt?: UtcTimestamp;
  readonly observedAt: UtcTimestamp;
}

/** Whether the most recently completed turn on an instance carried quota buckets. */
export type ProviderRuntimeTurnReport = "reported" | "silent";

/**
 * Holds bounded, process-local provider limit evidence observed on live
 * sessions: rolling usage windows and absolute quota buckets. The event
 * journal deliberately does not retain provider payloads; this store is a
 * rebuildable view that disappears with the runtime.
 */
export class ProviderRuntimeUsageLimitsStore {
  readonly #maxWindowsPerProvider: number;
  readonly #maxProviders: number;
  readonly #windows = new Map<string, Map<string, ProviderRateLimitWindow>>();
  readonly #resetHighWater = new Map<string, Map<string, number>>();
  readonly #buckets = new Map<string, Map<BucketName, ObservedBucket>>();
  readonly #sessionsReportingBuckets = new Map<string, Set<string>>();
  readonly #turnReports = new Map<string, ProviderRuntimeTurnReport>();

  constructor(
    options: {
      readonly maxWindowsPerProvider?: number;
      readonly maxProviders?: number;
    } = {},
  ) {
    const maximum = options.maxWindowsPerProvider ?? DEFAULT_MAX_WINDOWS_PER_PROVIDER;
    if (
      !Number.isSafeInteger(maximum) ||
      maximum <= 0 ||
      maximum > DEFAULT_MAX_WINDOWS_PER_PROVIDER
    ) {
      throw new Error("Provider runtime window retention must be a safe integer between 1 and 32.");
    }
    this.#maxWindowsPerProvider = maximum;
    const maxProviders = options.maxProviders ?? DEFAULT_MAX_PROVIDERS;
    if (!Number.isSafeInteger(maxProviders) || maxProviders <= 0) {
      throw new Error("Provider runtime retention must allow a positive safe number of providers.");
    }
    this.#maxProviders = maxProviders;
  }

  record(event: ProviderRuntimeEvent): void {
    switch (event.kind) {
      case "rate-limit-window":
        this.#recordWindow(event);
        return;
      case "rate-limit-bucket":
        this.#recordBucket(event);
        return;
      case "completed":
      case "failed":
      case "interrupted":
      case "waiting":
        this.#closeSession(event);
        return;
      default:
        return;
    }
  }

  windows(
    instanceId: ProviderInstanceId,
    now?: UtcTimestamp,
  ): ReadonlyArray<ProviderRateLimitWindow> {
    const windows = this.#windows.get(String(instanceId));
    if (windows === undefined) return [];
    if (now !== undefined) {
      const resetHighWater =
        this.#resetHighWater.get(String(instanceId)) ?? new Map<string, number>();
      this.#prune(windows, now, resetHighWater);
      this.#save(String(instanceId), windows, resetHighWater);
    }
    return [...windows.values()].sort((left, right) => left.window.localeCompare(right.window));
  }

  /**
   * What the last completed turn said about quota buckets, so an endpoint
   * that answered without rate-limit headers is reported as silent rather
   * than as a runtime that has not spoken yet.
   */
  lastCompletedTurn(instanceId: ProviderInstanceId): ProviderRuntimeTurnReport | undefined {
    return this.#turnReports.get(String(instanceId));
  }

  serviceLimits(
    instanceId: ProviderInstanceId,
    updatedAt: UtcTimestamp,
  ): ProviderServiceLimits | undefined {
    const rateLimitWindows = this.windows(instanceId, updatedAt);
    const buckets = this.#liveBuckets(String(instanceId), updatedAt);
    const observedAts = [
      ...rateLimitWindows.map((window) => window.observedAt),
      ...[...buckets.values()].map((bucket) => bucket.observedAt),
    ];
    const first = observedAts[0];
    if (first === undefined) return undefined;
    const latestObservedAt = observedAts.reduce(
      (latest, observedAt) => (Date.parse(observedAt) > Date.parse(latest) ? observedAt : latest),
      first,
    );
    return decodeProviderServiceLimits({
      providerInstanceId: instanceId,
      scope: "provider-instance",
      requests: serviceLimitBucket(buckets.get("requests")),
      tokens: serviceLimitBucket(buckets.get("tokens")),
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      // A window being exhausted is not evidence that the provider account
      // quota is exhausted; providers may expose several independent windows.
      quota: "unknown",
      source: "runtime-reported",
      confidence: "high",
      updatedAt: latestObservedAt,
      ...(rateLimitWindows.length === 0 ? {} : { rateLimitWindows }),
    });
  }

  clear(instanceId: ProviderInstanceId): void {
    const key = String(instanceId);
    this.#windows.delete(key);
    this.#resetHighWater.delete(key);
    this.#buckets.delete(key);
    this.#sessionsReportingBuckets.delete(key);
    this.#turnReports.delete(key);
  }

  #recordWindow(
    event: Extract<ProviderRuntimeEvent, { readonly kind: "rate-limit-window" }>,
  ): void {
    const key = String(event.instanceId);
    const windows = this.#windows.get(key) ?? new Map<string, ProviderRateLimitWindow>();
    const resetHighWater = this.#resetHighWater.get(key) ?? new Map<string, number>();
    const occurredAt = Date.parse(event.occurredAt);
    this.#prune(windows, event.occurredAt, resetHighWater);
    const resetsAt = event.resetsAt === undefined ? undefined : Date.parse(event.resetsAt);
    if (resetsAt !== undefined && resetsAt <= occurredAt) {
      this.#rememberReset(resetHighWater, event.window, resetsAt);
      this.#save(key, windows, resetHighWater);
      return;
    }
    const previousReset = resetHighWater.get(event.window);
    if (
      previousReset !== undefined &&
      (resetsAt === undefined ? occurredAt <= previousReset : resetsAt <= previousReset)
    ) {
      this.#save(key, windows, resetHighWater);
      return;
    }
    const previous = windows.get(event.window);
    if (previous !== undefined && Date.parse(previous.observedAt) > occurredAt) {
      return;
    }
    windows.set(event.window, {
      window: event.window,
      status: event.status,
      ...(event.utilization === undefined ? {} : { utilization: event.utilization }),
      ...(event.resetsAt === undefined && previous?.resetsAt === undefined
        ? {}
        : { resetsAt: event.resetsAt ?? previous?.resetsAt }),
      observedAt: event.occurredAt,
    });
    while (windows.size > this.#maxWindowsPerProvider) {
      const oldest = [...windows.entries()].sort(
        (left, right) => Date.parse(left[1].observedAt) - Date.parse(right[1].observedAt),
      )[0];
      if (oldest === undefined) break;
      windows.delete(oldest[0]);
    }
    this.#save(key, windows, resetHighWater);
    while (this.#windows.size > this.#maxProviders) {
      const oldest = [...this.#windows.entries()].sort(
        (left, right) => latestObservedAt(left[1]) - latestObservedAt(right[1]),
      )[0];
      if (oldest === undefined) break;
      this.#windows.delete(oldest[0]);
      this.#resetHighWater.delete(oldest[0]);
    }
  }

  #recordBucket(
    event: Extract<ProviderRuntimeEvent, { readonly kind: "rate-limit-bucket" }>,
  ): void {
    const key = String(event.instanceId);
    const sessions = this.#sessionsReportingBuckets.get(key) ?? new Set<string>();
    sessions.add(String(event.sessionId));
    while (sessions.size > MAX_OPEN_SESSIONS_PER_PROVIDER) {
      const oldest = sessions.values().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    this.#sessionsReportingBuckets.set(key, sessions);
    this.#boundProviders(this.#sessionsReportingBuckets);
    const occurredAt = Date.parse(event.occurredAt);
    // A bucket whose reset has already passed says nothing about the account
    // now: the provider refilled it and the observed remaining count is gone.
    if (event.resetsAt !== undefined && Date.parse(event.resetsAt) <= occurredAt) return;
    const buckets = this.#buckets.get(key) ?? new Map<BucketName, ObservedBucket>();
    const previous = buckets.get(event.bucket);
    if (previous !== undefined && Date.parse(previous.observedAt) > occurredAt) return;
    buckets.set(event.bucket, {
      limit: event.limit,
      remaining: event.remaining,
      ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
      observedAt: event.occurredAt,
    });
    this.#buckets.set(key, buckets);
    while (this.#buckets.size > this.#maxProviders) {
      const oldest = [...this.#buckets.entries()].sort(
        (left, right) => latestBucketObservedAt(left[1]) - latestBucketObservedAt(right[1]),
      )[0];
      if (oldest === undefined) break;
      this.#buckets.delete(oldest[0]);
    }
  }

  #closeSession(
    event: Extract<
      ProviderRuntimeEvent,
      { readonly kind: "completed" | "failed" | "interrupted" | "waiting" }
    >,
  ): void {
    const key = String(event.instanceId);
    const sessions = this.#sessionsReportingBuckets.get(key);
    const reported = sessions?.delete(String(event.sessionId)) ?? false;
    if (sessions !== undefined && sessions.size === 0) this.#sessionsReportingBuckets.delete(key);
    // Only a completed turn proves the endpoint answered: a failed or
    // interrupted one may never have reached a response with headers.
    if (event.kind !== "completed") return;
    this.#turnReports.set(key, reported ? "reported" : "silent");
    this.#boundProviders(this.#turnReports);
  }

  #liveBuckets(key: string, now: UtcTimestamp): Map<BucketName, ObservedBucket> {
    const buckets = this.#buckets.get(key);
    if (buckets === undefined) return new Map();
    const nowMs = Date.parse(now);
    for (const [name, bucket] of buckets) {
      if (bucket.resetsAt !== undefined && Date.parse(bucket.resetsAt) <= nowMs) {
        buckets.delete(name);
      }
    }
    if (buckets.size === 0) this.#buckets.delete(key);
    return buckets;
  }

  #boundProviders(map: Map<string, unknown>): void {
    while (map.size > this.#maxProviders) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  #prune(
    windows: Map<string, ProviderRateLimitWindow>,
    now: UtcTimestamp,
    resetHighWater: Map<string, number>,
  ): void {
    const nowMs = Date.parse(now);
    for (const [name, window] of windows) {
      if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= nowMs) {
        this.#rememberReset(resetHighWater, name, Date.parse(window.resetsAt));
        windows.delete(name);
      }
    }
  }

  #rememberReset(resetHighWater: Map<string, number>, window: string, resetAt: number): void {
    const previous = resetHighWater.get(window);
    if (previous === undefined || resetAt > previous) resetHighWater.set(window, resetAt);
  }

  #save(
    key: string,
    windows: Map<string, ProviderRateLimitWindow>,
    resetHighWater: Map<string, number>,
  ): void {
    while (resetHighWater.size > this.#maxWindowsPerProvider) {
      const oldest = [...resetHighWater.entries()].sort((left, right) => left[1] - right[1])[0];
      if (oldest === undefined) break;
      resetHighWater.delete(oldest[0]);
    }
    this.#windows.set(key, windows);
    this.#resetHighWater.set(key, resetHighWater);
  }
}

function serviceLimitBucket(bucket: ObservedBucket | undefined): ServiceLimitBucket {
  if (bucket === undefined) return { status: "unavailable" };
  return {
    status: "available",
    limit: bucket.limit,
    remaining: bucket.remaining,
    ...(bucket.resetsAt === undefined ? {} : { resetsAt: bucket.resetsAt }),
  };
}

function latestObservedAt(windows: Map<string, ProviderRateLimitWindow>): number {
  return Math.max(...[...windows.values()].map((window) => Date.parse(window.observedAt)));
}

function latestBucketObservedAt(buckets: Map<BucketName, ObservedBucket>): number {
  return Math.max(...[...buckets.values()].map((bucket) => Date.parse(bucket.observedAt)));
}

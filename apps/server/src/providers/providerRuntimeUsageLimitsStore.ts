import {
  decodeProviderServiceLimits,
  type ProviderInstanceId,
  type ProviderRateLimitWindow,
  type ProviderRuntimeEvent,
  type ProviderServiceLimits,
  type UtcTimestamp,
} from "@octant/contracts";

const DEFAULT_MAX_WINDOWS_PER_PROVIDER = 32;
const DEFAULT_MAX_PROVIDERS = 128;

/**
 * Holds bounded, process-local provider window evidence observed on live
 * sessions. The event journal deliberately does not retain provider payloads;
 * this store is a rebuildable view that disappears with the runtime.
 */
export class ProviderRuntimeUsageLimitsStore {
  readonly #maxWindowsPerProvider: number;
  readonly #maxProviders: number;
  readonly #windows = new Map<string, Map<string, ProviderRateLimitWindow>>();
  readonly #resetHighWater = new Map<string, Map<string, number>>();

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
    if (event.kind !== "rate-limit-window") return;
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

  serviceLimits(
    instanceId: ProviderInstanceId,
    updatedAt: UtcTimestamp,
  ): ProviderServiceLimits | undefined {
    const rateLimitWindows = this.windows(instanceId, updatedAt);
    if (rateLimitWindows.length === 0) return undefined;
    const firstWindow = rateLimitWindows[0];
    if (firstWindow === undefined) return undefined;
    const latestObservedAt = rateLimitWindows.reduce(
      (latest, window) =>
        Date.parse(window.observedAt) > Date.parse(latest) ? window.observedAt : latest,
      firstWindow.observedAt,
    );
    return decodeProviderServiceLimits({
      providerInstanceId: instanceId,
      scope: "provider-instance",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      concurrency: { status: "unavailable" },
      retry: { status: "inactive" },
      // A window being exhausted is not evidence that the provider account
      // quota is exhausted; providers may expose several independent windows.
      quota: "unknown",
      source: "runtime-reported",
      confidence: "high",
      updatedAt: latestObservedAt,
      rateLimitWindows,
    });
  }

  clear(instanceId: ProviderInstanceId): void {
    this.#windows.delete(String(instanceId));
    this.#resetHighWater.delete(String(instanceId));
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

function latestObservedAt(windows: Map<string, ProviderRateLimitWindow>): number {
  return Math.max(...[...windows.values()].map((window) => Date.parse(window.observedAt)));
}

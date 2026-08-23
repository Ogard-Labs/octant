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

  constructor(
    options: {
      readonly maxWindowsPerProvider?: number;
      readonly maxProviders?: number;
    } = {},
  ) {
    const maximum = options.maxWindowsPerProvider ?? DEFAULT_MAX_WINDOWS_PER_PROVIDER;
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error("Provider runtime window retention must be a positive safe integer.");
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
    this.#prune(windows, event.occurredAt);
    const previous = windows.get(event.window);
    if (previous !== undefined && Date.parse(previous.observedAt) >= Date.parse(event.occurredAt)) {
      return;
    }
    windows.set(event.window, {
      window: event.window,
      status: event.status,
      ...(event.utilization === undefined ? {} : { utilization: event.utilization }),
      ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
      observedAt: event.occurredAt,
    });
    while (windows.size > this.#maxWindowsPerProvider) {
      const oldest = [...windows.entries()].sort(
        (left, right) => Date.parse(left[1].observedAt) - Date.parse(right[1].observedAt),
      )[0];
      if (oldest === undefined) break;
      windows.delete(oldest[0]);
    }
    this.#windows.set(key, windows);
    while (this.#windows.size > this.#maxProviders) {
      const oldest = [...this.#windows.entries()].sort(
        (left, right) => latestObservedAt(left[1]) - latestObservedAt(right[1]),
      )[0];
      if (oldest === undefined) break;
      this.#windows.delete(oldest[0]);
    }
  }

  windows(
    instanceId: ProviderInstanceId,
    now?: UtcTimestamp,
  ): ReadonlyArray<ProviderRateLimitWindow> {
    const windows = this.#windows.get(String(instanceId));
    if (windows === undefined) return [];
    if (now !== undefined) this.#prune(windows, now);
    return [...windows.values()].sort((left, right) => left.window.localeCompare(right.window));
  }

  serviceLimits(
    instanceId: ProviderInstanceId,
    updatedAt: UtcTimestamp,
  ): ProviderServiceLimits | undefined {
    const rateLimitWindows = this.windows(instanceId, updatedAt);
    if (rateLimitWindows.length === 0) return undefined;
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
      updatedAt,
      rateLimitWindows,
    });
  }

  clear(instanceId: ProviderInstanceId): void {
    this.#windows.delete(String(instanceId));
  }

  #prune(windows: Map<string, ProviderRateLimitWindow>, now: UtcTimestamp): void {
    const nowMs = Date.parse(now);
    for (const [name, window] of windows) {
      if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= nowMs) {
        windows.delete(name);
      }
    }
  }
}

function latestObservedAt(windows: Map<string, ProviderRateLimitWindow>): number {
  return Math.max(...[...windows.values()].map((window) => Date.parse(window.observedAt)));
}

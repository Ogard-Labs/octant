import {
  decodeProviderFailure,
  decodeProviderUsageLimitsSnapshot,
  type ProviderInstance,
  type ProviderUsageLimitsEntry,
  type ProviderUsageLimitsSnapshot,
  type ProviderUsageLimitsSource,
  type ProviderInstanceId,
  type ProviderServiceLimits,
  type UtcTimestamp,
} from "@octant/contracts";

class ProviderUsageLimitsTimeout extends Error {
  override readonly name = "ProviderUsageLimitsTimeout";
}

class ProviderUsageLimitsStopped extends Error {
  override readonly name = "ProviderUsageLimitsStopped";
}

export interface ProviderUsageLimitsObservation {
  readonly source: ProviderUsageLimitsSource;
  readonly limits: ProviderServiceLimits;
}

export interface ProviderUsageLimitsServiceOptions {
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  readonly observe: (
    instance: ProviderInstance,
    signal: AbortSignal,
  ) => Promise<ProviderUsageLimitsObservation | undefined>;
  /** Latest normalized runtime evidence, if a live session has reported it. */
  readonly runtimeLimits?: (
    instanceId: ProviderInstanceId,
    observedAt: UtcTimestamp,
  ) => ProviderServiceLimits | undefined;
  readonly now: () => UtcTimestamp;
  readonly refreshIntervalMs?: number;
  readonly refreshTimeoutMs?: number;
  readonly schedule?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  readonly cancelSchedule?: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

export class ProviderUsageLimitsService {
  readonly #options: ProviderUsageLimitsServiceOptions;
  readonly #entries = new Map<string, ProviderUsageLimitsEntry>();
  readonly #runtimeWindowOwners = new Set<string>();
  #inFlight: Promise<ProviderUsageLimitsSnapshot> | undefined;
  #refreshAbortController: AbortController | undefined;
  #scheduleHandle: ReturnType<typeof setInterval> | undefined;

  constructor(options: ProviderUsageLimitsServiceOptions) {
    this.#options = options;
  }

  snapshot(): ProviderUsageLimitsSnapshot {
    return this.#snapshot(this.#options.now());
  }

  refresh(): Promise<ProviderUsageLimitsSnapshot> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const abortController = new AbortController();
    this.#refreshAbortController = abortController;
    const running = this.#refresh(abortController.signal).finally(() => {
      if (this.#inFlight === running) this.#inFlight = undefined;
      if (this.#refreshAbortController === abortController) {
        this.#refreshAbortController = undefined;
      }
    });
    this.#inFlight = running;
    return running;
  }

  start(): void {
    if (this.#scheduleHandle !== undefined) return;
    const schedule =
      this.#options.schedule ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.#scheduleHandle = schedule(() => {
      void this.refresh().catch(() => undefined);
    }, this.#options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
  }

  stop(): void {
    this.#refreshAbortController?.abort();
    if (this.#scheduleHandle === undefined) return;
    const cancel = this.#options.cancelSchedule ?? clearInterval;
    cancel(this.#scheduleHandle);
    this.#scheduleHandle = undefined;
  }

  async #refresh(signal: AbortSignal): Promise<ProviderUsageLimitsSnapshot> {
    const observedAt = this.#options.now();
    const instances = this.#options.listInstances();
    this.#pruneRuntimeWindowOwners(instances);
    const next = await Promise.all(
      instances.map((instance) => this.#observe(instance, observedAt, signal)),
    );
    if (signal.aborted) return this.#snapshot(this.#options.now());
    this.#entries.clear();
    for (const entry of next) this.#entries.set(String(entry.providerInstanceId), entry);
    return this.#snapshot(this.#options.now());
  }

  async #observe(
    instance: ProviderInstance,
    observedAt: UtcTimestamp,
    refreshSignal: AbortSignal,
  ): Promise<ProviderUsageLimitsEntry> {
    const previous = this.#entries.get(String(instance.id));
    if (refreshSignal.aborted) {
      return previous ?? this.#unavailable(instance, observedAt, "not-ready");
    }
    const retryAt = this.#retryAt(previous);
    if (previous !== undefined && retryAt !== undefined && retryAt > observedAt) return previous;
    if (!instance.enabled) {
      this.#runtimeWindowOwners.delete(String(instance.id));
      return this.#unavailable(instance, observedAt, "not-configured");
    }
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let rejectStopped: ((reason: ProviderUsageLimitsStopped) => void) | undefined;
    const onRefreshAbort = () => {
      const stopped = new ProviderUsageLimitsStopped();
      controller.abort(stopped);
      rejectStopped?.(stopped);
    };
    refreshSignal.addEventListener("abort", onRefreshAbort, { once: true });
    try {
      const observation = await Promise.race([
        this.#options.observe(instance, controller.signal),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort(new ProviderUsageLimitsTimeout());
            reject(new ProviderUsageLimitsTimeout());
          }, this.#options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
        }),
        new Promise<never>((_, reject) => {
          rejectStopped = reject;
          if (refreshSignal.aborted) {
            onRefreshAbort();
            return;
          }
        }),
      ]);
      const runtimeLimits = this.#options.runtimeLimits?.(instance.id, observedAt);
      if (observation === undefined) {
        if (runtimeLimits === undefined) {
          this.#runtimeWindowOwners.delete(String(instance.id));
          return this.#unavailable(instance, observedAt, "unsupported");
        }
        if (runtimeLimits.rateLimitWindows === undefined) {
          this.#runtimeWindowOwners.delete(String(instance.id));
        } else {
          this.#runtimeWindowOwners.add(String(instance.id));
        }
        return {
          providerInstanceId: instance.id,
          status: "available",
          source: "provider-runtime",
          observedAt,
          limits: runtimeLimits,
        };
      }
      if (runtimeLimits?.rateLimitWindows === undefined) {
        this.#runtimeWindowOwners.delete(String(instance.id));
      } else {
        this.#runtimeWindowOwners.add(String(instance.id));
      }
      return {
        providerInstanceId: instance.id,
        status: "available",
        source: observation.source,
        observedAt,
        limits:
          runtimeLimits?.rateLimitWindows === undefined
            ? observation.limits
            : {
                ...observation.limits,
                rateLimitWindows: runtimeLimits.rateLimitWindows,
              },
      };
    } catch (error) {
      if (error instanceof ProviderUsageLimitsStopped) {
        return previous ?? this.#unavailable(instance, observedAt, "not-ready");
      }
      const runtimeLimits = this.#options.runtimeLimits?.(instance.id, observedAt);
      if (runtimeLimits?.rateLimitWindows !== undefined) {
        this.#runtimeWindowOwners.add(String(instance.id));
      }
      const priorStaleLimits =
        previous?.status === "available"
          ? previous.limits
          : previous?.status === "failed"
            ? (previous.staleLimits ?? runtimeLimits)
            : runtimeLimits;
      const staleLimits =
        priorStaleLimits === undefined || runtimeLimits?.rateLimitWindows === undefined
          ? priorStaleLimits
          : { ...priorStaleLimits, rateLimitWindows: runtimeLimits.rateLimitWindows };
      const lastSuccessfulAt =
        previous?.status === "available"
          ? previous.observedAt
          : previous?.status === "failed"
            ? (previous.lastSuccessfulAt ?? runtimeLimits?.updatedAt)
            : runtimeLimits?.updatedAt;
      const providerFailure = this.#providerFailure(error);
      const retryAfterMs = providerFailure?.retryAfterMs;
      const failureRetryAt =
        retryAfterMs === undefined
          ? undefined
          : new Date(Date.parse(observedAt) + retryAfterMs).toISOString();
      return {
        providerInstanceId: instance.id,
        status: "failed",
        source: previous?.source ?? "provider-runtime",
        observedAt,
        failure: {
          category:
            error instanceof ProviderUsageLimitsTimeout ||
            controller.signal.reason instanceof ProviderUsageLimitsTimeout
              ? "timeout"
              : providerFailure?.category === "rate-limited"
                ? "rate-limited"
                : providerFailure?.category === "protocol"
                  ? "protocol"
                  : "unavailable",
          message: "Provider limits could not be refreshed.",
          ...(failureRetryAt === undefined ? {} : { retryAt: failureRetryAt as UtcTimestamp }),
        },
        ...(staleLimits === undefined ? {} : { staleLimits }),
        ...(lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt }),
      };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      refreshSignal.removeEventListener("abort", onRefreshAbort);
      rejectStopped = undefined;
    }
  }

  #unavailable(
    instance: ProviderInstance,
    observedAt: UtcTimestamp,
    reason: "unsupported" | "not-configured" | "not-ready",
  ): ProviderUsageLimitsEntry {
    this.#runtimeWindowOwners.delete(String(instance.id));
    return {
      providerInstanceId: instance.id,
      status: "unavailable",
      source: "provider-runtime",
      reason,
      observedAt,
    };
  }

  #retryAt(entry: ProviderUsageLimitsEntry | undefined): UtcTimestamp | undefined {
    if (entry?.status === "failed") return entry.failure.retryAt;
    if (entry?.status === "available" && entry.limits.retry.status === "active") {
      return entry.limits.retry.until;
    }
    return undefined;
  }

  #providerFailure(error: unknown) {
    try {
      return decodeProviderFailure(error);
    } catch {
      return undefined;
    }
  }

  #snapshot(refreshedAt: UtcTimestamp): ProviderUsageLimitsSnapshot {
    const entries = new Map(this.#entries);
    const runtimeLimits = this.#options.runtimeLimits;
    if (runtimeLimits !== undefined) {
      const instances = this.#options.listInstances();
      this.#pruneRuntimeWindowOwners(instances);
      for (const instance of instances) {
        if (!instance.enabled) continue;
        const limits = runtimeLimits(instance.id, refreshedAt);
        const previous = entries.get(String(instance.id));
        if (limits === undefined) {
          if (
            previous?.status === "available" &&
            previous.source === "provider-runtime" &&
            this.#runtimeWindowOwners.has(String(instance.id)) &&
            previous.limits.rateLimitWindows !== undefined
          ) {
            const { rateLimitWindows: _expiredWindows, ...withoutWindows } = previous.limits;
            const hasOtherEvidence =
              withoutWindows.requests.status === "available" ||
              withoutWindows.tokens.status === "available" ||
              withoutWindows.concurrency.status === "available" ||
              withoutWindows.retry.status === "active" ||
              withoutWindows.quota === "available" ||
              withoutWindows.quota === "exhausted";
            entries.set(
              String(instance.id),
              hasOtherEvidence
                ? {
                    ...previous,
                    limits: withoutWindows,
                  }
                : this.#unavailable(instance, refreshedAt, "unsupported"),
            );
          }
          continue;
        }
        if (previous?.status === "failed") {
          const staleLimits =
            previous.staleLimits === undefined || limits.rateLimitWindows === undefined
              ? (previous.staleLimits ?? limits)
              : { ...previous.staleLimits, rateLimitWindows: limits.rateLimitWindows };
          entries.set(String(instance.id), {
            ...previous,
            staleLimits,
            ...(previous.lastSuccessfulAt === undefined
              ? { lastSuccessfulAt: limits.updatedAt }
              : {}),
          });
          continue;
        }
        entries.set(String(instance.id), {
          providerInstanceId: instance.id,
          status: "available",
          source: "provider-runtime",
          observedAt: limits.updatedAt,
          limits:
            previous?.status === "available" && limits.rateLimitWindows !== undefined
              ? { ...previous.limits, rateLimitWindows: limits.rateLimitWindows }
              : limits,
        });
      }
    }
    return decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt,
      entries: [...entries.values()].sort((left, right) =>
        String(left.providerInstanceId).localeCompare(String(right.providerInstanceId)),
      ),
    });
  }

  #pruneRuntimeWindowOwners(instances: ReadonlyArray<ProviderInstance>): void {
    const currentIds = new Set(instances.map((instance) => String(instance.id)));
    for (const ownerId of this.#runtimeWindowOwners) {
      if (!currentIds.has(ownerId)) this.#runtimeWindowOwners.delete(ownerId);
    }
  }
}

import {
  decodeProviderFailure,
  decodeProviderUsageLimitsSnapshot,
  type ProviderInstance,
  type ProviderUsageLimitsEntry,
  type ProviderUsageLimitsSnapshot,
  type ProviderUsageLimitsSource,
  type ProviderUsageLimitsUnavailableReason,
  type ProviderInstanceId,
  type ProviderServiceLimits,
  UtcTimestamp as UtcTimestampSchema,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestampSchema);

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
  /**
   * Why an enabled instance with no evidence shows nothing. Defaults to
   * `unsupported`, which means the runtime may still report; a caller that
   * knows the runtime never will names that instead.
   */
  readonly unavailableReason?: (instance: ProviderInstance) => ProviderUsageLimitsUnavailableReason;
  readonly now: () => UtcTimestamp;
  readonly refreshIntervalMs?: number;
  readonly refreshTimeoutMs?: number;
  readonly schedule?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  readonly cancelSchedule?: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Where an entry's runtime evidence sits. `runtime-only` entries are nothing
 * but live session evidence and vanish with it; `merged` entries belong to a
 * direct observer and only borrow the runtime's rolling windows.
 */
type RuntimeEvidenceOrigin = "runtime-only" | "merged";

export class ProviderUsageLimitsService {
  readonly #options: ProviderUsageLimitsServiceOptions;
  readonly #entries = new Map<string, ProviderUsageLimitsEntry>();
  readonly #runtimeOrigins = new Map<string, RuntimeEvidenceOrigin>();
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
    this.#pruneRuntimeOrigins(instances);
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
    const key = String(instance.id);
    const previous = this.#entries.get(key);
    if (refreshSignal.aborted) {
      return previous ?? this.#unavailable(instance, observedAt, "not-ready");
    }
    const retryAt = this.#retryAt(previous);
    if (previous !== undefined && retryAt !== undefined && retryAt > observedAt) return previous;
    if (!instance.enabled) {
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
          return this.#unavailable(instance, observedAt, this.#noEvidenceReason(instance));
        }
        this.#runtimeOrigins.set(key, "runtime-only");
        return {
          providerInstanceId: instance.id,
          status: "available",
          source: "provider-runtime",
          observedAt,
          limits: runtimeLimits,
        };
      }
      if (runtimeLimits?.rateLimitWindows === undefined) {
        this.#runtimeOrigins.delete(key);
      } else {
        this.#runtimeOrigins.set(key, "merged");
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
      if (this.#runtimeOrigins.get(key) === "runtime-only" || priorStaleLimits === runtimeLimits) {
        if (staleLimits === undefined) this.#runtimeOrigins.delete(key);
        else this.#runtimeOrigins.set(key, "runtime-only");
      } else if (runtimeLimits?.rateLimitWindows !== undefined) {
        this.#runtimeOrigins.set(key, "merged");
      }
      const lastSuccessfulAt =
        previous?.status === "available"
          ? previous.observedAt
          : previous?.status === "failed"
            ? (previous.lastSuccessfulAt ?? runtimeLimits?.updatedAt)
            : runtimeLimits?.updatedAt;
      const providerFailure = this.#providerFailure(error);
      const retryAfterMs = providerFailure?.retryAfterMs;
      const failureRetryAt =
        retryAfterMs === undefined ? undefined : decodeRetryTimestamp(observedAt, retryAfterMs);
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
          ...(failureRetryAt === undefined ? {} : { retryAt: failureRetryAt }),
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

  #noEvidenceReason(instance: ProviderInstance): ProviderUsageLimitsUnavailableReason {
    return this.#options.unavailableReason?.(instance) ?? "unsupported";
  }

  #unavailable(
    instance: ProviderInstance,
    observedAt: UtcTimestamp,
    reason: ProviderUsageLimitsUnavailableReason,
    clearRuntimeOrigin = true,
  ): ProviderUsageLimitsEntry {
    if (clearRuntimeOrigin) this.#runtimeOrigins.delete(String(instance.id));
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
      this.#pruneRuntimeOrigins(instances);
      for (const instance of instances) {
        if (!instance.enabled) continue;
        const key = String(instance.id);
        const limits = runtimeLimits(instance.id, refreshedAt);
        const previous = entries.get(key);
        const origin = this.#runtimeOrigins.get(key);
        if (limits === undefined) {
          const expired = this.#withoutRuntimeEvidence(instance, previous, origin, refreshedAt);
          if (expired !== undefined) entries.set(key, expired);
          continue;
        }
        if (previous?.status === "failed") {
          const staleLimits =
            origin === "runtime-only" || previous.staleLimits === undefined
              ? limits
              : limits.rateLimitWindows === undefined
                ? withoutWindows(previous.staleLimits)
                : { ...previous.staleLimits, rateLimitWindows: limits.rateLimitWindows };
          if (previous.staleLimits === undefined) this.#runtimeOrigins.set(key, "runtime-only");
          entries.set(key, {
            ...previous,
            staleLimits,
            ...(previous.lastSuccessfulAt === undefined
              ? { lastSuccessfulAt: limits.updatedAt }
              : {}),
          });
          continue;
        }
        const previousAvailable = previous?.status === "available" ? previous : undefined;
        if (previousAvailable !== undefined && origin !== "runtime-only") {
          // A direct observer owns this entry; the runtime only lends it
          // rolling windows, and takes them back once they expire.
          if (limits.rateLimitWindows === undefined) {
            if (origin === "merged") {
              entries.set(key, {
                ...previousAvailable,
                limits: withoutWindows(previousAvailable.limits),
              });
            }
            continue;
          }
          this.#runtimeOrigins.set(key, "merged");
          entries.set(key, {
            ...previousAvailable,
            observedAt: latestTimestamp(previousAvailable.observedAt, limits.updatedAt),
            limits: { ...previousAvailable.limits, rateLimitWindows: limits.rateLimitWindows },
          });
          continue;
        }
        this.#runtimeOrigins.set(key, "runtime-only");
        entries.set(key, {
          providerInstanceId: instance.id,
          status: "available",
          source: previousAvailable?.source ?? "provider-runtime",
          observedAt:
            previousAvailable === undefined
              ? limits.updatedAt
              : latestTimestamp(previousAvailable.observedAt, limits.updatedAt),
          limits,
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

  /**
   * The entry once every live runtime fact behind it has expired. Evidence
   * that was only ever the runtime's disappears with it; an observer-owned
   * entry merely loses the windows it borrowed. The origin is kept: the
   * refreshed entry still holds the expired facts, so every later read must
   * reach the same answer until the next refresh replaces it.
   */
  #withoutRuntimeEvidence(
    instance: ProviderInstance,
    previous: ProviderUsageLimitsEntry | undefined,
    origin: RuntimeEvidenceOrigin | undefined,
    refreshedAt: UtcTimestamp,
  ): ProviderUsageLimitsEntry | undefined {
    if (origin === undefined || previous === undefined) return undefined;
    if (previous.status === "available") {
      if (origin === "runtime-only") {
        return this.#unavailable(instance, refreshedAt, this.#noEvidenceReason(instance), false);
      }
      if (previous.limits.rateLimitWindows === undefined) return undefined;
      const remaining = withoutWindows(previous.limits);
      return hasServiceLimitEvidence(remaining)
        ? { ...previous, limits: remaining }
        : this.#unavailable(instance, refreshedAt, this.#noEvidenceReason(instance), false);
    }
    if (previous.status === "failed" && previous.staleLimits !== undefined) {
      const { staleLimits, ...withoutStaleLimits } = previous;
      if (origin === "runtime-only" || staleLimits.rateLimitWindows === undefined) {
        return origin === "runtime-only" ? withoutStaleLimits : undefined;
      }
      const remaining = withoutWindows(staleLimits);
      return hasServiceLimitEvidence(remaining)
        ? { ...withoutStaleLimits, staleLimits: remaining }
        : withoutStaleLimits;
    }
    return undefined;
  }

  #pruneRuntimeOrigins(instances: ReadonlyArray<ProviderInstance>): void {
    const currentIds = new Set(instances.map((instance) => String(instance.id)));
    for (const ownerId of this.#runtimeOrigins.keys()) {
      if (!currentIds.has(ownerId)) this.#runtimeOrigins.delete(ownerId);
    }
  }
}

function withoutWindows(limits: ProviderServiceLimits): ProviderServiceLimits {
  const { rateLimitWindows: _expiredWindows, ...rest } = limits;
  return rest;
}

function hasServiceLimitEvidence(limits: ProviderServiceLimits): boolean {
  return (
    limits.requests.status === "available" ||
    limits.tokens.status === "available" ||
    limits.concurrency.status === "available" ||
    limits.retry.status === "active" ||
    limits.quota === "available" ||
    limits.quota === "exhausted"
  );
}

function latestTimestamp(left: UtcTimestamp, right: UtcTimestamp): UtcTimestamp {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function decodeRetryTimestamp(
  observedAt: UtcTimestamp,
  retryAfterMs: number,
): UtcTimestamp | undefined {
  try {
    return decodeUtcTimestamp(new Date(Date.parse(observedAt) + retryAfterMs).toISOString());
  } catch {
    return undefined;
  }
}

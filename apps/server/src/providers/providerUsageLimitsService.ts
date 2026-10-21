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
  type ServiceLimitBucket,
  UtcTimestamp as UtcTimestampSchema,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import { canonicalRateLimitWindowId } from "./rateLimitWindowIdentity";

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestampSchema);

class ProviderUsageLimitsTimeout extends Error {
  override readonly name = "ProviderUsageLimitsTimeout";
}

class ProviderUsageLimitsStopped extends Error {
  override readonly name = "ProviderUsageLimitsStopped";
}

export interface ProviderUsageLimitsObservation {
  readonly source: ProviderUsageLimitsSource;
  readonly limits?: ProviderServiceLimits;
  readonly unavailableReason?: ProviderUsageLimitsUnavailableReason;
}

export interface ProviderUsageLimitsServiceOptions {
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  readonly observe: (
    instance: ProviderInstance,
    signal: AbortSignal,
    /** `onDemand` is true only for a refresh a person asked for. */
    request: { readonly onDemand: boolean },
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
  /**
   * Readings the host saved before it last stopped. They come back as past
   * observations, with the time they were read, and give way to the first
   * fresh evidence. Nothing here asks a provider for anything.
   */
  readonly restoredEntries?: ReadonlyArray<ProviderUsageLimitsEntry>;
  /**
   * Called with the readings worth keeping whenever they change: the entries
   * that hold limits, a failed refresh's last good reading included.
   */
  readonly persistEntries?: (entries: ReadonlyArray<ProviderUsageLimitsEntry>) => void;
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
type RateLimitWindow = NonNullable<ProviderServiceLimits["rateLimitWindows"]>[number];

function mergeRateLimitWindows(
  left: ReadonlyArray<RateLimitWindow> | undefined,
  right: ReadonlyArray<RateLimitWindow> | undefined,
): ReadonlyArray<RateLimitWindow> | undefined {
  if (left === undefined && right === undefined) return undefined;
  const merged = new Map<string, RateLimitWindow>();
  const add = (window: RateLimitWindow) => {
    const key = canonicalRateLimitWindowId(window.window);
    const previous = merged.get(key);
    if (
      previous === undefined ||
      Date.parse(window.observedAt) >= Date.parse(previous.observedAt)
    ) {
      merged.set(key, { ...window, window: key });
    }
  };
  for (const window of left ?? []) add(window);
  for (const window of right ?? []) add(window);
  return [...merged.values()].sort((a, b) => a.window.localeCompare(b.window));
}

export class ProviderUsageLimitsService {
  readonly #options: ProviderUsageLimitsServiceOptions;
  readonly #entries = new Map<string, ProviderUsageLimitsEntry>();
  readonly #runtimeOrigins = new Map<string, RuntimeEvidenceOrigin>();
  /** Instances whose entry is still a reading restored from before a restart. */
  readonly #restored = new Set<string>();
  #persisted: string | undefined;
  #inFlight: Promise<ProviderUsageLimitsSnapshot> | undefined;
  #inFlightOnDemand = false;
  #refreshAbortController: AbortController | undefined;
  #scheduleHandle: ReturnType<typeof setInterval> | undefined;

  constructor(options: ProviderUsageLimitsServiceOptions) {
    this.#options = options;
    const restored = (options.restoredEntries ?? []).filter(
      (entry) => entry.status === "available",
    );
    // The saved file is the baseline: the first read rewrites it only when
    // an entry was dropped (an instance removed or disabled since).
    this.#persisted = JSON.stringify(restored);
    for (const entry of restored) {
      this.#entries.set(String(entry.providerInstanceId), entry);
      this.#restored.add(String(entry.providerInstanceId));
    }
    this.#settleRestored(options.now());
  }

  snapshot(): ProviderUsageLimitsSnapshot {
    return this.#snapshot(this.#options.now());
  }

  /**
   * `onDemand` marks a refresh a person asked for. Only that kind reaches a
   * source whose reading starts the provider's process; the schedule never
   * does.
   */
  refresh(request: { readonly onDemand?: boolean } = {}): Promise<ProviderUsageLimitsSnapshot> {
    const onDemand = request.onDemand === true;
    const inFlight = this.#inFlight;
    if (inFlight !== undefined) {
      // A scheduled pass cannot answer a request for a fresh reading, because
      // it never asked the costly sources. The requested pass runs after it.
      if (!onDemand || this.#inFlightOnDemand) return inFlight;
      const again = () => this.refresh(request);
      return inFlight.then(again, again);
    }
    const abortController = new AbortController();
    this.#refreshAbortController = abortController;
    this.#inFlightOnDemand = onDemand;
    const running = this.#refresh(abortController.signal, onDemand).finally(() => {
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

  async #refresh(signal: AbortSignal, onDemand: boolean): Promise<ProviderUsageLimitsSnapshot> {
    const observedAt = this.#options.now();
    const instances = this.#options.listInstances();
    this.#pruneRuntimeOrigins(instances);
    this.#settleRestored(observedAt);
    const next = await Promise.all(
      instances.map((instance) => this.#observe(instance, observedAt, signal, onDemand)),
    );
    if (signal.aborted) return this.#snapshot(this.#options.now());
    const before = new Map(this.#entries);
    this.#entries.clear();
    for (const entry of next) this.#entries.set(String(entry.providerInstanceId), entry);
    for (const key of this.#restored) {
      if (this.#entries.get(key) !== before.get(key)) this.#restored.delete(key);
    }
    return this.#snapshot(this.#options.now());
  }

  async #observe(
    instance: ProviderInstance,
    observedAt: UtcTimestamp,
    refreshSignal: AbortSignal,
    onDemand: boolean,
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
        this.#options.observe(instance, controller.signal, { onDemand }),
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
      if (observation?.unavailableReason !== undefined) {
        return this.#unavailable(instance, observedAt, observation.unavailableReason);
      }
      if (observation === undefined || observation.limits === undefined) {
        // A restored reading is the only evidence there is until a turn or a
        // refresh a person asked for reports again, so a pass that found
        // nothing leaves it as it was. A live runtime report with rolling
        // windows is merged into it when the snapshot is built.
        if (
          previous?.status === "available" &&
          this.#restored.has(key) &&
          (runtimeLimits === undefined || runtimeLimits.rateLimitWindows !== undefined)
        ) {
          return previous;
        }
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
      const rateLimitWindows = mergeRateLimitWindows(
        observation.limits.rateLimitWindows,
        runtimeLimits?.rateLimitWindows,
      );
      return {
        providerInstanceId: instance.id,
        status: "available",
        source: observation.source,
        observedAt,
        limits:
          rateLimitWindows === undefined
            ? observation.limits
            : { ...observation.limits, rateLimitWindows },
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
      const staleRateLimitWindows = mergeRateLimitWindows(
        priorStaleLimits?.rateLimitWindows,
        runtimeLimits?.rateLimitWindows,
      );
      const staleLimits =
        priorStaleLimits === undefined
          ? runtimeLimits
          : staleRateLimitWindows === undefined
            ? priorStaleLimits
            : { ...priorStaleLimits, rateLimitWindows: staleRateLimitWindows };
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
    this.#settleRestored(refreshedAt);
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
          const staleRateLimitWindows = mergeRateLimitWindows(
            previous.staleLimits?.rateLimitWindows,
            limits.rateLimitWindows,
          );
          const staleLimits =
            origin === "runtime-only" || previous.staleLimits === undefined
              ? limits
              : staleRateLimitWindows === undefined
                ? withoutWindows(previous.staleLimits)
                : { ...previous.staleLimits, rateLimitWindows: staleRateLimitWindows };
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
          const rateLimitWindows = mergeRateLimitWindows(
            previousAvailable.limits.rateLimitWindows,
            limits.rateLimitWindows,
          );
          this.#runtimeOrigins.set(key, "merged");
          entries.set(key, {
            ...previousAvailable,
            observedAt: latestTimestamp(previousAvailable.observedAt, limits.updatedAt),
            limits: { ...previousAvailable.limits, rateLimitWindows },
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
    const snapshot = decodeProviderUsageLimitsSnapshot({
      version: 1,
      refreshedAt,
      entries: [...entries.values()].sort((left, right) =>
        String(left.providerInstanceId).localeCompare(String(right.providerInstanceId)),
      ),
    });
    this.#persist(snapshot.entries);
    return snapshot;
  }

  /**
   * Keeps a restored reading honest: it is dropped once its instance is gone
   * or disabled, loses windows and buckets whose reset has passed, and turns
   * into an unavailable entry when nothing is left. The reading's own
   * `observedAt` is never touched, so it always reads as a past observation.
   */
  #settleRestored(now: UtcTimestamp): void {
    if (this.#restored.size === 0) return;
    const instances = new Map(
      this.#options.listInstances().map((instance) => [String(instance.id), instance]),
    );
    for (const key of this.#restored) {
      const entry = this.#entries.get(key);
      const instance = instances.get(key);
      if (entry?.status !== "available" || instance === undefined || !instance.enabled) {
        this.#entries.delete(key);
        this.#restored.delete(key);
        continue;
      }
      const limits = withoutExpiredEvidence(entry.limits, now);
      if (limits === undefined) {
        this.#entries.set(key, this.#unavailable(instance, now, this.#noEvidenceReason(instance)));
        this.#restored.delete(key);
      } else if (limits !== entry.limits) {
        this.#entries.set(key, { ...entry, limits });
      }
    }
  }

  #persist(entries: ReadonlyArray<ProviderUsageLimitsEntry>): void {
    const persist = this.#options.persistEntries;
    if (persist === undefined) return;
    const readings = entries.flatMap((entry): ProviderUsageLimitsEntry[] => {
      if (entry.status === "available") return [entry];
      if (entry.status !== "failed" || entry.staleLimits === undefined) return [];
      return [
        {
          providerInstanceId: entry.providerInstanceId,
          status: "available",
          source: entry.source,
          observedAt: entry.lastSuccessfulAt ?? entry.observedAt,
          limits: entry.staleLimits,
        },
      ];
    });
    const serialized = JSON.stringify(readings);
    if (serialized === this.#persisted) return;
    this.#persisted = serialized;
    try {
      persist(readings);
    } catch {
      // Reading the limits never fails because the file could not be saved.
    }
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

/**
 * The limits with every window, bucket, and retry hold whose time has passed
 * removed, or nothing when no figure is left to show.
 */
function withoutExpiredEvidence(
  limits: ProviderServiceLimits,
  now: UtcTimestamp,
): ProviderServiceLimits | undefined {
  const nowMs = Date.parse(now);
  const bucket = (value: ServiceLimitBucket): ServiceLimitBucket =>
    value.status === "available" &&
    value.resetsAt !== undefined &&
    Date.parse(value.resetsAt) <= nowMs
      ? { status: "unavailable" }
      : value;
  const windows = limits.rateLimitWindows?.filter(
    (window) => window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs,
  );
  const { rateLimitWindows: _stored, ...rest } = limits;
  const next: ProviderServiceLimits = {
    ...rest,
    requests: bucket(limits.requests),
    tokens: bucket(limits.tokens),
    concurrency: bucket(limits.concurrency),
    retry:
      limits.retry.status === "active" && Date.parse(limits.retry.until) <= nowMs
        ? { status: "inactive" }
        : limits.retry,
    ...(windows === undefined || windows.length === 0 ? {} : { rateLimitWindows: windows }),
  };
  const hasFigure =
    next.rateLimitWindows !== undefined ||
    next.requests.status === "available" ||
    next.tokens.status === "available" ||
    next.concurrency.status === "available" ||
    next.retry.status === "active";
  if (!hasFigure) return undefined;
  const unchanged =
    next.requests === limits.requests &&
    next.tokens === limits.tokens &&
    next.concurrency === limits.concurrency &&
    next.retry === limits.retry &&
    (next.rateLimitWindows?.length ?? 0) === (limits.rateLimitWindows?.length ?? 0);
  return unchanged ? limits : next;
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

import {
  decodeUtcTimestamp,
  nativeHarnessSlotCandidateKey,
  type NativeHarnessJob,
  type NativeHarnessRouteDecision,
  type NativeHarnessRouteFailureReason,
  type NativeHarnessSlotCandidate,
  type NativeHarnessSlotId,
  type ProjectId,
} from "@octant/contracts";
import { resolveNativeHarnessRoute } from "@octant/domain";
import type { NativeHarnessRoutingStore } from "./nativeHarnessRoutingStore";

const DEFAULT_COOLDOWN_MS = 60_000;
const CIRCUIT_FAILURES = 5;
const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_OPEN_MS = 60_000;

export interface NativeHarnessRouterOptions {
  readonly store: Pick<NativeHarnessRoutingStore, "host" | "projectOverride">;
  readonly isReady: (candidate: NativeHarnessSlotCandidate) => boolean;
  readonly now?: () => number;
}

interface Cooldown {
  readonly reason: NativeHarnessRouteFailureReason;
  readonly untilMs: number;
}

/**
 * Resolves each job's model call from the configured slots and remembers what
 * the failure chain learned: a candidate that just failed sits out for a
 * cooldown and the chain reverts to the primary when it expires, and a slot
 * that keeps failing trips a breaker so a tight retry loop cannot burn the
 * whole chain at full price.
 */
export class NativeHarnessRouter {
  readonly #options: NativeHarnessRouterOptions;
  readonly #cooldowns = new Map<string, Cooldown>();
  readonly #failures = new Map<string, number[]>();
  readonly #circuits = new Map<string, number>();

  constructor(options: NativeHarnessRouterOptions) {
    this.#options = options;
  }

  resolve(input: {
    readonly job: NativeHarnessJob;
    readonly projectId?: ProjectId | undefined;
  }): NativeHarnessRouteDecision {
    const nowMs = this.#now();
    const override =
      input.projectId === undefined
        ? undefined
        : this.#options.store.projectOverride(input.projectId);
    return resolveNativeHarnessRoute({
      job: input.job,
      host: this.#options.store.host().configuration,
      ...(override === undefined ? {} : { project: override.configuration }),
      facts: (candidate) => {
        const cooldown = this.#cooldowns.get(nativeHarnessSlotCandidateKey(candidate));
        const active = cooldown !== undefined && cooldown.untilMs > nowMs;
        return {
          ready: this.#options.isReady(candidate),
          ...(active
            ? {
                coolingDown: {
                  reason: cooldown.reason,
                  until: decodeUtcTimestamp(new Date(cooldown.untilMs).toISOString()),
                },
              }
            : {}),
        };
      },
      circuitOpen: (slotId) => (this.#circuits.get(String(slotId)) ?? 0) > nowMs,
      now: decodeUtcTimestamp(new Date(nowMs).toISOString()),
    });
  }

  /** A failure the chain should step around, with the reason the model sees. */
  reportFailure(input: {
    readonly slotId: NativeHarnessSlotId;
    readonly candidate: NativeHarnessSlotCandidate;
    readonly reason: NativeHarnessRouteFailureReason;
    readonly retryAfterMs?: number;
  }): void {
    const nowMs = this.#now();
    this.#cooldowns.set(nativeHarnessSlotCandidateKey(input.candidate), {
      reason: input.reason,
      untilMs: nowMs + Math.max(1_000, input.retryAfterMs ?? DEFAULT_COOLDOWN_MS),
    });
    const key = String(input.slotId);
    const recent = (this.#failures.get(key) ?? []).filter((at) => at > nowMs - CIRCUIT_WINDOW_MS);
    recent.push(nowMs);
    this.#failures.set(key, recent);
    if (recent.length >= CIRCUIT_FAILURES) {
      this.#circuits.set(key, nowMs + CIRCUIT_OPEN_MS);
      this.#failures.set(key, []);
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

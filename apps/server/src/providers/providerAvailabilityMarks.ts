import type { ProviderRuntimeEvent } from "@octant/contracts";
import { PROVIDER_DOWN_MS, providerAvailabilityFromFailure } from "@octant/domain";

/** At most this many sessions are remembered for "failed before any output". */
const MAX_TRACKED_SESSIONS = 512;

export interface ProviderAvailabilityMark {
  /** Down until this instant (epoch ms): its last request failed for availability. */
  readonly downUntil?: number;
  /** At its usage limit; `until` is the provider's reset when it named one. */
  readonly usageLimit?: { readonly until?: string };
}

/**
 * Which providers cannot take a new worker right now, from what their own
 * requests said (docs/design/coordinator-threads.md, Starting workers). Fed
 * at the shared runtime-event tap every driver's turns pass through, so a
 * failure on any thread counts. In memory only: after a restart every
 * provider is tried again, which the 5-minute mark would allow soon anyway.
 *
 * A usage limit with no reset named holds for the same 5 minutes as a down
 * mark, then the next start tries it again; a request that completes on the
 * provider clears both.
 */
export class ProviderAvailabilityMarks {
  readonly #now: () => number;
  readonly #marks = new Map<string, { downUntil?: number; limitUntil?: number; limit?: string }>();
  readonly #outputSeen = new Map<string, boolean>();
  readonly #failedBeforeOutput = new Map<string, number>();

  constructor(options: { readonly now: () => number }) {
    this.#now = options.now;
  }

  record(event: ProviderRuntimeEvent): void {
    const session = String(event.sessionId);
    switch (event.kind) {
      case "text-delta":
      case "reasoning-delta":
      case "tool-start":
      case "tool-request":
      case "tool-call-content":
      case "tool-progress":
      case "tool-success":
      case "tool-failure":
      case "file-change":
      case "diff":
      case "approval-request":
      case "user-input-request":
      case "outside-content-read":
      case "outside-content-result":
        this.#remember(this.#outputSeen, session, true);
        return;
      case "completed":
        this.#marks.delete(String(event.instanceId));
        this.#outputSeen.delete(session);
        return;
      case "failed": {
        const availability = providerAvailabilityFromFailure(event.failure);
        const beforeOutput = this.#outputSeen.get(session) !== true;
        this.#outputSeen.delete(session);
        if (availability === undefined) return;
        if (availability.kind === "down") this.markDown(String(event.instanceId));
        else this.markUsageLimit(String(event.instanceId), availability.until);
        if (beforeOutput) this.#remember(this.#failedBeforeOutput, session, this.#now());
        return;
      }
      default:
        return;
    }
  }

  markDown(providerInstanceId: string): void {
    const current = this.#marks.get(providerInstanceId) ?? {};
    this.#marks.set(providerInstanceId, { ...current, downUntil: this.#now() + PROVIDER_DOWN_MS });
  }

  markUsageLimit(providerInstanceId: string, until: string | undefined): void {
    const current = this.#marks.get(providerInstanceId) ?? {};
    const parsed = until === undefined ? Number.NaN : Date.parse(until);
    this.#marks.set(providerInstanceId, {
      ...current,
      limitUntil: Number.isFinite(parsed) ? parsed : this.#now() + PROVIDER_DOWN_MS,
      ...(until === undefined ? {} : { limit: until }),
    });
  }

  /** The provider's live mark, or `undefined` once every part of it has expired. */
  read(providerInstanceId: string): ProviderAvailabilityMark | undefined {
    const mark = this.#marks.get(providerInstanceId);
    if (mark === undefined) return undefined;
    const now = this.#now();
    const down = mark.downUntil !== undefined && mark.downUntil > now;
    const limited = mark.limitUntil !== undefined && mark.limitUntil > now;
    if (!down && !limited) {
      this.#marks.delete(providerInstanceId);
      return undefined;
    }
    return {
      ...(down && mark.downUntil !== undefined ? { downUntil: mark.downUntil } : {}),
      ...(limited ? { usageLimit: mark.limit === undefined ? {} : { until: mark.limit } } : {}),
    };
  }

  /** Whether this session's request failed for availability before any text or tool call. */
  failedBeforeOutput(sessionId: string): boolean {
    return this.#failedBeforeOutput.has(sessionId);
  }

  #remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_TRACKED_SESSIONS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

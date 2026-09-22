import type { WorkTurnRequestId } from "@octant/contracts";

/**
 * Process-local token accounting for in-flight Work turns.
 *
 * The provider reports usage as a runtime event; the durable turn record is a
 * transcript contract and does not carry tokens. This store keeps the last
 * reported figures per request id long enough for a caller that is waiting on
 * the turn — the goal loop — to read what the provider actually reported.
 * It is deliberately not a database: a restart loses it, and a loop that cannot
 * see spend falls back to time and turn budgets, which are the ceilings
 * ADR 0025 already requires.
 */
export class WorkTurnUsageStore {
  readonly #byRequest = new Map<
    string,
    { readonly inputTokens: number; readonly outputTokens: number }
  >();
  readonly #capacity: number;

  constructor(options: { readonly capacity?: number } = {}) {
    this.#capacity = options.capacity ?? 1_024;
  }

  record(
    requestId: WorkTurnRequestId,
    usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    },
  ): void {
    if (this.#byRequest.size >= this.#capacity) {
      const oldest = this.#byRequest.keys().next();
      if (!oldest.done) this.#byRequest.delete(oldest.value);
    }
    this.#byRequest.set(String(requestId), usage);
  }

  take(
    requestId: WorkTurnRequestId,
  ): { readonly inputTokens: number; readonly outputTokens: number } | undefined {
    const key = String(requestId);
    const usage = this.#byRequest.get(key);
    this.#byRequest.delete(key);
    return usage;
  }
}

import { uptime } from "node:os";

export interface ProcessAuthorityClockOptions {
  readonly wallClock?: () => number;
  readonly suspendAwareElapsedSource?: () => number;
}

/**
 * Process-local clock for short-lived local authority.
 *
 * The protected grants live only in this server process, so their epoch never
 * needs to survive a restart. Wall time establishes the process epoch once;
 * expiry then advances only from suspend-aware elapsed time. A restart drops
 * every grant and begins a fresh epoch from the Machine's current clock.
 */
export class ProcessAuthorityClock {
  readonly #epochMs: number;
  readonly #elapsedSource: () => number;
  readonly #elapsedEpochMs: number;

  constructor(options: ProcessAuthorityClockOptions = {}) {
    const wallClock = options.wallClock ?? Date.now;
    this.#elapsedSource = options.suspendAwareElapsedSource ?? (() => uptime() * 1_000);
    this.#epochMs = wallClock();
    this.#elapsedEpochMs = this.#elapsedSource();
  }

  nowMs(): number {
    const elapsedMs = this.#elapsedSource() - this.#elapsedEpochMs;
    return this.#epochMs + Math.floor(Math.max(0, elapsedMs));
  }

  /** Caller wall time is deliberately ignored after the process epoch exists. */
  clamp(_wallClockMs: number): number {
    return this.nowMs();
  }

  now(): () => number {
    return () => this.nowMs();
  }

  postureKind(): "ok" {
    return "ok";
  }
}

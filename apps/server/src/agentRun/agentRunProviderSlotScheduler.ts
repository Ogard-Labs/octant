import { decodeAgentRunStatusChanged, type CommittedAppend } from "@octant/contracts";
import type { AgentRunOrchestrationService } from "./agentRunOrchestrationService";

/**
 * How often a child waiting for a provider slot asks again when no turn has
 * ended. It covers a rate limit or an allowance that frees by the clock, and a
 * nudge the capacity scheduler never sent.
 */
export const AGENT_RUN_PROVIDER_SLOT_POLL_MS = 5_000;

/**
 * How long after a slot frees a person's turn has it to itself. A Chat turn is
 * refused at once when the provider is full and never waits, so a helper that
 * took every freed slot within the same instant would make the person's next
 * message fail again and again. A helper therefore asks only after this pause,
 * and only if nobody took the slot meanwhile.
 */
export const AGENT_RUN_PROVIDER_SLOT_GRACE_MS = 2_000;

/**
 * Wakes the children that wait for a provider slot.
 *
 * The orchestration service decides which child may start and which has waited
 * long enough; this only decides when to ask. One timer serves both reasons:
 * the periodic ask while any child waits, and the ask that follows a freed slot
 * after the grace. Neither runs on the stack of the work that freed the slot, so
 * a start that fails and releases its slot again cannot call itself in a loop:
 * each round is at least a poll apart. The timer stops when no child waits.
 */
export class AgentRunProviderSlotScheduler {
  readonly #orchestration: Pick<
    AgentRunOrchestrationService,
    "retryProviderSlotWaiters" | "hasProviderSlotWaiters"
  >;
  readonly #onCapacityFreed: (listener: () => void) => () => void;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #graceMs: number;
  readonly #onError: ((message: string, error: unknown) => void) | undefined;
  #unsubscribe: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerAt = 0;
  #freedAt = Number.NEGATIVE_INFINITY;
  #stopped = false;
  #retrying = false;

  constructor(options: {
    readonly orchestration: Pick<
      AgentRunOrchestrationService,
      "retryProviderSlotWaiters" | "hasProviderSlotWaiters"
    >;
    /** Subscribes to slots freeing; returns the unsubscribe. */
    readonly onCapacityFreed: (listener: () => void) => () => void;
    readonly now?: () => number;
    readonly pollMs?: number;
    readonly graceMs?: number;
    readonly onError?: (message: string, error: unknown) => void;
  }) {
    this.#orchestration = options.orchestration;
    this.#onCapacityFreed = options.onCapacityFreed;
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? AGENT_RUN_PROVIDER_SLOT_POLL_MS;
    this.#graceMs = options.graceMs ?? AGENT_RUN_PROVIDER_SLOT_GRACE_MS;
    this.#onError = options.onError;
  }

  start(): void {
    this.#unsubscribe ??= this.#onCapacityFreed(() => {
      // Runs inside the ending work's terminal signal: note the moment and
      // leave the asking to the timer. A slot this scheduler's own try gave
      // back is not a turn ending, and counting it would ask again at once.
      if (this.#retrying) return;
      this.#freedAt = this.#now();
      this.#arm(this.#freedAt + this.#graceMs);
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** The single entry point `journal.subscribeCommitted` feeds. */
  onCommittedAppend(append: CommittedAppend): void {
    for (const event of append.events) {
      if (event.eventName !== "agent.run-status-changed@1") continue;
      try {
        if (decodeAgentRunStatusChanged(event.payload).toStatus === "waiting") {
          // Deferred: the projection folds this append after the listener runs.
          queueMicrotask(() => {
            if (this.#orchestration.hasProviderSlotWaiters()) {
              this.#arm(this.#now() + this.#pollMs);
            }
          });
        }
      } catch (error) {
        this.#onError?.("Agent-run status event did not decode.", error);
      }
    }
  }

  /** One round of asking. */
  retryNow(): void {
    this.#retrying = true;
    try {
      this.#orchestration.retryProviderSlotWaiters(this.#now());
    } catch (error) {
      this.#onError?.("Children waiting for a request slot could not be retried.", error);
    } finally {
      this.#retrying = false;
    }
  }

  /** Fire at `at`, or sooner if a timer already waits for an earlier moment. */
  #arm(at: number): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) {
      if (this.#timerAt <= at) return;
      clearTimeout(this.#timer);
    }
    this.#timerAt = at;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        // A slot that freed after this timer was set is still the person's.
        const quietAt = this.#freedAt + this.#graceMs;
        if (this.#now() < quietAt) {
          this.#arm(quietAt);
          return;
        }
        if (!this.#orchestration.hasProviderSlotWaiters()) return;
        this.retryNow();
        if (this.#orchestration.hasProviderSlotWaiters()) this.#arm(this.#now() + this.#pollMs);
      },
      Math.max(0, at - this.#now()),
    );
    this.#timer.unref?.();
  }
}

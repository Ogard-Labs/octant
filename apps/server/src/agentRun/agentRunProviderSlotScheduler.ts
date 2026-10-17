import { decodeAgentRunStatusChanged, type CommittedAppend } from "@octant/contracts";
import { AGENT_RUN_PROVIDER_SLOT_WAITING_REASON } from "@octant/domain";
import type { AgentRunOrchestrationService } from "./agentRunOrchestrationService";

/**
 * How often a child waiting for a provider slot asks again when no turn has
 * ended. A turn that ends nudges at once; this covers a rate limit or an
 * allowance that frees by the clock, and a nudge the scheduler never sent.
 */
export const AGENT_RUN_PROVIDER_SLOT_POLL_MS = 5_000;

/**
 * Wakes the children that wait for a provider slot.
 *
 * The orchestration service decides which child may start and which has waited
 * long enough; this only notices when to ask. A turn, helper or compaction that
 * ends frees a slot, so each one asks at once. While any child waits, a timer
 * asks as well, and it stops when none does, so an idle host runs no timer.
 */
export class AgentRunProviderSlotScheduler {
  readonly #orchestration: Pick<
    AgentRunOrchestrationService,
    "retryProviderSlotWaiters" | "hasProviderSlotWaiters"
  >;
  readonly #onCapacityFreed: (listener: () => void) => () => void;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #onError: ((message: string, error: unknown) => void) | undefined;
  #unsubscribe: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #nudged = false;
  #stopped = false;

  constructor(options: {
    readonly orchestration: Pick<
      AgentRunOrchestrationService,
      "retryProviderSlotWaiters" | "hasProviderSlotWaiters"
    >;
    /** Subscribes to slots freeing; returns the unsubscribe. */
    readonly onCapacityFreed: (listener: () => void) => () => void;
    readonly now?: () => number;
    readonly pollMs?: number;
    readonly onError?: (message: string, error: unknown) => void;
  }) {
    this.#orchestration = options.orchestration;
    this.#onCapacityFreed = options.onCapacityFreed;
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? AGENT_RUN_PROVIDER_SLOT_POLL_MS;
    this.#onError = options.onError;
  }

  start(): void {
    this.#unsubscribe ??= this.#onCapacityFreed(() => this.#nudge());
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
        const change = decodeAgentRunStatusChanged(event.payload);
        if (
          change.toStatus === "waiting" &&
          change.recoveryReason === AGENT_RUN_PROVIDER_SLOT_WAITING_REASON
        ) {
          // Deferred: the projection folds this append after the listener runs.
          queueMicrotask(() => this.#arm());
        }
      } catch (error) {
        this.#onError?.("Agent-run status event did not decode.", error);
      }
    }
  }

  /** One round of asking, run on a nudge or by the timer. */
  retryNow(): void {
    try {
      this.#orchestration.retryProviderSlotWaiters(this.#now());
    } catch (error) {
      this.#onError?.("Children waiting for a request slot could not be retried.", error);
    }
  }

  #nudge(): void {
    if (this.#nudged || this.#stopped) return;
    this.#nudged = true;
    // The listener runs inside the ending work's terminal signal. Asking after
    // it returns lets that signal finish releasing before a child takes the slot.
    queueMicrotask(() => {
      this.#nudged = false;
      if (this.#stopped || !this.#orchestration.hasProviderSlotWaiters()) return;
      this.retryNow();
      this.#arm();
    });
  }

  #arm(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    if (!this.#orchestration.hasProviderSlotWaiters()) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.retryNow();
      this.#arm();
    }, this.#pollMs);
    this.#timer.unref?.();
  }
}

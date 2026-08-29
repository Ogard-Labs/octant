import type {
  CodeProjectPullRequestRow,
  CodeThreadFollowUp,
  CodeThreadFollowUpView,
  CodeThreadId,
} from "@octant/contracts";
import {
  deriveFailingChecksFollowUpTriggers,
  type LinkedPullRequestDefinitiveChecks,
} from "@octant/domain/code-follow-up-policy";
import type { CodeFollowUpTriggerObservation } from "./codeFollowUpService";

export interface FailingChecksFollowUpSink {
  read(threadId: CodeThreadId): CodeThreadFollowUpView;
  observeTrigger(input: CodeFollowUpTriggerObservation): Promise<CodeThreadFollowUp>;
}

/**
 * Turns refreshed pull-request snapshot rows into durable follow-up
 * obligations: when a linked pull request's checks are observed transitioning
 * to failing, the owning thread's existing follow-up marker opens. Strictly
 * read-only toward GitHub — it never mutates a pull request, never messages an
 * agent, and never initiates a refresh; it only consumes rows the snapshot
 * already produced. Completing the follow-up remains the only way to clear it.
 */
export class FailingChecksFollowUps {
  readonly #followUps: FailingChecksFollowUpSink;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  #lastDefinitiveChecks: ReadonlyMap<string, LinkedPullRequestDefinitiveChecks> = new Map();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly followUps: FailingChecksFollowUpSink;
    readonly uuid: () => string;
    readonly clock: () => string;
  }) {
    this.#followUps = options.followUps;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  /**
   * Observations are serialized: each one starts only after the previous one
   * has finished persisting its triggers and advancing the edge state.
   * Overlapping refreshes would otherwise both read the same previous state
   * and open duplicate triggers for a single failing edge. The returned
   * promise resolves when this observation (and everything queued before it)
   * has completed.
   */
  observe(rows: ReadonlyArray<CodeProjectPullRequestRow>): Promise<void> {
    const run = this.#tail.then(() => this.#observeNow(rows));
    // A failed observation must not wedge every later one.
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #observeNow(rows: ReadonlyArray<CodeProjectPullRequestRow>): Promise<void> {
    const previous = this.#lastDefinitiveChecks;
    const derived = deriveFailingChecksFollowUpTriggers({
      rows,
      lastDefinitiveChecks: previous,
    });
    const next = new Map(derived.lastDefinitiveChecks);
    for (const trigger of derived.triggers) {
      try {
        const view = this.#followUps.read(trigger.threadId);
        // Manual marks pick the next sequence after any prior trigger or
        // acknowledgement; automatic triggers use the same convention so both
        // share one sequence space and a completed marker reopens exactly once.
        const base = Math.max(
          view.followUp?.triggerSequence ?? 0,
          view.followUp?.acknowledgedThroughSequence ?? 0,
        );
        await this.#followUps.observeTrigger({
          threadId: trigger.threadId,
          sourceEventId: this.#uuid(),
          sourceSequence: base + 1,
          reason: trigger.reason,
          origin: trigger.origin,
          triggeredAt: this.#clock(),
        });
      } catch {
        // An archived thread or unavailable follow-up storage must never fail
        // the snapshot refresh. Restoring the pair's previous definitive state
        // re-arms the edge, so a trigger lost here fires again on the next
        // refresh instead of being silently dropped.
        const before = previous.get(trigger.observationKey);
        if (before === undefined) {
          next.delete(trigger.observationKey);
        } else {
          next.set(trigger.observationKey, before);
        }
      }
    }
    this.#lastDefinitiveChecks = next;
  }
}

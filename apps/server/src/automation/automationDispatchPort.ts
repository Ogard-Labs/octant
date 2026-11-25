import type { AutomationDefinition, AutomationRun, WindowId } from "@octant/contracts";

/** One durably claimed run handed to the thread dispatcher. */
export interface AutomationDispatchOffer {
  readonly definition: AutomationDefinition;
  readonly run: AutomationRun;
  /**
   * Present when a person explicitly confirmed or started this run from an
   * authenticated window or paired device, so the first turn runs as their
   * interactive turn rather than an unattended host run.
   */
  readonly confirmedByWindowId?: WindowId;
}

/**
 * Seam between the A3 scheduler and the A4 thread dispatcher. The scheduler
 * only claims occurrences durably and notifies this port; thread creation,
 * first-turn dispatch intents, and launch claims belong to the dispatcher
 * behind it. Implementations must be idempotent per (run id, lifecycle,
 * version): the scheduler re-offers queued and recovering-dispatch runs after
 * restart and after recovery transitions, re-offers post-intent dispatching
 * runs whose launch claim is absent or expired, and a throwing implementation
 * only loses the notification — the claim stays journaled and is re-offered on
 * the next pass or restart.
 */
export interface AutomationDispatchPort {
  readonly offer: (offer: AutomationDispatchOffer) => void;
}

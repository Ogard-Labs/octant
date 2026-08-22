/**
 * Objective satisfaction of a Work thread's confirmed delivery target. A
 * completed model turn is never enough on its own: Done requires user-confirmed
 * completion, evidence that names the current target, fresh supporting
 * evidence, and no outstanding child-run work. Ambiguous or stale evidence
 * collapses to waiting.
 */

export type WorkDeliverySatisfaction = "pending" | "waiting" | "done";

export interface WorkDeliveryChildRunEvidence {
  /** Non-terminal child runs (queued/starting/running/waiting). */
  readonly active: number;
  /** Terminal child runs whose required result the user has not acknowledged. */
  readonly unacknowledgedResults: number;
}

export interface WorkDeliveryCompletionEvidence {
  readonly deliveryTarget: string;
  readonly satisfactionEvidence: string;
}

export interface WorkDeliverySatisfactionInput {
  /** User-confirmed completion on the Work thread. */
  readonly completionConfirmed: boolean;
  /** Durable evidence recorded with that confirmation, when present. */
  readonly completionEvidence?: WorkDeliveryCompletionEvidence;
  /**
   * The authoritative current delivery target. For Work this is the thread
   * title: confirmation must name it exactly, so a later rename cannot keep a
   * stale Done.
   */
  readonly currentDeliveryTarget: string;
  readonly childAgents?: WorkDeliveryChildRunEvidence;
  /**
   * Freshness of supporting artifact, citation, or binding evidence. Stale
   * evidence can never independently satisfy a target.
   */
  readonly evidenceFreshness: "fresh" | "stale";
}

function childWorkOutstanding(childAgents: WorkDeliveryChildRunEvidence | undefined): boolean {
  if (childAgents === undefined) return false;
  return childAgents.active > 0 || childAgents.unacknowledgedResults > 0;
}

export function evaluateWorkDeliverySatisfaction(
  input: WorkDeliverySatisfactionInput,
): WorkDeliverySatisfaction {
  if (!input.completionConfirmed) return "pending";
  const evidence = input.completionEvidence;
  if (
    evidence === undefined ||
    evidence.deliveryTarget !== input.currentDeliveryTarget ||
    evidence.satisfactionEvidence.trim() === ""
  ) {
    return "waiting";
  }
  if (input.evidenceFreshness === "stale") return "waiting";
  if (childWorkOutstanding(input.childAgents)) return "waiting";
  return "done";
}

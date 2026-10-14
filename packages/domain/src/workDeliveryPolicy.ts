/**
 * When a Work thread's delivery is satisfied. A Work thread is Done when a
 * person marks it Done, and that mark is final: no evidence text is required,
 * and stale supporting evidence, a later rename, or an outstanding child run
 * does not pull it back to Waiting. Requiring fresh, matching evidence as well
 * filled boards with Waiting cards for work the person had already finished. A
 * completed model turn is never enough, and no agent can make the mark.
 * Reactivating an archived thread clears it.
 *
 * Code keeps an objective delivery target (`deliveryTargetPolicy`), with no
 * person's mark that overrides it.
 */

export type WorkDeliverySatisfaction = "pending" | "done";

export interface WorkDeliverySatisfactionInput {
  /** A person marked the Work thread Done. */
  readonly completionConfirmed: boolean;
}

export function evaluateWorkDeliverySatisfaction(
  input: WorkDeliverySatisfactionInput,
): WorkDeliverySatisfaction {
  return input.completionConfirmed ? "done" : "pending";
}

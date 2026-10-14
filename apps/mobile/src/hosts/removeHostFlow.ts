/**
 * Remove asks once before it deletes anything, because it never reaches the
 * host: the host keeps listing this phone until it is revoked from the desktop.
 */
export type RemoveHostFlowState = "idle" | "confirming";

export type RemoveHostFlowEvent = "ask" | "cancel" | "confirm";

export interface RemoveHostFlowStep {
  readonly state: RemoveHostFlowState;
  /** True only on the step where the person confirmed. */
  readonly remove: boolean;
}

export function stepRemoveHostFlow(
  state: RemoveHostFlowState,
  event: RemoveHostFlowEvent,
): RemoveHostFlowStep {
  if (event === "ask") return { state: "confirming", remove: false };
  if (event === "confirm" && state === "confirming") return { state: "idle", remove: true };
  return { state: "idle", remove: false };
}

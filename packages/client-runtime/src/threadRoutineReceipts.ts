import type { ThreadRoutineReceipt } from "@octant/contracts";

/**
 * The routines a turn's tool steps created, in arrival order, for the receipt
 * cards a client draws under the turn. A Work turn's steps and a Code turn's
 * both carry the receipt on the call that created the routine.
 */
export function threadRoutineReceipts(
  steps: ReadonlyArray<{ readonly routine?: ThreadRoutineReceipt | undefined }> | undefined,
): ReadonlyArray<ThreadRoutineReceipt> {
  return (steps ?? []).flatMap((step) => (step.routine === undefined ? [] : [step.routine]));
}

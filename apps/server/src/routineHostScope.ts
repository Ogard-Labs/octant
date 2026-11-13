import { randomUUID } from "node:crypto";
import { decodeWindowId, type WindowId } from "@octant/contracts";

/**
 * The service scope a routine's runs act under. A routine is host-owned, so
 * the host creates its thread and starts its first turn as itself. Dispatch
 * used to borrow whichever local window happened to be registered: a run
 * failed when none was open, and otherwise took that window's identity and,
 * for Code, its Project binding. The usage-limit resume timer is host-owned
 * the same way and continues a stopped Work or Code turn under this scope. A
 * goal loop runs each of its Work rounds under it, and a finished child run's
 * result is delivered into its parent thread under it. At start, the host
 * looks under it at the remote of each Code thread whose push or pull request
 * step a restart left unknown, and settles the steps the remote proves.
 *
 * Minted per process and never registered with window authority, so no route
 * resolves to it and no renderer or paired device can claim it. Reaching this
 * scope grants nothing a routine's dispatcher has not already revalidated
 * against the routine's captured Project and authority. A benchmark run's Code
 * cells act under it too, so a run revalidates at start instead: the starting
 * window must be able to reach every Code Project its suite names, and a run
 * that asks for more than a Project allows is refused whole.
 */
export const ROUTINE_HOST_SCOPE_ID: WindowId = decodeWindowId(randomUUID());

export function isRoutineHostScope(scopeId: WindowId): boolean {
  return String(scopeId) === String(ROUTINE_HOST_SCOPE_ID);
}

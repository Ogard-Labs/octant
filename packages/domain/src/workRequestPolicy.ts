import type { WorkRequestResolution, WorkRequestStatus } from "@octant/contracts/work-requests";

/**
 * Decide whether a Work request may transition at all. Only a `pending`
 * request may settle; every terminal status (`resolved`, `cancelled`,
 * `interrupted`, `expired`) is final and denies any further transition. This
 * is the pure authority the server checks before attempting to settle a
 * resolution, cancellation, interruption, or expiry so a stale or replayed
 * command can never re-open a settled request.
 */
export function classifyWorkRequestTransition(input: {
  readonly currentStatus: WorkRequestStatus;
}): "allow" | "deny" {
  return input.currentStatus === "pending" ? "allow" : "deny";
}

/**
 * Decide whether the provider session recorded on a Work request still
 * matches the thread's current provider. A request only stays answerable
 * while its originating provider session remains the thread's active one;
 * if the thread's provider changed (or is unknown), the request must be
 * treated as unauthorized rather than answered against a stale session.
 */
export function classifyWorkRequestProviderAuthority(input: {
  readonly requestProviderInstanceId: string;
  readonly threadProviderInstanceId: string | undefined;
}): "allow" | "deny" {
  return input.threadProviderInstanceId !== undefined &&
    input.requestProviderInstanceId === input.threadProviderInstanceId
    ? "allow"
    : "deny";
}

export type WorkRequestSettledAttempt =
  | { readonly kind: "resolved"; readonly resolution: WorkRequestResolution }
  | { readonly kind: "cancelled" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "expired" };

export type WorkRequestSettledCurrent =
  | { readonly status: "pending" }
  | { readonly status: "resolved"; readonly resolution: WorkRequestResolution }
  | { readonly status: "cancelled" }
  | { readonly status: "interrupted" }
  | { readonly status: "expired" };

/**
 * Decide whether an already-settled Work request's current state matches
 * an attempted settle transition exactly, so a duplicate resolution,
 * cancellation, interruption, or expiry attempt (from a retry, reconnect, or
 * restart) can be treated as an idempotent success rather than an error.
 * Returns `false` both when the request is still `pending` (nothing to
 * settle idempotently yet — the caller should attempt the real transition)
 * and when the current terminal state genuinely conflicts with the attempt
 * (a different terminal status, or the same `resolved` status with a
 * different resolution payload).
 */
export function workRequestSettledIdempotently(input: {
  readonly current: WorkRequestSettledCurrent;
  readonly attempted: WorkRequestSettledAttempt;
}): boolean {
  const { current, attempted } = input;
  if (current.status === "pending") return false;
  if (current.status !== attempted.kind) return false;
  if (current.status === "resolved" && attempted.kind === "resolved") {
    return sameResolution(current.resolution, attempted.resolution);
  }
  return true;
}

function sameResolution(left: WorkRequestResolution, right: WorkRequestResolution): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "approval" && right.kind === "approval") {
    return left.approved === right.approved;
  }
  if (left.kind === "user-input" && right.kind === "user-input") {
    return left.answer === right.answer;
  }
  return false;
}

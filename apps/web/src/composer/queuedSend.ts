/**
 * One client-side follow-up parked while a provider turn is running.
 *
 * The host admits one turn per thread. This is only an intent: it never
 * bypasses send-path authority, and it is forgotten on restart because it is
 * not journaled. Depth is one; a second enqueue replaces nothing and adds
 * nothing — the composer itself is the queued message.
 */
export type QueuedSendState =
  | { readonly status: "idle" }
  | { readonly status: "queued"; readonly threadKey: string }
  | { readonly status: "held"; readonly threadKey: string; readonly reason: string };

export type TurnSettlement =
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "refused"
  | "waiting";

export const EMPTY_QUEUED_SEND: QueuedSendState = { status: "idle" };

export function enqueueQueuedSend(
  current: QueuedSendState,
  threadKey: string,
  settlement: TurnSettlement | "idle",
): QueuedSendState {
  if (settlement !== "running" || threadKey.trim() === "") return current;
  if (current.status === "queued" && current.threadKey === threadKey) return current;
  return { status: "queued", threadKey };
}

export function discardQueuedSend(): QueuedSendState {
  return EMPTY_QUEUED_SEND;
}

/**
 * Leaving a thread, or unmounting its composer, drops the auto-send intent.
 * The draft stays in the composer the caller already owns; this only refuses
 * to fire behind the user's back.
 */
export function disarmQueuedSend(
  current: QueuedSendState,
  threadKey: string | undefined,
): QueuedSendState {
  if (current.status === "idle") return current;
  if (threadKey !== undefined && current.threadKey === threadKey) return current;
  return EMPTY_QUEUED_SEND;
}

export function settleQueuedSend(
  current: QueuedSendState,
  threadKey: string | undefined,
  settlement: TurnSettlement | "idle",
): { readonly next: QueuedSendState; readonly fire: boolean } {
  if (current.status === "idle") return { next: current, fire: false };
  if (threadKey === undefined || current.threadKey !== threadKey) {
    return { next: EMPTY_QUEUED_SEND, fire: false };
  }
  if (settlement === "running" || settlement === "idle") {
    return { next: current, fire: false };
  }
  if (settlement === "completed") {
    return current.status === "queued"
      ? { next: EMPTY_QUEUED_SEND, fire: true }
      : { next: current, fire: false };
  }
  if (current.status === "held") return { next: current, fire: false };
  if (
    settlement === "cancelled" ||
    settlement === "failed" ||
    settlement === "refused" ||
    settlement === "waiting"
  ) {
    return {
      next: {
        status: "held",
        threadKey: current.threadKey,
        reason: queuedHoldReason(settlement),
      },
      fire: false,
    };
  }
  return { next: current, fire: false };
}

export function queuedHoldReason(
  settlement: "cancelled" | "failed" | "refused" | "waiting",
): string {
  switch (settlement) {
    case "cancelled":
      return "The response was cancelled. The queued message was not sent.";
    case "failed":
      return "The response failed. The queued message was not sent.";
    case "refused":
      return "The response was refused. The queued message was not sent.";
    case "waiting":
      return "The response is waiting. The queued message was not sent.";
  }
}

export function queuedSendStatusMessage(state: QueuedSendState): string | undefined {
  if (state.status === "queued") {
    return "This message is queued and will send when the response finishes.";
  }
  if (state.status === "held") return state.reason;
  return undefined;
}

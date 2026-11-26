import type { ThreadMessageQueueItem } from "@octant/contracts";

export interface QueuedMessageRow {
  readonly messageId: string;
  readonly text: string;
  /**
   * Still waiting and this phone may change the queue, so it can be edited or
   * removed; one on its way, or any on a phone that may only read, cannot.
   */
  readonly changeable: boolean;
}

/** A thread's queued messages as the phone lists them above its composer. */
export function queuedMessageRows(
  items: ReadonlyArray<ThreadMessageQueueItem>,
  allowChanges: boolean,
): ReadonlyArray<QueuedMessageRow> {
  return items.map((item) => ({
    messageId: String(item.messageId),
    text: item.payload?.prompt ?? "The host no longer holds this message's words.",
    changeable:
      allowChanges &&
      item.status === "queued" &&
      item.steering !== true &&
      item.payload !== undefined,
  }));
}

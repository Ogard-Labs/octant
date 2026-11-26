import type { ThreadMessageQueueItem } from "@octant/contracts";

export interface QueuedMessageRow {
  readonly messageId: string;
  readonly text: string;
  /** Still waiting, so it can be edited or removed; one on its way cannot. */
  readonly changeable: boolean;
}

/** A thread's queued messages as the phone lists them above its composer. */
export function queuedMessageRows(
  items: ReadonlyArray<ThreadMessageQueueItem>,
): ReadonlyArray<QueuedMessageRow> {
  return items.map((item) => ({
    messageId: String(item.messageId),
    text: item.payload?.prompt ?? "The host no longer holds this message's words.",
    changeable: item.status === "queued" && item.steering !== true && item.payload !== undefined,
  }));
}

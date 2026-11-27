import type { ThreadMessageQueueItem } from "@octant/contracts";

export type QueuedMessageRowAction = "edit" | "send-now" | "remove";

export interface QueuedMessageRow {
  readonly messageId: string;
  readonly text: string;
  /**
   * Still waiting and this phone may change the queue, so it can be edited or
   * removed; one on its way, or any on a phone that may only read, cannot.
   */
  readonly changeable: boolean;
  /** Controls shown on this row; empty on a read-only phone or non-editable row. */
  readonly actions: ReadonlyArray<QueuedMessageRowAction>;
}

const CHANGEABLE_ACTIONS: ReadonlyArray<QueuedMessageRowAction> = ["edit", "send-now", "remove"];

/** A thread's queued messages as the phone lists them above its composer. */
export function queuedMessageRows(
  items: ReadonlyArray<ThreadMessageQueueItem>,
  allowChanges: boolean,
): ReadonlyArray<QueuedMessageRow> {
  return items.map((item) => {
    const changeable =
      allowChanges &&
      item.status === "queued" &&
      item.steering !== true &&
      item.payload !== undefined;
    return {
      messageId: String(item.messageId),
      text: item.payload?.prompt ?? "The host no longer holds this message's words.",
      changeable,
      actions: changeable ? CHANGEABLE_ACTIONS : [],
    };
  });
}

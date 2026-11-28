import type { MobileModelOption } from "@octant/client-runtime";

export interface PendingAttachment {
  readonly id: string;
  readonly displayName: string;
}

export type PendingAttachmentEvent =
  | { readonly type: "uploaded"; readonly attachment: PendingAttachment }
  | { readonly type: "staged"; readonly attachments: ReadonlyArray<PendingAttachment> }
  | { readonly type: "sent" }
  | { readonly type: "thread-changed" };

/**
 * Attachments leave the composer only when a send succeeds or the thread
 * changes. A thread reload or a model-list reload is deliberately not an
 * event: loading the model list used to clear a just-picked attachment.
 */
export function pendingAttachmentsReducer(
  current: ReadonlyArray<PendingAttachment>,
  event: PendingAttachmentEvent,
): ReadonlyArray<PendingAttachment> {
  if (event.type === "uploaded") return [...current, event.attachment];
  if (event.type === "staged") {
    if (event.attachments.length === 0) return current;
    const seen = new Set(current.map((item) => item.id));
    const added = event.attachments.filter((item) => !seen.has(item.id));
    return added.length === 0 ? current : [...current, ...added];
  }
  return current.length === 0 ? current : [];
}

export function modelOptionForThread(
  options: ReadonlyArray<MobileModelOption>,
  thread: { readonly providerInstanceId: unknown; readonly modelId: unknown },
): MobileModelOption | undefined {
  return options.find(
    (option) =>
      option.providerInstanceId === String(thread.providerInstanceId) &&
      option.modelId === String(thread.modelId),
  );
}

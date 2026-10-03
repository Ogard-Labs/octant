import { ChevronDown } from "lucide-react";
import type { ThreadMessageQueueHoldReason, ThreadMessageQueueSnapshot } from "@octant/contracts";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import type { ThreadMessageQueue as QueueState } from "./useThreadMessageQueue";
import "./thread-message-queue.css";

const holdMessage: Readonly<Record<ThreadMessageQueueHoldReason, string>> = {
  paused: "The queue is paused.",
  "host-restart": "The host restarted. Review the queue before resuming.",
  "delivery-unknown":
    "The host is checking whether the message started. It will not send another copy.",
  "binding-changed": "Thread settings changed. Restore them or remove and queue the message again.",
  "authority-revoked": "This window no longer has permission to continue the queue.",
  cancelled: "The last turn was stopped. Review the queue before resuming.",
  failed: "The last turn failed. Review the queue before resuming.",
  "thread-unavailable": "This thread is unavailable.",
  "content-unavailable":
    "Queued content is unavailable. Remove the affected message and write it again.",
  "admission-refused": "The host refused to start the message. Review the thread before resuming.",
};

export function ThreadMessageQueue({
  queue,
  showUnavailable = false,
}: {
  readonly queue: QueueState;
  readonly showUnavailable?: boolean;
}) {
  const [editing, setEditing] = useState<{
    readonly id: string;
    readonly prompt: string;
    readonly version: ThreadMessageQueueSnapshot["version"];
  }>();
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const snapshot = queue.snapshot;
  if (
    queue.available &&
    !queue.busy &&
    queue.message === undefined &&
    snapshot?.items.length === 0 &&
    !snapshot.paused &&
    snapshot.holdReason === undefined &&
    !queue.uncertain
  )
    return null;
  if (!showUnavailable && snapshot === undefined) return null;
  const disabled = !queue.available || queue.busy || queue.uncertain;
  const queued = snapshot?.items.filter((item) => item.status === "queued") ?? [];
  return (
    <section aria-label="Message queue" className="thread-message-queue">
      <div className="thread-message-queue__heading">
        <OctantButton
          type="button"
          variant="ghost"
          size="sm"
          className="thread-message-queue__toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown aria-hidden="true" size={12} />
          {snapshot === undefined
            ? "Message queue"
            : `${queued.length} queued${snapshot.items.length > queued.length ? ` · ${snapshot.items.length - queued.length} active` : ""}`}
          {snapshot?.paused === true ? " · Paused" : ""}
        </OctantButton>
        {snapshot !== undefined && (
          <OctantButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() =>
              void queue.change({
                kind: snapshot.paused || snapshot.holdReason !== undefined ? "resume" : "pause",
              })
            }
          >
            {snapshot.paused || snapshot.holdReason !== undefined ? "Resume queue" : "Pause queue"}
          </OctantButton>
        )}
      </div>
      {snapshot?.holdReason !== undefined && (
        <p role="status">Queue held. {holdMessage[snapshot.holdReason]}</p>
      )}
      {queue.message !== undefined && <p role="status">{queue.message}</p>}
      {(queue.uncertain || !queue.available) && (
        <OctantButton
          type="button"
          size="sm"
          variant="outline"
          disabled={queue.busy}
          onClick={() => void queue.retry()}
        >
          Check queue
        </OctantButton>
      )}
      <ol id={detailsId} hidden={!expanded}>
        {snapshot?.items.map((item, index) => {
          const position = queued.findIndex((candidate) => candidate.messageId === item.messageId);
          const editable = item.status === "queued" && item.payload !== undefined;
          const edit = editing?.id === item.messageId ? editing : undefined;
          const move = (offset: number) => {
            const ids = queued.map((entry) => entry.messageId);
            const other = ids[position + offset];
            if (other === undefined) return;
            ids[position + offset] = item.messageId;
            ids[position] = other;
            let queuedIndex = 0;
            const ordered = snapshot.items.map((entry) =>
              entry.status === "queued" ? (ids[queuedIndex++] ?? entry.messageId) : entry.messageId,
            );
            void queue.change({ kind: "reorder", messageIds: ordered });
          };
          return (
            <li key={item.messageId} aria-label={`Queued message ${index + 1}`}>
              {edit !== undefined ? (
                <div>
                  {edit.version !== snapshot.version && (
                    <p role="status">
                      The queue changed while you were editing. Cancel and reopen this edit to
                      review the current message.
                    </p>
                  )}
                  <OctantTextarea
                    aria-label={`Edit queued message ${index + 1}`}
                    value={edit.prompt}
                    maxLength={200000}
                    onChange={(event) => setEditing({ ...edit, prompt: event.currentTarget.value })}
                  />
                  <OctantButton
                    type="button"
                    size="sm"
                    disabled={disabled || edit.version !== snapshot.version}
                    onClick={async () => {
                      if (
                        (await queue.change({
                          kind: "edit",
                          messageId: item.messageId,
                          prompt: edit.prompt,
                          expectedVersion: edit.version,
                        })) === "accepted"
                      )
                        setEditing(undefined);
                    }}
                  >
                    Save message
                  </OctantButton>
                  <OctantButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(undefined)}
                  >
                    Cancel edit
                  </OctantButton>
                </div>
              ) : (
                <p className="thread-message-queue__prompt">
                  {item.payload?.prompt ?? "Message content is unavailable."}
                </p>
              )}
              {(item.payload?.attachmentIds?.length ?? 0) > 0 && (
                <span>
                  {item.payload?.attachmentIds?.length}{" "}
                  {item.payload?.attachmentIds?.length === 1 ? "attachment" : "attachments"}
                </span>
              )}
              {item.status !== "queued" && (
                <span role="status">
                  {item.status === "dispatching" ? "Starting" : "Accepted by host"}
                </span>
              )}
              <div className="thread-message-queue__actions">
                <OctantButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit queued message ${index + 1}`}
                  disabled={disabled || !editable}
                  onClick={() =>
                    setEditing({
                      id: item.messageId,
                      prompt: item.payload?.prompt ?? "",
                      version: snapshot.version,
                    })
                  }
                >
                  Edit
                </OctantButton>
                <OctantButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Move queued message ${index + 1} up`}
                  disabled={disabled || !editable || position <= 0}
                  onClick={() => move(-1)}
                >
                  Move up
                </OctantButton>
                <OctantButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Move queued message ${index + 1} down`}
                  disabled={disabled || !editable || position >= queued.length - 1}
                  onClick={() => move(1)}
                >
                  Move down
                </OctantButton>
                <OctantButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove queued message ${index + 1}`}
                  disabled={disabled || item.status !== "queued"}
                  onClick={() => void queue.change({ kind: "remove", messageId: item.messageId })}
                >
                  Remove
                </OctantButton>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

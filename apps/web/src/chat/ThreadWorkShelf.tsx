import type {
  ThreadFollowUpCommand,
  ThreadFollowUp,
  ThreadWorkCommand,
  ThreadWorkItem,
  ThreadWorkItemStatus,
} from "@octant/contracts/chat";
import type { AggregateVersion } from "@octant/contracts/events";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

type EditWorkItemCommand = Extract<ThreadWorkCommand, { kind: "edit-chat-work-item" }>;
type CompleteWorkItemCommand = Extract<ThreadWorkCommand, { kind: "complete-chat-work-item" }>;
type CancelWorkItemCommand = Extract<ThreadWorkCommand, { kind: "cancel-chat-work-item" }>;
type CompleteFollowUpCommand = Extract<ThreadFollowUpCommand, { kind: "complete-chat-follow-up" }>;

export interface ThreadWorkShelfProps {
  /** Authoritative, decoded work-list aggregate version supplied by the caller. */
  readonly aggregateVersion: AggregateVersion;
  /** Authoritative, decoded follow-up aggregate version supplied by the caller. */
  readonly followUpVersion: AggregateVersion;
  /** Authoritative, decoded follow-up state. Rendering it never acknowledges it. */
  readonly followUp?: ThreadFollowUp | undefined;
  /** Authoritative, decoded work items for the active thread. */
  readonly items: ReadonlyArray<ThreadWorkItem>;
  /** Collapses the shelf to its counts until the user explicitly expands it. */
  readonly narrow?: boolean | undefined;
  readonly onCancel?: ((command: CancelWorkItemCommand) => void) | undefined;
  readonly onComplete?: ((command: CompleteWorkItemCommand) => void) | undefined;
  readonly onCompleteFollowUp?: ((command: CompleteFollowUpCommand) => void) | undefined;
  readonly onEdit?: ((command: EditWorkItemCommand) => void) | undefined;
}

export function ThreadWorkShelf(props: ThreadWorkShelfProps) {
  const currentItemsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [editingItemId, setEditingItemId] = useState<ThreadWorkItem["id"] | undefined>();
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDetail, setDraftDetail] = useState("");
  const currentItems = ordered(props.items.filter((item) => !isHistoryItem(item)));
  const historyItems = ordered(props.items.filter(isHistoryItem));
  const blockedCount = currentItems.filter((item) => item.status === "blocked").length;
  const toggleLabel = `Work list: ${currentItems.length} remaining, ${blockedCount} blocked`;

  function beginEditing(item: ThreadWorkItem): void {
    setEditingItemId(item.id);
    setDraftTitle(item.title);
    setDraftDetail(item.detail ?? "");
  }

  function saveEdit(item: ThreadWorkItem): void {
    const title = draftTitle.trim();
    if (title.length === 0 || props.onEdit === undefined) return;
    props.onEdit({
      kind: "edit-chat-work-item",
      threadId: item.threadId,
      expectedVersion: props.aggregateVersion,
      itemId: item.id,
      title,
      ...(draftDetail.trim().length === 0 ? {} : { detail: draftDetail.trim() }),
    });
    setEditingItemId(undefined);
  }

  return (
    <section
      aria-label="Thread work"
      className="thread-work-shelf"
      data-narrow={props.narrow || undefined}
    >
      <div className="thread-work-shelf__summary">
        <OctantButton
          aria-controls={currentItemsId}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          className="thread-work-shelf__toggle"
          onClick={() => setExpanded((current) => !current)}
          type="button"
          variant="ghost"
        >
          <span aria-hidden="true">{expanded ? "−" : "+"}</span>
          <span className="thread-work-shelf__wide-label">
            Work list · {currentItems.length} remaining · {blockedCount} blocked
          </span>
          <span className="thread-work-shelf__narrow-label">
            {currentItems.length} remaining · {blockedCount} blocked
          </span>
        </OctantButton>
        {props.followUp?.state === "open" ? (
          <div
            aria-label="Follow-up required"
            className="thread-work-shelf__follow-up"
            role="status"
            title={props.followUp.reason}
          >
            <span aria-hidden="true">◆</span> Follow-up required: {props.followUp.reason}
            {props.onCompleteFollowUp === undefined ? null : (
              <OctantButton
                onClick={() =>
                  props.onCompleteFollowUp?.({
                    kind: "complete-chat-follow-up",
                    threadId: props.followUp!.threadId,
                    expectedVersion: props.followUpVersion,
                    acknowledgedThroughSequence: props.followUp!.triggerSequence,
                  })
                }
                type="button"
                variant="ghost"
              >
                Complete follow-up
              </OctantButton>
            )}
          </div>
        ) : null}
      </div>

      {expanded ? (
        <div className="thread-work-shelf__content" id={currentItemsId}>
          <ol aria-label="Current work" className="thread-work-shelf__current-items">
            {currentItems.map((item) => (
              <li data-status={item.status} key={item.id}>
                <div className="thread-work-shelf__item-copy">
                  <span aria-label={`Status: ${workStatusLabel(item.status)}`}>
                    {workStatusLabel(item.status)}
                  </span>
                  <strong>{item.title}</strong>
                  {item.detail === undefined ? null : <p>{item.detail}</p>}
                </div>
                {editingItemId === item.id ? (
                  <form
                    aria-label={`Edit ${item.title}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveEdit(item);
                    }}
                  >
                    <label>
                      Title for {item.title}
                      <OctantInput
                        onChange={(event) => setDraftTitle(event.target.value)}
                        value={draftTitle}
                      />
                    </label>
                    <label>
                      Details for {item.title}
                      <OctantInput
                        onChange={(event) => setDraftDetail(event.target.value)}
                        value={draftDetail}
                      />
                    </label>
                    <OctantButton type="submit" variant="secondary">
                      Save {item.title}
                    </OctantButton>
                    <OctantButton
                      onClick={() => setEditingItemId(undefined)}
                      type="button"
                      variant="ghost"
                    >
                      Cancel editing {item.title}
                    </OctantButton>
                  </form>
                ) : (
                  <div className="thread-work-shelf__item-actions">
                    {props.onEdit === undefined ? null : (
                      <OctantButton
                        onClick={() => beginEditing(item)}
                        type="button"
                        variant="ghost"
                      >
                        Edit {item.title}
                      </OctantButton>
                    )}
                    {props.onComplete === undefined ? null : (
                      <OctantButton
                        onClick={() =>
                          props.onComplete?.({
                            kind: "complete-chat-work-item",
                            threadId: item.threadId,
                            expectedVersion: props.aggregateVersion,
                            itemId: item.id,
                          })
                        }
                        type="button"
                        variant="ghost"
                      >
                        Complete {item.title}
                      </OctantButton>
                    )}
                    {props.onCancel === undefined ? null : (
                      <OctantButton
                        onClick={() =>
                          props.onCancel?.({
                            kind: "cancel-chat-work-item",
                            threadId: item.threadId,
                            expectedVersion: props.aggregateVersion,
                            itemId: item.id,
                          })
                        }
                        type="button"
                        variant="ghost"
                      >
                        Cancel {item.title}
                      </OctantButton>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>

          {historyItems.length === 0 ? null : (
            <section aria-label="Completed work" className="thread-work-shelf__history">
              <OctantButton
                aria-expanded={historyExpanded}
                onClick={() => setHistoryExpanded((current) => !current)}
                type="button"
                variant="ghost"
              >
                Completed history, {historyItems.length}{" "}
                {historyItems.length === 1 ? "item" : "items"}
              </OctantButton>
              {historyExpanded ? (
                <ol aria-label="Completed work history">
                  {historyItems.map((item) => (
                    <li key={item.id}>
                      <span aria-label={`Status: ${workStatusLabel(item.status)}`}>
                        {workStatusLabel(item.status)}
                      </span>{" "}
                      {item.title}
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>
          )}
        </div>
      ) : null}
    </section>
  );
}

function isHistoryItem(item: ThreadWorkItem): boolean {
  return item.status === "completed" || item.status === "cancelled";
}

function ordered(items: ReadonlyArray<ThreadWorkItem>): ReadonlyArray<ThreadWorkItem> {
  return items.toSorted(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

function workStatusLabel(status: ThreadWorkItemStatus): string {
  switch (status) {
    case "in-progress":
      return "In progress";
    case "pending":
      return "Pending";
    case "blocked":
      return "Blocked";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

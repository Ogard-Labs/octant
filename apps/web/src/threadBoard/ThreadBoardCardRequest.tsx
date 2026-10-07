import { PendingRequestRow } from "../pendingRequests/PendingRequestRow";
import { pendingRequestKey } from "../pendingRequests/pendingRequests";
import { OctantButton } from "../ui/base/OctantButton";
import type { BoardCardRequest } from "./useBoardPendingRequests";

/**
 * The question or approval a waiting thread is parked on, answered where its
 * card is. It is the Needs you row without the thread's name, which the card
 * already carries. A thread with more than one request shows the oldest and
 * points at the thread for the rest.
 */
export function ThreadBoardCardRequest(props: {
  readonly request: BoardCardRequest;
  /** Opens the thread, where a typed answer goes in its composer. */
  readonly onOpenThread: () => void;
}) {
  const { entry, moreWaiting } = props.request;
  return (
    <div className="board-card-request">
      <PendingRequestRow
        embedded
        key={pendingRequestKey(entry.request)}
        now={props.request.now}
        onAnswer={props.request.onAnswer}
        onOpenThread={props.onOpenThread}
        request={entry.request}
        settled={entry.unlisted}
      />
      {moreWaiting === 0 ? null : (
        <OctantButton
          className="board-card-request__more window-no-drag"
          onClick={props.onOpenThread}
          size="sm"
          type="button"
          variant="link"
        >
          {`+${String(moreWaiting)} more waiting`}
        </OctantButton>
      )}
    </div>
  );
}

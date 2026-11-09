import type { MovedThreadReference } from "@octant/contracts";
import type { ReactNode } from "react";
import { FrozenBarScope } from "../../composer/frozenBarScope";
import { holdsThread, ThreadMoveFrozenBar } from "./ThreadMoveFrozenBar";
import { ThreadMoveTombstone } from "./ThreadMoveTombstone";
import type { ThreadMoveClient } from "./threadMoveClient";
import { useThreadMove } from "./useThreadMove";

/**
 * One thread pane, as a move leaves it. A thread that moved away shows its
 * tombstone in place of the pane; a thread a move holds keeps its transcript
 * readable and gives its composer's place to the frozen bar. Without the move
 * routes (another host's thread, or a remote client) the pane is unchanged.
 */
export function ThreadMoveHold(props: {
  readonly thread: MovedThreadReference;
  readonly client: ThreadMoveClient | undefined;
  /** This computer's name, for the tombstone's route line. */
  readonly hostName: string;
  readonly children: ReactNode;
}) {
  if (props.client === undefined) return <>{props.children}</>;
  return <ReadThreadMoveHold {...props} client={props.client} />;
}

function ReadThreadMoveHold(props: {
  readonly thread: MovedThreadReference;
  readonly client: ThreadMoveClient;
  readonly hostName: string;
  readonly children: ReactNode;
}) {
  const move = useThreadMove(props.client, props.thread);
  const status = move.status;
  if (status?.departed !== undefined) {
    return (
      <ThreadMoveTombstone
        client={props.client}
        departed={status.departed}
        hostName={props.hostName}
        onChanged={move.refresh}
      />
    );
  }
  const bar =
    status !== undefined && holdsThread(status) ? (
      <ThreadMoveFrozenBar
        client={props.client}
        onChanged={move.refresh}
        status={status}
        thread={props.thread}
      />
    ) : undefined;
  return <FrozenBarScope.Provider value={bar}>{props.children}</FrozenBarScope.Provider>;
}

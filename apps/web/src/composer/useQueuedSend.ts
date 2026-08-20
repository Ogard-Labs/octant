import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_QUEUED_SEND,
  discardQueuedSend,
  disarmQueuedSend,
  enqueueQueuedSend,
  queuedSendStatusMessage,
  settleQueuedSend,
  type QueuedSendState,
  type TurnSettlement,
} from "./queuedSend";

export interface UseQueuedSendInput {
  readonly threadKey: string | undefined;
  readonly settlement: TurnSettlement | "idle";
  /** Ordinary send path. Invoked only when a queued intent is allowed to fire. */
  readonly send: () => Promise<boolean>;
}

export interface QueuedSend {
  readonly state: QueuedSendState;
  readonly statusMessage: string | undefined;
  readonly enqueue: () => boolean;
  readonly discard: () => void;
}

/**
 * Parks one composer intent while a turn is running and sends it through the
 * caller's ordinary send path when that turn completes. Cancel, failure, and
 * refusal hold it. Leaving the thread, or unmounting, drops the auto-send
 * without sending.
 */
export function useQueuedSend(input: UseQueuedSendInput): QueuedSend {
  const [state, setState] = useState<QueuedSendState>(EMPTY_QUEUED_SEND);
  const sendRef = useRef(input.send);
  sendRef.current = input.send;
  const firing = useRef(false);

  useEffect(() => {
    setState((current) => disarmQueuedSend(current, input.threadKey));
  }, [input.threadKey]);

  useEffect(() => {
    if (firing.current) return;
    const decision = settleQueuedSend(state, input.threadKey, input.settlement);
    if (decision.fire) {
      firing.current = true;
      setState(EMPTY_QUEUED_SEND);
      void sendRef.current().finally(() => {
        firing.current = false;
      });
      return;
    }
    if (decision.next !== state) setState(decision.next);
  }, [input.settlement, input.threadKey, state]);

  const enqueue = useCallback((): boolean => {
    if (input.threadKey === undefined) return false;
    let accepted = false;
    setState((current) => {
      const next = enqueueQueuedSend(current, input.threadKey!, input.settlement);
      accepted = next.status === "queued";
      return next;
    });
    return accepted;
  }, [input.settlement, input.threadKey]);

  const discard = useCallback((): void => {
    setState(discardQueuedSend());
  }, []);

  return {
    state,
    statusMessage: queuedSendStatusMessage(state),
    enqueue,
    discard,
  };
}

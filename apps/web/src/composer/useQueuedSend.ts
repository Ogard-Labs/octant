import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_QUEUED_SEND,
  discardQueuedSend,
  disarmQueuedSend,
  enqueueQueuedSend,
  queuedHoldReason,
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
  /**
   * When false, a completed turn does not fire yet. Used to wait for in-flight
   * uploads or a provider change that has not reached the server.
   */
  readonly ready?: boolean;
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
  const [release, setRelease] = useState(0);
  const sendRef = useRef(input.send);
  sendRef.current = input.send;
  const threadKeyRef = useRef(input.threadKey);
  threadKeyRef.current = input.threadKey;
  const settlementRef = useRef(input.settlement);
  settlementRef.current = input.settlement;
  const stateRef = useRef(state);
  stateRef.current = state;
  const firing = useRef(false);

  useEffect(() => {
    setState((current) => disarmQueuedSend(current, input.threadKey));
  }, [input.threadKey]);

  useEffect(() => {
    if (firing.current) return;
    const decision = settleQueuedSend(state, input.threadKey, input.settlement);
    if (decision.fire) {
      if (input.ready === false) return;
      const threadKey = input.threadKey;
      if (threadKey === undefined) return;
      firing.current = true;
      void (async () => {
        let sent = false;
        let failed = false;
        try {
          if (threadKeyRef.current !== threadKey) return;
          sent = await sendRef.current();
        } catch {
          failed = true;
        } finally {
          firing.current = false;
          setRelease((current) => current + 1);
        }
        if (threadKeyRef.current !== threadKey) return;
        setState((current) => {
          if (current.status !== "queued" || current.threadKey !== threadKey) return current;
          if (sent) return EMPTY_QUEUED_SEND;
          return {
            status: "held",
            threadKey,
            reason: queuedHoldReason(failed ? "failed" : "refused"),
          };
        });
      })();
      return;
    }
    if (decision.next !== state) setState(decision.next);
  }, [input.ready, input.settlement, input.threadKey, release, state]);

  const enqueue = useCallback((): boolean => {
    const threadKey = threadKeyRef.current;
    if (threadKey === undefined) return false;
    const next = enqueueQueuedSend(stateRef.current, threadKey, settlementRef.current);
    setState(next);
    return next.status === "queued";
  }, []);

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

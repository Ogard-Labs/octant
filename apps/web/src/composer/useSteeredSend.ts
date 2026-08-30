import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_STEERED_SEND,
  disarmSteeredSend,
  settleSteeredSend,
  steerSend,
  type SteeredSendState,
  type TurnSettlement,
} from "./steeredSend";

export interface UseSteeredSendInput<Message> {
  readonly threadKey: string | undefined;
  readonly settlement: TurnSettlement | "idle";
  /** Ordinary send path. Invoked once the thread stops running a response. */
  readonly send: (message: Message) => Promise<boolean>;
  /**
   * Called when the message never reached the host — refused, dropped, or the
   * thread left before it ran. The surface puts the words back in the composer
   * so nothing the user typed disappears.
   */
  readonly restore: (message: Message) => void;
  /**
   * When false, a settled turn does not send yet. Used to wait for in-flight
   * uploads or a provider change that has not reached the server.
   */
  readonly ready?: boolean;
}

export interface SteeredSend<Message> {
  /** The message already sent and waiting to run, for the transcript to show. */
  readonly pending: Message | undefined;
  readonly steer: (message: Message) => boolean;
  /**
   * Give up on sending, handing the words back through `restore`. Used when the
   * thread can no longer take the message at all — a confirmed completion, say
   * — so it never waits on a settlement that will not come.
   */
  readonly drop: () => void;
}

/**
 * Accepts a message the user sends while a response is running and sends it
 * through the caller's ordinary send path as soon as the thread stops running
 * one. The composer clears immediately — the surface shows the message in the
 * transcript instead — and `restore` hands the words back if the send never
 * happened.
 */
export function useSteeredSend<Message>(input: UseSteeredSendInput<Message>): SteeredSend<Message> {
  const [state, setState] = useState<SteeredSendState<Message>>(EMPTY_STEERED_SEND);
  const [release, setRelease] = useState(0);
  const sendRef = useRef(input.send);
  sendRef.current = input.send;
  const restoreRef = useRef(input.restore);
  restoreRef.current = input.restore;
  const threadKeyRef = useRef(input.threadKey);
  threadKeyRef.current = input.threadKey;
  const settlementRef = useRef(input.settlement);
  settlementRef.current = input.settlement;
  const stateRef = useRef(state);
  stateRef.current = state;
  const firing = useRef(false);

  useEffect(() => {
    const current = stateRef.current;
    const next = disarmSteeredSend(current, input.threadKey);
    if (next === current) return;
    if (current.status === "steering") restoreRef.current(current.message);
    setState(next);
  }, [input.threadKey]);

  useEffect(() => {
    if (firing.current) return;
    const decision = settleSteeredSend(state, input.threadKey, input.settlement);
    if (decision.fire && state.status === "steering") {
      if (input.ready === false) return;
      const threadKey = input.threadKey;
      if (threadKey === undefined) return;
      const message = state.message;
      firing.current = true;
      void (async () => {
        let sent = false;
        try {
          if (threadKeyRef.current !== threadKey) return;
          sent = await sendRef.current(message);
        } catch {
          sent = false;
        } finally {
          firing.current = false;
          setRelease((current) => current + 1);
        }
        if (threadKeyRef.current !== threadKey) return;
        if (!sent) restoreRef.current(message);
        setState((current) =>
          current.status === "steering" && current.threadKey === threadKey
            ? EMPTY_STEERED_SEND
            : current,
        );
      })();
      return;
    }
    if (decision.next !== state) setState(decision.next);
  }, [input.ready, input.settlement, input.threadKey, release, state]);

  const steer = useCallback((message: Message): boolean => {
    const threadKey = threadKeyRef.current;
    if (threadKey === undefined) return false;
    const next = steerSend(stateRef.current, threadKey, message, settlementRef.current);
    setState(next);
    return next.status === "steering" && next.message === message;
  }, []);

  const drop = useCallback((): void => {
    const current = stateRef.current;
    if (current.status !== "steering") return;
    restoreRef.current(current.message);
    setState(EMPTY_STEERED_SEND);
  }, []);

  return {
    pending: state.status === "steering" ? state.message : undefined,
    steer,
    drop,
  };
}

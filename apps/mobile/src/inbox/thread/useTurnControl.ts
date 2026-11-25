import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  loadMobileMessageQueue,
  queueMobileMessage,
  removeMobileQueuedMessage,
  type MobileSendResult,
  type MobileStopResult,
} from "@octant/client-runtime";
import type { ThreadMessageQueueSnapshot } from "@octant/contracts";
import { hapticFailure, hapticSuccess } from "../../ui/haptics";
import { runMutation } from "./runMutation";
import type { ThreadHookInput } from "./threadTypes";

// The queue empties as turns end, so it is read as often as the transcript is.
const QUEUE_REFRESH_MS = 4_000;

export interface TurnControl {
  /** The computer's own queue; undefined where this phone may not read or use one. */
  readonly queue: ThreadMessageQueueSnapshot | undefined;
  /** A change to the queue is on its way. */
  readonly pending: boolean;
  readonly queueMessage: () => Promise<void>;
  readonly removeQueued: (messageId: string) => Promise<void>;
  /** Stops the running turn; undefined while none runs that this phone may stop. */
  readonly stop: (() => Promise<void>) | undefined;
}

/** The running turn's Stop, and what waits behind it. */
export function useTurnControl(
  input: ThreadHookInput & {
    /** A turn runs, so a message waits or steers rather than starting one. */
    readonly live: boolean;
    readonly stopTurn: (() => Promise<MobileStopResult>) | undefined;
    readonly attachmentIds: ReadonlyArray<string>;
    readonly onQueued: () => void;
    /** Sent, and no answer came: kept under its id until the computer says. */
    readonly onUnanswered: (message: { readonly id: string; readonly text: string }) => boolean;
    readonly onStopped: () => void;
  },
): TurnControl {
  const { transport, target, guard, ui, gate, live } = input;
  const identity = target?.identity;
  const mode = target?.mode;
  const threadId = target?.threadId;
  const [queue, setQueue] = useState<ThreadMessageQueueSnapshot | undefined>();
  const shown = useRef(identity);
  shown.current = identity;

  const read = useCallback(async () => {
    if (transport === undefined || mode === undefined || threadId === undefined) return;
    try {
      const held = await loadMobileMessageQueue(transport, { mode, threadId });
      if (shown.current === identity) setQueue(held);
    } catch {
      // A read that was lost says nothing about the queue, so what was read
      // before stands; taking it as none closed the composer in mid-turn.
    }
  }, [identity, mode, threadId, transport]);

  useEffect(() => {
    setQueue(undefined);
    void read();
  }, [read]);
  const waiting = (queue?.items.length ?? 0) > 0;
  useEffect(() => {
    if (!live && !waiting) return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void read();
    }, QUEUE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, read, waiting]);

  // A turn is running, so the screen is busy already and cannot say that a
  // message is on its way: a second press would queue the same words again.
  const changing = useRef(false);
  const unanswered = useRef<{ readonly words: string; readonly id: string } | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const change = async (
    run: (snapshot: ThreadMessageQueueSnapshot) => Promise<MobileSendResult>,
    failure: string,
    onDone: (status: "queued" | "unreachable") => void,
  ) => {
    if (identity === undefined || queue === undefined || changing.current) return;
    changing.current = true;
    setPending(true);
    await runMutation({
      guard,
      identity,
      gate,
      ui,
      failure,
      run: () => run(queue),
      onDone: (result) => {
        if (result.status === "refused") {
          hapticFailure();
          ui.setError(result.message);
          return;
        }
        if (result.status === "queued") setQueue(result.snapshot);
        onDone(result.status);
      },
    });
    changing.current = false;
    setPending(false);
  };

  return {
    queue,
    pending,
    queueMessage: async () => {
      const prompt = input.prompt.trim();
      if (transport === undefined || prompt.length === 0) return;
      // The same words and files again are the same message until the computer
      // has answered for it.
      const words = JSON.stringify([prompt, input.attachmentIds]);
      const messageId =
        unanswered.current?.words === words
          ? unanswered.current.id
          : globalThis.crypto.randomUUID();
      unanswered.current = undefined;
      await change(
        ({ scope }) =>
          queueMobileMessage({
            transport,
            scope: { mode: scope.mode, threadId: String(scope.threadId) },
            messageId,
            prompt,
            attachmentIds: input.attachmentIds,
          }),
        "The message could not be queued.",
        (status) => {
          if (status === "unreachable") {
            // Files do not wait on the phone, so a message with them stays here.
            const held =
              input.attachmentIds.length === 0 &&
              input.onUnanswered({ id: messageId, text: prompt });
            if (!held) {
              unanswered.current = { words, id: messageId };
              ui.setError("No answer came. Your draft stays here; send it again.");
              return;
            }
          } else hapticSuccess();
          input.setPrompt("");
          input.onQueued();
        },
      );
    },
    removeQueued: async (messageId) => {
      if (transport === undefined) return;
      await change(
        (snapshot) => removeMobileQueuedMessage({ transport, snapshot, messageId }),
        "The message could not be removed.",
        () => undefined,
      );
    },
    stop:
      input.stopTurn === undefined || identity === undefined
        ? undefined
        : async () => {
            const { stopTurn } = input;
            if (stopTurn === undefined) return;
            await runMutation({
              guard,
              identity,
              gate,
              ui,
              failure: "The turn could not be stopped. Nothing changed.",
              run: stopTurn,
              onDone: (result) => {
                if (result.status === "refused") {
                  hapticFailure();
                  ui.setError(result.message);
                  return;
                }
                hapticSuccess();
                input.onStopped();
              },
            });
          },
  };
}

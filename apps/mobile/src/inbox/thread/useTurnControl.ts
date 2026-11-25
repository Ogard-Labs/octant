import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  loadMobileMessageQueue,
  queueMobileMessage,
  removeMobileQueuedMessage,
  type MobileQueueResult,
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
    const held = await loadMobileMessageQueue(transport, { mode, threadId }).catch(() => undefined);
    if (shown.current === identity) setQueue(held);
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

  const change = async (
    run: (snapshot: ThreadMessageQueueSnapshot) => Promise<MobileQueueResult>,
    failure: string,
    onDone: () => void,
  ) => {
    if (identity === undefined || queue === undefined) return;
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
        setQueue(result.snapshot);
        onDone();
      },
    });
  };

  return {
    queue,
    queueMessage: async () => {
      const prompt = input.prompt.trim();
      if (transport === undefined || prompt.length === 0) return;
      await change(
        (snapshot) =>
          queueMobileMessage({
            transport,
            snapshot,
            prompt,
            attachmentIds: input.attachmentIds,
          }),
        "The message could not be queued.",
        () => {
          hapticSuccess();
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

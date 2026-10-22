import { useCallback, useEffect, useState } from "react";
import {
  loadMobileWorkThread,
  loadMobileWorkTranscript,
  sendMobileWorkTurn,
} from "@octant/client-runtime";
import type { WorkThread, WorkTurnState } from "@octant/contracts";
import { runLoad, runMutation } from "./runMutation";
import type { RefreshOptions, ThreadHookInput } from "./threadTypes";
import { workFollowUpTarget } from "./workFollowUpTarget";

export function useWorkThread(input: ThreadHookInput) {
  const { transport, target, guard, ui, gate, prompt, setPrompt } = input;
  const identity = target?.identity;
  const threadId = target?.threadId;
  const enabled = target?.mode === "work";
  const [thread, setThread] = useState<WorkThread | undefined>();
  const [turns, setTurns] = useState<ReadonlyArray<WorkTurnState> | undefined>();

  useEffect(() => {
    setThread(undefined);
    setTurns(undefined);
  }, [identity]);

  const refresh = useCallback(
    async (options?: RefreshOptions) => {
      if (!enabled || transport === undefined || identity === undefined || threadId === undefined) {
        return;
      }
      await runLoad({
        guard,
        identity,
        quiet: options?.quiet === true,
        ui,
        failure: "Could not load the Work thread.",
        load: () =>
          Promise.all([
            loadMobileWorkThread(transport, threadId),
            loadMobileWorkTranscript(transport, threadId),
          ]),
        onLoaded: ([loaded, transcript]) => {
          setThread(loaded);
          setTurns(transcript.turns);
        },
        onFailed: () => {
          setThread(undefined);
          setTurns(undefined);
        },
      });
    },
    [enabled, guard, identity, threadId, transport, ui],
  );

  const sendFollowUp = async () => {
    if (!enabled || transport === undefined || identity === undefined || threadId === undefined) {
      return;
    }
    const followUp = workFollowUpTarget(thread, threadId);
    if (followUp.status === "not-loaded") {
      ui.setError(followUp.message);
      return;
    }
    await runMutation({
      guard,
      identity,
      gate,
      ui,
      failure: "Follow-up failed.",
      run: () => sendMobileWorkTurn({ transport, thread: followUp.thread, prompt }),
      onDone: (turn) => {
        setTurns((current) => [...(current ?? []), turn]);
        setPrompt("");
      },
    });
  };

  return {
    thread,
    turns,
    live: (turns ?? []).some(
      (turn) =>
        turn.status === "accepted" || turn.status === "running" || turn.status === "waiting",
    ),
    refresh,
    sendFollowUp,
  };
}

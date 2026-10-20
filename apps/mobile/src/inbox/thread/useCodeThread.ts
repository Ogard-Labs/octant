import { useCallback, useEffect, useState } from "react";
import {
  loadMobileCodeConversation,
  loadMobileCodeThread,
  sendMobileCodeTurn,
  type MobileCodeConversation,
} from "@octant/client-runtime";
import { runLoad, runMutation } from "./runMutation";
import type { RefreshOptions, ThreadHookInput } from "./threadTypes";

export function useCodeThread(input: ThreadHookInput) {
  const { transport, target, guard, ui, gate, prompt, setPrompt } = input;
  const identity = target?.identity;
  const threadId = target?.threadId;
  const enabled = target?.mode === "code";
  const [policy, setPolicy] = useState<string | undefined>();
  const [conversation, setConversation] = useState<MobileCodeConversation | undefined>();

  useEffect(() => {
    setPolicy(undefined);
    setConversation(undefined);
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
        failure: "Could not load the Code thread.",
        load: () =>
          Promise.all([
            loadMobileCodeThread(transport, threadId),
            loadMobileCodeConversation(transport, threadId),
          ]),
        onLoaded: ([thread, loaded]) => {
          setPolicy(thread.executionPolicy);
          setConversation(loaded);
        },
        onFailed: () => {
          setPolicy(undefined);
          setConversation(undefined);
        },
      });
    },
    [enabled, guard, identity, threadId, transport, ui],
  );

  const sendFollowUp = async () => {
    if (!enabled || transport === undefined || identity === undefined || threadId === undefined) {
      return;
    }
    await runMutation({
      guard,
      identity,
      gate,
      ui,
      failure: "Follow-up failed.",
      run: async () => {
        await sendMobileCodeTurn({ transport, threadId, prompt });
        return loadMobileCodeConversation(transport, threadId);
      },
      onDone: (loaded) => {
        setConversation(loaded);
        setPrompt("");
      },
    });
  };

  const turns = conversation?.turns;
  return {
    policy,
    conversation,
    turns,
    live: (turns ?? []).some((turn) => turn.status === "waiting"),
    refresh,
    sendFollowUp,
  };
}

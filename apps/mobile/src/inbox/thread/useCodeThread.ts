import { useCallback, useEffect, useState } from "react";
import {
  loadMobileCodeConversation,
  loadMobileCodeThread,
  sendMobileCodeTurn,
  type MobileCodeConversation,
} from "@octant/client-runtime";
import type { CodeThread } from "@octant/contracts";
import { runLoad, runMutation, sendThenReload } from "./runMutation";
import type { RefreshOptions, ThreadHookInput } from "./threadTypes";
import { useThreadAttachments } from "./useThreadAttachments";

export function useCodeThread(input: ThreadHookInput) {
  const { transport, target, guard, ui, gate, prompt, setPrompt } = input;
  const identity = target?.identity;
  const threadId = target?.threadId;
  const enabled = target?.mode === "code";
  const [policy, setPolicy] = useState<string | undefined>();
  const [codeThread, setCodeThread] = useState<CodeThread | undefined>();
  const [conversation, setConversation] = useState<MobileCodeConversation | undefined>();
  const [threadModel, setThreadModel] = useState<
    { readonly providerInstanceId: string; readonly modelId: string } | undefined
  >();
  const attachments = useThreadAttachments("code", input);

  useEffect(() => {
    setPolicy(undefined);
    setCodeThread(undefined);
    setConversation(undefined);
    setThreadModel(undefined);
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
          setCodeThread(thread);
          setThreadModel({
            providerInstanceId: String(thread.providerInstanceId),
            modelId: String(thread.modelId),
          });
          setConversation(loaded);
        },
        onFailed: () => {
          setPolicy(undefined);
          setCodeThread(undefined);
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
      run: () =>
        sendThenReload({
          send: () =>
            sendMobileCodeTurn({
              transport,
              threadId,
              prompt,
              attachmentIds: attachments.pending.map((attachment) => attachment.id),
            }),
          onSent: () => {
            if (!guard.isSelected(identity)) return;
            setPrompt("");
            attachments.sent();
          },
          reload: () => loadMobileCodeConversation(transport, threadId),
        }),
      onDone: (loaded) => {
        if (loaded !== undefined) setConversation(loaded);
      },
    });
  };

  const turns = conversation?.turns;
  return {
    policy,
    thread: codeThread,
    conversation,
    turns,
    live: (turns ?? []).some((turn) => turn.status === "waiting"),
    refresh,
    sendFollowUp,
    threadModel,
    pendingAttachments: attachments.pending,
    attach: attachments.attach,
  };
}

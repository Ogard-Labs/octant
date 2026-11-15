import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadMobileCodeConversation,
  loadMobileCodeThread,
  sendMobileCodeTurn,
  type MobileCodeConversation,
} from "@octant/client-runtime";
import type { CodeThread } from "@octant/contracts";
import { loadCodeConversationPage } from "./codeConversationPage";
import { runLoad, runMutation, sendThenReload } from "./runMutation";
import type { RefreshOptions, ThreadHookInput } from "./threadTypes";
import { useThreadAttachments } from "./useThreadAttachments";

/**
 * The selected Code thread. `focusOperationId` is a message search hit's
 * provider turn: when it is older than the newest page, the thread opens on
 * the page ending with it, anchored there across refreshes until the reader
 * jumps to the latest turns or sends a follow-up.
 */
export function useCodeThread(input: ThreadHookInput, focusOperationId?: string) {
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
  // The provider turn the shown page ends with, while it is not the newest.
  const anchor = useRef<string | undefined>(undefined);
  // The search hit is looked for once per opened thread, on its first load.
  // The thread screen mounts afresh for every hit it opens, so the hit is
  // read when the thread changes rather than tracked on its own.
  const focus = useRef(focusOperationId);
  focus.current = focusOperationId;
  const pendingFocus = useRef<string | undefined>(focusOperationId);

  useEffect(() => {
    setPolicy(undefined);
    setCodeThread(undefined);
    setConversation(undefined);
    setThreadModel(undefined);
    anchor.current = undefined;
    pendingFocus.current = focus.current;
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
            loadCodeConversationPage(transport, threadId, anchor.current, pendingFocus.current),
          ]),
        onLoaded: ([thread, { loaded, anchoredAt }]) => {
          pendingFocus.current = undefined;
          anchor.current = anchoredAt;
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
            // The reply arrives at the newest turns, so the reader goes there.
            anchor.current = undefined;
          },
          reload: () => loadMobileCodeConversation(transport, threadId),
        }),
      onDone: (loaded) => {
        if (loaded !== undefined) setConversation(loaded);
      },
    });
  };

  const jumpToLatest = useCallback(async () => {
    anchor.current = undefined;
    await refresh();
  }, [refresh]);

  const turns = conversation?.turns;
  return {
    policy,
    thread: codeThread,
    conversation,
    turns,
    live: (turns ?? []).some((turn) => turn.status === "waiting"),
    refresh,
    jumpToLatest,
    sendFollowUp,
    threadModel,
    pendingAttachments: attachments.pending,
    attach: attachments.attach,
  };
}

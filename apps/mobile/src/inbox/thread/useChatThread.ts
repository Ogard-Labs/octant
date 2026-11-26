import { typedClaimFor } from "@octant/client-runtime/typed-composer-text";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelMobileChatWorkItem,
  completeMobileChatFollowUp,
  completeMobileChatWorkItem,
  decodeMobileModelOptionId,
  keepDeclaredModelOptionValues,
  interruptMobileChatTurn,
  latestActiveChatAttempt,
  latestRetryableChatAttempt,
  loadMobileChatThread,
  retryMobileChatTurn,
  sendMobileChatTurn,
  type MobileModelOption,
} from "@octant/client-runtime";
import type {
  ChatThreadView,
  ProviderModelOptionValues,
  ThreadFollowUp,
  ThreadWorkItem,
} from "@octant/contracts";
import { chatSettingsToSend } from "../modelSettings";
import { runChatEventLoop } from "./chatEventLoop";
import { modelOptionForThread } from "./pendingAttachments";
import { runLoad, runMutation, sendThenReload } from "./runMutation";
import type { RefreshOptions, ThreadHookInput } from "./threadTypes";
import { useThreadAttachments } from "./useThreadAttachments";

export function useChatThread(
  input: ThreadHookInput & { readonly modelOptions: ReadonlyArray<MobileModelOption> },
) {
  const { transport, target, guard, ui, gate, prompt, setPrompt, modelOptions, typedScope } = input;
  const identity = target?.identity;
  const threadId = target?.threadId;
  const enabled = target?.mode === "chat";
  const [loaded, setLoaded] = useState<ChatThreadView | undefined>();
  // A view that belongs to another thread is never exposed: the reset effect
  // below runs after the first render of a new selection.
  const view = loaded !== undefined && String(loaded.thread.id) === threadId ? loaded : undefined;
  const viewRef = useRef(view);
  viewRef.current = view;
  const [pendingPrompt, setPendingPrompt] = useState<string | undefined>();
  const [pendingFailure, setPendingFailure] = useState<string | undefined>();
  const attachments = useThreadAttachments("chat", input);
  const pendingAttachments = attachments.pending;
  const [modelOptionId, setModelOptionIdState] = useState<string | undefined>();
  // The person's own choice of the model's settings; absent, the thread's own apply.
  const [chosenValues, setChosenValues] = useState<ProviderModelOptionValues | undefined>();
  const [reconnecting, setReconnecting] = useState(false);
  const hasView = view !== undefined;

  const activeAttempt = view === undefined ? undefined : latestActiveChatAttempt(view);
  const retryableAttempt = view === undefined ? undefined : latestRetryableChatAttempt(view);

  useEffect(() => {
    setLoaded(undefined);
    setPendingPrompt(undefined);
    setPendingFailure(undefined);
    setModelOptionIdState(undefined);
    setChosenValues(undefined);
    setReconnecting(false);
  }, [identity]);

  // Matching the thread's model is its own step, not part of the reload: a
  // reload keyed on the model list wiped a just-picked attachment.
  const loadedProvider = view === undefined ? undefined : String(view.thread.providerInstanceId);
  const loadedModel = view === undefined ? undefined : String(view.thread.modelId);
  useEffect(() => {
    if (loadedProvider === undefined || loadedModel === undefined) return;
    const match = modelOptionForThread(modelOptions, {
      providerInstanceId: loadedProvider,
      modelId: loadedModel,
    });
    if (match !== undefined) setModelOptionIdState(match.id);
  }, [loadedModel, loadedProvider, modelOptions]);

  // A value the newly chosen model does not declare would make the host refuse
  // the change, so choosing a model drops what it does not offer.
  const selectedSettings = modelOptions.find((option) => option.id === modelOptionId)?.settings;
  const modelOptionValues = keepDeclaredModelOptionValues(
    selectedSettings,
    chosenValues ?? view?.thread.modelOptionValues,
  );
  const setModelOptionId = (id: string) => {
    setModelOptionIdState(id);
    const next = modelOptions.find((option) => option.id === id);
    setChosenValues((previous) =>
      previous === undefined ? undefined : keepDeclaredModelOptionValues(next?.settings, previous),
    );
  };
  const setModelOptionValue = (optionId: string, value: string | undefined) => {
    const rest = Object.fromEntries(
      Object.entries(modelOptionValues).filter(([id]) => id !== optionId),
    );
    setChosenValues(value === undefined ? rest : { ...rest, [optionId]: value });
  };

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
        failure: "Could not load the thread.",
        load: () => loadMobileChatThread(transport, threadId),
        onLoaded: setLoaded,
        onFailed: () => undefined,
      });
    },
    [enabled, guard, identity, threadId, transport, ui],
  );

  // The loop starts once the view exists, so it needs no polling timer to wait for it.
  useEffect(() => {
    const start = viewRef.current;
    if (!enabled || !hasView || start === undefined) return;
    if (transport === undefined || identity === undefined || threadId === undefined) return;
    const controller = new AbortController();
    void runChatEventLoop({
      transport,
      threadId,
      startSequence: start.lastSequence,
      signal: controller.signal,
      onView: (next) => {
        if (guard.isSelected(identity)) setLoaded(next);
      },
      onReconnecting: (value) => {
        if (guard.isSelected(identity)) setReconnecting(value);
      },
    });
    return () => controller.abort();
  }, [enabled, guard, hasView, identity, threadId, transport]);

  const mutateView = (failure: string, run: () => Promise<unknown>) => {
    if (!enabled || transport === undefined || view === undefined || identity === undefined) {
      return Promise.resolve(undefined);
    }
    return runMutation({
      guard,
      identity,
      gate,
      ui,
      failure,
      run: async () => {
        await run();
        return loadMobileChatThread(transport, view.thread.id);
      },
      onDone: setLoaded,
    });
  };

  const send = async () => {
    // Read now, before anything is awaited: the claim is of the text being sent.
    const typedClaim = typedClaimFor(typedScope, prompt);
    if (!enabled || transport === undefined || view === undefined || identity === undefined) return;
    const decoded =
      modelOptionId === undefined ? undefined : decodeMobileModelOptionId(modelOptionId);
    const needsChange =
      decoded !== undefined &&
      (decoded.providerInstanceId !== String(view.thread.providerInstanceId) ||
        decoded.modelId !== String(view.thread.modelId));
    const settingsToSend = chatSettingsToSend({
      settings: selectedSettings,
      chosen: chosenValues,
      thread: view.thread.modelOptionValues,
    });
    const valuesChanged = settingsToSend !== undefined;
    return runMutation({
      guard,
      identity,
      gate,
      ui,
      failure: "Follow-up failed.",
      run: () =>
        sendThenReload({
          send: () =>
            sendMobileChatTurn({
              transport,
              threadId: view.thread.id,
              expectedVersion: view.thread.version,
              prompt,
              ...typedClaim,
              ...(pendingAttachments.length > 0
                ? { attachmentIds: pendingAttachments.map((item) => item.id) }
                : {}),
              ...((needsChange || valuesChanged) && decoded !== undefined
                ? { providerInstanceId: decoded.providerInstanceId, modelId: decoded.modelId }
                : {}),
              ...(settingsToSend !== undefined && decoded !== undefined
                ? { modelOptionValues: settingsToSend }
                : {}),
            }),
          onSent: () => {
            if (!guard.isSelected(identity)) return;
            setPrompt("");
            attachments.sent();
            // The host has the choice now; from here its values are the thread's.
            setChosenValues(undefined);
          },
          reload: () => loadMobileChatThread(transport, view.thread.id),
        }),
      onDone: (next) => {
        // The sent turn stays on screen until the reload shows it.
        if (next !== undefined) setLoaded(next);
        setPendingPrompt(undefined);
      },
      onFailed: (message) => {
        setPendingPrompt(undefined);
        setPendingFailure(message);
      },
    });
  };

  const stop = async () => {
    if (transport === undefined || view === undefined || activeAttempt === undefined) return;
    await mutateView("Stop failed.", () =>
      interruptMobileChatTurn({
        transport,
        threadId: view.thread.id,
        expectedVersion: view.thread.version,
        turnId: String(activeAttempt.turnId),
        attemptId: String(activeAttempt.id),
      }),
    );
  };

  const retry = async () => {
    if (transport === undefined || view === undefined || retryableAttempt === undefined) return;
    await mutateView("Retry failed.", () =>
      retryMobileChatTurn({
        transport,
        threadId: view.thread.id,
        expectedVersion: view.thread.version,
        turnId: String(retryableAttempt.turnId),
        attemptId: String(retryableAttempt.id),
      }),
    );
  };

  const completeWorkItem = (item: ThreadWorkItem) => {
    if (transport === undefined || view === undefined) return;
    void mutateView("Could not complete the work item.", () =>
      completeMobileChatWorkItem({
        transport,
        threadId: String(view.thread.id),
        expectedVersion: view.workListVersion,
        itemId: String(item.id),
      }),
    );
  };

  const cancelWorkItem = (item: ThreadWorkItem) => {
    if (transport === undefined || view === undefined) return;
    void mutateView("Could not cancel the work item.", () =>
      cancelMobileChatWorkItem({
        transport,
        threadId: String(view.thread.id),
        expectedVersion: view.workListVersion,
        itemId: String(item.id),
      }),
    );
  };

  const completeFollowUp = (followUp: ThreadFollowUp) => {
    if (transport === undefined || view === undefined) return;
    void mutateView("Could not complete the follow-up.", () =>
      completeMobileChatFollowUp({
        transport,
        threadId: String(view.thread.id),
        expectedVersion: view.followUpVersion,
        acknowledgedThroughSequence: followUp.triggerSequence,
      }),
    );
  };

  return {
    view,
    activeAttempt,
    retryableAttempt,
    pendingPrompt,
    pendingFailure,
    pendingAttachments,
    modelOptionId,
    setModelOptionId,
    modelOptionValues,
    setModelOptionValue,
    reconnecting,
    refresh,
    attach: attachments.attach,
    attachmentsSent: attachments.sent,
    send,
    stop,
    retry,
    completeWorkItem,
    cancelWorkItem,
    completeFollowUp,
  };
}

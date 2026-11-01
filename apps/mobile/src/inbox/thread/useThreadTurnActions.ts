import { useEffect, useRef, useState } from "react";
import {
  MOBILE_REWIND_NO_FILES_IN_THIS_MODE,
  composerAfterRewind,
  forkMobileChatThread,
  forkMobileCodeThread,
  forkMobileWorkThread,
  mobileCodeRewindFilesOffer,
  previewMobileCodeRewind,
  rewindMobileChatThread,
  rewindMobileCodeThread,
  rewindMobileWorkThread,
  type MobileInboxRow,
  type MobileRemoteTransport,
  type MobileRewindScope,
  type MobileTurnTargets,
} from "@octant/client-runtime";
import type { ChatThreadView, CodeThread, WorkThread } from "@octant/contracts";
import { MOBILE_COPY } from "../../copy";
import type { MessageActionItem } from "../../ui/MessageActions";
import type { RewindSheetProps } from "../../ui/RewindSheet";
import { failureMessage, runMutation } from "./runMutation";
import type { SelectedThreadGuard } from "./selectedThreadGuard";
import type { MutationGate, ThreadTarget, ThreadUi } from "./threadTypes";

interface OpenRewind {
  readonly fromId: string;
  /** The person's message that returns to the composer; absent where there is none. */
  readonly prompt: string | undefined;
  readonly removedTurns: number | undefined;
  readonly files: RewindSheetProps["files"];
  readonly rollback?: "native" | "handoff";
  readonly busy: boolean;
  /** The Chat version the sheet was opened on; a rewind confirms only against it. */
  readonly chatVersion?: number;
  readonly message?: string;
}

export interface ThreadTurnActionsInput {
  readonly transport: MobileRemoteTransport | undefined;
  readonly target: ThreadTarget | undefined;
  readonly guard: SelectedThreadGuard;
  readonly ui: ThreadUi;
  readonly gate: MutationGate;
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
  /** True while a turn of the thread starts, runs, or waits: nothing is offered then. */
  readonly turnLive: boolean;
  readonly refresh: () => Promise<void>;
  /** Opens the thread a fork made. */
  readonly onOpenThread: (row: MobileInboxRow) => void;
  readonly chatThread: ChatThreadView["thread"] | undefined;
  readonly workThread: WorkThread | undefined;
  readonly codeThread: CodeThread | undefined;
}

/**
 * Fork from here and Rewind to here on one message. The host decides every
 * effect and refuses what it will not do; the phone only names the point,
 * asks once with the host's preview, and puts the removed message back in the
 * composer. While a turn runs, or the host is stale, nothing is offered.
 */
export function useThreadTurnActions(input: ThreadTurnActionsInput) {
  const { transport, target, guard, ui, gate, turnLive } = input;
  const identity = target?.identity;
  const mode = target?.mode;
  const [open, setOpen] = useState<OpenRewind | undefined>();
  const [forking, setForking] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const promptRef = useRef(input.prompt);
  promptRef.current = input.prompt;

  useEffect(() => {
    setOpen(undefined);
    setForking(false);
    setNotice(undefined);
  }, [identity]);

  const canAct =
    transport !== undefined &&
    identity !== undefined &&
    gate.allowProductMutations &&
    !turnLive &&
    !forking;

  const fork = async (throughId: string) => {
    if (transport === undefined || identity === undefined) return;
    setNotice(undefined);
    setForking(true);
    const outcome = await runMutation({
      guard,
      identity,
      gate,
      ui,
      failure: "The thread could not be forked. This thread is unchanged.",
      run: async () => {
        if (mode === "chat" && input.chatThread !== undefined) {
          return forkMobileChatThread({
            transport,
            thread: input.chatThread,
            throughTurnId: throughId,
          });
        }
        if (mode === "work" && input.workThread !== undefined) {
          return forkMobileWorkThread({
            transport,
            thread: input.workThread,
            throughRequestId: throughId,
          });
        }
        if (mode === "code" && input.codeThread !== undefined) {
          return forkMobileCodeThread({
            transport,
            sourceThreadId: String(input.codeThread.id),
            sourceTitle: input.codeThread.title,
            throughOperationId: throughId,
          });
        }
        return undefined;
      },
      onDone: (row) => {
        if (row !== undefined) input.onOpenThread(row);
      },
    });
    if (outcome !== "stale") setForking(false);
  };

  const openRewind = async (targets: MobileTurnTargets) => {
    const fromId = targets.rewindFromId;
    if (transport === undefined || identity === undefined || fromId === undefined) return;
    if (!gate.allowProductMutations) {
      ui.setError(gate.message);
      return;
    }
    setNotice(undefined);
    const base = {
      fromId,
      prompt: targets.rewindPrompt,
      busy: false,
      ...(input.chatThread === undefined ? {} : { chatVersion: input.chatThread.version }),
    } as const;
    if (mode !== "code" || input.codeThread === undefined) {
      setOpen({
        ...base,
        removedTurns: targets.removedTurns,
        files: { kind: "unavailable", reason: MOBILE_REWIND_NO_FILES_IN_THIS_MODE },
      });
      return;
    }
    const offer = mobileCodeRewindFilesOffer(input.codeThread.executionPolicy);
    if (offer.kind === "conversation-only") {
      setOpen({
        ...base,
        removedTurns: targets.removedTurns,
        files: { kind: "unavailable", reason: offer.reason },
      });
      return;
    }
    setOpen({ ...base, removedTurns: undefined, files: { kind: "loading" } });
    const codeThread = input.codeThread;
    const result = await guard.guarded(identity, () =>
      previewMobileCodeRewind(transport, {
        threadId: codeThread.id,
        checkoutId: codeThread.checkoutId,
        fromOperationId: fromId,
      }),
    );
    if (result.status === "stale") return;
    setOpen((current) => {
      if (current === undefined || current.fromId !== fromId) return current;
      if (result.status === "failed") {
        return {
          ...current,
          files: { kind: "unavailable", reason: "The files could not be compared." },
          message: failureMessage(result.cause, "The rewind could not be previewed. Try again."),
        };
      }
      return {
        ...current,
        removedTurns: result.value.removedTurns,
        rollback: result.value.rollback,
        files: result.value.files,
      };
    });
  };

  const confirmRewind = async (scope: MobileRewindScope) => {
    const current = open;
    if (transport === undefined || identity === undefined || current === undefined) return;
    if (!gate.allowProductMutations) {
      setOpen({ ...current, message: gate.message });
      return;
    }
    // The sheet named the turns this rewind removes. If the conversation moved
    // since, the host would take the newer turns out unseen, so ask again.
    if (
      mode === "chat" &&
      current.chatVersion !== undefined &&
      input.chatThread?.version !== current.chatVersion
    ) {
      setOpen({
        ...current,
        message: "The conversation changed while this was open. Close it and try again.",
      });
      return;
    }
    setOpen({ ...current, busy: true });
    const result = await guard.guarded(identity, async () => {
      if (mode === "chat" && input.chatThread !== undefined) {
        await rewindMobileChatThread({
          transport,
          thread: input.chatThread,
          fromTurnId: current.fromId,
        });
        return { notice: MOBILE_COPY.rewindDone };
      }
      if (mode === "work" && input.workThread !== undefined) {
        const rewound = await rewindMobileWorkThread({
          transport,
          threadId: String(input.workThread.id),
          fromRequestId: current.fromId,
        });
        return { notice: MOBILE_COPY.rewindDone, prompt: rewound.prompt };
      }
      if (mode === "code" && input.codeThread !== undefined) {
        const rewound = await rewindMobileCodeThread(transport, {
          threadId: input.codeThread.id,
          checkoutId: input.codeThread.checkoutId,
          fromOperationId: current.fromId,
          scope,
        });
        return {
          notice:
            rewound.scope === "files"
              ? MOBILE_COPY.rewindDoneFilesOnly
              : rewound.files === "restored"
                ? MOBILE_COPY.rewindDoneFiles
                : MOBILE_COPY.rewindDone,
        };
      }
      throw new Error("not a thread this phone can rewind");
    });
    if (result.status === "stale") return;
    if (result.status === "failed") {
      setOpen({
        ...current,
        busy: false,
        message: failureMessage(
          result.cause,
          "The rewind did not report back. Refresh before assuming it did nothing.",
        ),
      });
      // The host may have moved on; read it again so the next try names real turns.
      void input.refresh();
      return;
    }
    setOpen(undefined);
    setNotice(result.value.notice);
    if (scope !== "files") {
      const returned =
        ("prompt" in result.value ? result.value.prompt : undefined) ?? current.prompt;
      if (returned !== undefined) {
        input.setPrompt(composerAfterRewind(returned, promptRef.current));
      }
    }
    void input.refresh();
  };

  /** The two actions one message offers, or none where they cannot run. */
  const actionsFor = (targets: MobileTurnTargets | undefined): ReadonlyArray<MessageActionItem> => {
    if (!canAct || targets === undefined) return [];
    const actions: MessageActionItem[] = [];
    const forkThroughId = targets.forkThroughId;
    if (forkThroughId !== undefined) {
      actions.push({
        id: "fork",
        label: MOBILE_COPY.forkFromHere,
        icon: "git-branch-outline",
        onPress: () => fork(forkThroughId),
      });
    }
    if (targets.rewindFromId !== undefined) {
      actions.push({
        id: "rewind",
        label: MOBILE_COPY.rewindToHere,
        icon: "arrow-undo-outline",
        onPress: () => openRewind(targets),
      });
    }
    return actions;
  };

  const sheet: RewindSheetProps = {
    visible: open !== undefined,
    onClose: () => setOpen(undefined),
    removedTurns: open?.removedTurns,
    files: open?.files ?? { kind: "loading" },
    ...(open?.rollback === undefined ? {} : { rollback: open.rollback }),
    busy: open?.busy === true || forking,
    ...(open?.message === undefined ? {} : { message: open.message }),
    onRewind: (scope) => void confirmRewind(scope),
  };

  return { actionsFor, sheet, notice, forking };
}

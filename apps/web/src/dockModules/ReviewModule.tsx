import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { unavailable } from "./moduleState";
import { ReviewWorkspace } from "../gitHistory/ReviewWorkspace";
import { decodeCodeThreadId } from "@octant/contracts";
import { Suspense } from "react";
import { ShellState } from "../shell/ShellState";
import type { CodeLineNotesSendResult } from "../code/CodeLineNotes";
import type { CodeController } from "../code/useCodeController";

type Props = Pick<
  ThreadUtilityDockContentProps,
  | "codeClient"
  | "codeController"
  | "codeDiffLayout"
  | "codeThreadView"
  | "hostBridge"
  | "onOpenFile"
  | "serverUrl"
  | "subject"
  | "windowCapability"
  | "agentRunClient"
  | "requestedAgentReview"
  | "requestedCodeReviewFile"
  | "onAgentReviewBack"
>;

const LINE_NOTES_REFUSED: CodeLineNotesSendResult = {
  status: "refused",
  message: "The thread did not accept the notes; its reason shows there.",
};

/**
 * Sends line notes as one ordinary follow-up. They count as sent the moment
 * the host accepts the message and starts its turn: that message is journaled
 * then, so a turn that later waits, stops or fails must not keep the notes
 * pending, where sending them again would repeat the instructions.
 */
export function sendLineNotesAsFollowUp(
  controller: Pick<CodeController, "sendFollowUp">,
  message: string,
): Promise<CodeLineNotesSendResult> {
  return new Promise((resolve) => {
    let accepted = false;
    const accept = () => {
      accepted = true;
      resolve({ status: "sent" });
    };
    controller
      .sendFollowUp(
        message,
        [],
        [],
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        undefined,
        [],
        false,
        undefined,
        { onAccepted: accept },
      )
      .then((sent) => {
        if (accepted) return;
        if (sent) accept();
        else resolve(LINE_NOTES_REFUSED);
      })
      .catch(() => {
        if (!accepted) resolve(LINE_NOTES_REFUSED);
      });
  });
}

export default function ReviewModule(props: Props) {
  if (props.subject.mode !== "code") {
    return unavailable("Review", "Review opens from a Code thread.");
  }
  const threadId = decodeCodeThreadId(props.subject.threadId);
  const controller = props.codeController;
  // Line notes go out as an ordinary follow-up through the thread's own
  // controller, so the host applies the same mode and access checks as the
  // composer. Only the controller showing this thread may send for it.
  const sendsForThread =
    controller?.activeView !== undefined &&
    String(controller.activeView.thread.id) === String(threadId);
  const lineNotesSendUnavailable = !sendsForThread
    ? "Open this thread to send its notes."
    : controller.turnStatus === "sending" || controller.turnStatus === "running"
      ? "Send when the current turn finishes. Your notes are kept."
      : undefined;
  return (
    <Suspense fallback={<ShellState state="loading" title="Loading review" />}>
      <ReviewWorkspace
        {...(props.requestedCodeReviewFile === undefined
          ? {}
          : { requestedCodeReviewFile: props.requestedCodeReviewFile })}
        {...(props.agentRunClient === undefined ? {} : { agentRunClient: props.agentRunClient })}
        {...(props.requestedAgentReview === undefined
          ? {}
          : { requestedAgentReview: props.requestedAgentReview })}
        {...(props.onAgentReviewBack === undefined
          ? {}
          : { onAgentReviewBack: props.onAgentReviewBack })}
        {...(props.codeClient === undefined ? {} : { client: props.codeClient })}
        {...(props.codeDiffLayout === undefined ? {} : { defaultDiffLayout: props.codeDiffLayout })}
        {...(props.codeThreadView === undefined ? {} : { view: props.codeThreadView })}
        threadId={threadId}
        {...(controller === undefined || !sendsForThread
          ? {}
          : {
              onSendLineNotes: (message: string) => sendLineNotesAsFollowUp(controller, message),
            })}
        {...(lineNotesSendUnavailable === undefined ? {} : { lineNotesSendUnavailable })}
        {...(props.subject.checkoutId === undefined
          ? {}
          : { checkoutId: props.subject.checkoutId })}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        onOpenFile={props.onOpenFile}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
      />
    </Suspense>
  );
}

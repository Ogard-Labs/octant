import { decodeUtcTimestamp, decodeWorkThreadId } from "@octant/contracts";
import { decodeChatThreadId } from "@octant/contracts/chat";
import { decodeCodeThreadId } from "@octant/contracts/code";
import type { OctantMode } from "@octant/contracts/modes";
import type { ChatThreadRestOutcome } from "../chat/useChatController";
import type { CodeThreadRestOutcome } from "../code/useCodeController";
import type { ThreadRowActions } from "../projects/ThreadRowMenu";
import type { ShellActions } from "./shellActions";

export type ThreadRestRowActions = Pick<
  ThreadRowActions,
  "onCompleteThread" | "onReopenThread" | "onSnoozeThread" | "onWakeThread" | "onPinThread"
>;

/**
 * Settle, reopen, snooze, wake and pin for each mode's threads. The sidebar row
 * menu and the command palette use these same handlers, so a host refusal
 * reaches the person the same way from either: neither has anywhere of its own
 * to report one, so it reads where thread notices already appear.
 *
 * List pin is a Code-only mark, so Chat and Work have none.
 */
export function threadRestRowActions(
  actions: Pick<
    ShellActions,
    | "completeChatThread"
    | "reopenChatThread"
    | "snoozeChatThread"
    | "wakeChatThread"
    | "completeCodeThread"
    | "reopenCodeThread"
    | "snoozeCodeThread"
    | "wakeCodeThread"
    | "pinCodeThread"
    | "runWorkRestCommand"
    | "setThreadExportNotice"
  >,
): Record<OctantMode, ThreadRestRowActions> {
  const noteRefusal = (outcome: CodeThreadRestOutcome | ChatThreadRestOutcome): void => {
    if (outcome.status === "refused") actions.setThreadExportNotice(outcome.message);
  };
  return {
    code: {
      onCompleteThread: (threadId) =>
        void actions.completeCodeThread(decodeCodeThreadId(threadId)).then(noteRefusal),
      onReopenThread: (threadId) =>
        void actions.reopenCodeThread(decodeCodeThreadId(threadId)).then(noteRefusal),
      onSnoozeThread: (threadId, until) =>
        void actions.snoozeCodeThread(decodeCodeThreadId(threadId), until).then(noteRefusal),
      onWakeThread: (threadId) =>
        void actions.wakeCodeThread(decodeCodeThreadId(threadId)).then(noteRefusal),
      onPinThread: (threadId, pinned) =>
        void actions.pinCodeThread(decodeCodeThreadId(threadId), pinned),
    },
    chat: {
      onCompleteThread: (threadId) =>
        void actions.completeChatThread(decodeChatThreadId(threadId)).then(noteRefusal),
      onReopenThread: (threadId) =>
        void actions.reopenChatThread(decodeChatThreadId(threadId)).then(noteRefusal),
      onSnoozeThread: (threadId, until) =>
        void actions.snoozeChatThread(decodeChatThreadId(threadId), until).then(noteRefusal),
      onWakeThread: (threadId) =>
        void actions.wakeChatThread(decodeChatThreadId(threadId)).then(noteRefusal),
    },
    // Work has no controller of its own for thread metadata: a rest command
    // goes straight to the client with the version the sidebar last saw.
    work: {
      onCompleteThread: (threadId) =>
        void actions.runWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "complete-work-thread",
          threadId: decodeWorkThreadId(threadId),
          expectedVersion,
        })),
      onReopenThread: (threadId) =>
        void actions.runWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "reopen-work-thread",
          threadId: decodeWorkThreadId(threadId),
          expectedVersion,
        })),
      onSnoozeThread: (threadId, until) =>
        void actions.runWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "snooze-work-thread",
          threadId: decodeWorkThreadId(threadId),
          expectedVersion,
          until: decodeUtcTimestamp(until),
        })),
      onWakeThread: (threadId) =>
        void actions.runWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "wake-work-thread",
          threadId: decodeWorkThreadId(threadId),
          expectedVersion,
        })),
    },
  };
}

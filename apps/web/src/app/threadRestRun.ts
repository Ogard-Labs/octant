import { decodeUtcTimestamp, decodeWorkThreadId } from "@octant/contracts";
import { decodeChatThreadId } from "@octant/contracts/chat";
import { decodeCodeThreadId } from "@octant/contracts/code";
import type { OctantMode } from "@octant/contracts/modes";
import type {
  ThreadRestChange,
  ThreadRestRow,
  ThreadRestShellActions,
} from "./threadRestRowActions";
import { threadRestUndoStore } from "./threadRestUndoStore";

type RestOutcome =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly message: string };

const DONE_TITLES: Readonly<Record<ThreadRestChange["kind"], string>> = {
  pin: "Pinned",
  unpin: "Unpinned",
  settle: "Settled",
  "mark-done": "Marked done",
  reopen: "Reopened",
  snooze: "Snoozed",
  wake: "Woken",
};

/**
 * The change that takes another back. It reads the row as it was before the
 * change: a reopened thread marked Done is marked Done again rather than only
 * settled, and a woken thread goes back to sleep until its old wake time. A
 * wake time already past leaves the thread awake, so nothing is sent.
 */
export function inverseThreadRestChange(
  change: ThreadRestChange,
  before: ThreadRestRow | undefined,
  now: Date,
): ThreadRestChange | { readonly kind: "none"; readonly reason: string } {
  switch (change.kind) {
    case "pin":
      return { kind: "unpin" };
    case "unpin":
      return { kind: "pin" };
    case "settle":
    case "mark-done":
      return { kind: "reopen" };
    case "reopen":
      return before?.markedDone === true || before?.workDone === true
        ? { kind: "mark-done" }
        : { kind: "settle" };
    case "snooze":
      return { kind: "wake" };
    case "wake": {
      const until = before?.snooze?.until;
      if (until === undefined || Date.parse(until) <= now.getTime()) {
        return { kind: "none", reason: "Its snooze has already ended, so it stays awake." };
      }
      return { kind: "snooze", until };
    }
  }
}

function senders(actions: ThreadRestShellActions) {
  const sendCode = async (threadId: string, change: ThreadRestChange): Promise<RestOutcome> => {
    const id = decodeCodeThreadId(threadId);
    switch (change.kind) {
      case "pin":
      case "unpin":
        return actions.setCodeThreadPin(id, change.kind === "pin");
      case "settle":
        return actions.completeCodeThread(id);
      case "mark-done":
        return actions.markCodeThreadDone(id);
      case "reopen":
        return actions.reopenCodeThread(id);
      case "snooze":
        return actions.snoozeCodeThread(id, change.until);
      case "wake":
        return actions.wakeCodeThread(id);
    }
  };
  const sendChat = async (threadId: string, change: ThreadRestChange): Promise<RestOutcome> => {
    const id = decodeChatThreadId(threadId);
    switch (change.kind) {
      case "settle":
        return actions.completeChatThread(id);
      case "reopen":
        return actions.reopenChatThread(id);
      case "snooze":
        return actions.snoozeChatThread(id, change.until);
      case "wake":
        return actions.wakeChatThread(id);
      case "pin":
      case "unpin":
      case "mark-done":
        return { status: "refused", message: "A Chat thread has no pin or Done mark." };
    }
  };
  // Work has no controller of its own for thread metadata: a rest command
  // goes straight to the client with the version the sidebar last saw.
  // Each change names its own command; Work has no list pin, so a pin is
  // refused here rather than sent as some other command.
  const sendWork = async (threadId: string, change: ThreadRestChange): Promise<RestOutcome> => {
    const workThreadId = decodeWorkThreadId(threadId);
    switch (change.kind) {
      case "pin":
      case "unpin":
        return { status: "refused", message: "A Work thread cannot be pinned." };
      case "settle":
        return actions.tryWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "complete-work-thread",
          threadId: workThreadId,
          expectedVersion,
        }));
      case "reopen":
        return actions.tryWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "reopen-work-thread",
          threadId: workThreadId,
          expectedVersion,
        }));
      // Marks Done again the way the Done banner does, naming the thread as
      // its delivery target; the host checks that against its own record.
      case "mark-done":
        return actions.tryWorkRestCommand(threadId, (expectedVersion, thread) => ({
          kind: "confirm-work-thread-completion",
          threadId: workThreadId,
          expectedVersion,
          deliveryTarget: thread.title,
        }));
      case "snooze":
        return actions.tryWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "snooze-work-thread",
          threadId: workThreadId,
          expectedVersion,
          until: decodeUtcTimestamp(change.until),
        }));
      case "wake":
        return actions.tryWorkRestCommand(threadId, (expectedVersion) => ({
          kind: "wake-work-thread",
          threadId: workThreadId,
          expectedVersion,
        }));
    }
  };
  const senders: Record<
    OctantMode,
    (threadId: string, change: ThreadRestChange) => Promise<RestOutcome>
  > = { code: sendCode, chat: sendChat, work: sendWork };

  const send: Record<
    OctantMode,
    (threadId: string, change: ThreadRestChange) => Promise<RestOutcome>
  > = { code: sendCode, chat: sendChat, work: sendWork };
  return send;
}

/**
 * Sends one sidebar change through its mode's own command and, once the host
 * accepts it, offers Undo: the inverse change, sent as a new request.
 */
export function runThreadRestChange(input: {
  readonly actions: ThreadRestShellActions;
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly change: ThreadRestChange;
  readonly sequence: number;
  readonly before: ThreadRestRow | undefined;
}): Promise<void> {
  const { actions, mode, threadId, change, before } = input;
  const send = senders(actions)[mode];
  const noteRefusal = (outcome: RestOutcome): void => {
    if (outcome.status === "refused") actions.setThreadExportNotice(outcome.message);
  };
  return send(threadId, change).then((outcome) => {
    noteRefusal(outcome);
    if (outcome.status !== "ok") return;
    threadRestUndoStore.offer({
      sequence: input.sequence,
      title: DONE_TITLES[change.kind],
      detail: before?.title ?? "The thread",
      undo: () => {
        const inverse = inverseThreadRestChange(change, before, new Date());
        if (inverse.kind === "none") {
          actions.setThreadExportNotice(inverse.reason);
          return;
        }
        void send(threadId, inverse).then(noteRefusal);
      },
    });
  });
}

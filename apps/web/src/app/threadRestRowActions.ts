import type { OctantMode } from "@octant/contracts/modes";
import type { ThreadRowActions } from "../projects/ThreadRowMenu";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import type { ShellActions } from "./shellActions";
import { couldNotLoad } from "../shell/windowNotice";

export type ThreadRestRowActions = Pick<
  ThreadRowActions,
  | "onCompleteThread"
  | "onReopenThread"
  | "onSnoozeThread"
  | "onWakeThread"
  | "onPinThread"
  | "onMarkThreadDone"
>;

/** A sidebar state change, as the person asked for it or as its Undo sends it. */
export type ThreadRestChange =
  | { readonly kind: "pin" | "unpin" | "settle" | "mark-done" | "reopen" | "wake" }
  | { readonly kind: "snooze"; readonly until: string };

/** The row a change was made from, read before the change is sent. */
export type ThreadRestRow = Pick<
  ChatThreadNavigationItem,
  "title" | "markedDone" | "workDone" | "completedAt" | "snooze" | "pinned"
>;

/** A five-second offer to take back the change the host just accepted. */
export interface ThreadRestUndoNotice {
  /**
   * When the change was asked for, in the order the person made them. Replies
   * can arrive out of that order, so a notice older than one already shown is
   * dropped rather than replacing the newer change's Undo.
   */
  readonly sequence: number;
  readonly title: string;
  readonly detail: string;
  readonly undo: () => void;
}

let lastRestChange = 0;

/** The number of the newest sidebar change asked for in this window. */
export function latestThreadRestChange(): number {
  return lastRestChange;
}

export type ThreadRestShellActions = Pick<
  ShellActions,
  | "completeChatThread"
  | "reopenChatThread"
  | "snoozeChatThread"
  | "wakeChatThread"
  | "completeCodeThread"
  | "reopenCodeThread"
  | "snoozeCodeThread"
  | "wakeCodeThread"
  | "setCodeThreadPin"
  | "markCodeThreadDone"
  | "tryWorkRestCommand"
  | "setThreadExportNotice"
  | "threadRestRow"
>;

/**
 * Settle, reopen, snooze, wake, pin and Mark done for each mode's threads. The
 * sidebar row menu, a row dragged within the sidebar and the command palette
 * all use these same handlers, so a host refusal reaches the person the same
 * way from each: none has anywhere of its own to report one, so it reads where
 * thread notices already appear. Every change the host accepts offers Undo,
 * which sends the inverse command as a new request; the host may refuse that
 * too, and its sentence shows.
 *
 * Each change is numbered and its row read as it is made; sending it, and the
 * Undo, load with the first change (`threadRestRun`), so the window's first
 * load does not carry them. List pin and Mark done are Code-only.
 */
export function threadRestRowActions(
  actions: ThreadRestShellActions,
): Record<OctantMode, ThreadRestRowActions> {
  const run = (mode: OctantMode, threadId: string, change: ThreadRestChange): void => {
    lastRestChange += 1;
    const sequence = lastRestChange;
    const before = actions.threadRestRow(mode, threadId);
    void import("./threadRestRun").then(
      ({ runThreadRestChange }) =>
        runThreadRestChange({ actions, mode, threadId, change, sequence, before }),
      () => actions.setThreadExportNotice(couldNotLoad("this change to the thread")),
    );
  };
  const rowActions = (mode: OctantMode): ThreadRestRowActions => ({
    onCompleteThread: (threadId) => run(mode, threadId, { kind: "settle" }),
    onReopenThread: (threadId) => run(mode, threadId, { kind: "reopen" }),
    onSnoozeThread: (threadId, until) => run(mode, threadId, { kind: "snooze", until }),
    onWakeThread: (threadId) => run(mode, threadId, { kind: "wake" }),
  });
  return {
    code: {
      ...rowActions("code"),
      onPinThread: (threadId, pinned) => run("code", threadId, { kind: pinned ? "pin" : "unpin" }),
      onMarkThreadDone: (threadId) => run("code", threadId, { kind: "mark-done" }),
    },
    chat: rowActions("chat"),
    work: rowActions("work"),
  };
}

import { decodeCodeThreadId } from "@octant/contracts/code";
import type { CodeThreadRestOutcome } from "../code/useCodeController";
import type { ThreadCoordinatorActions } from "../projects/ThreadRowMenu";
import type { ShellActions } from "./shellActions";

/**
 * Make coordinator, Stop coordinating, and both wake switches for a Code
 * thread's menus. The sidebar row menu and the thread pane's header menu use
 * these same handlers, so a host refusal (a worker, a fifth coordinator, a
 * window that is not local) reaches the person the same way from either.
 */
export function codeThreadCoordinatorActions(
  actions: Pick<
    ShellActions,
    | "setCodeThreadCoordinator"
    | "editCodeThreadCoordinatorBounds"
    | "setCodeThreadCoordinatorWake"
    | "setCodeThreadMessageWake"
    | "setCodeThreadRestartContinuation"
    | "setThreadExportNotice"
  >,
): Required<ThreadCoordinatorActions> {
  const noteRefusal = (outcome: CodeThreadRestOutcome): void => {
    if (outcome.status === "refused") actions.setThreadExportNotice(outcome.message);
  };
  return {
    onSetCoordinator: (threadId, coordinator, workerLevel) =>
      void actions
        .setCodeThreadCoordinator(decodeCodeThreadId(threadId), coordinator, workerLevel)
        .then(noteRefusal),
    onEditCoordinatorBounds: (threadId) =>
      actions.editCodeThreadCoordinatorBounds(decodeCodeThreadId(threadId)),
    onSetMessageWake: (threadId, wake) =>
      void actions.setCodeThreadMessageWake(decodeCodeThreadId(threadId), wake).then(noteRefusal),
    onSetCoordinatorWake: (threadId, wake) =>
      void actions
        .setCodeThreadCoordinatorWake(decodeCodeThreadId(threadId), wake)
        .then(noteRefusal),
    onSetRestartContinuation: (threadId, continueAfterRestart) =>
      void actions
        .setCodeThreadRestartContinuation(decodeCodeThreadId(threadId), continueAfterRestart)
        .then(noteRefusal),
  };
}

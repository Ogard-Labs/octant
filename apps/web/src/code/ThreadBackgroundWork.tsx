import { Terminal } from "../ui/icons";
import type { CodeLiveTask, CodeThreadId } from "@octant/contracts";
import type { CodeThreadPullRequestWait } from "@octant/contracts/code-project-pull-request-switches";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantButton } from "../ui/base/OctantButton";
import type { ThreadSessionClient } from "./codeSessionClient";
import type { ThreadWaitClient } from "./threadWaitClient";
import { waitKey, waitLabel, waitRepository } from "./threadWaitCopy";
import "./thread-background-work.css";

const ThreadBackgroundWorkDetails = lazy(() =>
  import("./ThreadBackgroundWorkDetails").then((module) => ({
    default: module.ThreadBackgroundWorkDetails,
  })),
);

/**
 * What an idle thread still has going, above the composer: the background
 * tasks (a dev server, a watch) its provider session runs after the turn that
 * started them completed, and in Code the pull requests it waits on. Nothing
 * shows while neither is there, or while a turn holds the thread: the turn
 * shows its own work. Work and Code threads both show it, each reading its own
 * mode's host routes.
 */
export function ThreadBackgroundWork<Id extends string>(props: {
  readonly threadId: Id;
  readonly client: ThreadSessionClient<Id> | undefined;
  /** A Code thread's pull-request waits; absent where a thread has none. */
  readonly pullRequests?:
    | {
        readonly threadId: CodeThreadId;
        readonly client: ThreadWaitClient | undefined;
        readonly turnRunning: boolean;
        /** Not active, or settled: the host then lists no wait. */
        readonly resting: boolean;
      }
    | undefined;
}) {
  const { threadId, client } = props;
  const waitClient = props.pullRequests?.client;
  const waitThreadId = props.pullRequests?.threadId;
  const turnRunning = props.pullRequests?.turnRunning ?? false;
  const resting = props.pullRequests?.resting ?? false;
  const [tasks, setTasks] = useState<ReadonlyArray<CodeLiveTask>>([]);
  const [waits, setWaits] = useState<ReadonlyArray<CodeThreadPullRequestWait>>([]);
  const [stopping, setStopping] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const section = useRef<HTMLElement>(null);
  // Each source's answers apply in the order they were asked, so a slow poll
  // asked before a Stop cannot bring the stopped entry back.
  const asked = useRef({ tasks: 0, waits: 0 });
  const activeThread = useRef(String(threadId));
  activeThread.current = String(threadId);

  useEffect(() => {
    setTasks([]);
    setWaits([]);
    setMessage(undefined);
    setStopping(undefined);
    setDetailsOpen(false);
  }, [threadId]);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const key = String(threadId);
      const current = () => signal?.aborted !== true && activeThread.current === key;
      const tasksAsk = ++asked.current.tasks;
      const waitsAsk = ++asked.current.waits;
      // One source failing keeps its last answer and never hides the other's.
      await Promise.allSettled([
        client?.liveTasks(threadId).then((live) => {
          if (current() && tasksAsk === asked.current.tasks)
            setTasks(live.turnRunning ? [] : live.tasks);
        }),
        waitThreadId === undefined
          ? undefined
          : waitClient?.waits(waitThreadId).then((next) => {
              if (current() && waitsAsk === asked.current.waits) setWaits(next);
            }),
      ]);
    },
    [client, threadId, waitClient, waitThreadId],
  );
  const followUps = useThreadActivityRevision("threadFollowUps");
  // A turn ending and the thread being settled change the answers too, and
  // raise no follow-up notice of their own. Not the Code navigation notice:
  // it arrives for every live step of any Code turn.
  const revision = (followUps ?? 0) * 4 + (turnRunning ? 2 : 0) + (resting ? 1 : 0);
  useVisibleRefresh(
    refresh,
    revision,
    followUps === undefined ? 15_000 : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const stop = async (target: string, act: () => Promise<unknown>, failure: string) => {
    // A stop that ends after the person moved to another thread says nothing
    // there: its failure and its busy state belong to the thread it was for.
    const key = String(threadId);
    const here = () => activeThread.current === key;
    setStopping(target);
    setMessage(undefined);
    try {
      await act();
      await refresh();
    } catch {
      if (here()) setMessage(failure);
    } finally {
      if (here()) setStopping(undefined);
    }
  };
  const closeDetails = () => {
    // With nothing left the row goes with the dialog, taking Details with it,
    // so focus goes to the composer the row sat in rather than to the page.
    const composer =
      tasks.length + (turnRunning ? 0 : waits.length) === 0
        ? section.current
            ?.closest(".composer-frame")
            ?.querySelector<HTMLElement>("textarea, [contenteditable='true']")
        : undefined;
    setDetailsOpen(false);
    if (composer !== undefined && composer !== null)
      queueMicrotask(() => composer.focus({ preventScroll: true }));
  };
  const stopTasks = () =>
    client === undefined
      ? undefined
      : void stop(
          "tasks",
          () => client.stopLiveTasks(threadId),
          "This computer could not stop these tasks. Try again.",
        );
  const stopWait = (wait: CodeThreadPullRequestWait) =>
    waitClient === undefined || waitThreadId === undefined
      ? undefined
      : void stop(
          waitKey(wait),
          () => waitClient.stop(waitThreadId, wait),
          "This computer could not stop this. Try again.",
        );

  const shownWaits = turnRunning ? [] : waits;
  const shown = tasks.length + shownWaits.length > 0;
  if (!shown && message === undefined && !detailsOpen) return null;

  // The row's own Stop means one thing only: every task, which end together
  // with their session, or the single pull request. Anything else is stopped
  // by name in Details.
  const onlyWait = tasks.length === 0 && shownWaits.length === 1 ? shownWaits[0] : undefined;
  const onlyTasks = tasks.length > 0 && shownWaits.length === 0;
  return (
    <section aria-label="Background work" className="thread-background-work" ref={section}>
      {shown ? (
        <div className="thread-background-work__row">
          <Terminal aria-hidden="true" size={14} className="thread-background-work__icon" />
          <div className="thread-background-work__summary">
            <span className="thread-background-work__state">
              {backgroundSummary(tasks.length, shownWaits)}
            </span>
            {/* One entry reads after the state, set off by a dot ("Waiting ·
                Watching pull request"); several read as a muted list after the
                count. */}
            <ul
              className={`thread-background-work__list${
                tasks.length + shownWaits.length === 1 ? " thread-background-work__list--one" : ""
              }`}
            >
              {tasks.map((task) => (
                <li
                  key={task.taskId}
                  className="thread-background-work__command"
                  title={task.description ?? task.taskId}
                >
                  {task.description ?? "Background task"}
                </li>
              ))}
              {shownWaits.map((wait) => (
                <li key={waitKey(wait)} title={`${waitLabel(wait)} in ${waitRepository(wait)}`}>
                  {waitLabel(wait)}
                </li>
              ))}
            </ul>
          </div>
          <div className="thread-background-work__actions">
            <OctantButton
              ref={detailsButton}
              type="button"
              variant="bare"
              className="thread-background-work__action"
              aria-haspopup="dialog"
              aria-label="Show background work details"
              onClick={() => setDetailsOpen(true)}
            >
              Details
            </OctantButton>
            {onlyTasks ? (
              <OctantButton
                type="button"
                variant="bare"
                className="thread-background-work__action"
                disabled={stopping !== undefined}
                aria-label="Stop the live tasks"
                onClick={stopTasks}
              >
                Stop
              </OctantButton>
            ) : onlyWait === undefined ? null : (
              <OctantButton
                type="button"
                variant="bare"
                className="thread-background-work__action"
                disabled={stopping !== undefined}
                aria-label={`Stop: ${waitLabel(onlyWait)}`}
                onClick={() => stopWait(onlyWait)}
              >
                Stop
              </OctantButton>
            )}
          </div>
        </div>
      ) : null}
      {message === undefined || detailsOpen ? null : (
        <p className="thread-background-work__message" role="status">
          {message}
        </p>
      )}
      {detailsOpen ? (
        <Suspense fallback={null}>
          <ThreadBackgroundWorkDetails
            tasks={tasks}
            waits={shownWaits}
            stopping={stopping}
            message={message}
            restoreFocus={detailsButton}
            onStopTasks={stopTasks}
            onStopWait={stopWait}
            onClose={closeDetails}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${String(n)} ${many}`;
}

/** The row's lead words: what the thread is doing, counted when there is more than one. */
function backgroundSummary(tasks: number, waits: ReadonlyArray<CodeThreadPullRequestWait>): string {
  const paused = waits.length > 0 && waits.every((wait) => wait.paused);
  if (waits.length === 0)
    return tasks === 1 ? "Running" : `Running ${count(tasks, "task", "tasks")}`;
  const pullRequests = count(waits.length, "pull request", "pull requests");
  if (tasks > 0)
    return `Running ${count(tasks, "task", "tasks")}, ${paused ? "paused" : "waiting"} on ${pullRequests}`;
  if (waits.length === 1) return paused ? "Paused" : "Waiting";
  return `${paused ? "Paused" : "Waiting"} on ${pullRequests}`;
}

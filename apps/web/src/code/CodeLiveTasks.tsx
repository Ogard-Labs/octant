import { Activity } from "../ui/icons";
import type { CodeLiveTask, CodeThreadId } from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantButton } from "../ui/base/OctantButton";
import { createCodeSessionClient, type CodeSessionClient } from "./codeSessionClient";
import "./code-live-tasks.css";

/**
 * The background tasks (a dev server, a watch) the thread's provider session
 * still runs after the turn that started them completed, above the composer,
 * with Stop. Nothing shows while none runs. While a turn holds the session the
 * turn itself shows them, so the list waits until it settles.
 */
export function CodeLiveTasks(props: {
  readonly threadId: CodeThreadId;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  readonly client?: CodeSessionClient | undefined;
}) {
  const { threadId, serverUrl, windowCapability } = props;
  const client = useMemo(
    () =>
      props.client ??
      (serverUrl === undefined || windowCapability === undefined
        ? undefined
        : createCodeSessionClient({ serverUrl, windowCapability })),
    [props.client, serverUrl, windowCapability],
  );
  const [tasks, setTasks] = useState<ReadonlyArray<CodeLiveTask>>([]);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState<string>();
  const activeThread = useRef(String(threadId));
  activeThread.current = String(threadId);

  useEffect(() => {
    setTasks([]);
    setMessage(undefined);
    setStopping(false);
  }, [threadId]);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (client === undefined) return;
      const key = String(threadId);
      const live = await client.liveTasks(threadId);
      if (signal?.aborted === true || activeThread.current !== key) return;
      setTasks(live.turnRunning ? [] : live.tasks);
    },
    [client, threadId],
  );
  const revision = useThreadActivityRevision("threadFollowUps");
  useVisibleRefresh(
    refresh,
    revision,
    revision === undefined ? 15_000 : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const stop = async () => {
    if (client === undefined) return;
    setStopping(true);
    setMessage(undefined);
    try {
      await client.stopLiveTasks(threadId);
      await refresh();
    } catch {
      setMessage("The host could not stop these tasks. Try again.");
    } finally {
      setStopping(false);
    }
  };

  if (tasks.length === 0 && message === undefined) return null;
  return (
    <section aria-label="Live tasks" className="code-live-tasks">
      <div className="code-live-tasks__row">
        <Activity aria-hidden="true" size={14} className="code-live-tasks__icon" />
        <ul className="code-live-tasks__list">
          {tasks.map((task) => (
            <li key={task.taskId} title={task.description ?? task.taskId}>
              {task.description ?? "Background task"}
            </li>
          ))}
        </ul>
        <span className="code-live-tasks__state">
          {tasks.length === 1 ? "Running" : `${String(tasks.length)} running`}
        </span>
        <OctantButton
          type="button"
          size="sm"
          variant="ghost"
          disabled={stopping || tasks.length === 0}
          aria-label="Stop the live tasks"
          onClick={() => void stop()}
        >
          Stop
        </OctantButton>
      </div>
      {message === undefined ? null : (
        <p className="code-live-tasks__message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

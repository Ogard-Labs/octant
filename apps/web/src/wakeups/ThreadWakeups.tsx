import { AlarmClock } from "lucide-react";
import type { ThreadWakeup, ThreadWakeupMode } from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantButton } from "../ui/base/OctantButton";
import { createThreadWakeupClient, type ThreadWakeupClient } from "./threadWakeupClient";
import "./thread-wakeups.css";

const fireTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * The wake-ups the thread's agent scheduled, above its composer: when each
 * fires next, with Cancel; one that came due while Octant was not running
 * says it was missed and waits for Run now or Cancel. It shows nothing while the
 * thread has none.
 */
export function ThreadWakeups(props: {
  readonly mode: ThreadWakeupMode;
  readonly threadId: string;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  readonly client?: ThreadWakeupClient | undefined;
}) {
  const { mode, threadId, serverUrl, windowCapability } = props;
  const client = useMemo(
    () =>
      props.client ??
      (serverUrl === undefined || windowCapability === undefined
        ? undefined
        : createThreadWakeupClient({ serverUrl, windowCapability })),
    [props.client, serverUrl, windowCapability],
  );
  const [wakeups, setWakeups] = useState<ReadonlyArray<ThreadWakeup>>([]);
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const threadKey = `${mode}:${threadId}`;
  const activeKey = useRef(threadKey);
  activeKey.current = threadKey;

  useEffect(() => {
    setWakeups([]);
    setMessage(undefined);
    setBusyId(undefined);
  }, [threadKey]);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (client === undefined) return;
      const key = threadKey;
      const next = await client.list(mode, threadId);
      if (signal?.aborted === true || activeKey.current !== key) return;
      setWakeups(next);
    },
    [client, mode, threadId, threadKey],
  );
  const revision = useThreadActivityRevision("threadFollowUps");
  useVisibleRefresh(
    refresh,
    revision,
    revision === undefined ? 15_000 : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const act = async (wakeup: ThreadWakeup, kind: "cancel" | "run") => {
    if (client === undefined) return;
    setBusyId(String(wakeup.id));
    setMessage(undefined);
    try {
      const result = await client.execute({
        kind: kind === "cancel" ? "cancel-thread-wakeup" : "run-missed-thread-wakeup",
        wakeupId: wakeup.id,
      });
      if (result.kind === "thread-wakeup-refused") setMessage(result.message);
      await refresh();
    } catch {
      setMessage("The host could not change this wake-up. Try again.");
    } finally {
      setBusyId(undefined);
    }
  };

  if (wakeups.length === 0 && message === undefined) return null;
  return (
    <section aria-label="Scheduled wake-ups" className="thread-wakeups">
      <ul>
        {wakeups.map((wakeup) => {
          const missed = wakeup.status === "missed";
          const busy = busyId === String(wakeup.id);
          return (
            <li key={String(wakeup.id)} className="thread-wakeups__row" data-status={wakeup.status}>
              <AlarmClock aria-hidden="true" size={14} className="thread-wakeups__icon" />
              <div className="thread-wakeups__text">
                <span className="thread-wakeups__when">
                  {missed
                    ? `Missed ${fireTime(wakeup.nextFireAt)} · Octant was not running`
                    : `Wakes ${fireTime(wakeup.nextFireAt)}`}
                </span>
                <span className="thread-wakeups__prompt" title={wakeup.prompt}>
                  {wakeup.prompt}
                </span>
              </div>
              <div className="thread-wakeups__actions">
                {missed ? (
                  <OctantButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void act(wakeup, "run")}
                  >
                    Run now
                  </OctantButton>
                ) : null}
                <OctantButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Cancel the wake-up: ${wakeup.prompt}`}
                  onClick={() => void act(wakeup, "cancel")}
                >
                  Cancel
                </OctantButton>
              </div>
            </li>
          );
        })}
      </ul>
      {message === undefined ? null : (
        <p className="thread-wakeups__message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

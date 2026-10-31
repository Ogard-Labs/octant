import type { AutomationClient } from "@octant/client-runtime";
import type { AutomationSummary } from "@octant/contracts/automation";
import { CalendarClock } from "lucide-react";
import { useCallback, useState } from "react";
import { automationLifecycleLabel } from "../automation/automationCenterModel";
import { routineScheduleLine } from "../automation/routinePresentation";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { EnvironmentGroup } from "./EnvironmentGroup";

const IDLE_ROUTINES_POLL_MS = 5_000;
const ROUTINE_READ_LIMIT = 100;

/**
 * The routines this thread's agent proposed and the person confirmed, with
 * the two things a person wants without leaving the thread: pause or resume
 * it, and open it in the Automation Center.
 *
 * A thread that created none shows nothing at all, so the row never suggests a
 * feature the thread did not use. The read lives outside the collapsible group
 * because the group mounts its body only while open, and a closed row could
 * otherwise never learn it has anything to show.
 */
export function EnvironmentRoutines(props: {
  readonly client: AutomationClient;
  readonly threadId: string;
  readonly projectId: string;
  readonly mode: "work" | "code";
  readonly onOpenRoutine?: (automationId: string) => void;
}) {
  const { client, threadId, projectId, mode } = props;
  const [routines, setRoutines] = useState<ReadonlyArray<AutomationSummary>>([]);
  const [message, setMessage] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const revision = useThreadActivityRevision("toolApprovals");

  const read = useCallback(
    async (signal?: AbortSignal) => {
      const listed = await client.list({ mode, projectId, limit: ROUTINE_READ_LIMIT }, signal);
      if (signal?.aborted === true) return;
      const next = listed.items.filter(
        (item) => String(item.originThreadId) === threadId && item.lifecycle !== "archived",
      );
      setRoutines((current) => (samePollingData(current, next) ? current : next));
    },
    [client, mode, projectId, threadId],
  );
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        await read(signal);
      } catch {
        // A failed read keeps the last answer; nothing is shown until one succeeds.
      }
    },
    [read],
  );
  useVisibleRefresh(
    refresh,
    revision,
    revision === undefined ? IDLE_ROUTINES_POLL_MS : THREAD_ACTIVITY_RECOVERY_MS,
  );

  async function change(summary: AutomationSummary) {
    if (busyId !== undefined) return;
    setBusyId(String(summary.id));
    setMessage(undefined);
    try {
      const result = await client.execute({
        kind: summary.lifecycle === "paused" ? "resume-automation" : "pause-automation",
        automationId: summary.id,
        expectedVersion: summary.version,
      });
      if (result.kind === "automation-command-failed") {
        setMessage(result.message);
      } else {
        await read();
      }
    } catch {
      setMessage("The change did not reach the host. Try again.");
    } finally {
      setBusyId(undefined);
    }
  }

  if (routines.length === 0) return null;
  const nowIso = new Date().toISOString();
  return (
    <EnvironmentGroup
      icon={CalendarClock}
      summary={`${String(routines.length)} ${routines.length === 1 ? "routine" : "routines"}`}
      title="Routines"
    >
      <ul className="environment-routines__list">
        {routines.map((summary) => {
          const schedule = routineScheduleLine(summary.trigger, summary.nextDueAt, nowIso);
          const paused = summary.lifecycle === "paused";
          return (
            <li className="environment-routine" key={String(summary.id)}>
              <div className="environment-routine__head">
                <span className="environment-routine__name">{summary.displayName}</span>
                <span className="environment-routines__state">
                  {summary.lifecycle === "enabled"
                    ? "Active"
                    : paused
                      ? "Paused"
                      : automationLifecycleLabel(summary.lifecycle)}
                </span>
              </div>
              <p className="environment-routine__schedule">
                {summary.trigger.kind === "weekly-local"
                  ? `${schedule} (${summary.trigger.timeZone})`
                  : schedule}
              </p>
              <div className="environment-routine__actions">
                {props.onOpenRoutine === undefined ? null : (
                  <OctantButton
                    className="window-no-drag"
                    onClick={() => props.onOpenRoutine?.(String(summary.id))}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Open in Automation Center
                  </OctantButton>
                )}
                {summary.lifecycle === "enabled" || paused ? (
                  <OctantButton
                    className="window-no-drag"
                    disabled={busyId !== undefined}
                    onClick={() => void change(summary)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {paused ? "Resume" : "Pause"}
                  </OctantButton>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {message === undefined ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
    </EnvironmentGroup>
  );
}

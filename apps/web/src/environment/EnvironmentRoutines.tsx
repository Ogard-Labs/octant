import "../styles/environment-details.css";
import "../styles/automation.css";
import type { AutomationClient } from "@octant/client-runtime";
import type {
  AutomationCommandResult,
  AutomationSummary,
  AutomationThreadRoutineRequest,
} from "@octant/contracts/automation";
import { CalendarClock, MoreHorizontal, Plus } from "../ui/icons";
import { useCallback, useState } from "react";
import { automationLifecycleLabel } from "../automation/automationCenterModel";
import { followUpWhenLabel, routineScheduleLine } from "../automation/routinePresentation";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantMenu } from "../ui/base/OctantMenu";
import { EnvironmentGroup } from "./EnvironmentGroup";
import { FollowUpPicker, scheduledAtOf, type Editing } from "./EnvironmentFollowUpPicker";
import { EnvironmentRoutineForm } from "./EnvironmentRoutineForm";

const IDLE_ROUTINES_POLL_MS = 5_000;
const ROUTINE_PAGE_LIMIT = 100;
/**
 * A Project's whole list is read, page by page, because the host orders it by
 * last change and counts archived routines too: one page let a busy Project's
 * older active routine drop out of its own thread's row. The bound keeps a
 * pathological Project from turning one poll into an unbounded walk.
 */
const MAX_ROUTINE_PAGES = 10;
/** Past this many the row shows the first few and a Show all. */
const COLLAPSED_ROUTINE_COUNT = 5;

type Place = "follow-up-here" | "from-here" | "follow-up-elsewhere" | "project";
type Opened = { readonly kind: "follow-up"; readonly editing: Editing } | { readonly kind: "new" };

/** Where a routine stands to this thread: its own follow-ups first, then what it created. */
function placeOf(summary: AutomationSummary, threadId: string): Place {
  const here = String(summary.originThreadId) === threadId;
  if (summary.targetPolicy === "same-thread")
    return here ? "follow-up-here" : "follow-up-elsewhere";
  return here ? "from-here" : "project";
}

const PLACE_ORDER: Record<Place, number> = {
  "follow-up-here": 0,
  "from-here": 1,
  "follow-up-elsewhere": 2,
  project: 2,
};

const PLACE_LABEL: Record<Place, string | undefined> = {
  "follow-up-here": "Follow-up here",
  "from-here": "From this thread",
  "follow-up-elsewhere": "Follow-up in another thread",
  project: undefined,
};

/** The routines this row lists, in the order it lists them. */
export function arrangeThreadRoutines(
  items: ReadonlyArray<AutomationSummary>,
  threadId: string,
): ReadonlyArray<AutomationSummary> {
  return items
    .filter(
      (item) =>
        (item.lifecycle === "enabled" || item.lifecycle === "paused") &&
        // A follow-up whose one run has started is no longer still to come;
        // the routine ends once that run settles.
        !(item.targetPolicy === "same-thread" && item.latestRunLifecycle !== undefined),
    )
    .map((item, index) => ({ item, index, place: PLACE_ORDER[placeOf(item, threadId)] }))
    .sort(
      (left, right) =>
        left.place - right.place ||
        dueOrder(left.item) - dueOrder(right.item) ||
        left.index - right.index,
    )
    .map((entry) => entry.item);
}

function dueOrder(summary: AutomationSummary): number {
  return summary.nextDueAt === null ? Number.POSITIVE_INFINITY : Date.parse(summary.nextDueAt);
}

/**
 * Every active and paused routine of this thread's Project, so a person sees
 * from the thread what already runs in its folder: this thread's own
 * follow-ups first, then the routines it created, then the rest. Each one can
 * be paused, resumed, or opened in Automations from its "…" menu, and a follow-up here
 * moved or cancelled. The row is always offered in a Work or Code thread,
 * because both ways to create one start here: Follow up later, and New
 * routine, which the host builds from this thread's Project and mode.
 *
 * The read lives outside the collapsible group because the group mounts its
 * body only while open, and a closed row could otherwise never show its count.
 */
export function EnvironmentRoutines(props: {
  readonly client: AutomationClient;
  readonly threadId: string;
  readonly projectId: string;
  readonly mode: "work" | "code";
  readonly onOpenRoutine?: (automationId: string) => void;
  /**
   * Offers "Set a goal…" in the "+" menu. The Work panel passes it while its
   * thread has no goal, so the goal group appears only once there is one.
   */
  readonly onSetGoal?: () => void;
}) {
  const { client, threadId, projectId, mode } = props;
  const [routines, setRoutines] = useState<ReadonlyArray<AutomationSummary>>([]);
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState<Opened>();
  const [showAll, setShowAll] = useState(false);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const revision = useThreadActivityRevision("toolApprovals");

  const read = useCallback(
    async (signal?: AbortSignal) => {
      const items: AutomationSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_ROUTINE_PAGES; page += 1) {
        const listed = await client.list(
          {
            mode,
            projectId,
            limit: ROUTINE_PAGE_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          },
          signal,
        );
        if (signal?.aborted === true) return;
        items.push(...listed.items);
        if (listed.nextCursor === undefined || listed.nextCursor === null) break;
        cursor = listed.nextCursor;
      }
      const next = arrangeThreadRoutines(items, threadId);
      setRoutines((current) => (samePollingData(current, next) ? current : next));
    },
    [client, mode, projectId, threadId],
  );
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        await read(signal);
      } catch {
        // A failed read keeps the last answer; nothing changes until one succeeds.
      }
    },
    [read],
  );
  useVisibleRefresh(
    refresh,
    revision,
    revision === undefined ? IDLE_ROUTINES_POLL_MS : THREAD_ACTIVITY_RECOVERY_MS,
  );

  async function act(run: () => Promise<AutomationCommandResult>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await run();
      if (result.kind === "automation-command-failed") {
        setMessage(result.message);
        return false;
      }
      await read();
      return true;
    } catch {
      setMessage("The change did not reach the host. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitFollowUp(editing: Editing, scheduledAt: string, taskPrompt: string) {
    const done = await act(() =>
      editing.kind === "new"
        ? client.followUp({
            kind: "schedule-follow-up",
            threadId: threadId as never,
            mode,
            projectId: projectId as never,
            scheduledAt: scheduledAt as never,
            taskPrompt,
          })
        : client.followUp({
            kind: "reschedule-follow-up",
            automationId: editing.summary.id,
            expectedVersion: editing.summary.version,
            scheduledAt: scheduledAt as never,
          }),
    );
    if (done) setOpened(undefined);
  }

  async function submitRoutine(request: AutomationThreadRoutineRequest) {
    if (await act(() => client.createThreadRoutine(request))) setOpened(undefined);
  }

  function start(next: Opened) {
    setOpen(true);
    setOpened(next);
  }

  const nowIso = new Date().toISOString();
  const shown =
    showAll || routines.length <= COLLAPSED_ROUTINE_COUNT
      ? routines
      : routines.slice(0, COLLAPSED_ROUTINE_COUNT);
  return (
    <EnvironmentGroup
      // The two ways to add one share a "+" at the row's end: two ghost
      // buttons stood in every thread's strip whether or not it had any.
      action={
        <OctantMenu
          items={[
            { value: "follow-up", label: "Follow up later", disabled: busy },
            { value: "routine", label: "New routine", disabled: busy },
            ...(props.onSetGoal === undefined ? [] : [{ value: "goal", label: "Set a goal…" }]),
          ]}
          onValueChange={(value) =>
            value === "goal"
              ? props.onSetGoal?.()
              : value === "follow-up"
                ? start({ kind: "follow-up", editing: { kind: "new" } })
                : start({ kind: "new" })
          }
          selectionMode="action"
          trigger={<Plus aria-hidden="true" size={16} />}
          triggerClassName="environment-menu-trigger"
          triggerLabel="Add a routine"
          value=""
        />
      }
      icon={CalendarClock}
      onOpenChange={setOpen}
      open={open}
      summary={
        routines.length === 0
          ? undefined
          : `${String(routines.length)} ${routines.length === 1 ? "routine" : "routines"}`
      }
      title="Routines"
    >
      {opened?.kind === "follow-up" ? (
        <FollowUpPicker
          busy={busy}
          editing={opened.editing}
          onClose={() => setOpened(undefined)}
          onSubmit={(scheduledAt, taskPrompt) =>
            void submitFollowUp(opened.editing, scheduledAt, taskPrompt)
          }
        />
      ) : null}
      {opened?.kind === "new" ? (
        <EnvironmentRoutineForm
          busy={busy}
          mode={mode}
          onClose={() => setOpened(undefined)}
          onSubmit={(request) => void submitRoutine(request)}
          projectId={projectId}
          threadId={threadId}
        />
      ) : null}
      {message === undefined ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
      {shown.length === 0 ? null : (
        <ul aria-label="Routines in this Project" className="environment-routines__list">
          {shown.map((summary) => {
            const place = placeOf(summary, threadId);
            const label = PLACE_LABEL[place];
            const paused = summary.lifecycle === "paused";
            const followUpHere = place === "follow-up-here";
            const schedule = followUpHere
              ? followUpWhenLabel(scheduledAtOf(summary), nowIso)
              : routineScheduleLine(summary.trigger, summary.nextDueAt, nowIso);
            return (
              <li
                aria-label={summary.displayName}
                className="environment-routine"
                key={String(summary.id)}
              >
                <div className="environment-routine__text">
                  <span className="environment-routine__name">{summary.displayName}</span>
                  <p className="environment-routine__schedule">
                    {[
                      label === undefined ? undefined : <span key="place">{label}</span>,
                      <span key="when">
                        {summary.trigger.kind === "weekly-local"
                          ? `${schedule} (${summary.trigger.timeZone})`
                          : schedule}
                      </span>,
                      summary.lifecycle === "enabled" ? undefined : (
                        <span key="state">
                          {paused ? "Paused" : automationLifecycleLabel(summary.lifecycle)}
                        </span>
                      ),
                    ]
                      .filter((part) => part !== undefined)
                      .flatMap((part, index) =>
                        index === 0
                          ? [part]
                          : [
                              <span aria-hidden="true" key={`dot-${String(index)}`}>
                                {" · "}
                              </span>,
                              part,
                            ],
                      )}
                  </p>
                </div>
                {/* One "…" slot at the row's end, drawn at rest, so nothing
                    moves when a row is pointed at (maintainer request
                    2026-11-17: the four lines and two or three ghost buttons
                    per routine were the loudest thing in the panel). */}
                <OctantMenu
                  items={[
                    ...(followUpHere
                      ? [
                          { value: "change-time", label: "Change time", disabled: busy },
                          {
                            value: "cancel",
                            label: "Cancel follow-up",
                            destructive: true,
                            disabled: busy,
                          },
                        ]
                      : [
                          {
                            value: "pause-resume",
                            label: paused ? "Resume" : "Pause",
                            disabled: busy,
                          },
                        ]),
                    ...(props.onOpenRoutine === undefined
                      ? []
                      : [{ value: "open", label: "Open in Automations" }]),
                  ]}
                  onValueChange={(value) => {
                    if (value === "change-time") {
                      start({ kind: "follow-up", editing: { kind: "move", summary } });
                    } else if (value === "cancel") {
                      void act(() =>
                        client.execute({
                          kind: "archive-automation",
                          automationId: summary.id,
                          expectedVersion: summary.version,
                        }),
                      );
                    } else if (value === "pause-resume") {
                      void act(() =>
                        client.execute({
                          kind: paused ? "resume-automation" : "pause-automation",
                          automationId: summary.id,
                          expectedVersion: summary.version,
                        }),
                      );
                    } else {
                      props.onOpenRoutine?.(String(summary.id));
                    }
                  }}
                  selectionMode="action"
                  trigger={<MoreHorizontal aria-hidden="true" size={16} />}
                  triggerClassName="environment-menu-trigger"
                  triggerLabel={`Actions for ${summary.displayName}`}
                  value=""
                />
              </li>
            );
          })}
        </ul>
      )}
      {routines.length > shown.length ? (
        <OctantButton
          className="window-no-drag"
          onClick={() => setShowAll(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Show all {String(routines.length)}
        </OctantButton>
      ) : null}
    </EnvironmentGroup>
  );
}

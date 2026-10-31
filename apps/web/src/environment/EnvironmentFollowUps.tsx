import type { AutomationClient } from "@octant/client-runtime";
import type { AutomationCommandResult, AutomationSummary } from "@octant/contracts/automation";
import { AlarmClock } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { followUpWhenLabel } from "../automation/routinePresentation";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { EnvironmentGroup } from "./EnvironmentGroup";

const IDLE_FOLLOW_UPS_POLL_MS = 5_000;
const FOLLOW_UP_READ_LIMIT = 100;
const DEFAULT_FOLLOW_UP_PROMPT = "Check on this and summarise what has changed since.";

type QuickPick = "hour" | "tomorrow" | "custom";
type Editing =
  | { readonly kind: "new" }
  | { readonly kind: "move"; readonly summary: AutomationSummary };

/**
 * One-time follow-ups in this thread: a later turn the host sends here with a
 * fixed prompt, so the agent picks the conversation back up ("check whether
 * the reply arrived"). The row is always offered in a Work or Code thread,
 * because setting one up starts here; what is pending shows under it with
 * the two things a person changes, the time and whether it happens at all.
 */
export function EnvironmentFollowUps(props: {
  readonly client: AutomationClient;
  readonly threadId: string;
  readonly projectId: string;
  readonly mode: "work" | "code";
}) {
  const { client, threadId, projectId, mode } = props;
  const [pending, setPending] = useState<ReadonlyArray<AutomationSummary>>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Editing>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const revision = useThreadActivityRevision("toolApprovals");

  const read = useCallback(
    async (signal?: AbortSignal) => {
      const listed = await client.list({ mode, projectId, limit: FOLLOW_UP_READ_LIMIT }, signal);
      if (signal?.aborted === true) return;
      const next = listed.items.filter(
        (item) =>
          String(item.originThreadId) === threadId &&
          item.targetPolicy === "same-thread" &&
          item.lifecycle === "enabled" &&
          // Its one run has started: the routine ends once that run settles,
          // and until then it is no longer something still to come.
          item.latestRunLifecycle === undefined,
      );
      setPending((current) => (samePollingData(current, next) ? current : next));
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
    revision === undefined ? IDLE_FOLLOW_UPS_POLL_MS : THREAD_ACTIVITY_RECOVERY_MS,
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

  async function submit(scheduledAt: string, taskPrompt: string) {
    const target = editing;
    if (target === undefined) return;
    const done = await act(() =>
      target.kind === "new"
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
            automationId: target.summary.id,
            expectedVersion: target.summary.version,
            scheduledAt: scheduledAt as never,
          }),
    );
    if (done) setEditing(undefined);
  }

  const nowIso = new Date().toISOString();
  const next = pending[0];
  return (
    <EnvironmentGroup
      action={
        <OctantButton
          className="window-no-drag"
          disabled={busy}
          onClick={() => {
            setOpen(true);
            setEditing({ kind: "new" });
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Follow up later
        </OctantButton>
      }
      icon={AlarmClock}
      onOpenChange={setOpen}
      open={open}
      summary={next === undefined ? undefined : shortWhen(next, nowIso)}
      title="Follow-up"
    >
      {pending.length === 0 && editing === undefined ? (
        <p className="environment-follow-ups__empty">
          Nothing scheduled. A follow-up sends one turn back into this thread at the time you pick.
        </p>
      ) : (
        <ul className="environment-routines__list">
          {pending.map((summary) => (
            <li className="environment-routine" key={String(summary.id)}>
              <div className="environment-routine__head">
                <span className="environment-routine__name">{summary.displayName}</span>
              </div>
              <p className="environment-routine__schedule">
                {followUpWhenLabel(scheduledAtOf(summary), nowIso)}
              </p>
              <div className="environment-routine__actions">
                <OctantButton
                  className="window-no-drag"
                  disabled={busy}
                  onClick={() => setEditing({ kind: "move", summary })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Change time
                </OctantButton>
                <OctantButton
                  aria-label={`Cancel follow-up ${summary.displayName}`}
                  className="window-no-drag"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      client.execute({
                        kind: "archive-automation",
                        automationId: summary.id,
                        expectedVersion: summary.version,
                      }),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </OctantButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing === undefined ? null : (
        <FollowUpPicker
          busy={busy}
          editing={editing}
          onClose={() => setEditing(undefined)}
          onSubmit={(scheduledAt, taskPrompt) => void submit(scheduledAt, taskPrompt)}
        />
      )}
      {message === undefined ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
    </EnvironmentGroup>
  );
}

function FollowUpPicker(props: {
  readonly editing: Editing;
  readonly busy: boolean;
  readonly onSubmit: (scheduledAt: string, taskPrompt: string) => void;
  readonly onClose: () => void;
}) {
  const ids = { custom: useId(), prompt: useId() };
  const [pick, setPick] = useState<QuickPick>("tomorrow");
  const [custom, setCustom] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_FOLLOW_UP_PROMPT);
  const moving = props.editing.kind === "move";
  const scheduledAt = quickPickInstant(pick, custom, new Date());
  const ready = scheduledAt !== undefined && (moving || prompt.trim().length > 0);
  const choices: ReadonlyArray<{ readonly value: QuickPick; readonly label: string }> = [
    { value: "hour", label: "In 1 hour" },
    { value: "tomorrow", label: "Tomorrow at 9:00" },
    { value: "custom", label: "Pick a time" },
  ];
  return (
    <form
      aria-label={moving ? "Change follow-up time" : "Follow up later"}
      className="environment-follow-up-picker"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) props.onSubmit(scheduledAt, prompt.trim());
      }}
    >
      <div className="environment-follow-up-picker__picks" role="group" aria-label="When">
        {choices.map((choice) => (
          <OctantButton
            aria-pressed={pick === choice.value}
            className="window-no-drag"
            key={choice.value}
            onClick={() => setPick(choice.value)}
            size="sm"
            type="button"
            variant={pick === choice.value ? "secondary" : "ghost"}
          >
            {choice.label}
          </OctantButton>
        ))}
      </div>
      {pick === "custom" ? (
        <div className="environment-follow-up-picker__field">
          <label htmlFor={ids.custom}>Follow up at</label>
          <OctantInput
            className="input"
            id={ids.custom}
            onChange={(event) => setCustom(event.target.value)}
            type="datetime-local"
            value={custom}
          />
        </div>
      ) : null}
      {moving ? null : (
        <div className="environment-follow-up-picker__field">
          <label htmlFor={ids.prompt}>What to check</label>
          <OctantTextarea
            id={ids.prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={2}
            value={prompt}
          />
        </div>
      )}
      <p className="environment-follow-up-picker__note">
        It runs once in this thread with the thread&apos;s own access, asking before effects. It is
        skipped if the thread is busy, done, or archived by then.
      </p>
      <div className="environment-routine__actions">
        <OctantButton
          className="window-no-drag"
          disabled={!ready || props.busy}
          size="sm"
          type="submit"
        >
          {moving ? "Move follow-up" : "Schedule follow-up"}
        </OctantButton>
        <OctantButton
          className="window-no-drag"
          onClick={props.onClose}
          size="sm"
          type="button"
          variant="ghost"
        >
          Close
        </OctantButton>
      </div>
    </form>
  );
}

/** The instant a quick pick names, or undefined when it names none in the future. */
function quickPickInstant(pick: QuickPick, custom: string, now: Date): string | undefined {
  if (pick === "hour") {
    const at = new Date(now.getTime() + 60 * 60_000);
    at.setSeconds(0, 0);
    return at.toISOString();
  }
  if (pick === "tomorrow") {
    const at = new Date(now);
    at.setDate(at.getDate() + 1);
    at.setHours(9, 0, 0, 0);
    return at.toISOString();
  }
  // A datetime-local value has no zone; the browser reads it as local time.
  const ms = custom === "" ? Number.NaN : new Date(custom).getTime();
  return Number.isFinite(ms) && ms > now.getTime() ? new Date(ms).toISOString() : undefined;
}

/** A pending follow-up is due at its once trigger's instant. */
function scheduledAtOf(summary: AutomationSummary): string {
  return summary.trigger.kind === "once" ? summary.trigger.scheduledAt : (summary.nextDueAt ?? "");
}

/** The header's trailing phrase: "tomorrow at 9:00" without the verb. */
function shortWhen(summary: AutomationSummary, nowIso: string): string {
  return followUpWhenLabel(scheduledAtOf(summary), nowIso).replace(/^Follows up /, "");
}

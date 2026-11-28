import "../styles/environment-details.css";
import type { AutomationClient } from "@octant/client-runtime";
import type {
  AutomationFinishWaitTargetCandidate,
  AutomationFollowUpRequest,
  AutomationSummary,
  AutomationThreadFinishCondition,
} from "@octant/contracts/automation";
import { useEffect, useId, useMemo, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";

type FinishWaitAction = "same-thread" | "new-thread" | "run-routine";

const DEFAULT_FINISH_WAIT_PROMPT = "Review what that thread finished and continue from here.";

const TARGET_STATUS_LABEL: Record<AutomationFinishWaitTargetCandidate["status"], string> = {
  working: "working",
  waiting: "waiting for you",
  idle: "idle",
  done: "done",
  unavailable: "unavailable",
};

/**
 * Compact picker for arming a one-shot follow-up or routine run when another
 * thread on this host finishes. Lists only local threads the person can open,
 * excludes this thread itself, and warns if the chosen thread already satisfies
 * the condition so the person can either run now or wait for its next turn.
 */
export function EnvironmentFinishWaitPicker(props: {
  readonly client: AutomationClient;
  readonly threadId: string;
  readonly projectId: string;
  readonly mode: "chat" | "work" | "code";
  readonly existingRoutines: ReadonlyArray<AutomationSummary>;
  readonly busy: boolean;
  readonly onSubmit: (request: AutomationFollowUpRequest) => void;
  readonly onRunRoutineNow?: (routine: AutomationSummary) => void;
  readonly onClose: () => void;
}) {
  const { client, threadId, projectId, mode, existingRoutines } = props;
  const ids = {
    target: useId(),
    condition: useId(),
    action: useId(),
    routine: useId(),
    prompt: useId(),
  };
  const [targets, setTargets] = useState<ReadonlyArray<AutomationFinishWaitTargetCandidate>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [targetId, setTargetId] = useState("");
  const [condition, setCondition] = useState<AutomationThreadFinishCondition>("turn-finished");
  const [action, setAction] = useState<FinishWaitAction>("same-thread");
  const [routineId, setRoutineId] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_FINISH_WAIT_PROMPT);

  const selectableRoutines = useMemo(
    () =>
      existingRoutines.filter(
        (item) =>
          item.lifecycle === "enabled" &&
          item.targetPolicy !== "same-thread" &&
          item.trigger.kind !== "thread-finished",
      ),
    [existingRoutines],
  );

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(undefined);
    const load = client.listFinishWaitTargets;
    if (load === undefined) {
      setTargets([]);
      setLoading(false);
      return;
    }
    void load(controller.signal)
      .then((response) => {
        if (!active) return;
        const eligible = response.targets.filter((entry) => String(entry.threadId) !== threadId);
        setTargets(eligible);
        if (eligible.length > 0 && eligible[0] !== undefined) {
          setTargetId((current) => current || String(eligible[0]?.threadId ?? ""));
        }
      })
      .catch(() => {
        if (!active) return;
        setLoadError("Could not load threads on this host.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, threadId]);

  useEffect(() => {
    if (action === "run-routine" && routineId === "" && selectableRoutines[0] !== undefined) {
      setRoutineId(String(selectableRoutines[0].id));
    }
  }, [action, routineId, selectableRoutines]);

  const selectedTarget = targets.find((entry) => String(entry.threadId) === targetId);
  const selectedRoutine = selectableRoutines.find((item) => String(item.id) === routineId);
  const alreadyMet =
    selectedTarget !== undefined &&
    (condition === "done" ? selectedTarget.alreadyDone : selectedTarget.alreadyTurnFinished);

  const ready =
    selectedTarget !== undefined &&
    (action === "run-routine" ? selectedRoutine !== undefined : prompt.trim().length > 0);

  function handleSubmit() {
    if (!ready || selectedTarget === undefined) return;
    if (action === "run-routine") {
      if (selectedRoutine === undefined) return;
      props.onSubmit({
        kind: "arm-routine-finish-wait",
        automationId: selectedRoutine.id,
        expectedVersion: selectedRoutine.version,
        targetThreadId: selectedTarget.threadId as never,
        targetMode: selectedTarget.mode,
        targetProjectId: selectedTarget.projectId,
        condition,
      });
      return;
    }
    props.onSubmit({
      kind: "arm-thread-finish-follow-up",
      action,
      threadId: threadId as never,
      mode,
      projectId: projectId as never,
      targetThreadId: selectedTarget.threadId as never,
      targetMode: selectedTarget.mode,
      targetProjectId: selectedTarget.projectId,
      condition,
      taskPrompt: prompt.trim(),
    });
  }

  return (
    <form
      aria-label="Follow up when a thread finishes"
      className="environment-follow-up-picker"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="environment-follow-up-picker__field">
        <label htmlFor={ids.target}>Watch thread</label>
        <OctantSelectField
          aria-label="Watch thread"
          disabled={loading || props.busy || targets.length === 0}
          id={ids.target}
          onValueChange={setTargetId}
          options={
            targets.length === 0
              ? [
                  {
                    id: "",
                    label: loading ? "Loading threads…" : "No other threads available on this host",
                  },
                ]
              : targets.map((entry) => ({
                  id: String(entry.threadId),
                  label: `${entry.title} (${entry.mode} · ${TARGET_STATUS_LABEL[entry.status]})`,
                }))
          }
          value={targetId}
        />
      </div>

      {loadError === undefined ? null : <OctantAlert tone="warning">{loadError}</OctantAlert>}

      <div className="environment-follow-up-picker__field">
        <label htmlFor={ids.condition}>When</label>
        <OctantSelectField
          aria-label="When"
          disabled={props.busy}
          id={ids.condition}
          onValueChange={(value) => setCondition(value === "done" ? "done" : "turn-finished")}
          options={[
            { id: "turn-finished", label: "Its next turn finishes" },
            { id: "done", label: "It is marked done" },
          ]}
          value={condition}
        />
      </div>

      {alreadyMet ? (
        <OctantAlert tone="neutral">
          <span>
            {condition === "done"
              ? "That thread is already marked done. Arming waits for a future completion, or you can act now."
              : "That thread already finished its last turn. Arming waits for its next finished turn, or you can act now."}
          </span>
          {action === "run-routine" &&
          selectedRoutine !== undefined &&
          props.onRunRoutineNow !== undefined ? (
            <OctantButton
              className="window-no-drag"
              disabled={props.busy}
              onClick={() => props.onRunRoutineNow?.(selectedRoutine)}
              size="xs"
              type="button"
              variant="secondary"
            >
              Run now
            </OctantButton>
          ) : null}
        </OctantAlert>
      ) : null}

      {mode === "chat" ? null : (
        <div className="environment-follow-up-picker__field">
          <label htmlFor={ids.action}>Then</label>
          <OctantSelectField
            aria-label="Then"
            disabled={props.busy}
            id={ids.action}
            onValueChange={(next) =>
              setAction(next === "new-thread" || next === "run-routine" ? next : "same-thread")
            }
            options={[
              { id: "same-thread", label: "Resume this thread" },
              { id: "new-thread", label: "Start a new thread in this Project" },
              ...(selectableRoutines.length > 0
                ? [{ id: "run-routine", label: "Run an existing routine once more" }]
                : []),
            ]}
            value={action}
          />
        </div>
      )}

      {action === "run-routine" ? (
        <div className="environment-follow-up-picker__field">
          <label htmlFor={ids.routine}>Routine</label>
          <OctantSelectField
            aria-label="Routine"
            disabled={props.busy}
            id={ids.routine}
            onValueChange={setRoutineId}
            options={selectableRoutines.map((item) => ({
              id: String(item.id),
              label: item.displayName,
            }))}
            value={routineId}
          />
        </div>
      ) : (
        <div className="environment-follow-up-picker__field">
          <label htmlFor={ids.prompt}>What to do</label>
          <OctantTextarea
            id={ids.prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={2}
            value={prompt}
          />
        </div>
      )}

      <p className="environment-follow-up-picker__note">
        {mode === "chat"
          ? "Runs once in this thread using its model and account. Expires after 7 days."
          : "Runs once at Ask first (no unattended Full access), using this thread's model and account. Expires after 7 days."}
      </p>

      <div className="environment-routine__actions">
        <OctantButton
          className="window-no-drag"
          disabled={!ready || props.busy}
          size="sm"
          type="submit"
        >
          Wait for thread
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

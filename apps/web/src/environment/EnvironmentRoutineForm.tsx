import {
  decodeAutomationThreadRoutineRequest,
  type AutomationMissedRunPolicy,
  type AutomationThreadRoutineRequest,
} from "@octant/contracts/automation";
import { useId, useState } from "react";
import {
  automationModeLabel,
  automationTriggerIssues,
  MAX_AUTOMATION_NAME_LENGTH,
  MAX_AUTOMATION_PROMPT_LENGTH,
} from "../automation/automationCenterModel";
import {
  initialRoutineScheduleState,
  RoutineScheduleFields,
  routineScheduleFormValue,
  type RoutineScheduleFormState,
} from "../automation/RoutineScheduleFields";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

/**
 * A new routine set up from the thread: what the Automation Center's editor
 * asks for a schedule, with the parts that carry authority left out. The host
 * takes this thread's Project, mode, binding, and an approval-gated profile
 * from the thread itself, so the form cannot name anything wider.
 */
export function EnvironmentRoutineForm(props: {
  readonly threadId: string;
  readonly projectId: string;
  readonly mode: "work" | "code";
  readonly busy: boolean;
  readonly onSubmit: (request: AutomationThreadRoutineRequest) => void;
  readonly onClose: () => void;
}) {
  const ids = { name: useId(), prompt: useId() };
  const [displayName, setDisplayName] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [trigger, setTrigger] = useState<RoutineScheduleFormState>(() =>
    initialRoutineScheduleState(undefined, {
      kind: "weekly-local",
      weekdays: new Set([1, 2, 3, 4, 5]),
      timeZone: localTimeZone(),
    }),
  );
  const [missedRunPolicy, setMissedRunPolicy] = useState<AutomationMissedRunPolicy>("skip");
  const [issues, setIssues] = useState<ReadonlyArray<string>>([]);

  function submit() {
    const name = displayName.trim();
    const prompt = taskPrompt.trim();
    const schedule = routineScheduleFormValue(trigger);
    const found = [
      ...(name.length === 0 || name.length > MAX_AUTOMATION_NAME_LENGTH
        ? ["Name the routine."]
        : []),
      ...(prompt.length === 0 || prompt.length > MAX_AUTOMATION_PROMPT_LENGTH
        ? ["Say what each run should do."]
        : []),
      ...automationTriggerIssues(schedule),
    ];
    if (found.length > 0) {
      setIssues(found);
      return;
    }
    let request: AutomationThreadRoutineRequest;
    try {
      request = decodeAutomationThreadRoutineRequest({
        kind: "create-thread-routine",
        threadId: props.threadId,
        mode: props.mode,
        projectId: props.projectId,
        displayName: name,
        taskPrompt: prompt,
        trigger:
          schedule.kind === "weekly-local"
            ? { ...schedule, weekdays: [...schedule.weekdays].sort((a, b) => a - b) }
            : schedule,
        missedRunPolicy,
      });
    } catch {
      setIssues(["Check the schedule: it is not one a routine can use."]);
      return;
    }
    setIssues([]);
    props.onSubmit(request);
  }

  return (
    <form
      aria-label="New routine"
      className="environment-routine-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="automation-editor__field">
        <label htmlFor={ids.name}>Name</label>
        <OctantInput
          className="input"
          id={ids.name}
          onChange={(event) => setDisplayName(event.target.value)}
          type="text"
          value={displayName}
        />
      </div>
      <div className="automation-editor__field">
        <label htmlFor={ids.prompt}>Task for each run</label>
        <OctantTextarea
          className="textarea"
          id={ids.prompt}
          onChange={(event) => setTaskPrompt(event.target.value)}
          rows={2}
          value={taskPrompt}
        />
      </div>
      <RoutineScheduleFields
        missedRunPolicy={missedRunPolicy}
        onMissedRunPolicyChange={setMissedRunPolicy}
        onTriggerChange={setTrigger}
        trigger={trigger}
      />
      {issues.length === 0 ? null : (
        /* ui-boundary-exception: inline-field-error */
        <ul className="environment-routine-form__issues" role="alert">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <p className="environment-follow-up-picker__note">
        Each run starts a new {automationModeLabel(props.mode)} thread in this Project with this
        task, with this thread&apos;s access at most, and asks before it changes anything.
      </p>
      <div className="environment-routine__actions">
        <OctantButton className="window-no-drag" disabled={props.busy} size="sm" type="submit">
          Create routine
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

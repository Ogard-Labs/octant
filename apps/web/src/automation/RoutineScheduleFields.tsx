import type { AutomationMissedRunPolicy, AutomationTrigger } from "@octant/contracts";
import { useId } from "react";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { AutomationTriggerFormValue } from "./automationCenterModel";

/**
 * The schedule and missed-run fields of a routine, shared by the Automation
 * Center editor and the form a thread's Environment opens, so a schedule reads
 * and validates the same wherever a person sets one.
 */
export interface RoutineScheduleFormState {
  readonly kind: AutomationTriggerFormValue["kind"];
  readonly onceLocal: string;
  readonly anchorLocal: string;
  readonly intervalMinutes: string;
  readonly weekdays: ReadonlySet<number>;
  readonly localTime: string;
  readonly timeZone: string;
}

export function utcInstantFromLocalInput(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

export function localInputFromUtcInstant(instant: string): string {
  const date = new Date(instant);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

const weekdayOptions = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
] as const;

function supportedTimeZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

export function initialRoutineScheduleState(
  initial: AutomationTrigger | undefined,
  defaults: Partial<RoutineScheduleFormState> = {},
): RoutineScheduleFormState {
  const base: RoutineScheduleFormState = {
    kind: "once",
    onceLocal: "",
    anchorLocal: "",
    intervalMinutes: "60",
    weekdays: new Set<number>(),
    localTime: "09:00",
    timeZone: "",
    ...defaults,
  };
  if (initial === undefined) return base;
  switch (initial.kind) {
    case "once":
      return {
        ...base,
        kind: "once",
        onceLocal: localInputFromUtcInstant(initial.scheduledAt),
      };
    case "interval":
      return {
        ...base,
        kind: "interval",
        anchorLocal: localInputFromUtcInstant(initial.anchorAt),
        intervalMinutes: String(initial.intervalMinutes),
      };
    case "weekly-local":
      return {
        ...base,
        kind: "weekly-local",
        weekdays: new Set(initial.weekdays),
        localTime: initial.localTime,
        timeZone: initial.timeZone,
      };
  }
}

export function routineScheduleFormValue(
  trigger: RoutineScheduleFormState,
): AutomationTriggerFormValue {
  switch (trigger.kind) {
    case "once":
      return { kind: "once", scheduledAt: utcInstantFromLocalInput(trigger.onceLocal) ?? "" };
    case "interval":
      return {
        kind: "interval",
        anchorAt: utcInstantFromLocalInput(trigger.anchorLocal) ?? "",
        intervalMinutes: Number(trigger.intervalMinutes),
      };
    case "weekly-local":
      return {
        kind: "weekly-local",
        weekdays: [...trigger.weekdays],
        localTime: trigger.localTime,
        timeZone: trigger.timeZone.trim(),
      };
  }
}

export function RoutineScheduleFields(props: {
  readonly trigger: RoutineScheduleFormState;
  readonly onTriggerChange: (
    update: (previous: RoutineScheduleFormState) => RoutineScheduleFormState,
  ) => void;
  readonly missedRunPolicy: AutomationMissedRunPolicy;
  readonly onMissedRunPolicyChange: (policy: AutomationMissedRunPolicy) => void;
}) {
  const { trigger, onTriggerChange: setTrigger } = props;
  const ids = {
    schedule: useId(),
    onceAt: useId(),
    anchorAt: useId(),
    interval: useId(),
    time: useId(),
    timeZone: useId(),
    timeZoneList: useId(),
    missed: useId(),
  };
  return (
    <>
      <div className="automation-editor__field">
        <label htmlFor={ids.schedule}>Schedule</label>
        <OctantSelectField
          className="select"
          id={ids.schedule}
          onValueChange={(value) =>
            setTrigger((previous) => ({
              ...previous,
              kind: value as RoutineScheduleFormState["kind"],
            }))
          }
          options={[
            { id: "once", label: "Run once" },
            { id: "interval", label: "Repeat on an interval" },
            { id: "weekly-local", label: "Weekly on chosen days" },
          ]}
          value={trigger.kind}
        />
      </div>

      {trigger.kind === "once" ? (
        <div className="automation-editor__field">
          <label htmlFor={ids.onceAt}>Run at</label>
          <OctantInput
            className="input"
            id={ids.onceAt}
            onChange={(event) =>
              setTrigger((previous) => ({ ...previous, onceLocal: event.target.value }))
            }
            type="datetime-local"
            value={trigger.onceLocal}
          />
        </div>
      ) : null}

      {trigger.kind === "interval" ? (
        <>
          <div className="automation-editor__field">
            <label htmlFor={ids.anchorAt}>Starts at</label>
            <OctantInput
              className="input"
              id={ids.anchorAt}
              onChange={(event) =>
                setTrigger((previous) => ({ ...previous, anchorLocal: event.target.value }))
              }
              type="datetime-local"
              value={trigger.anchorLocal}
            />
          </div>
          <div className="automation-editor__field">
            <label htmlFor={ids.interval}>Repeat every (minutes)</label>
            <OctantInput
              className="input"
              id={ids.interval}
              min={15}
              max={43_200}
              onChange={(event) =>
                setTrigger((previous) => ({ ...previous, intervalMinutes: event.target.value }))
              }
              type="number"
              value={trigger.intervalMinutes}
            />
          </div>
        </>
      ) : null}

      {trigger.kind === "weekly-local" ? (
        <>
          <fieldset className="automation-editor__field automation-editor__weekdays">
            <legend>Weekdays</legend>
            {weekdayOptions.map((weekday) => (
              <label className="automation-editor__weekday check" key={weekday.value}>
                <OctantCheckbox
                  checked={trigger.weekdays.has(weekday.value)}
                  onChange={(event) =>
                    setTrigger((previous) => {
                      const weekdays = new Set(previous.weekdays);
                      if (event.target.checked) weekdays.add(weekday.value);
                      else weekdays.delete(weekday.value);
                      return { ...previous, weekdays };
                    })
                  }
                />
                <span>{weekday.label}</span>
              </label>
            ))}
          </fieldset>
          <div className="automation-editor__field">
            <label htmlFor={ids.time}>Time of day</label>
            <OctantInput
              className="input"
              id={ids.time}
              onChange={(event) =>
                setTrigger((previous) => ({ ...previous, localTime: event.target.value }))
              }
              type="time"
              value={trigger.localTime}
            />
          </div>
          <div className="automation-editor__field">
            <label htmlFor={ids.timeZone}>Timezone</label>
            <OctantInput
              className="input"
              id={ids.timeZone}
              list={ids.timeZoneList}
              onChange={(event) =>
                setTrigger((previous) => ({ ...previous, timeZone: event.target.value }))
              }
              placeholder="Europe/Oslo"
              type="text"
              value={trigger.timeZone}
            />
            <datalist id={ids.timeZoneList}>
              {supportedTimeZones().map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </div>
        </>
      ) : null}

      <div className="automation-editor__field">
        <label htmlFor={ids.missed}>Missed runs</label>
        <OctantSelectField
          className="select"
          id={ids.missed}
          onValueChange={(value) =>
            props.onMissedRunPolicyChange(value as AutomationMissedRunPolicy)
          }
          options={[
            { id: "skip", label: "Skip missed runs" },
            { id: "run-once", label: "Run the newest missed occurrence once" },
          ]}
          value={props.missedRunPolicy}
        />
      </div>
    </>
  );
}

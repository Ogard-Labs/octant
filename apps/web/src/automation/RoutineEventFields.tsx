import { useId } from "react";
import type { AutomationEventSourceChoice } from "@octant/contracts";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { RoutineScheduleFormState } from "./RoutineScheduleFields";

const key = (source: Pick<AutomationEventSourceChoice, "integrationId" | "sourceId">) =>
  JSON.stringify([source.integrationId, source.sourceId]);

export function RoutineEventFields(props: {
  readonly trigger: RoutineScheduleFormState;
  readonly sources: ReadonlyArray<AutomationEventSourceChoice>;
  readonly onChange: (
    update: (previous: RoutineScheduleFormState) => RoutineScheduleFormState,
  ) => void;
}) {
  const id = useId();
  const selected = props.sources.find((source) => key(source) === key(props.trigger));
  return (
    <>
      <div className="automation-editor__field">
        <label htmlFor={`${id}-source`}>Event source</label>
        <OctantSelectField
          id={`${id}-source`}
          value={selected === undefined ? "" : key(selected)}
          placeholder="Choose a connected source"
          options={props.sources.map((source) => ({ id: key(source), label: source.label }))}
          onValueChange={(value) => {
            const source = props.sources.find((choice) => key(choice) === value);
            if (source !== undefined)
              props.onChange((previous) => ({
                ...previous,
                integrationId: source.integrationId,
                sourceId: source.sourceId,
                sourceLabel: source.label,
                sourceIdentity: "",
                eventFilters: {},
              }));
          }}
        />
        {props.sources.length === 0 ? (
          <p role="status" className="automation-editor__note">
            No event sources are available. Connect and enable an integration in Settings, then
            reopen this editor.
          </p>
        ) : null}
      </div>
      {selected?.fields.map((field) => (
        <div className="automation-editor__field" key={field.id}>
          <label htmlFor={`${id}-${field.id}`}>{field.label}</label>
          <OctantInput
            id={`${id}-${field.id}`}
            value={props.trigger.eventFilters[field.id] ?? ""}
            required={field.required}
            maxLength={256}
            placeholder={field.placeholder}
            onChange={(event) => {
              const value = event.target.value;
              props.onChange((previous) => ({
                ...previous,
                eventFilters: { ...previous.eventFilters, [field.id]: value },
              }));
            }}
          />
        </div>
      ))}
      <div className="automation-editor__field">
        <label htmlFor={`${id}-poll`}>Check every (minutes)</label>
        <OctantInput
          id={`${id}-poll`}
          type="number"
          min={1}
          max={60}
          step={1}
          value={props.trigger.pollMinutes}
          onChange={(event) => {
            const value = event.target.value;
            props.onChange((previous) => ({ ...previous, pollMinutes: value }));
          }}
        />
      </div>
      <div className="automation-editor__field">
        <label htmlFor={`${id}-limit`}>Automatic runs per arm</label>
        <OctantInput
          id={`${id}-limit`}
          type="number"
          min={1}
          max={32}
          step={1}
          value={props.trigger.automaticStartLimit}
          onChange={(event) => {
            const value = event.target.value;
            props.onChange((previous) => ({ ...previous, automaticStartLimit: value }));
          }}
        />
      </div>
      <p className="automation-editor__note">
        The first complete check is a baseline and starts no task. The host must stay running. After
        a gap, the missed-run choice covers only surviving observed events. New events during a run,
        or events attributed to routine output, wait for review. Re-arm explicitly skips held events
        and restores the allowance. Event text is external data; it cannot change this task or its
        authority.
      </p>
    </>
  );
}

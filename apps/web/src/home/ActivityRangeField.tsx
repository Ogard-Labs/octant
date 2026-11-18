import type { ActivityRangeChoice } from "@octant/contracts/code-home-activity";
import type { ActivityRangeResult } from "@octant/domain/activity-range-policy";
import { useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField, type OctantSelectOption } from "../ui/base/OctantSelect";

export interface ActivityRangeFieldProps {
  /** Accessible name of the timeframe control. */
  readonly label: string;
  readonly value: ActivityRangeChoice;
  /**
   * Called only with a range that resolves: named choices always do, and the
   * custom Apply calls resolve first so impossible or reversed dates stay in
   * the field with their error instead of reaching the settings.
   */
  readonly onChange: (next: ActivityRangeChoice) => void;
  /** The panel's resolver bound to its clock, time zone and week start. */
  readonly resolve: (range: ActivityRangeChoice) => ActivityRangeResult;
  readonly disabled?: boolean;
}

const NAMED_RANGE_OPTIONS: ReadonlyArray<{
  readonly id: Exclude<ActivityRangeChoice["kind"], "custom">;
  readonly label: string;
}> = [
  { id: "today", label: "Today" },
  { id: "last-24-hours", label: "Last 24 hours" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this-week", label: "This week" },
  { id: "this-month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "this-year", label: "This year" },
  { id: "total", label: "Total" },
];

const CUSTOM_ID = "custom";

/** The timeframe a control shows for a stored choice. */
export function activityRangeLabel(range: ActivityRangeChoice): string {
  if (range.kind === "custom") return `${range.startDate} – ${range.endDate}`;
  return NAMED_RANGE_OPTIONS.find((option) => option.id === range.kind)?.label ?? range.kind;
}

function todayDate(): string {
  // A starting point only; Apply still sends the pair through resolve, which
  // owns the Gregorian and ordering rules.
  return new Date().toISOString().slice(0, 10);
}

function refusalMessage(result: ActivityRangeResult): string {
  if (result.status === "ready") return "";
  switch (result.reason) {
    case "reversed-custom-range":
      return "The end date is before the start date.";
    case "invalid-custom-date":
      return "Enter real dates.";
    default:
      return "This timeframe cannot be resolved.";
  }
}

/**
 * One timeframe choice: a select of the named ranges plus an inline
 * start/end date editor for a custom pair. The pair is committed on Apply,
 * and only when it resolves — a reversed or impossible pair keeps the field
 * open with its error.
 */
export function ActivityRangeField(props: ActivityRangeFieldProps) {
  const startId = useId();
  const endId = useId();
  const errorId = useId();
  const [editing, setEditing] = useState(props.value.kind === "custom");
  const [startDate, setStartDate] = useState(
    props.value.kind === "custom" ? props.value.startDate : todayDate(),
  );
  const [endDate, setEndDate] = useState(
    props.value.kind === "custom" ? props.value.endDate : todayDate(),
  );
  const [error, setError] = useState("");

  const options: ReadonlyArray<OctantSelectOption> = [
    ...NAMED_RANGE_OPTIONS,
    { id: CUSTOM_ID, label: "Custom dates…" },
  ];

  const selectValue = props.value.kind === "custom" ? CUSTOM_ID : props.value.kind;

  const apply = () => {
    const next: ActivityRangeChoice = { kind: "custom", startDate, endDate };
    const result = props.resolve(next);
    if (result.status !== "ready") {
      setError(refusalMessage(result));
      return;
    }
    setError("");
    props.onChange(next);
  };

  return (
    <span className="activity-range-field">
      <OctantSelectField
        aria-label={props.label}
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        onValueChange={(id) => {
          if (id === CUSTOM_ID) {
            setEditing(true);
            return;
          }
          setEditing(false);
          setError("");
          const named = NAMED_RANGE_OPTIONS.find((option) => option.id === id);
          if (named === undefined) return;
          props.onChange({ kind: named.id });
        }}
        options={options}
        triggerClassName="activity-range-field__trigger"
        value={selectValue}
      />
      {editing || props.value.kind === "custom" ? (
        <span className="activity-range-field__custom">
          <label className="oct-meta" htmlFor={startId}>
            From
          </label>
          <OctantInput
            aria-describedby={error === "" ? undefined : errorId}
            id={startId}
            onChange={(event) => setStartDate(event.target.value)}
            type="date"
            value={startDate}
          />
          <label className="oct-meta" htmlFor={endId}>
            Through
          </label>
          <OctantInput
            aria-describedby={error === "" ? undefined : errorId}
            id={endId}
            onChange={(event) => setEndDate(event.target.value)}
            type="date"
            value={endDate}
          />
          <OctantButton onClick={apply} size="sm" type="button" variant="secondary">
            Apply
          </OctantButton>
        </span>
      ) : null}
      {error === "" ? null : (
        <OctantAlert
          className="activity-range-field__error"
          id={errorId}
          layout="row"
          tone="warning"
        >
          {error}
        </OctantAlert>
      )}
    </span>
  );
}

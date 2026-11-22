import { Minus, Plus } from "../icons";
import { useState } from "react";
import { OctantButton } from "./OctantButton";
import { OctantInput } from "./OctantInput";

export interface OctantNumberStepperProps {
  /**
   * Draws a plain right-aligned number field, with the unit inside it and no
   * buttons: the arrow keys step it. Settings rows use it, because a minus and
   * a plus beside a number made every numeric row louder than its label.
   */
  readonly field?: boolean;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly step?: number;
  readonly suffix?: string | undefined;
  readonly value: number;
}

export function OctantNumberStepper(props: OctantNumberStepperProps) {
  const step = props.step ?? 1;
  const decimals = decimalPlaces(step);
  const [draft, setDraft] = useState(String(props.value));
  // Follow a new value during render, not in an effect. An effect also ran on
  // mount, and when the stepper mounted outside act (a settings panel that
  // appears once its load resolves) a first edit could land before it: React
  // flushed the pending effect after queuing the edit, so the field snapped
  // back to the old value and the next keystroke appended to it.
  const [shownValue, setShownValue] = useState(props.value);
  if (props.value !== shownValue) {
    setShownValue(props.value);
    setDraft(String(props.value));
  }
  const commit = (next: number) => {
    const bounded = Math.min(props.max, Math.max(props.min, next));
    const normalized = Number(bounded.toFixed(decimals));
    setDraft(String(normalized));
    props.onChange(normalized);
  };

  if (props.field === true) {
    return (
      <span className="octant-number-field window-no-drag">
        <OctantInput
          aria-label={props.label}
          className="octant-number-field__input"
          unstyled
          max={props.max}
          min={props.min}
          onChange={(event) => {
            const nextDraft = event.currentTarget.value;
            setDraft(nextDraft);
            const next = Number(nextDraft);
            if (
              nextDraft !== "" &&
              Number.isFinite(next) &&
              next >= props.min &&
              next <= props.max
            ) {
              props.onChange(Number(next.toFixed(decimals)));
            }
          }}
          onBlur={() => {
            const next = Number(draft);
            commit(Number.isFinite(next) ? next : props.value);
          }}
          step={step}
          type="number"
          value={draft}
        />
        {props.suffix === undefined ? null : (
          <span className="octant-number-field__suffix">{props.suffix}</span>
        )}
      </span>
    );
  }

  return (
    <span className="octant-number-stepper window-no-drag">
      <OctantButton
        aria-label={`Decrease ${props.label}`}
        className="octant-number-stepper__button rounded-none"
        disabled={props.value <= props.min}
        onClick={() => commit(props.value - step)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Minus aria-hidden="true" size={14} />
      </OctantButton>
      <OctantInput
        aria-label={props.label}
        className="octant-number-stepper__input"
        unstyled
        max={props.max}
        min={props.min}
        onChange={(event) => {
          const nextDraft = event.currentTarget.value;
          setDraft(nextDraft);
          const next = Number(nextDraft);
          if (nextDraft !== "" && Number.isFinite(next) && next >= props.min && next <= props.max) {
            props.onChange(Number(next.toFixed(decimals)));
          }
        }}
        onBlur={() => {
          const next = Number(draft);
          commit(Number.isFinite(next) ? next : props.value);
        }}
        step={step}
        type="number"
        value={draft}
      />
      {props.suffix === undefined ? null : (
        <span className="octant-number-stepper__suffix">{props.suffix}</span>
      )}
      <OctantButton
        aria-label={`Increase ${props.label}`}
        className="octant-number-stepper__button rounded-none"
        disabled={props.value >= props.max}
        onClick={() => commit(props.value + step)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Plus aria-hidden="true" size={14} />
      </OctantButton>
    </span>
  );
}

function decimalPlaces(value: number): number {
  const text = String(value);
  const decimal = text.indexOf(".");
  return decimal === -1 ? 0 : text.length - decimal - 1;
}

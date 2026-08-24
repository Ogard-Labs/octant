import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { OctantButton } from "./OctantButton";
import { OctantInput } from "./OctantInput";

export interface OctantNumberStepperProps {
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly step?: number;
  readonly suffix?: string;
  readonly value: number;
}

export function OctantNumberStepper(props: OctantNumberStepperProps) {
  const step = props.step ?? 1;
  const decimals = decimalPlaces(step);
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = (next: number) => {
    const bounded = Math.min(props.max, Math.max(props.min, next));
    const normalized = Number(bounded.toFixed(decimals));
    setDraft(String(normalized));
    props.onChange(normalized);
  };

  return (
    <span className="octant-number-stepper window-no-drag">
      <OctantButton
        aria-label={`Decrease ${props.label}`}
        className="octant-number-stepper__button"
        disabled={props.value <= props.min}
        onClick={() => commit(props.value - step)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Minus aria-hidden="true" size={14} strokeWidth={1.8} />
      </OctantButton>
      <OctantInput
        aria-label={props.label}
        className="octant-number-stepper__input"
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
        className="octant-number-stepper__button"
        disabled={props.value >= props.max}
        onClick={() => commit(props.value + step)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Plus aria-hidden="true" size={14} strokeWidth={1.8} />
      </OctantButton>
    </span>
  );
}

function decimalPlaces(value: number): number {
  const text = String(value);
  const decimal = text.indexOf(".");
  return decimal === -1 ? 0 : text.length - decimal - 1;
}

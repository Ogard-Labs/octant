import { Switch } from "../shadcn/switch";
import { OctantTooltip } from "./OctantTooltip";

export interface OctantSwitchProps {
  readonly checked: boolean;
  readonly describedBy?: string;
  readonly disabled?: boolean;
  /** Spoken and hover explanation for a switch the user cannot change. */
  readonly disabledReason?: string;
  readonly label: string;
  readonly onCheckedChange: (checked: boolean) => void;
}

/** Octant switch adapter over the owned shadcn/Base UI Switch recipe. */
export function OctantSwitch(props: OctantSwitchProps) {
  const disabledReason = props.disabled === true ? props.disabledReason : undefined;
  const control = (
    <Switch
      aria-description={disabledReason}
      aria-describedby={props.describedBy}
      aria-label={props.label}
      checked={props.checked}
      className="octant-switch window-no-drag"
      disabled={props.disabled}
      onCheckedChange={(checked) => props.onCheckedChange(checked)}
    />
  );
  if (disabledReason === undefined) return control;
  // A disabled switch takes no pointer events, so a title on it never showed.
  // The wrapper carries the hover explanation; the switch still speaks it.
  return (
    <OctantTooltip label={disabledReason}>
      <span className="octant-switch__disabled-reason">{control}</span>
    </OctantTooltip>
  );
}

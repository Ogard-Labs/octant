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
  // A disabled switch takes no pointer events, so a title on it never showed.
  // A layer over it carries the hover explanation while the switch still
  // speaks it. The switch keeps one place in the tree either way: swapping
  // wrappers when it became enabled remounted it and dropped the click.
  return (
    <span className="octant-switch__frame">
      {control}
      {disabledReason === undefined ? null : (
        <OctantTooltip label={disabledReason}>
          <span aria-hidden="true" className="octant-switch__disabled-reason" />
        </OctantTooltip>
      )}
    </span>
  );
}

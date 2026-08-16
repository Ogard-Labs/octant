import { Switch } from "../shadcn/switch";

export interface OctantSwitchProps {
  readonly checked: boolean;
  readonly describedBy?: string;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onCheckedChange: (checked: boolean) => void;
}

/** Octant switch adapter over the owned shadcn/Base UI Switch recipe. */
export function OctantSwitch(props: OctantSwitchProps) {
  return (
    <Switch
      aria-describedby={props.describedBy}
      aria-label={props.label}
      checked={props.checked}
      className="octant-switch window-no-drag"
      disabled={props.disabled}
      onCheckedChange={(checked) => props.onCheckedChange(checked)}
    />
  );
}

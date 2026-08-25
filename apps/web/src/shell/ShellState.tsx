import {
  Compass,
  LoaderCircle,
  RefreshCcw,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

type ShellStateKind = "disconnected" | "loading" | "neutral" | "warning";

const stateIcons: Record<ShellStateKind, LucideIcon> = {
  disconnected: WifiOff,
  loading: LoaderCircle,
  neutral: Compass,
  warning: TriangleAlert,
};

export interface ShellStateProps {
  readonly action?: { readonly label: string; readonly onClick: () => void };
  readonly eyebrow?: string;
  readonly message: string;
  readonly role?: "alert" | "status";
  readonly state: ShellStateKind;
  readonly title: string;
}

export function ShellState(props: ShellStateProps) {
  const StateIcon = stateIcons[props.state];
  return (
    <section
      className={`shell-state shell-state--${props.state}`}
      role={props.role ?? (props.state === "loading" ? "status" : undefined)}
    >
      <span className="shell-state__icon">
        <StateIcon
          aria-hidden="true"
          className={props.state === "loading" ? "shell-state__spinner" : undefined}
          size={16}
          strokeWidth={1.7}
        />
      </span>
      <div className="shell-state__copy">
        {props.eyebrow === undefined ? null : (
          <span className="shell-state__eyebrow">{props.eyebrow}</span>
        )}
        <h1 className="shell-state__title">{props.title}</h1>
        <p>{props.message}</p>
      </div>
      {props.action === undefined ? null : (
        <OctantButton
          className="shell-state__action"
          onClick={props.action.onClick}
          type="button"
          variant="secondary"
        >
          <RefreshCcw aria-hidden="true" size={14} strokeWidth={1.9} />
          <span>{props.action.label}</span>
        </OctantButton>
      )}
    </section>
  );
}

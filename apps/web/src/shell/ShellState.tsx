import {
  Compass,
  LoaderCircle,
  RefreshCcw,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  OctantEmptyStateActions,
  OctantEmptyStateCopy,
  OctantEmptyStateDescription,
  OctantEmptyStateEyebrow,
  OctantEmptyStateMedia,
  OctantEmptyStateRoot,
  OctantEmptyStateTitle,
} from "../ui/base/OctantEmptyState";

type ShellStateKind = "disconnected" | "loading" | "neutral" | "warning";

const stateIcons: Record<ShellStateKind, LucideIcon> = {
  disconnected: WifiOff,
  loading: LoaderCircle,
  neutral: Compass,
  warning: TriangleAlert,
};

const stateTones: Record<ShellStateKind, "neutral" | "warning"> = {
  disconnected: "warning",
  loading: "neutral",
  neutral: "neutral",
  warning: "warning",
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
    <OctantEmptyStateRoot
      data-state={props.state}
      role={props.role ?? (props.state === "loading" ? "status" : undefined)}
    >
      <OctantEmptyStateMedia tone={stateTones[props.state]}>
        <StateIcon
          aria-hidden="true"
          className={props.state === "loading" ? "shell-state__spinner" : undefined}
          size={16}
          strokeWidth={1.7}
        />
      </OctantEmptyStateMedia>
      <OctantEmptyStateCopy>
        {props.eyebrow === undefined ? null : (
          <OctantEmptyStateEyebrow>{props.eyebrow}</OctantEmptyStateEyebrow>
        )}
        <OctantEmptyStateTitle>{props.title}</OctantEmptyStateTitle>
        <OctantEmptyStateDescription>{props.message}</OctantEmptyStateDescription>
      </OctantEmptyStateCopy>
      {props.action === undefined ? null : (
        <OctantEmptyStateActions>
          <OctantButton onClick={props.action.onClick} type="button" variant="secondary">
            <RefreshCcw aria-hidden="true" size={14} strokeWidth={1.9} />
            <span>{props.action.label}</span>
          </OctantButton>
        </OctantEmptyStateActions>
      )}
    </OctantEmptyStateRoot>
  );
}

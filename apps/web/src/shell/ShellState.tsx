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
  OctantEmptyContent,
  OctantEmptyHeader,
  OctantEmptyDescription,
  OctantEmptyEyebrow,
  OctantEmptyMedia,
  OctantEmptyRoot,
  OctantEmptyTitle,
} from "../ui/base/OctantEmpty";

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
    <OctantEmptyRoot
      className="shell-state"
      data-state={props.state}
      role={props.role ?? (props.state === "loading" ? "status" : undefined)}
    >
      <OctantEmptyMedia tone={stateTones[props.state]}>
        <StateIcon
          aria-hidden="true"
          className={props.state === "loading" ? "shell-state__spinner" : undefined}
          size={16}
          strokeWidth={1.7}
        />
      </OctantEmptyMedia>
      <OctantEmptyHeader>
        {props.eyebrow === undefined ? null : (
          <OctantEmptyEyebrow>{props.eyebrow}</OctantEmptyEyebrow>
        )}
        <OctantEmptyTitle>{props.title}</OctantEmptyTitle>
        <OctantEmptyDescription>{props.message}</OctantEmptyDescription>
      </OctantEmptyHeader>
      {props.action === undefined ? null : (
        <OctantEmptyContent>
          <OctantButton onClick={props.action.onClick} type="button" variant="secondary">
            <RefreshCcw aria-hidden="true" size={14} strokeWidth={1.9} />
            <span>{props.action.label}</span>
          </OctantButton>
        </OctantEmptyContent>
      )}
    </OctantEmptyRoot>
  );
}

import type { ContextHealth } from "@octant/contracts/context";
import { contextHealthLabel } from "./contextInspectorModel";
import { OctantButton } from "../ui/base/OctantButton";
import "./context.css";

export interface ContextTabWarningProps {
  readonly health: Exclude<ContextHealth, "healthy">;
  readonly label: string;
  readonly onOpen: () => void;
}

export function ContextTabWarning(props: ContextTabWarningProps) {
  const health = contextHealthLabel(props.health);
  return (
    <OctantButton
      aria-label={`${props.label}: ${health}. Open context inspector.`}
      className="context-tab-warning"
      data-health={props.health}
      onClick={props.onOpen}
      type="button"
      variant="ghost"
    >
      <span aria-hidden="true">!</span>
      <span>{health}</span>
    </OctantButton>
  );
}

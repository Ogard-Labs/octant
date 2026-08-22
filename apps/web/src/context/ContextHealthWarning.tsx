import type { ContextHealth } from "@octant/contracts/context";
import { contextHealthLabel } from "./contextInspectorModel";
import { OctantButton } from "../ui/base/OctantButton";
import "./context.css";

export interface ContextHealthWarningProps {
  readonly health: Exclude<ContextHealth, "healthy">;
  readonly label: string;
  readonly onOpen: (opener: HTMLElement) => void;
}

/**
 * A degraded context, marked where the reader can already see the subject.
 *
 * This rode on the workspace tab strip until panes stopped holding tabs, which
 * left a rate-limited or blocked Project announcing itself to nobody while it
 * was not the pane's subject. It is a button rather than a badge because the
 * remedy lives on that Project's composer meter, and it carries the health in
 * words so a reader who cannot see the colour still reads the state.
 */
export function ContextHealthWarning(props: ContextHealthWarningProps) {
  const health = contextHealthLabel(props.health);
  return (
    <OctantButton
      aria-label={`${props.label}: ${health}. Open this Project.`}
      className="context-health-warning"
      data-health={props.health}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => props.onOpen(event.currentTarget)}
      type="button"
      variant="ghost"
    >
      <span aria-hidden="true">!</span>
      <span>{health}</span>
    </OctantButton>
  );
}

import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";
import { contextStatusModel, type ContextFocus } from "./contextInspectorModel";
import { OctantButton } from "../ui/base/OctantButton";
import "./context.css";

export interface ContextStatusBarProps {
  readonly focus: ContextFocus;
  readonly onOpenInspector: () => void;
  readonly snapshot: ContextInspectorSnapshot;
}

export function ContextStatusBar(props: ContextStatusBarProps) {
  const model = contextStatusModel(props.snapshot, props.focus);
  return (
    <div className="context-status-bar" data-health={model.health} role="status">
      <OctantButton
        aria-label={`Open context inspector for ${props.snapshot.displayLabel}. ${model.healthLabel}.`}
        className="context-status-bar__button"
        onClick={props.onOpenInspector}
        type="button"
        variant="ghost"
      >
        <span className="context-status-bar__scope">{model.scopeLabel}</span>
        <span>{model.usageLabel}</span>
        <span>{model.headroomLabel}</span>
        <span>{model.toolsLabel}</span>
        <span className="context-status-bar__health">
          <span aria-hidden="true">{healthMark(model.health)}</span>
          {model.healthLabel}
        </span>
        {model.attentionLabel === undefined ? null : (
          <span className="context-status-bar__attention">{model.attentionLabel}</span>
        )}
      </OctantButton>
    </div>
  );
}

function healthMark(health: ContextInspectorSnapshot["next"]["plan"]["health"]): string {
  if (health === "healthy") return "✓";
  if (health === "optimizing") return "↻";
  if (health === "rate-limited") return "◷";
  return "!";
}

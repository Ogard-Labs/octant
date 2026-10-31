import type { ProjectAction } from "@octant/contracts/projects";
import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantMenu } from "../ui/base/OctantMenu";

/** How many actions sit in the header before the rest move into a menu. */
const INLINE_ACTIONS = 3;

export interface ProjectActionButtonsProps {
  readonly actions: ReadonlyArray<ProjectAction>;
  readonly onRun: (action: ProjectAction) => void;
}

/**
 * The Code Project's saved actions as buttons in the window header. Each one
 * only asks the host to type its saved line into the Project terminal; what
 * the line may do is decided there. Drawn into the header's own slot, and
 * nowhere when that slot is not on screen.
 */
export function ProjectActionButtons(props: ProjectActionButtonsProps) {
  const [host, setHost] = useState<Element | null>(() =>
    typeof document === "undefined"
      ? null
      : document.querySelector("[data-octant-project-actions]"),
  );
  useEffect(() => {
    setHost(document.querySelector("[data-octant-project-actions]"));
  }, []);
  if (host === null || props.actions.length === 0) return null;
  const inline = props.actions.slice(0, INLINE_ACTIONS);
  const rest = props.actions.slice(INLINE_ACTIONS);
  return createPortal(
    <div
      aria-label="Project actions"
      className="project-action-buttons window-no-drag"
      role="group"
    >
      {inline.map((action) => (
        <OctantButton
          key={String(action.id)}
          onClick={() => props.onRun(action)}
          size="sm"
          title={action.command}
          type="button"
          variant="ghost"
        >
          <Play aria-hidden="true" size={12} />
          {action.name}
        </OctantButton>
      ))}
      {rest.length === 0 ? null : (
        <OctantMenu
          items={rest.map((action) => ({ label: action.name, value: String(action.id) }))}
          onValueChange={(value) => {
            const selected = rest.find((action) => String(action.id) === value);
            if (selected !== undefined) props.onRun(selected);
          }}
          selectionMode="action"
          trigger={<span>More</span>}
          triggerClassName="project-action-buttons__more"
          triggerLabel="More Project actions"
          value=""
        />
      )}
    </div>,
    host,
  );
}

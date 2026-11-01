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
  /** The Project's main folder and its extra folders; a choice is offered only with an extra one. */
  readonly mainFolder?: string;
  readonly extraFolders?: ReadonlyArray<string>;
  /** `folder` is the extra folder the person chose; absent runs in the main folder. */
  readonly onRun: (action: ProjectAction, folder?: string) => void;
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
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
  const extras = props.extraFolders ?? [];
  const [chosen, setChosen] = useState<string>("");
  // A removed folder falls back to the main one rather than staying chosen.
  const folder = extras.includes(chosen) ? chosen : "";
  const run = (action: ProjectAction) =>
    folder === "" ? props.onRun(action) : props.onRun(action, folder);
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
          onClick={() => run(action)}
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
            if (selected !== undefined) run(selected);
          }}
          selectionMode="action"
          trigger={<span>More</span>}
          triggerClassName="project-action-buttons__more"
          triggerLabel="More Project actions"
          value=""
        />
      )}
      {extras.length === 0 ? null : (
        <OctantMenu
          items={[
            { label: `${folderName(props.mainFolder ?? "")} (main)`, value: "" },
            ...extras.map((path) => ({ label: folderName(path), value: path })),
          ]}
          onValueChange={setChosen}
          trigger={<span>Run in: {folder === "" ? "main folder" : folderName(folder)}</span>}
          triggerClassName="project-action-buttons__more"
          triggerLabel="Folder to run actions in"
          value={folder}
        />
      )}
    </div>,
    host,
  );
}

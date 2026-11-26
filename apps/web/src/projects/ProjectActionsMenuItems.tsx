import type { ReactNode } from "react";
import type { OpenRepositoryBootstrap } from "./addRepositoryToComputerContext";
import type { ProjectColor, ProjectId, ProjectSummary } from "@octant/contracts/projects";
import {
  OctantMenuItem as OctantMenuActionItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuSub,
  OctantMenuSubPopup,
  OctantMenuSubTrigger,
} from "../ui/base/OctantMenu";

export interface ProjectActionsMenuProps {
  readonly canMoveDown: boolean;
  readonly canMoveUp: boolean;
  readonly nextProjectId?: ProjectId;
  readonly onArchive: (projectId: ProjectId) => void;
  readonly onColorChange?: (projectId: ProjectId, color: ProjectColor | null) => void;
  readonly onMove: (projectId: ProjectId, pinned: boolean) => void;
  /** Starts a coordinator in a Code Project (docs/design/coordinator-threads.md). */
  readonly onNewCoordinator?: (projectId: ProjectId) => void;
  readonly onOpen: (project: ProjectSummary) => void;
  readonly onReorder: (
    projectId: ProjectId,
    pinned: boolean,
    beforeProjectId?: ProjectId,
    afterProjectId?: ProjectId,
  ) => void;
  readonly onRestore: (projectId: ProjectId) => void;
  readonly previousProjectId?: ProjectId;
  readonly project: ProjectSummary;
  readonly railPins?: {
    readonly pinnedIds: ReadonlySet<string>;
    readonly onChange: (projectId: ProjectId, pinned: boolean) => void;
  };
}

/**
 * A Project row's action items, loaded when its menu first opens rather than
 * with the sidebar. The row hands in what it already holds (the colour
 * choices, the rail's limit) so this module imports only the menu itself.
 */
export function ProjectActionsMenuItems(
  props: ProjectActionsMenuProps & {
    readonly onAddToAnotherComputer?: OpenRepositoryBootstrap | undefined;
    readonly railLimit: number;
    readonly railFullReason: string;
    readonly colors: {
      readonly items: ReadonlyArray<{
        readonly icon?: ReactNode;
        readonly label: string;
        readonly value: string;
      }>;
      readonly valueOf: (color: ProjectColor | undefined) => string;
      readonly fromValue: (value: string) => ProjectColor | null | undefined;
    };
  },
) {
  const { project } = props;
  // An archived Project has no rail tile to pin.
  const railPins = project.lifecycle === "archived" ? undefined : props.railPins;
  const railPinned = railPins?.pinnedIds.has(String(project.id)) === true;
  const railFull = !railPinned && (railPins?.pinnedIds.size ?? 0) >= props.railLimit;
  const archived = project.lifecycle === "archived";
  // An archived Project is read-only, so its colour is as fixed as its name.
  const onColorChange = archived ? undefined : props.onColorChange;
  // Coordinators are Code only: Work turns carry no messages for one to follow
  // up with, and an archived Project starts nothing.
  const onNewCoordinator = archived || project.type !== "code" ? undefined : props.onNewCoordinator;
  const onAddToAnotherComputer = props.onAddToAnotherComputer;
  return (
    <OctantMenuPortal>
      <OctantMenuPositioner className="outline-none window-no-drag">
        <OctantMenuPopup className="window-no-drag">
          <OctantMenuActionItem onClick={() => props.onOpen(project)}>
            Open Project
          </OctantMenuActionItem>
          {onNewCoordinator === undefined ? null : (
            <OctantMenuActionItem onClick={() => onNewCoordinator(project.id)}>
              New coordinator
            </OctantMenuActionItem>
          )}
          {onAddToAnotherComputer === undefined || archived || project.type !== "code" ? null : (
            <OctantMenuActionItem onClick={() => onAddToAnotherComputer(project.id)}>
              Add to another computer…
            </OctantMenuActionItem>
          )}
          <OctantMenuActionItem onClick={() => props.onMove(project.id, !project.pinned)}>
            {project.pinned ? "Unpin Project" : "Pin Project"}
          </OctantMenuActionItem>
          {railPins === undefined ? null : (
            <OctantMenuActionItem
              disabled={railFull}
              onClick={() => railPins.onChange(project.id, !railPinned)}
              {...(railFull
                ? { "aria-description": props.railFullReason, title: props.railFullReason }
                : {})}
            >
              {railPinned ? "Unpin from rail" : "Pin to rail"}
            </OctantMenuActionItem>
          )}
          <OctantMenuActionItem
            disabled={!props.canMoveUp}
            onClick={() => props.onReorder(project.id, project.pinned, props.previousProjectId)}
          >
            Move up
          </OctantMenuActionItem>
          <OctantMenuActionItem
            disabled={!props.canMoveDown}
            onClick={() =>
              props.onReorder(project.id, project.pinned, undefined, props.nextProjectId)
            }
          >
            Move down
          </OctantMenuActionItem>
          {onColorChange === undefined ? null : (
            <OctantMenuSub>
              <OctantMenuSubTrigger>Colour</OctantMenuSubTrigger>
              <OctantMenuSubPopup>
                <OctantMenuRadioGroup
                  onValueChange={(value) => {
                    if (typeof value !== "string") return;
                    const color = props.colors.fromValue(value);
                    if (color !== undefined) onColorChange(project.id, color);
                  }}
                  value={props.colors.valueOf(project.color)}
                >
                  {props.colors.items.map((item) => (
                    <OctantMenuRadioItem closeOnClick key={item.value} value={item.value}>
                      <span
                        aria-hidden="true"
                        className="flex size-(--oct-icon-md) items-center justify-center"
                      >
                        {item.icon}
                      </span>
                      {item.label}
                    </OctantMenuRadioItem>
                  ))}
                </OctantMenuRadioGroup>
              </OctantMenuSubPopup>
            </OctantMenuSub>
          )}
          <OctantMenuActionItem
            onClick={() => (archived ? props.onRestore(project.id) : props.onArchive(project.id))}
          >
            {archived ? "Restore Project" : "Archive Project"}
          </OctantMenuActionItem>
        </OctantMenuPopup>
      </OctantMenuPositioner>
    </OctantMenuPortal>
  );
}

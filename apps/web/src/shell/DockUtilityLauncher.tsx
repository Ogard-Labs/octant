import { GitPullRequest, Plus } from "lucide-react";
import { DockToolIcon } from "./dockToolIcons";
import { groupDockTools } from "./dockToolGroups";
import {
  OctantMenuRoot,
  OctantMenuTrigger,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuPopup,
  OctantMenuItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuSeparator,
} from "../ui/base/OctantMenu";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

export interface DockUtilityLauncherSurface {
  readonly id: RightUtilityDockSurfaceId;
  readonly label: string;
}

/**
 * Something this thread is already about that can be opened as a tab.
 *
 * The tool list answers "what kind of tab"; this answers "which one", so the
 * reader does not have to leave the dock, find the pull request on another
 * surface, and come back.
 */
export interface DockUtilityLauncherReference {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly onOpen: () => void;
}

export interface DockUtilityLauncherProps {
  readonly onOpen: (surface: RightUtilityDockSurfaceId) => void;
  readonly surfaces: ReadonlyArray<DockUtilityLauncherSurface>;
  readonly references?: ReadonlyArray<DockUtilityLauncherReference>;
}

export function DockUtilityLauncher(props: DockUtilityLauncherProps) {
  // A subject whose remaining tools are all gated away has nothing to offer,
  // and a permanently greyed-out plus reads as a broken control rather than as
  // an honest "nothing to add here". Absence is the honest state.
  const references = props.references ?? [];
  if (props.surfaces.length === 0 && references.length === 0) return null;

  return (
    <span className="dock-utility-launcher">
      <OctantMenuRoot>
        <OctantMenuTrigger aria-label="Add tool" className="shell-icon-button window-no-drag">
          <Plus aria-hidden="true" size={16} strokeWidth={1.5} />
        </OctantMenuTrigger>
        <OctantMenuPortal>
          <OctantMenuPositioner>
            <OctantMenuPopup aria-label="Add tool">
              <DockToolLaunchList
                onOpen={(surface) => {
                  props.onOpen(surface);
                }}
                surfaces={props.surfaces}
              />
              {references.length === 0 ? null : (
                <>
                  <OctantMenuSeparator />
                  <OctantMenuGroup>
                    <OctantMenuGroupLabel>Relevant to this thread</OctantMenuGroupLabel>
                    {references.map((reference) => (
                      <OctantMenuItem
                        className="workspace-disclosure__action window-no-drag"
                        key={reference.id}
                        onClick={() => {
                          reference.onOpen();
                        }}
                      >
                        <GitPullRequest aria-hidden="true" size={14} strokeWidth={1.7} />
                        <span className="dock-utility-launcher__reference">
                          <span>{reference.label}</span>
                          {reference.detail === undefined ? null : (
                            <span className="dock-utility-launcher__reference-detail">
                              {reference.detail}
                            </span>
                          )}
                        </span>
                      </OctantMenuItem>
                    ))}
                  </OctantMenuGroup>
                </>
              )}
            </OctantMenuPopup>
          </OctantMenuPositioner>
        </OctantMenuPortal>
      </OctantMenuRoot>
    </span>
  );
}

export function DockToolLaunchList(props: {
  readonly onOpen: (surface: RightUtilityDockSurfaceId) => void;
  readonly surfaces: ReadonlyArray<DockUtilityLauncherSurface>;
}) {
  const groups = groupDockTools(props.surfaces);
  return (
    <>
      {groups.map((group) => (
        <OctantMenuGroup
          aria-label={groups.length > 1 ? group.label : undefined}
          className="dock-utility-launcher__group"
          key={group.label}
        >
          {groups.length > 1 ? <OctantMenuGroupLabel>{group.label}</OctantMenuGroupLabel> : null}
          {group.surfaces.map((surface) => (
            <OctantMenuItem
              className="workspace-disclosure__action window-no-drag"
              key={surface.id}
              onClick={() => props.onOpen(surface.id)}
            >
              <DockToolIcon surface={surface.id} />
              <span>{surface.label}</span>
            </OctantMenuItem>
          ))}
        </OctantMenuGroup>
      ))}
    </>
  );
}

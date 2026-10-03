import { GitPullRequest, Plus } from "lucide-react";
import { useState } from "react";
import { DockToolIcon } from "./dockToolIcons";
import { groupDockTools } from "./dockToolGroups";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
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
  const [open, setOpen] = useState(false);

  // A subject whose remaining tools are all gated away has nothing to offer,
  // and a permanently greyed-out plus reads as a broken control rather than as
  // an honest "nothing to add here". Absence is the honest state.
  const references = props.references ?? [];
  if (props.surfaces.length === 0 && references.length === 0) return null;

  // The menu hangs from the plus in a portal. The in-flow menu was clipped by
  // the dock's right edge, and the workaround that pinned it to the toolbar put
  // it far from the button that opened it; the popover's collision handling
  // keeps it under the plus and still inside the window.
  return (
    <span className="dock-utility-launcher">
      <OctantPopover
        align="start"
        className="dock-utility-launcher__menu"
        onOpenChange={setOpen}
        open={open}
        side="bottom"
        title="Add tool"
        trigger={<Plus aria-hidden="true" size={16} strokeWidth={1.5} />}
        triggerClassName="shell-icon-button"
        triggerLabel="Add tool"
        triggerVariant="ghost-icon"
      >
        <DockToolLaunchList
          onOpen={(surface) => {
            props.onOpen(surface);
            setOpen(false);
          }}
          surfaces={props.surfaces}
        />
        {references.length === 0 ? null : (
          <>
            <span className="workspace-disclosure__caption">Relevant to this thread</span>
            {references.map((reference) => (
              <OctantButton
                className="workspace-disclosure__action window-no-drag"
                key={reference.id}
                onClick={() => {
                  reference.onOpen();
                  setOpen(false);
                }}
                type="button"
                variant="ghost"
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
              </OctantButton>
            ))}
          </>
        )}
      </OctantPopover>
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
        <span
          aria-label={groups.length > 1 ? group.label : undefined}
          className="dock-utility-launcher__group"
          key={group.label}
          role={groups.length > 1 ? "group" : undefined}
        >
          {groups.length > 1 ? (
            <span className="dock-utility-launcher__group-title">{group.label}</span>
          ) : null}
          {group.surfaces.map((surface) => (
            <OctantButton
              className="workspace-disclosure__action window-no-drag"
              key={surface.id}
              onClick={() => props.onOpen(surface.id)}
              type="button"
              variant="ghost"
            >
              <DockToolIcon surface={surface.id} />
              <span>{surface.label}</span>
            </OctantButton>
          ))}
        </span>
      ))}
    </>
  );
}

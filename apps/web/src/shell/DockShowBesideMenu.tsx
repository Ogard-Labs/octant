import { Columns2 } from "lucide-react";
import { useId } from "react";
import { DockToolIcon } from "./dockToolIcons";
import { DockToolLaunchList, type DockUtilityLauncherSurface } from "./DockUtilityLauncher";
import {
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

export interface DockShowBesideMenuProps {
  /** Tools that are open in the strip but not on screen. */
  readonly open: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly surface: RightUtilityDockSurfaceId;
  }>;
  /** Tools this thread can launch that are not open yet. */
  readonly launchable: ReadonlyArray<DockUtilityLauncherSurface>;
  readonly onShowOpen: (tabId: string) => void;
  readonly onOpen: (surface: RightUtilityDockSurfaceId) => void;
}

/**
 * Shows another tool with the one in front, beside it when the dock has the width and below it when the columns stack. The tab strip fits two or three
 * tabs at a usual dock width, so a tool in its overflow list had neither a
 * menu nor a drop target to tile from; this is the control that always can.
 */
export function DockShowBesideMenu(props: DockShowBesideMenuProps) {
  const labelId = useId();
  if (props.open.length === 0 && props.launchable.length === 0) return null;
  return (
    <OctantMenuRoot>
      <OctantMenuTrigger
        aria-label="Show another tool"
        className="shell-icon-button window-no-drag"
        title="Show another tool"
      >
        <Columns2 aria-hidden="true" size={16} strokeWidth={1.5} />
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner>
          {/* The popup is named by its trigger unless told otherwise, and the
              trigger says what the button does, not what the menu holds. */}
          <OctantMenuPopup aria-labelledby={labelId}>
            <span className="sr-only" id={labelId}>
              Show another tool
            </span>
            {props.open.map((tool) => (
              <OctantMenuItem
                className="workspace-disclosure__action window-no-drag"
                key={tool.id}
                onClick={() => props.onShowOpen(tool.id)}
              >
                <DockToolIcon surface={tool.surface} />
                <span>{tool.label}</span>
              </OctantMenuItem>
            ))}
            {props.open.length > 0 && props.launchable.length > 0 ? <OctantMenuSeparator /> : null}
            {props.launchable.length === 0 ? null : (
              <DockToolLaunchList onOpen={props.onOpen} surfaces={props.launchable} />
            )}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

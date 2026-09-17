import type { SidebarDestinationCustomization } from "@octant/contracts/shell";
import { Ellipsis, PanelLeft } from "lucide-react";
import {
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import {
  setSidebarDestinationShown,
  sidebarDestinationOrder,
  sidebarDestinationVisibility,
} from "./navigationModel";

export interface SidebarMoreProps {
  readonly customization: SidebarDestinationCustomization;
  readonly onChange: (next: SidebarDestinationCustomization) => void;
  readonly onCustomizeSidebar: () => void;
}

/**
 * The sidebar's own control. It carries no destinations: each row is one
 * element the rail can show, checked while it is in the rail, and the popup
 * closes with the path to ordering and the menu-only placement in Settings.
 */
export function SidebarMore(props: SidebarMoreProps) {
  return (
    <OctantMenuRoot>
      <OctantMenuTrigger aria-label="More" className="sidebar-item window-no-drag justify-start">
        <Ellipsis aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
        <span className="sidebar-label">More</span>
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner align="start" side="right">
          <OctantMenuPopup aria-label="More" className="w-[min(248px,calc(100vw-24px))]">
            <OctantMenuGroup aria-label="Sidebar elements">
              <OctantMenuGroupLabel>Sidebar elements</OctantMenuGroupLabel>
              {sidebarDestinationOrder(props.customization).map((destination) => (
                <OctantMenuCheckboxItem
                  checked={
                    sidebarDestinationVisibility(props.customization, destination.id) === "shown"
                  }
                  key={destination.id}
                  onCheckedChange={(checked) =>
                    props.onChange(
                      setSidebarDestinationShown(props.customization, destination.id, checked),
                    )
                  }
                >
                  {destination.label}
                </OctantMenuCheckboxItem>
              ))}
            </OctantMenuGroup>
            <OctantMenuSeparator />
            <OctantMenuGroup aria-label="Sidebar">
              <OctantMenuItem onClick={props.onCustomizeSidebar}>
                <PanelLeft aria-hidden={true} className="icon" size={16} strokeWidth={1.5} />
                <span>Customize sidebar</span>
              </OctantMenuItem>
            </OctantMenuGroup>
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

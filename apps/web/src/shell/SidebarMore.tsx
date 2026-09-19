import { Ellipsis, PanelLeft } from "lucide-react";
import {
  OctantMenuGroup,
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";
import { secondaryIcons, type SidebarSecondaryAction } from "./SidebarProfile";

export interface SidebarMoreProps {
  /** The destinations waiting under More, in the sidebar's destination order. */
  readonly items: ReadonlyArray<SidebarSecondaryAction>;
  readonly onCustomizeSidebar: () => void;
}

/**
 * The last destination row: an ellipsis that opens the destinations the
 * sidebar does not list, in a popup beside the rail instead of the account
 * menu they wait in when the More row is off.
 */
export function SidebarMore(props: SidebarMoreProps) {
  return (
    <OctantMenuRoot>
      <OctantMenuTrigger
        aria-label="More destinations"
        className="sidebar-item window-no-drag justify-start"
      >
        <Ellipsis aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />
        <span className="sidebar-label">More</span>
      </OctantMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner align="start" side="right">
          <OctantMenuPopup
            aria-label="More destinations"
            className="w-[min(248px,calc(100vw-24px))]"
          >
            <OctantMenuGroup aria-label="Destinations">
              {props.items.map((item) => {
                const Icon = secondaryIcons[item.id];
                return (
                  <OctantMenuItem key={item.id} onClick={item.onSelect}>
                    <Icon aria-hidden={true} className="icon" size={16} strokeWidth={1.5} />
                    <span>{item.label}</span>
                  </OctantMenuItem>
                );
              })}
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

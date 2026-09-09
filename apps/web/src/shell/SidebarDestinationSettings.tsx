import type { SidebarDestinationCustomization } from "@octant/contracts/shell";
import { ChevronDown, ChevronUp } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField, type OctantSelectOption } from "../ui/base/OctantSelect";
import { IconButton } from "./IconButton";
import {
  moveSidebarDestination,
  setSidebarDestinationVisibility,
  sidebarDestinationOrder,
  sidebarDestinationVisibility,
  type SidebarDestinationPlacement,
} from "./navigationModel";

const visibilityOptions: Record<SidebarDestinationPlacement, ReadonlyArray<OctantSelectOption>> = {
  primary: [
    { id: "shown", label: "Always show" },
    { id: "hidden", label: "Don't show" },
  ],
  menu: [
    { id: "shown", label: "Always show" },
    { id: "menu", label: "Menu only" },
    { id: "hidden", label: "Don't show" },
  ],
};

export interface SidebarDestinationSettingsProps {
  readonly customization: SidebarDestinationCustomization;
  readonly onChange: (next: SidebarDestinationCustomization) => void;
}

/**
 * Editor for where each destination lives: a sidebar row, the account menu,
 * or nowhere — and in what order. The rows mirror the live sidebar, so moving
 * a destination here moves it there.
 */
export function SidebarDestinationSettings(props: SidebarDestinationSettingsProps) {
  const destinations = sidebarDestinationOrder(props.customization);
  return (
    <div className="flex w-full flex-col gap-3">
      <ul className="flex flex-col">
        {destinations.map((destination, index) => (
          <li className="flex items-center justify-between gap-2 py-1" key={destination.id}>
            <span className="min-w-0 flex-1 truncate text-sm">{destination.label}</span>
            <OctantSelectField
              aria-label={`${destination.label} visibility`}
              onValueChange={(value) => {
                if (value === "shown" || value === "menu" || value === "hidden") {
                  props.onChange(
                    setSidebarDestinationVisibility(props.customization, destination.id, value),
                  );
                }
              }}
              options={visibilityOptions[destination.placement]}
              triggerClassName="w-32 shrink-0"
              value={sidebarDestinationVisibility(props.customization, destination.id)}
            />
            <span className="flex shrink-0 items-center gap-1">
              <IconButton
                disabled={index === 0}
                icon={ChevronUp}
                label={`Move ${destination.label} up`}
                onClick={() =>
                  props.onChange(moveSidebarDestination(props.customization, destination.id, "up"))
                }
              />
              <IconButton
                disabled={index === destinations.length - 1}
                icon={ChevronDown}
                label={`Move ${destination.label} down`}
                onClick={() =>
                  props.onChange(
                    moveSidebarDestination(props.customization, destination.id, "down"),
                  )
                }
              />
            </span>
          </li>
        ))}
      </ul>
      <div>
        <OctantButton
          onClick={() => props.onChange({ order: [], visibility: [] })}
          size="sm"
          type="button"
          variant="secondary"
        >
          Reset sidebar destinations
        </OctantButton>
      </div>
    </div>
  );
}

import type { OctantMode } from "@octant/contracts/modes";
import {
  CircleCheck,
  CirclePlay,
  Eye,
  Folder,
  History,
  Inbox,
  PanelLeftOpen,
  Search,
  Settings,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { modeIcons, modeLabels, modeOrder } from "./ModeSwitcher";
import type { SidebarTile, SidebarTileId } from "./SidebarCountTiles";
import { navigationIcon } from "./SidebarNavigation";
import type { SidebarNavigationDescriptorId } from "./navigationModel";

export interface SidebarRailProject {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly onOpen: () => void;
}

export interface SidebarRailProps {
  readonly nativeHost: boolean;
  readonly onExpand: () => void;
  readonly newThread?: { readonly label: string; readonly onSelect: () => void };
  readonly onOpenSearch?: () => void;
  readonly activeMode: OctantMode;
  readonly modes: ReadonlyArray<OctantMode>;
  readonly onSelectMode: (mode: OctantMode) => void;
  /** The count tiles, drawn as icons with their counts as badges. */
  readonly tiles: ReadonlyArray<SidebarTile>;
  /** Destination rows still shown beside the tiles (Board, Pull requests, …). */
  readonly destinations: ReadonlyArray<{
    readonly id: SidebarNavigationDescriptorId;
    readonly label: string;
    readonly onSelect: () => void;
    readonly active: boolean;
  }>;
  readonly projects: ReadonlyArray<SidebarRailProject>;
  readonly onOpenProjects?: () => void;
  readonly onOpenActivity?: () => void;
  readonly onOpenSettings: () => void;
}

const TILE_RAIL: Readonly<
  Record<SidebarTileId, { readonly label: string; readonly icon: LucideIcon }>
> = {
  inbox: { label: "Inbox", icon: Inbox },
  running: { label: "Running", icon: CirclePlay },
  review: { label: "To review", icon: Eye },
  done: { label: "Done today", icon: CircleCheck },
};

/** Projects past this many wait behind the folder button rather than scroll the rail. */
const RAIL_PROJECT_LIMIT = 6;

/**
 * What a collapsed sidebar leaves: one column of the places the full sidebar
 * offers, as icons. Hiding the sidebar used to remove every route to them but
 * the window chrome's Show sidebar, so a person who wanted more room lost the
 * counts, the modes, and their Projects with it.
 */
export function SidebarRail(props: SidebarRailProps) {
  const modes = modeOrder.filter((mode) => props.modes.includes(mode));
  const visibleProjects = props.projects.slice(0, RAIL_PROJECT_LIMIT);
  return (
    <aside aria-label="Octant sidebar, collapsed" className="sidebar-rail" data-octant-sidebar-rail>
      {props.nativeHost ? (
        <span aria-hidden="true" className="sidebar-rail__traffic-lights window-drag-region" />
      ) : null}
      <nav aria-label="Collapsed sidebar" className="sidebar-rail__column window-no-drag">
        <RailButton icon={PanelLeftOpen} label="Show sidebar" onSelect={props.onExpand} />
        {props.newThread === undefined ? null : (
          <RailButton
            icon={SquarePen}
            label={props.newThread.label}
            onSelect={props.newThread.onSelect}
          />
        )}
        {props.onOpenSearch === undefined ? null : (
          <RailButton icon={Search} label="Search" onSelect={props.onOpenSearch} />
        )}
        {modes.length < 2 ? null : (
          <>
            <RailDivider />
            <div aria-label="Workspace mode" className="sidebar-rail__group" role="group">
              {modes.map((mode) => (
                <RailButton
                  active={mode === props.activeMode}
                  icon={modeIcons[mode]}
                  key={mode}
                  label={modeLabels[mode]}
                  onSelect={() => {
                    if (mode !== props.activeMode) props.onSelectMode(mode);
                  }}
                />
              ))}
            </div>
          </>
        )}
        {props.tiles.length === 0 && props.destinations.length === 0 ? null : <RailDivider />}
        {props.tiles.map((tile) => {
          const rail = TILE_RAIL[tile.id];
          return (
            <RailButton
              active={tile.active === true}
              badge={tile.count}
              icon={rail.icon}
              key={tile.id}
              label={`${rail.label}, ${tile.count}`}
              {...(tile.onSelect === undefined ? {} : { onSelect: tile.onSelect })}
            />
          );
        })}
        {props.destinations.map((destination) => {
          const Icon = navigationIcon(destination.id);
          return Icon === undefined ? null : (
            <RailButton
              active={destination.active}
              icon={Icon}
              key={destination.id}
              label={destination.label}
              onSelect={destination.onSelect}
            />
          );
        })}
        {visibleProjects.length === 0 && props.onOpenProjects === undefined ? null : (
          <RailDivider />
        )}
        {visibleProjects.map((project) => (
          <RailButton
            active={project.active}
            key={project.id}
            label={project.name}
            onSelect={project.onOpen}
          >
            <span aria-hidden="true" className="sidebar-rail__project">
              {projectInitial(project.name)}
            </span>
          </RailButton>
        ))}
        {props.onOpenProjects === undefined ? null : (
          <RailButton icon={Folder} label="Projects" onSelect={props.onOpenProjects} />
        )}
        {props.onOpenActivity === undefined ? null : (
          <RailButton icon={History} label="Activity feed" onSelect={props.onOpenActivity} />
        )}
        <span aria-hidden="true" className="sidebar-rail__spacer" />
        <RailButton icon={Settings} label="Settings" onSelect={props.onOpenSettings} />
      </nav>
    </aside>
  );
}

function projectInitial(name: string): string {
  const letter = name.trim().match(/[\p{L}\p{N}]/u)?.[0];
  return letter === undefined ? "·" : letter.toLocaleUpperCase();
}

function RailDivider() {
  return <span aria-hidden="true" className="sidebar-rail__divider" />;
}

/**
 * One rail control. The link recipe paints nothing; the face inside carries
 * the hover and current fills, as the count tiles do, so the shared button
 * recipe is never repainted. The name is the visible tooltip too, because an
 * icon alone names nothing for a sighted reader.
 */
function RailButton(props: {
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly badge?: number;
  readonly active?: boolean;
  readonly onSelect?: () => void;
  readonly children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <OctantButton
      aria-current={props.active === true ? "page" : undefined}
      aria-label={props.label}
      className="sidebar-rail__button window-no-drag hover:no-underline"
      disabled={props.onSelect === undefined}
      onClick={() => props.onSelect?.()}
      title={props.label}
      type="button"
      variant="link"
    >
      <span aria-hidden="true" className="sidebar-rail__face">
        {Icon === undefined ? null : <Icon size={16} strokeWidth={1.7} />}
        {props.children}
        {props.badge === undefined || props.badge === 0 ? null : (
          <span className="sidebar-rail__badge">{props.badge > 99 ? "99+" : props.badge}</span>
        )}
      </span>
    </OctantButton>
  );
}

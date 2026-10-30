import type { OctantMode } from "@octant/contracts/modes";
import {
  Activity,
  CheckCheck,
  ClipboardCheck,
  Folders,
  House,
  Inbox,
  LoaderCircle,
  Search,
  Settings,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { modeIcons, modeLabels } from "./ModeSwitcher";
import { visibleModeOf, visibleModes, type VisibleMode } from "./workKind";
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
  /**
   * `beside` stands next to the open sidebar, which already offers New
   * thread, Search, the modes, and the Projects list, so the rail keeps only
   * the places and counts. `collapsed` replaces a hidden sidebar. Show
   * sidebar, Back, and Forward live in the title band in both, so the rail
   * stays one icon wide.
   */
  readonly placement?: "collapsed" | "beside";
  readonly newThread?: { readonly label: string; readonly onSelect: () => void };
  readonly onOpenSearch?: () => void;
  readonly activeMode: OctantMode;
  readonly modes: ReadonlyArray<OctantMode>;
  readonly onSelectMode: (mode: VisibleMode) => void;
  /** The way back to the mode's start screen, first among the places. */
  readonly home?: { readonly onOpen: () => void; readonly active: boolean };
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
  /** Whether the Projects page is the one showing. */
  readonly projectsActive?: boolean;
  readonly onOpenActivity?: () => void;
  readonly onOpenSettings: () => void;
  /** Plan usage rings, drawn at the foot above Settings. */
  readonly usage?: ReactNode;
  /** The More menu: destinations the rail does not list, and Customize sidebar. */
  readonly more?: ReactNode;
}

const TILE_RAIL: Readonly<
  Record<SidebarTileId, { readonly label: string; readonly icon: LucideIcon }>
> = {
  inbox: { label: "Inbox", icon: Inbox },
  running: { label: "Running", icon: LoaderCircle },
  review: { label: "To review", icon: ClipboardCheck },
  done: { label: "Done today", icon: CheckCheck },
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
  const modes = visibleModes(props.modes);
  const activeMode = visibleModeOf(props.activeMode);
  const beside = props.placement === "beside";
  const visibleProjects = beside ? [] : props.projects.slice(0, RAIL_PROJECT_LIMIT);
  return (
    <aside
      aria-label={beside ? "Destinations" : "Octant sidebar, collapsed"}
      className={beside ? "sidebar-rail sidebar-rail--beside" : "sidebar-rail"}
      data-native-host={props.nativeHost ? "" : undefined}
      data-octant-sidebar-rail
    >
      {props.nativeHost ? (
        <span aria-hidden="true" className="sidebar-rail__traffic-lights window-drag-region" />
      ) : null}
      <nav
        aria-label={beside ? "Destinations" : "Collapsed sidebar"}
        className="sidebar-rail__column window-no-drag"
      >
        {beside || props.newThread === undefined ? null : (
          <RailButton
            icon={SquarePen}
            label={props.newThread.label}
            onSelect={props.newThread.onSelect}
          />
        )}
        {beside || props.onOpenSearch === undefined ? null : (
          <RailButton icon={Search} label="Search" onSelect={props.onOpenSearch} />
        )}
        {beside || modes.length < 2 ? null : (
          <>
            <RailDivider />
            <div aria-label="Workspace mode" className="sidebar-rail__group" role="group">
              {modes.map((mode) => (
                <RailButton
                  active={mode === activeMode}
                  icon={modeIcons[mode]}
                  key={mode}
                  label={modeLabels[mode]}
                  onSelect={() => {
                    if (mode !== activeMode) props.onSelectMode(mode);
                  }}
                />
              ))}
            </div>
          </>
        )}
        {beside ||
        (props.home === undefined &&
          props.tiles.length === 0 &&
          props.destinations.length === 0) ? null : (
          <RailDivider />
        )}
        {props.home === undefined ? null : (
          <RailButton
            active={props.home.active}
            icon={House}
            label="Home"
            onSelect={props.home.onOpen}
          />
        )}
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
        {props.onOpenActivity === undefined ? null : (
          <RailButton icon={Activity} label="Activity feed" onSelect={props.onOpenActivity} />
        )}
        {props.onOpenProjects === undefined ? null : (
          <RailButton
            active={props.projectsActive === true}
            icon={Folders}
            label="Projects"
            onSelect={props.onOpenProjects}
          />
        )}
        {props.more}
        <span aria-hidden="true" className="sidebar-rail__spacer" />
        {props.usage}
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
 * recipe is never repainted. The name also shows as a label beside the rail
 * on hover and keyboard focus, because an icon alone names nothing for a
 * sighted reader, and the native title tooltip was slow and easy to miss.
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
    <OctantTooltip label={props.label} side="right">
      <OctantButton
        aria-current={props.active === true ? "page" : undefined}
        aria-label={props.label}
        className="sidebar-rail__button window-no-drag hover:no-underline"
        disabled={props.onSelect === undefined}
        onClick={() => props.onSelect?.()}
        type="button"
        variant="link"
      >
        <span aria-hidden="true" className="sidebar-rail__face">
          {Icon === undefined ? null : <Icon size={20} strokeWidth={1.7} />}
          {props.children}
          {props.badge === undefined || props.badge === 0 ? null : (
            <span className="sidebar-rail__badge">{props.badge > 99 ? "99+" : props.badge}</span>
          )}
        </span>
      </OctantButton>
    </OctantTooltip>
  );
}

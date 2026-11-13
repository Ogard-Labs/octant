import type { OctantMode } from "@octant/contracts/modes";
import {
  Folders,
  House,
  ScrollText,
  Search,
  Settings,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantContextMenu } from "../ui/base/OctantContextMenu";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { iconForVisibleMode, modeLabels } from "./ModeSwitcher";
import { visibleModeOf, visibleModes, type VisibleMode } from "./workKind";
import { TILE_ICONS, type SidebarTile, type SidebarTileId } from "./SidebarCountTiles";
import { navigationIcon } from "./SidebarNavigation";
import { ProjectIcon } from "../projects/ProjectIcon";
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
  /** The automatic list: the first Projects, drawn only in the collapsed rail. */
  readonly projects: ReadonlyArray<SidebarRailProject>;
  /**
   * Projects the person pinned, in the order they pinned them, already
   * resolved against the Projects that exist. They show in both placements.
   */
  readonly pinnedProjects?: ReadonlyArray<SidebarRailProject>;
  /** Unpins a Project from a pinned tile's context menu. */
  readonly onUnpinProject?: (projectId: string) => void;
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
  inbox: { label: "Inbox", icon: TILE_ICONS.inbox },
  running: { label: "Running", icon: TILE_ICONS.running },
  review: { label: "To review", icon: TILE_ICONS.review },
  done: { label: "Done today", icon: TILE_ICONS.done },
};

/**
 * Project tiles past this many wait behind the folder button rather than push
 * Settings and the usage rings out of the window. Pins count against it first
 * in the collapsed rail, and the beside rail draws no more than this many of
 * them: the sidebar next to it lists every Project anyway.
 */
export const RAIL_PROJECT_LIMIT = 6;

/**
 * The pinned Projects that still exist, in pin order. A pin for a Project that
 * is gone draws nothing.
 */
export function resolveRailPins<P extends { readonly id: string }>(
  pinnedIds: ReadonlyArray<string>,
  existing: ReadonlyArray<P>,
): ReadonlyArray<P> {
  const byId = new Map(existing.map((project) => [String(project.id), project] as const));
  return pinnedIds.flatMap((id) => {
    const project = byId.get(id);
    return project === undefined ? [] : [project];
  });
}

/**
 * The pin list to save after pinning or unpinning one Project. Pins for
 * Projects that no longer exist are dropped here, the next time pins are saved,
 * but only when `existingIds` is the complete, loaded Project list. Without it
 * (still loading, or refused) every other pin is kept: an empty list is not
 * evidence that a Project is gone.
 */
export function savedRailPins<Id extends string>(
  saved: ReadonlyArray<Id>,
  existingIds: ReadonlySet<string> | undefined,
  projectId: Id,
  pinned: boolean,
): ReadonlyArray<Id> {
  const kept = saved.filter(
    (id) => id !== projectId && (existingIds === undefined || existingIds.has(id)),
  );
  return pinned ? [...kept, projectId] : kept;
}

/** What the rail draws: pins first, then the automatic list fills what is left. */
function railProjectTiles(
  placement: "collapsed" | "beside",
  pinned: ReadonlyArray<SidebarRailProject>,
  automatic: ReadonlyArray<SidebarRailProject>,
): ReadonlyArray<{ readonly project: SidebarRailProject; readonly pinned: boolean }> {
  const pins = pinned.slice(0, RAIL_PROJECT_LIMIT);
  const pinnedIds = new Set(pins.map((project) => String(project.id)));
  const rest =
    placement === "beside"
      ? []
      : automatic
          .filter((project) => !pinnedIds.has(String(project.id)))
          .slice(0, RAIL_PROJECT_LIMIT - pins.length);
  return [
    ...pins.map((project) => ({ project, pinned: true })),
    ...rest.map((project) => ({ project, pinned: false })),
  ];
}

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
  const visibleProjects = railProjectTiles(
    beside ? "beside" : "collapsed",
    props.pinnedProjects ?? [],
    props.projects,
  );
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
        <div className="sidebar-rail__scroll">
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
                    icon={iconForVisibleMode(mode, false)}
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
                tile={tile.id}
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
          {visibleProjects.map(({ project, pinned }) => {
            const tile = (
              <RailButton active={project.active} label={project.name} onSelect={project.onOpen}>
                <ProjectIcon
                  fallback={
                    <span aria-hidden="true" className="sidebar-rail__project">
                      {projectInitial(project.name)}
                    </span>
                  }
                  projectId={String(project.id)}
                  size={20}
                />
              </RailButton>
            );
            const unpin = props.onUnpinProject;
            return pinned && unpin !== undefined ? (
              <OctantContextMenu
                items={[{ label: "Unpin from rail", value: "unpin" }]}
                key={project.id}
                onValueChange={() => unpin(String(project.id))}
                triggerClassName="sidebar-rail__tile"
              >
                {tile}
              </OctantContextMenu>
            ) : (
              <Fragment key={project.id}>{tile}</Fragment>
            );
          })}
          {props.onOpenActivity === undefined ? null : (
            <RailButton icon={ScrollText} label="Activity feed" onSelect={props.onOpenActivity} />
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
        </div>
        <div className="sidebar-rail__foot">
          {props.usage}
          <RailButton icon={Settings} label="Settings" onSelect={props.onOpenSettings} />
        </div>
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
  /** Which count this is; the Colour style gives its icon the tile's hue. */
  readonly tile?: SidebarTileId;
  readonly children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <OctantTooltip label={props.label} side="right">
      <OctantButton
        aria-current={props.active === true ? "page" : undefined}
        aria-label={props.label}
        className="sidebar-rail__button window-no-drag hover:no-underline"
        data-tile={props.tile}
        disabled={props.onSelect === undefined}
        onClick={() => props.onSelect?.()}
        type="button"
        variant="rail"
      >
        <span aria-hidden="true" className="sidebar-rail__face">
          {Icon === undefined ? null : <Icon size={20} />}
          {props.children}
          {props.badge === undefined || props.badge === 0 ? null : (
            <span className="sidebar-rail__badge">{props.badge > 99 ? "99+" : props.badge}</span>
          )}
        </span>
      </OctantButton>
    </OctantTooltip>
  );
}

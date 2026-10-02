import { CircleCheck, CirclePlay, Eye, Inbox, type LucideIcon } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export type SidebarTileId = "inbox" | "running" | "review" | "done";

export interface SidebarTile {
  readonly id: SidebarTileId;
  readonly count: number;
  /** Absent leaves the tile showing its count with nowhere to go. */
  readonly onSelect?: () => void;
  readonly active?: boolean;
}

const TILE_LABELS: Readonly<Record<SidebarTileId, string>> = {
  inbox: "Inbox",
  running: "Running",
  review: "To review",
  done: "Done today",
};

const TILE_ICONS: Readonly<Record<SidebarTileId, LucideIcon>> = {
  inbox: Inbox,
  running: CirclePlay,
  review: Eye,
  done: CircleCheck,
};

/**
 * The sidebar's four counts as tiles: what needs the person, what is running,
 * what finished unread, and what was completed today. Each tile is one button
 * whose name carries the count, so a screen reader hears "Running, 2" rather
 * than a bare number beside a label.
 */
export function SidebarCountTiles(props: { readonly tiles: ReadonlyArray<SidebarTile> }) {
  return (
    <div aria-label="Thread counts" className="sidebar-tiles" role="group">
      {props.tiles.map((tile) => {
        const Icon = TILE_ICONS[tile.id];
        const label = TILE_LABELS[tile.id];
        return (
          <OctantButton
            aria-current={tile.active === true ? "page" : undefined}
            aria-label={`${label}, ${tile.count}`}
            // The link variant draws nothing of its own; the face inside the
            // button carries the tile's paint, so the shared button recipe is
            // never repainted from a feature stylesheet.
            className="sidebar-tile window-no-drag hover:no-underline"
            data-tile={tile.id}
            disabled={tile.onSelect === undefined}
            key={tile.id}
            onClick={() => tile.onSelect?.()}
            type="button"
            variant="link"
          >
            <span aria-hidden="true" className="sidebar-tile__face">
              <span className="sidebar-tile__top">
                <Icon className="sidebar-tile__icon" size={16} strokeWidth={1.8} />
                <span className="sidebar-tile__count">{tile.count}</span>
              </span>
              <span className="sidebar-tile__label">{label}</span>
            </span>
          </OctantButton>
        );
      })}
    </div>
  );
}

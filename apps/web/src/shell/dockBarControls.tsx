import type { LucideIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** An action everyone knows: an icon button with a tooltip. */
export interface DockBarButton {
  readonly kind: "button";
  readonly id: string;
  /** The accessible name and, unless `title` says more, the tooltip. */
  readonly label: string;
  readonly title?: string;
  readonly icon: LucideIcon;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /**
   * A state that must read at a glance (View only) stays in words: the button
   * shows its label, never folds into the More menu while it is there and, as a
   * cue, moves to the secondary row rather than being cut.
   */
  readonly words?: boolean;
}

/** An icon button that opens a menu of actions (Terminal's, a device's More). */
export interface DockBarMenu {
  readonly kind: "menu";
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
  }>;
  readonly onSelect: (item: string) => void;
}

/**
 * Navigation between a tool's views or places: words, never icons. Drawn as a
 * small word switch with the pressed option marked; when the words do not fit
 * it becomes one control showing the current option's name, with a menu of the
 * rest. `compact` keeps it that way (a long list of devices is a menu).
 */
export interface DockBarChoice {
  readonly kind: "choice";
  readonly id: string;
  /** Names the group for assistive technology and, folded, the menu. */
  readonly label: string;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    /** The menu row's second line (a device's system and state). */
    readonly description?: string;
  }>;
  readonly value: string;
  readonly onChange: (option: string) => void;
  readonly compact?: boolean;
}

/** A quiet word or two the tool says about itself: a count, a state. */
export interface DockBarText {
  readonly kind: "text";
  readonly id: string;
  readonly text: string;
  /** Announced politely when it changes. */
  readonly live?: boolean;
  /** A status mark before the words (running, busy, lost, idle). */
  readonly dot?: "running" | "busy" | "lost" | "idle";
  /**
   * A cue a person must be able to read (a billed Desktop's provider and place).
   * It is never cut to an ellipsis: when the bar cannot hold it beside the
   * tool's name it moves to the one secondary row.
   */
  readonly cue?: boolean;
}

/**
 * A control the tool draws itself (a popover trigger with its own panel). It
 * never folds and is measured as drawn; `width` is only the room kept for it
 * before it has been. Where the bar cannot hold it, it moves to the one
 * secondary row without being remounted.
 */
export interface DockBarNode {
  readonly kind: "node";
  readonly id: string;
  readonly width: number;
  readonly node: ReactNode;
}

export type DockBarItem = DockBarButton | DockBarMenu | DockBarChoice | DockBarText | DockBarNode;

/**
 * Where a tool's controls stand: in its tile's bar beside the other tiles'
 * (`tiled`), in the one slim row a tool shown alone gets (`alone`), or in the
 * bottom panel's bar (`bottom`).
 */
export type DockBarPlacement = "tiled" | "alone" | "bottom";

export interface DockBarHost {
  readonly placement: DockBarPlacement;
  /** One registrant's items, or undefined to clear them. */
  readonly set: (owner: string, items: ReadonlyArray<DockBarItem> | undefined) => void;
}

/** Provided by a tile (and the bottom panel) around its tool. */
export const DockBarContext = createContext<DockBarHost | undefined>(undefined);

/** Where the tool's controls would stand, or undefined where nothing hosts them. */
export function useDockBarPlacement(): DockBarPlacement | undefined {
  return useContext(DockBarContext)?.placement;
}

/**
 * Passes a tool's bar controls up to whatever shows it. The host lays them out
 * and folds them; a tool shown where nothing hosts them (a central tab) keeps
 * drawing its own header, which `undefined` tells it. Items are matched by `id`,
 * so a callback that changes between renders never re-registers them.
 */
export function useDockBarControls(
  items: ReadonlyArray<DockBarItem>,
): DockBarPlacement | undefined {
  const host = useContext(DockBarContext);
  const owner = useId();
  const latest = useRef(items);
  latest.current = items;
  const hasNode = items.some((item) => item.kind === "node");
  const shape = JSON.stringify(
    items.map((item) => {
      switch (item.kind) {
        case "button":
          return [item.id, item.label, item.title, item.disabled === true, item.words === true];
        case "menu":
          return [item.id, item.label, item.items];
        case "choice":
          return [item.id, item.label, item.value, item.options, item.compact === true];
        case "text":
          return [item.id, item.text, item.live === true, item.dot, item.cue === true];
        case "node":
          return [item.id, item.width];
      }
    }),
  );
  useLayoutEffect(
    () => {
      if (host === undefined) return;
      const current = (id: string) => latest.current.find((item) => item.id === id);
      host.set(
        owner,
        latest.current.map((item): DockBarItem => {
          if (item.kind === "button")
            return {
              ...item,
              onSelect: () => {
                const live = current(item.id);
                if (live?.kind === "button") live.onSelect();
              },
            };
          if (item.kind === "menu")
            return {
              ...item,
              onSelect: (id) => {
                const live = current(item.id);
                if (live?.kind === "menu") live.onSelect(id);
              },
            };
          if (item.kind === "choice")
            return {
              ...item,
              onChange: (option) => {
                const live = current(item.id);
                if (live?.kind === "choice") live.onChange(option);
              },
            };
          return item;
        }),
      );
      // A node is the tool's own element and changes with its state, so it is
      // handed up again after every render that holds one; the host re-renders,
      // the tool does not, so this settles.
      return hasNode ? undefined : () => host.set(owner, undefined);
    },
    hasNode ? undefined : [host, owner, shape],
  );
  // A tool that unmounts while holding nodes still clears its controls.
  useLayoutEffect(() => () => host?.set(owner, undefined), [host, owner]);
  return host?.placement;
}

const reported = new Set<string>();

/**
 * Every registrant's items in the order they registered. Two registrants that
 * hand up the same id would have drawn one control that acts for the wrong one
 * (a Refresh that refreshed only the last tree), so the later one is refused
 * and said so, once, in the console.
 */
export function mergeDockBarItems(
  byOwner: ReadonlyMap<string, ReadonlyArray<DockBarItem>>,
): ReadonlyArray<DockBarItem> | undefined {
  if (byOwner.size === 0) return undefined;
  const seen = new Set<string>();
  const merged: DockBarItem[] = [];
  for (const items of byOwner.values()) {
    for (const item of items) {
      if (seen.has(item.id)) {
        if (!reported.has(item.id)) {
          reported.add(item.id);
          console.error(
            `Two tools handed the dock bar a control with the id "${item.id}"; the later one was refused.`,
          );
        }
        continue;
      }
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * What a host of bar controls keeps: each registrant's items apart, so one
 * unmounting clears only its own, and the merged list to draw.
 */
export function useDockBarSlot(placement: DockBarPlacement): {
  readonly host: DockBarHost;
  readonly items: ReadonlyArray<DockBarItem> | undefined;
} {
  const [byOwner, setByOwner] = useState<ReadonlyMap<string, ReadonlyArray<DockBarItem>>>(
    new Map(),
  );
  const set = useCallback((owner: string, items: ReadonlyArray<DockBarItem> | undefined) => {
    setByOwner((current) => {
      const next = new Map(current);
      if (items === undefined) next.delete(owner);
      else next.set(owner, items);
      return next;
    });
  }, []);
  const host = useMemo(() => ({ placement, set }), [placement, set]);
  const items = useMemo(() => mergeDockBarItems(byOwner), [byOwner]);
  return { host, items };
}

import type { IconComponent } from "../ui/icons";
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
  readonly icon: IconComponent;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** A toggle that is on (Ignore whitespace): the button reads pressed. */
  readonly pressed?: boolean;
  /**
   * A state that must read at a glance (View only) stays in words: the button
   * shows its label rather than an icon. It is still a named control: at the
   * menu step it folds into the More menu before any state cue does.
   */
  readonly words?: boolean;
}

/** An icon button that opens a menu of actions (Terminal's, a device's More). */
export interface DockBarMenu {
  readonly kind: "menu";
  readonly id: string;
  readonly label: string;
  readonly icon: IconComponent;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
    /**
     * A row that holds a setting rather than starting an action. `radio` rows
     * that follow one another are one choice; `check` is a switch. Both read
     * `checked` and report a change through `onSelect` with their id.
     */
    readonly choice?: "radio" | "check";
    readonly checked?: boolean;
  }>;
  readonly onSelect: (item: string) => void;
  /**
   * Words for a setting in the menu that is not at its default (Review's
   * layout, whitespace). A menu that hides a setting says so on its button: a
   * dot, and these words as its description.
   */
  readonly active?: string;
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

/**
 * A quiet word or two the tool says about itself: a count, a state. State
 * outranks every named control: the bar folds it only after the actions and
 * view switches are in the More menu, and then into that menu's first rows,
 * with a badge on the More button that reads it.
 */
export interface DockBarText {
  readonly kind: "text";
  readonly id: string;
  readonly text: string;
  /** Announced politely when it changes. */
  readonly live?: boolean;
  /** A status mark before the words (running, busy, lost, idle). */
  readonly dot?: "running" | "busy" | "lost" | "idle";
  /**
   * A cue a person must be able to read (a billed Desktop's provider and
   * place): it is never cut to an ellipsis, and when it folds the More button
   * carries its badge.
   */
  readonly cue?: boolean;
  /**
   * How urgently the folded badge reads. Absent, it follows the dot: lost
   * reads as danger, busy as warning, anything else neutral.
   */
  readonly tone?: "warning" | "danger";
}

/**
 * A control the tool draws itself (a popover trigger with its own panel). It
 * never folds into the More menu and is measured as drawn; `width` is only the
 * room kept for it before it has been. Where the bar cannot hold it even with
 * the tool's name shortened, it moves — without being remounted — to the one
 * secondary row, which nothing else may share.
 */
export interface DockBarNode {
  readonly kind: "node";
  readonly id: string;
  readonly width: number;
  readonly node: ReactNode;
}

export type DockBarItem = DockBarButton | DockBarMenu | DockBarChoice | DockBarText | DockBarNode;

/**
 * Where a tool's controls stand: in its pane's bar (`tiled`, whether the tool
 * is shown alone or among tiles) or in the bottom panel's bar (`bottom`).
 */
export type DockBarPlacement = "tiled" | "bottom";

export interface DockBarHost {
  readonly placement: DockBarPlacement;
  /** One registrant's items, or undefined to clear them. */
  readonly set: (owner: string, items: ReadonlyArray<DockBarItem> | undefined) => void;
  /**
   * The bar's leading slot, where a tool with tabs of its own (Files' open
   * files) draws them in place of its name. Absent where the host has none.
   */
  readonly lead?: HTMLElement | null;
}

/** Provided by a tile (and the bottom panel) around its tool. */
export const DockBarContext = createContext<DockBarHost | undefined>(undefined);

/**
 * What the focused pane's bar offers right now, so the command palette can
 * list the same named commands the bar draws — the palette command and the
 * bar's own control close over the one registered callback.
 */
export interface FocusedDockToolSource {
  readonly toolLabel: string;
  readonly items: ReadonlyArray<DockBarItem>;
}

/**
 * One publication per owner, the last addressed wins: the focused tile or the
 * bottom panel writes its merged items with `set`, and only `focus` — a
 * pointer or focus the person gave that owner — promotes it to the palette's
 * source. Updating controls never re-promotes, so a background tool's fresh
 * items cannot steal the palette from the owner the person is in. An owner
 * clears only its own publication — when the focused owner unmounts, the
 * most recently published one stands back up instead of leaving the palette
 * empty.
 */
export interface FocusedDockTool {
  readonly get: () => FocusedDockToolSource | undefined;
  readonly set: (owner: string, source: FocusedDockToolSource | undefined) => void;
  readonly focus: (owner: string) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createFocusedDockTool(): FocusedDockTool {
  const sources = new Map<string, FocusedDockToolSource>();
  const listeners = new Set<() => void>();
  let focused: string | undefined;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => {
      if (focused !== undefined) {
        const source = sources.get(focused);
        if (source !== undefined) return source;
      }
      return [...sources.values()].at(-1);
    },
    set: (owner, source) => {
      if (source === undefined) {
        if (!sources.delete(owner)) return;
        if (focused === owner) focused = undefined;
      } else {
        // Insert in place: a refresh keeps its owner's rank, and a first
        // registration does not promote over whoever is focused.
        sources.set(owner, source);
      }
      emit();
    },
    focus: (owner) => {
      if (focused === owner) return;
      focused = owner;
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Mounted once above the shell's dock so focused tiles can publish to the palette. */
export const FocusedDockToolContext = createContext<FocusedDockTool | undefined>(undefined);

/**
 * The element a tool portals its own tabs into, so they stand in the pane's
 * bar where the Browser's pages do. Null where the host has no such slot (the
 * bottom panel, a central tab): the tool then draws its tab row itself.
 */
export function useDockBarLead(): HTMLElement | null {
  return useContext(DockBarContext)?.lead ?? null;
}

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
          return [
            item.id,
            item.label,
            item.title,
            item.disabled === true,
            item.words === true,
            item.pressed,
          ];
        case "menu":
          return [item.id, item.label, item.items, item.active];
        case "choice":
          return [item.id, item.label, item.value, item.options, item.compact === true];
        case "text":
          return [item.id, item.text, item.live === true, item.dot, item.cue === true, item.tone];
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
  /** Give this to the bar's leading slot element to let a tool draw its tabs there. */
  readonly leadRef: (node: HTMLElement | null) => void;
} {
  const [lead, setLead] = useState<HTMLElement | null>(null);
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
  const host = useMemo(() => ({ placement, set, lead }), [placement, set, lead]);
  const items = useMemo(() => mergeDockBarItems(byOwner), [byOwner]);
  return { host, items, leadRef: setLead };
}

import type { LucideIcon } from "lucide-react";
import { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";

/** An action in a tile's bar: an icon button that does one thing. */
export interface DockBarButton {
  readonly kind: "button";
  readonly id: string;
  /** The accessible name, the tooltip and, folded, the menu row. */
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
}

/** A view switch in a tile's bar: one icon button per option, one pressed. */
export interface DockBarChoice {
  readonly kind: "choice";
  readonly id: string;
  /** Names the group for assistive technology; folded, the menu's group label. */
  readonly label: string;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly icon: LucideIcon;
  }>;
  readonly value: string;
  readonly onChange: (option: string) => void;
}

export type DockBarItem = DockBarButton | DockBarChoice;

export interface DockBarHost {
  readonly set: (items: ReadonlyArray<DockBarItem> | undefined) => void;
}

/** Provided by a tile around its tool; absent in the bottom panel. */
export const DockBarContext = createContext<DockBarHost | undefined>(undefined);

/**
 * Passes a tool's bar controls up to the tile that shows it. The tile lays
 * them out between the tool's name and its own Arrange and Close, and folds
 * them into one menu when the bar is too narrow. Returns whether a tile took
 * them: a tool shown anywhere else (the bottom panel) keeps drawing its own
 * header. Controls are matched by `id`, so a callback that changes between
 * renders never re-registers them.
 */
export function useDockBarControls(items: ReadonlyArray<DockBarItem>): boolean {
  const host = useContext(DockBarContext);
  const latest = useRef(items);
  latest.current = items;
  const shape = JSON.stringify(
    items.map((item) =>
      item.kind === "button"
        ? [item.id, item.label, item.disabled === true]
        : [item.id, item.label, item.value, item.options.map((option) => option.id)],
    ),
  );
  useLayoutEffect(() => {
    if (host === undefined) return;
    const current = (id: string) => latest.current.find((item) => item.id === id);
    host.set(
      latest.current.map((item): DockBarItem => {
        if (item.kind === "button")
          return {
            ...item,
            onSelect: () => {
              const live = current(item.id);
              if (live?.kind === "button") live.onSelect();
            },
          };
        return {
          ...item,
          onChange: (option) => {
            const live = current(item.id);
            if (live?.kind === "choice") live.onChange(option);
          },
        };
      }),
    );
    return () => host.set(undefined);
    // `shape` stands for everything but the callbacks and icons.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [host, shape]);
  return host !== undefined;
}

export function useDockBarHost(
  set: (items: ReadonlyArray<DockBarItem> | undefined) => void,
): DockBarHost {
  return useMemo(() => ({ set }), [set]);
}

import type { ReactNode } from "react";
import { ShadcnDropdownMenu } from "../shadcn/dropdown-menu";

export interface OctantMenuItem {
  readonly description?: string;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly value: string;
}

export interface OctantMenuAction {
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface OctantMenuProps {
  readonly actions?: ReadonlyArray<OctantMenuAction>;
  readonly items: ReadonlyArray<OctantMenuItem>;
  readonly onValueChange: (value: string) => void;
  readonly trigger: ReactNode;
  /** Replaces the default trigger recipe when a surface owns one (e.g. `mode-trigger`). */
  readonly triggerClassName?: string;
  readonly triggerLabel: string;
  readonly value: string;
  readonly selectionMode?: "radio" | "action";
}

/** Octant menu adapter over the owned shadcn/Base UI DropdownMenu recipe. */
export function OctantMenu(props: OctantMenuProps) {
  return <ShadcnDropdownMenu {...props} />;
}

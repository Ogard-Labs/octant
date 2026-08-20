import type { ReactNode } from "react";
import { ShadcnDropdownMenu } from "../shadcn/dropdown-menu";

export interface OctantMenuItem {
  readonly description?: string;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly value: string;
}

export interface OctantMenuProps {
  readonly items: ReadonlyArray<OctantMenuItem>;
  readonly onValueChange: (value: string) => void;
  readonly trigger: ReactNode;
  /** Replaces the default trigger recipe when a surface owns one (e.g. `mode-trigger`). */
  readonly triggerClassName?: string;
  readonly triggerLabel: string;
  readonly value: string;
}

/** Octant menu adapter over the owned shadcn/Base UI DropdownMenu recipe. */
export function OctantMenu(props: OctantMenuProps) {
  return <ShadcnDropdownMenu {...props} />;
}

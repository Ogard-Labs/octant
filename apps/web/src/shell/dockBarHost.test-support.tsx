import type { ReactNode } from "react";
import { DockBarRow, type DockBarFold } from "./DockBarRow";
import { DockBarContext, useDockBarSlot, type DockBarPlacement } from "./dockBarControls";

/**
 * A real host of bar controls for a test: the same slot a tile and the bottom
 * panel keep, with the controls drawn in a `data-testid="bar"` region, so a
 * tool's controls are found where a person would find them.
 */
export function DockBarTestHost(props: {
  readonly placement: DockBarPlacement;
  readonly toolLabel?: string;
  /** How far the host has folded the controls; the default is none. */
  readonly fold?: DockBarFold;
  readonly children: ReactNode;
}) {
  const { host, items } = useDockBarSlot(props.placement);
  return (
    <DockBarContext.Provider value={host}>
      <div data-testid="bar">
        {items === undefined ? null : (
          <DockBarRow
            fold={props.fold ?? "full"}
            items={items}
            toolLabel={props.toolLabel ?? "Tool"}
          />
        )}
      </div>
      {props.children}
    </DockBarContext.Provider>
  );
}

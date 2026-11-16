import type { PaneId } from "@octant/contracts/shell";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DockToolButtons } from "./DockToolButtons";
import type { DockUtilityLauncherReference } from "./DockUtilityLauncher";
import type { DockToolButtonsModel } from "./dockToolButtonsModel";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

/**
 * What a thread pane's header needs to draw its tool buttons. The dock shows
 * the focused thread's tools, so the model describes that thread; the other
 * panes of a split draw the same tools at rest.
 */
export interface PaneDockTools {
  /** The focused pane's tools, as the dock shows them. */
  readonly model: DockToolButtonsModel;
  /** The pull requests the focused thread is about, listed after the tools. */
  readonly references?: ReadonlyArray<DockUtilityLauncherReference>;
  /**
   * A press on a pane's button. `fromRest` says the press began while the pane
   * was not the focused one: it then focuses the pane and shows the tool there,
   * and never closes one.
   */
  readonly onPress: (
    paneId: PaneId,
    surface: RightUtilityDockSurfaceId,
    opener: HTMLElement,
    fromRest: boolean,
  ) => void;
  readonly onMenuAction: (surface: RightUtilityDockSurfaceId, value: string) => void;
}

export const PaneDockToolsContext = createContext<PaneDockTools | undefined>(undefined);

/**
 * The tools of a pane that is not the focused one. None of them is on screen
 * (the dock holds the focused thread's), so no button is pressed, marked open,
 * or draggable, and a press only ever opens.
 */
export function restingDockToolButtons(model: DockToolButtonsModel): DockToolButtonsModel {
  const rest = (button: DockToolButtonsModel["buttons"][number]) => ({
    id: button.id,
    label: button.label,
    pressed: false,
    open: false,
    press: { kind: "open" } as const,
    tabIds: [],
    menu: [],
    ...(button.disabledReason === undefined ? {} : { disabledReason: button.disabledReason }),
  });
  return { buttons: model.buttons.map(rest), more: model.more.map(rest) };
}

/** The header width under which the title and a button per tool do not both fit. */
export const PANE_TOOLS_COLLAPSE_WIDTH = 440;

/**
 * A thread pane's tool buttons, at the right end of its header. In the focused
 * pane they are the dock's own row. In another pane of a split they stand at
 * rest, and a press focuses that pane and opens the tool for its thread.
 */
export function PaneDockToolGroup(props: { readonly active: boolean; readonly paneId: PaneId }) {
  const tools = useContext(PaneDockToolsContext);
  const group = useRef<HTMLDivElement>(null);
  const fromRest = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const model = useMemo(
    () =>
      tools === undefined
        ? undefined
        : props.active
          ? tools.model
          : restingDockToolButtons(tools.model),
    [props.active, tools],
  );
  const present = model !== undefined && model.buttons.length + model.more.length > 0;
  // The header decides: under the width that holds a title and the row, the
  // row folds into one menu button. Measured, not a container query, so one
  // set of buttons exists at a time.
  useLayoutEffect(() => {
    const header = group.current?.parentElement;
    if (header === null || header === undefined) return;
    const measure = () => {
      const width = header.getBoundingClientRect().width;
      if (width > 0) setCollapsed(width < PANE_TOOLS_COLLAPSE_WIDTH);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [present]);
  if (tools === undefined || model === undefined || !present) return null;
  const paneId = props.paneId;
  return (
    <div
      className="workspace-pane__tools window-no-drag"
      data-collapsed={collapsed ? "true" : undefined}
      // The pane takes the focus on the same pointer or key press, before the
      // click arrives; what the press does is decided by how the pane stood
      // when it began.
      onKeyDownCapture={() => {
        fromRest.current = !props.active;
      }}
      onPointerDownCapture={() => {
        fromRest.current = !props.active;
      }}
      ref={group}
    >
      <DockToolButtons
        collapsed={collapsed}
        dragSource={props.active}
        model={model}
        onMenuAction={tools.onMenuAction}
        onPress={(surface, opener) => {
          const rest = fromRest.current || !props.active;
          fromRest.current = false;
          tools.onPress(paneId, surface, opener, rest);
        }}
        {...(props.active && tools.references !== undefined
          ? { references: tools.references }
          : {})}
      />
    </div>
  );
}

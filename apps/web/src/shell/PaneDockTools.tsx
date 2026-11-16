import type { OctantMode } from "@octant/contracts/modes";
import type { PaneId } from "@octant/contracts/shell";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DockToolButtons } from "./DockToolButtons";
import type { DockUtilityLauncherReference } from "./DockUtilityLauncher";
import { isDockToolLaunchable, type DockToolCapabilities } from "./dockToolAvailability";
import { DOCK_TOOL_BUTTON_ORDER, type DockToolButtonsModel } from "./dockToolButtonsModel";
import { usePaneToolsHost } from "./paneToolsHost";
import {
  PANE_TOOLS_COLLAPSE_WIDTH,
  RIGHT_UTILITY_DOCK_SURFACES,
  TITLE_BAR_TOOLS_COLLAPSE_WIDTH,
  type RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";

/**
 * What a thread pane's header needs to draw its tool buttons. The dock shows
 * the focused thread's tools, so the model describes that thread. Another pane
 * of a split draws its own thread's row at rest.
 */
export interface PaneDockTools {
  /** The focused pane's tools, as the dock shows them. */
  readonly model: DockToolButtonsModel;
  /** The pull requests the focused thread is about, listed after the tools. */
  readonly references?: ReadonlyArray<DockUtilityLauncherReference>;
  /**
   * The tools a thread has open in its own dock, wherever the focus is: each
   * thread keeps its tabs while another pane has the dock. Absent, a resting
   * row marks nothing open.
   */
  readonly openTools?: (
    mode: OctantMode,
    threadId: string,
  ) => ReadonlyArray<RightUtilityDockSurfaceId>;
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
 * What is known of a thread whose pane is not the focused one. Its plan, its
 * delivery target, its Canvas and its written document are read only for the
 * focused thread, so at rest they count as absent and their tools are left
 * out unless the thread has one open.
 */
const RESTING_CAPABILITIES: DockToolCapabilities = {
  hasPlanArtifact: false,
  hasDelivery: false,
  hasCanvasDocument: false,
  hasWrittenDocument: false,
  hasAppleSimulator: false,
  hasChildRuns: "unknown",
  addAgentInvoked: false,
  hasExistingThread: true,
};

/**
 * The tool row of a pane that is not the focused one, for its own thread: the
 * tools its mode has, and a quiet open mark on each one the thread has open
 * in its dock. None of them is on screen (the dock holds the focused
 * thread's), so no button is pressed or draggable and a press only ever
 * opens. The row used to copy the focused thread's tools, so a Chat pane
 * beside a Code thread offered a Terminal, and a thread's open tools were
 * never marked.
 */
export function restingDockToolButtons(
  mode: OctantMode,
  open: ReadonlyArray<RightUtilityDockSurfaceId>,
): DockToolButtonsModel {
  const tools = RIGHT_UTILITY_DOCK_SURFACES.filter(
    (surface) =>
      (surface.modes as ReadonlyArray<OctantMode>).includes(mode) &&
      (open.includes(surface.id) || isDockToolLaunchable(surface.id, RESTING_CAPABILITIES)),
  ).map((surface) => ({
    id: surface.id,
    label: surface.label,
    pressed: false,
    open: open.includes(surface.id),
    press: { kind: "open" } as const,
    tabIds: [],
    menu: [],
  }));
  return {
    buttons: DOCK_TOOL_BUTTON_ORDER.flatMap((id) => tools.filter((tool) => tool.id === id)),
    more: tools.filter((tool) => !DOCK_TOOL_BUTTON_ORDER.includes(tool.id)),
  };
}

/** The gap between the items of a pane's header (`.workspace-pane__header`). */
const PANE_HEADER_GAP = 4;

/** How long after a press began its click may still arrive. */
const REST_PRESS_WINDOW_MS = 1_000;

/**
 * A thread pane's tool buttons. In a wide window the focused pane's row stands
 * at the end of the title bar (the bar's slot, `usePaneToolsHost`), above the
 * Environment section, and stays there whatever opens beside the thread; a
 * pane that is not the focused one draws no row, because the bar holds one.
 * Until 2026-11-16 the row stood in the pane's header on a line worked out
 * from the thread's narrowest width, which left it in the middle of the bar
 * with nothing open (maintainer request).
 *
 * With no slot (a narrow window, a pane by itself) the row is in the pane's
 * own header as before: the focused pane's is the dock's own row, and another
 * pane of a split stands at rest, where a press focuses that pane and opens
 * the tool for its thread.
 */
export function PaneDockToolGroup(props: {
  readonly active: boolean;
  readonly paneId: PaneId;
  /** The thread the pane holds; a pane at rest draws a row only for one. */
  readonly thread?: { readonly mode: OctantMode; readonly threadId: string } | undefined;
}) {
  const tools = useContext(PaneDockToolsContext);
  const barSlot = usePaneToolsHost();
  const group = useRef<HTMLDivElement>(null);
  // When the last press on the row began in a pane at rest, or 0.
  const restPressAt = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  const restMode = props.thread?.mode;
  const restThreadId = props.thread?.threadId;
  const model = useMemo(
    () =>
      tools === undefined
        ? undefined
        : props.active
          ? tools.model
          : restMode === undefined || restThreadId === undefined
            ? undefined
            : restingDockToolButtons(restMode, tools.openTools?.(restMode, restThreadId) ?? []),
    [props.active, restMode, restThreadId, tools],
  );
  const present = model !== undefined && model.buttons.length + model.more.length > 0;
  // The header decides: under the width that holds a title and the row, the
  // row folds into one menu button. Measured, not a container query, so one
  // set of buttons exists at a time.
  // The room is the header's own width, or less where the lead stops short of
  // the header's end: there it is the run from the pane's edge to the line the
  // row ends on. A lead that runs to the header's end, or to a split's Close
  // after it, is a pane narrower than that line, and the header's width counts
  // as it always has.
  useLayoutEffect(() => {
    if (barSlot !== null) {
      // In the title bar the bar's own width decides. The pane's header cannot:
      // it gives up the row's width at its end, so folding the row would widen
      // the header and unfold it again.
      const bar = barSlot.closest<HTMLElement>(".window-chrome");
      // Only the focused pane draws the row there, so only it measures.
      if (bar === null || !present || !props.active) return;
      const measureBar = () => {
        const width = bar.getBoundingClientRect().width;
        if (width > 0) setCollapsed(width < TITLE_BAR_TOOLS_COLLAPSE_WIDTH);
      };
      measureBar();
      if (typeof ResizeObserver === "undefined") return;
      const barObserver = new ResizeObserver(measureBar);
      barObserver.observe(bar);
      return () => barObserver.disconnect();
    }
    const lead = group.current?.parentElement;
    if (lead === null || lead === undefined) return;
    const header = lead.closest<HTMLElement>(".workspace-pane__header") ?? lead;
    const measure = () => {
      const box = header.getBoundingClientRect();
      const end = lead.nextElementSibling?.getBoundingClientRect().left ?? box.right;
      const run = lead.getBoundingClientRect().right;
      const width = run >= end - PANE_HEADER_GAP - 1 ? box.width : run - box.left;
      if (width > 0) setCollapsed(width < PANE_TOOLS_COLLAPSE_WIDTH);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(lead);
    if (header !== lead) observer.observe(header);
    return () => observer.disconnect();
  }, [present, barSlot, props.active]);
  if (tools === undefined || model === undefined || !present) return null;
  // The bar holds one row, the focused pane's.
  if (barSlot !== null && !props.active) return null;
  const paneId = props.paneId;
  const row = (
    <div
      className="workspace-pane__tools window-no-drag"
      data-collapsed={collapsed ? "true" : undefined}
      // The pane takes the focus on the same pointer or key press, before the
      // click arrives; what the press does is decided by how the pane stood
      // when it began.
      onKeyDownCapture={() => {
        restPressAt.current = props.active ? 0 : performance.now();
      }}
      onPointerDownCapture={() => {
        restPressAt.current = props.active ? 0 : performance.now();
      }}
      ref={group}
    >
      <DockToolButtons
        collapsed={collapsed}
        dragSource={props.active}
        model={model}
        onMenuAction={tools.onMenuAction}
        onPress={(surface, opener) => {
          // The mark only speaks for the click of its own press. A press that
          // never became a click (a right click, a drag off the button) left it
          // set, and a later press with no pointer or key event of its own (an
          // assistive press) was then read as coming from rest and refused to
          // close its tool.
          const rest =
            !props.active || performance.now() - restPressAt.current < REST_PRESS_WINDOW_MS;
          restPressAt.current = 0;
          tools.onPress(paneId, surface, opener, rest);
        }}
        {...(props.active && tools.references !== undefined
          ? { references: tools.references }
          : {})}
      />
    </div>
  );
  return barSlot === null ? row : createPortal(row, barSlot);
}

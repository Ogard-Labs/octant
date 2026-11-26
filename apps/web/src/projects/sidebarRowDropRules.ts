import type { ThreadRowActions } from "./ThreadRowMenu";
import type {
  SidebarRowDropAction,
  SidebarRowDropState,
  SidebarRowDropZone,
} from "./sidebarRowDrop";
import "./sidebar-row-drop.css";

/**
 * What a row dragged within the sidebar does, loaded with the first drag so
 * the window's first load does not carry it.
 */
export const SIDEBAR_ROW_DROP_LABELS: Readonly<Record<SidebarRowDropAction, string>> = {
  pin: "Pin",
  unpin: "Unpin",
  settle: "Settle",
  reopen: "Un-settle",
  wake: "Wake",
};

/**
 * The action a row dropped on a zone asks for, or none. Snoozed is never a
 * target, because a snooze needs a time the drop cannot give. Dragging a row
 * out of a shelf or the Pinned group, anywhere else in the list, undoes that
 * rest; a row dropped where it already is asks for nothing.
 */
export function sidebarRowDropAction(input: {
  readonly row: SidebarRowDropState;
  readonly zone: SidebarRowDropZone;
  readonly canPin: boolean;
}): SidebarRowDropAction | null {
  const { row, zone } = input;
  switch (zone) {
    case "pinned":
      return input.canPin && row.pinned !== true ? "pin" : null;
    case "completed":
      return row.shelf === "completed" ? null : "settle";
    case "snoozed":
      return null;
    case "list":
      if (row.shelf === "completed") return "reopen";
      if (row.shelf === "snoozed") return "wake";
      return input.canPin && row.fromPinned === true && row.pinned === true ? "unpin" : null;
  }
}

/**
 * The zone under a point. A shelf or the Pinned group sits inside the list,
 * so the narrower zone wins over the list around it.
 */
export function resolveSidebarRowDropZone(
  point: { readonly x: number; readonly y: number },
  zones: ReadonlyArray<{
    readonly zone: SidebarRowDropZone;
    readonly rect: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;
  }>,
): SidebarRowDropZone | null {
  const under = zones.filter(
    ({ rect }) =>
      point.x >= rect.left &&
      point.x <= rect.left + rect.width &&
      point.y >= rect.top &&
      point.y <= rect.top + rect.height,
  );
  return (under.find((entry) => entry.zone !== "list") ?? under[0])?.zone ?? null;
}

type DropRect = Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;

/**
 * The part of a zone the person can see: its box cut to every box that clips
 * it, or null when none of it shows. A bounding box ignores overflow, so a
 * Pinned group taller than the scrolling list reached under the dock below
 * and took a drop meant for the visible Settled shelf there.
 */
export function visibleSidebarRowDropRect(
  rect: DropRect,
  clips: ReadonlyArray<DropRect>,
): DropRect | null {
  let left = rect.left;
  let top = rect.top;
  let right = rect.left + rect.width;
  let bottom = rect.top + rect.height;
  for (const clip of clips) {
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.left + clip.width);
    bottom = Math.min(bottom, clip.top + clip.height);
  }
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function clippingBoxes(element: HTMLElement): ReadonlyArray<DropRect> {
  const boxes: Array<DropRect> = [];
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      boxes.push(ancestor.getBoundingClientRect());
    }
  }
  return boxes;
}

export function measureSidebarRowDropZones(
  root: ParentNode = document,
): ReadonlyArray<{ readonly zone: SidebarRowDropZone; readonly rect: DropRect }> {
  return [...root.querySelectorAll<HTMLElement>("[data-sidebar-row-drop]")].flatMap((element) => {
    const zone = element.dataset.sidebarRowDrop;
    if (zone !== "pinned" && zone !== "snoozed" && zone !== "completed" && zone !== "list") {
      return [];
    }
    const rect = visibleSidebarRowDropRect(element.getBoundingClientRect(), clippingBoxes(element));
    return rect === null ? [] : [{ zone, rect }];
  });
}

/** Where a row dragged over the sidebar lands, or null when the drop asks nothing. */
export function sidebarRowDropDestination(input: {
  readonly point: { readonly x: number; readonly y: number };
  readonly row: SidebarRowDropState;
  readonly canPin: boolean;
  readonly zones?: ReturnType<typeof measureSidebarRowDropZones>;
}): {
  readonly kind: "sidebar";
  readonly zone: SidebarRowDropZone;
  readonly action: SidebarRowDropAction;
  readonly label: string;
} | null {
  const zone = resolveSidebarRowDropZone(input.point, input.zones ?? measureSidebarRowDropZones());
  if (zone === null) return null;
  const action = sidebarRowDropAction({ row: input.row, zone, canPin: input.canPin });
  return action === null
    ? null
    : { kind: "sidebar", zone, action, label: SIDEBAR_ROW_DROP_LABELS[action] };
}

/**
 * Carries out a drop through the row menu's own handlers, so the host decides,
 * a refusal shows its sentence, and an accepted change offers Undo.
 */
export function runSidebarRowDrop(
  action: SidebarRowDropAction,
  rowId: string,
  actions: Pick<
    ThreadRowActions,
    "onPinThread" | "onCompleteThread" | "onReopenThread" | "onWakeThread"
  >,
): void {
  switch (action) {
    case "pin":
      return actions.onPinThread?.(rowId, true);
    case "unpin":
      return actions.onPinThread?.(rowId, false);
    case "settle":
      return actions.onCompleteThread?.(rowId);
    case "reopen":
      return actions.onReopenThread?.(rowId);
    case "wake":
      return actions.onWakeThread?.(rowId);
  }
}

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

export function measureSidebarRowDropZones(
  root: ParentNode = document,
): ReadonlyArray<{ readonly zone: SidebarRowDropZone; readonly rect: DOMRectReadOnly }> {
  return [...root.querySelectorAll<HTMLElement>("[data-sidebar-row-drop]")].flatMap((element) => {
    const zone = element.dataset.sidebarRowDrop;
    if (zone !== "pinned" && zone !== "snoozed" && zone !== "completed" && zone !== "list") {
      return [];
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    return [{ zone, rect }];
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

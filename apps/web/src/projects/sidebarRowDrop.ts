import { useState, useSyncExternalStore, type DragEvent } from "react";
import type { ThreadRowActions } from "./ThreadRowMenu";

/**
 * Where a sidebar thread row can land inside the sidebar itself: the Pinned
 * group, the Snoozed or Settled shelf, or anywhere else in the list. Each zone
 * is an element carrying `data-sidebar-row-drop`, measured when the pointer
 * moves, the way composer drop zones are.
 */
export type SidebarRowDropZone = "pinned" | "snoozed" | "completed" | "list";

/** What a drop in the sidebar asks of the thread; each is an existing row-menu action. */
export type SidebarRowDropAction = "pin" | "unpin" | "settle" | "reopen" | "wake";

/** What the dragged row was when the drag started. */
export interface SidebarRowDropState {
  readonly pinned?: boolean;
  readonly shelf?: "snoozed" | "completed";
  /** The row was dragged from the Pinned group, not just a pinned thread elsewhere. */
  readonly fromPinned?: boolean;
}

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
} | null {
  const zone = resolveSidebarRowDropZone(input.point, input.zones ?? measureSidebarRowDropZones());
  if (zone === null) return null;
  const action = sidebarRowDropAction({ row: input.row, zone, canPin: input.canPin });
  return action === null ? null : { kind: "sidebar", zone, action };
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

// The lit zone is a window-wide fact of the one drag in progress, read by the
// zones themselves so the whole sidebar does not re-render on each move.
let litZone: SidebarRowDropZone | undefined;
const listeners = new Set<() => void>();

export function setLitSidebarRowDropZone(zone: SidebarRowDropZone | undefined): void {
  if (litZone === zone) return;
  litZone = zone;
  for (const listener of listeners) listener();
}

export function useLitSidebarRowDropZone(): SidebarRowDropZone | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => litZone,
    () => litZone,
  );
}

function carriesFiles(transfer: DataTransfer | null): transfer is DataTransfer {
  return transfer !== null && [...transfer.types].includes("Files");
}

/**
 * Files from the computer dropped on a thread row: the row opens its thread
 * the way a click does, and the files wait for that thread's composer, which
 * attaches them through its own path and limits. Only a drag that carries
 * files lights the row; a dragged row or text passes over it untouched.
 */
export function useThreadRowFileDrop(
  open: () => void,
  offer: ((files: ReadonlyArray<File>) => void) | undefined,
): {
  readonly "data-file-drop-over"?: "true";
  readonly onDragOver?: (event: DragEvent<HTMLElement>) => void;
  readonly onDragLeave?: () => void;
  readonly onDrop?: (event: DragEvent<HTMLElement>) => void;
} {
  const [over, setOver] = useState(false);
  if (offer === undefined) return {};
  return {
    ...(over ? { "data-file-drop-over": "true" as const } : {}),
    onDragOver: (event) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (event) => {
      setOver(false);
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      const files = [...event.dataTransfer.files];
      if (files.length === 0) return;
      open();
      offer(files);
    },
  };
}

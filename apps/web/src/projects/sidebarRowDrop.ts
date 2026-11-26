import type { DragEvent } from "react";

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

/**
 * Lights the zone a dragged row is over, straight on the zones' own elements,
 * so the sidebar does not re-render on each move; none lights nothing. The
 * rules that pick the zone load with the first drag (`sidebarRowDropRules`).
 */
export function lightSidebarRowDropZone(zone: SidebarRowDropZone | undefined): void {
  // Applied on every move, so a zone drawn after the drag started is lit too.
  for (const element of document.querySelectorAll<HTMLElement>("[data-sidebar-row-drop]")) {
    if (element.dataset.sidebarRowDrop === zone) element.dataset.dropLit = "true";
    else delete element.dataset.dropLit;
  }
}

function carriesFiles(transfer: DataTransfer | null): transfer is DataTransfer {
  return transfer !== null && [...transfer.types].includes("Files");
}

let fileDropRow: HTMLElement | null = null;
function markFileDropRow(row: HTMLElement | null): void {
  if (fileDropRow === row) return;
  if (fileDropRow !== null) delete fileDropRow.dataset.fileDropOver;
  fileDropRow = row;
  if (row !== null) row.dataset.fileDropOver = "true";
}

function threadRowAt(target: EventTarget): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(".sidebar-navigation__thread[data-thread-id]")
    : null;
}

/**
 * Files from the computer dropped on a thread row, handled once for the whole
 * sidebar: the row opens its thread with its own click, and the files wait
 * for that thread's composer, which attaches them through its own path and
 * limits. Only a drag that carries files lights the row; a dragged row or
 * text passes over it untouched.
 */
export function sidebarFileDropHandlers(
  offer: ((threadId: string, files: ReadonlyArray<File>) => void) | undefined,
): {
  readonly onDragOver?: (event: DragEvent<HTMLElement>) => void;
  readonly onDragLeave?: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop?: (event: DragEvent<HTMLElement>) => void;
} {
  if (offer === undefined) return {};
  return {
    onDragOver: (event) => {
      const row = threadRowAt(event.target);
      if (row === null || !carriesFiles(event.dataTransfer)) return markFileDropRow(null);
      event.preventDefault();
      void import("./sidebar-row-drop.css");
      event.dataTransfer.dropEffect = "copy";
      markFileDropRow(row);
    },
    onDragLeave: (event) => {
      const into = event.relatedTarget;
      if (!(into instanceof Node && event.currentTarget.contains(into))) markFileDropRow(null);
    },
    onDrop: (event) => {
      markFileDropRow(null);
      const row = threadRowAt(event.target);
      const threadId = row?.dataset.threadId;
      if (row === null || threadId === undefined || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      const files = [...event.dataTransfer.files];
      if (files.length === 0) return;
      row.click();
      offer(threadId, files);
    },
  };
}

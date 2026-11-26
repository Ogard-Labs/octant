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

/**
 * Files from the computer dropped on a thread row, wherever the row is drawn
 * (the sidebar, a server's Projects, a Project's overview): the row opens its
 * thread through `open`, never through its click, which a cancelled drag may
 * have told to ignore the next press. The files then wait for that thread's
 * composer, which attaches them through its own path and limits. Only a drag
 * that carries files lights the row; a dragged row or text passes over it.
 */
export function threadRowFileDrop(
  open: () => void,
  offer: ((files: ReadonlyArray<File>) => void) | undefined,
): {
  readonly onDragOver?: (event: DragEvent<HTMLElement>) => void;
  readonly onDragLeave?: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop?: (event: DragEvent<HTMLElement>) => void;
} {
  if (offer === undefined) return {};
  return {
    onDragOver: (event) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      // Only the lit row's look; a stylesheet that fails to load costs nothing else.
      void import("./sidebar-row-drop.css").catch(() => undefined);
      event.dataTransfer.dropEffect = "copy";
      event.currentTarget.dataset.fileDropOver = "true";
    },
    onDragLeave: (event) => {
      delete event.currentTarget.dataset.fileDropOver;
    },
    onDrop: (event) => {
      delete event.currentTarget.dataset.fileDropOver;
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      const files = [...event.dataTransfer.files];
      if (files.length === 0) return;
      open();
      offer(files);
    },
  };
}

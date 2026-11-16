import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";

/**
 * A tool being dragged to a new place in the dock: by its pane's bar, or by
 * its button in the title band. The source is in one part of the window and
 * the drop zones in another, so they share this small store instead of a prop
 * path through the shell.
 *
 * The drag is pointer events, as the workspace's own tab drags are, not the
 * platform's drag-and-drop. That one moved nothing in the desktop window
 * (three slow drags of a bar onto another pane, 2026-11-16), and in a browser
 * tab a quick drag lost its drop: the zones are drawn as the drag begins, and
 * a release that arrives before the first "over" on a zone is no drop at all.
 * It had only ever been checked with made-up drag events. Pointer events need
 * no drag session, no data and no accepted target, and a real mouse, a test
 * and a driver all send the same ones.
 */
export interface DockToolDrag {
  readonly tabId: string;
  readonly source: "bar" | "button";
}

export interface DockDragPoint {
  readonly clientX: number;
  readonly clientY: number;
}

/** Somewhere a dragged tool can land. */
export interface DockDropTarget {
  /** The pointer moved; `undefined` once it is nowhere (the drag ended). */
  readonly over: (drag: DockToolDrag, point: DockDragPoint | undefined) => void;
  /** The pointer was released. True when this target took the tool. */
  readonly drop: (drag: DockToolDrag, point: DockDragPoint) => boolean;
}

/** How far a press travels before it is a drag and no longer a click. */
export const DOCK_DRAG_THRESHOLD = 6;

let dragged: DockToolDrag | undefined;
let cancelActive: (() => void) | undefined;
const listeners = new Set<() => void>();
const targets = new Set<DockDropTarget>();

function publish(next: DockToolDrag | undefined): void {
  if (dragged === next) return;
  dragged = next;
  for (const listener of Array.from(listeners)) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The tool being dragged, or undefined while none is. */
export function useDraggedDockTool(): DockToolDrag | undefined {
  return useSyncExternalStore(
    subscribe,
    () => dragged,
    () => undefined,
  );
}

export function registerDockDropTarget(target: DockDropTarget): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}

/** Abandons the drag in flight, as Escape does. */
export function cancelDockToolDrag(): void {
  cancelActive?.();
}

/**
 * Follows a press that may become a drag. Nothing changes until the pointer
 * has travelled the threshold, so a plain click on the bar, a tab or a tool's
 * button stays a click. From there the source holds the pointer, a small label
 * follows it, the drop targets are told where it is, and the release hands the
 * tool to the target under it. Escape, a cancelled pointer or a window that
 * loses focus ends the drag with nothing moved.
 */
export function pressDockToolDrag(
  event: ReactPointerEvent<HTMLElement>,
  tool: DockToolDrag & { readonly label: string },
): void {
  if (event.button !== 0) return;
  // A press whose release never reached the window must not hold the next one.
  cancelActive?.();
  const element = event.currentTarget;
  const pointerId = event.pointerId;
  const start = { x: event.clientX, y: event.clientY };
  const drag: DockToolDrag = { tabId: tool.tabId, source: tool.source };
  let started = false;
  let ghost: HTMLElement | undefined;

  const end = (point: DockDragPoint | undefined) => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onCancel);
    cancelActive = undefined;
    if (!started) return;
    ghost?.remove();
    try {
      element.releasePointerCapture?.(pointerId);
    } catch {
      // The pointer was already released.
    }
    if (point !== undefined) {
      for (const target of Array.from(targets)) {
        if (target.drop(drag, point)) break;
      }
    }
    for (const target of Array.from(targets)) target.over(drag, undefined);
    publish(undefined);
    // The release that ends a drag is not a click on whatever it began on: a
    // tool's button would close its tool, a tab would be chosen.
    const swallow = (click: MouseEvent) => {
      click.preventDefault();
      click.stopPropagation();
    };
    window.addEventListener("click", swallow, true);
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
  };
  const onMove = (move: PointerEvent) => {
    if (move.pointerId !== pointerId) return;
    if (!started) {
      if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < DOCK_DRAG_THRESHOLD) return;
      started = true;
      try {
        element.setPointerCapture?.(pointerId);
      } catch {
        // The source left the document; the window still hears the pointer.
      }
      window.getSelection()?.removeAllRanges();
      ghost = document.createElement("div");
      ghost.className = "workspace-drag-preview";
      ghost.setAttribute("aria-hidden", "true");
      ghost.textContent = tool.label;
      document.body.append(ghost);
      publish(drag);
    }
    move.preventDefault();
    ghost?.style.setProperty("--workspace-drag-preview-left", `${move.clientX + 12}px`);
    ghost?.style.setProperty("--workspace-drag-preview-top", `${move.clientY + 12}px`);
    for (const target of Array.from(targets)) target.over(drag, move);
  };
  const onUp = (up: PointerEvent) => {
    if (up.pointerId === pointerId) end(up);
  };
  const onCancel = () => end(undefined);
  const onKeyDown = (key: KeyboardEvent) => {
    if (key.key !== "Escape" || !started) return;
    key.preventDefault();
    key.stopPropagation();
    end(undefined);
  };
  cancelActive = onCancel;
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", onCancel);
}

import { useSyncExternalStore } from "react";

/**
 * The open tool being dragged from its button in the title band, by tab id.
 * The button is a drag source in one part of the window and the dock's drop
 * zones are the target in another, so the two share this small store instead
 * of a prop path through the shell.
 */
let dragged: string | undefined;
const listeners = new Set<() => void>();

function publish(next: string | undefined): void {
  if (dragged === next) return;
  dragged = next;
  for (const listener of Array.from(listeners)) listener();
}

export function startDockToolDrag(tabId: string): void {
  publish(tabId);
}

export function endDockToolDrag(): void {
  publish(undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The tab being dragged, or undefined while no tool is. */
export function useDraggedDockTool(): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => dragged,
    () => undefined,
  );
}

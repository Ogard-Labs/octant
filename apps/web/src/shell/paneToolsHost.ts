import { useSyncExternalStore } from "react";

/**
 * Where the focused pane's tool buttons stand in a wide window: a slot at the
 * end of the title bar, which the bar itself hands over when it mounts. The
 * row is drawn by the pane (it knows the thread and its tools) and placed in
 * the bar, so it stays at the bar's end whatever opens or closes beside the
 * thread. With no slot (a narrow window, a pane rendered by itself) the row
 * stays in the pane's own header.
 */
let host: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** The title bar's own ref callback for the slot. */
export function setPaneToolsHost(next: HTMLElement | null): void {
  if (host === next) return;
  host = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The slot at the end of the title bar, or null where the window has none. */
export function usePaneToolsHost(): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => host,
    () => null,
  );
}

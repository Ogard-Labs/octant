import type { ThreadRestUndoNotice } from "./threadRestRowActions";

/**
 * The one Undo notice this window shows. A newer change replaces it; a slower
 * reply to an older change, arriving after it, does not take its place. Only
 * code that loads with the first change reaches it, so the window's first
 * load does not carry it.
 */
let shown: ThreadRestUndoNotice | undefined;
let newest = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const threadRestUndoStore = {
  offer(notice: ThreadRestUndoNotice): void {
    if (notice.sequence < newest) return;
    newest = notice.sequence;
    shown = notice;
    emit();
  },
  dismiss(): void {
    if (shown === undefined) return;
    shown = undefined;
    emit();
  },
  current: (): ThreadRestUndoNotice | undefined => shown,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

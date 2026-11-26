import { latestThreadRestChange, type ThreadRestUndoNotice } from "./threadRestRowActions";

/**
 * The one Undo notice this window shows. A newer change replaces it; a slower
 * reply to an older change, arriving after it, does not take its place. Only
 * code that loads with the first change reaches it, so the window's first
 * load does not carry it.
 */
let shown: ThreadRestUndoNotice | undefined;
let newest = 0;
let retiredThrough = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const threadRestUndoStore = {
  offer(notice: ThreadRestUndoNotice): void {
    if (notice.sequence < newest || notice.sequence <= retiredThrough) return;
    newest = notice.sequence;
    shown = notice;
    emit();
  },
  dismiss(): void {
    if (shown === undefined) return;
    shown = undefined;
    emit();
  },
  /**
   * Ends every Undo asked for so far, shown or still waiting on its host's
   * answer. A change sent before the window moved to another host or closed
   * would otherwise offer, after the move, an Undo that runs the old host's
   * actions.
   */
  retire(): void {
    retiredThrough = latestThreadRestChange();
    threadRestUndoStore.dismiss();
  },
  current: (): ThreadRestUndoNotice | undefined => shown,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

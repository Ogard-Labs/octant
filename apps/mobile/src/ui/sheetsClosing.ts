/**
 * Sheets still on their way out. The system shows one sheet at a time from a
 * screen and refuses to show another while one is leaving, so a sheet asked
 * for then (Thread details handing over to Views and panes) waits until the
 * one before it has gone.
 */
const leaving = new Map<symbol, ReturnType<typeof setTimeout>>();
/** Well past the system's exit motion, which takes about a third of a second. */
const LONGEST_EXIT_MS = 1_000;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export const sheetsClosing = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** Whether a sheet other than this one is still leaving. */
  othersLeaving(sheet: symbol) {
    for (const entry of leaving.keys()) if (entry !== sheet) return true;
    return false;
  },
  isLeaving(sheet: symbol) {
    return leaving.has(sheet);
  },
  leaves(sheet: symbol) {
    if (leaving.has(sheet)) return;
    // A sheet that never reports it has gone, such as one asked away before
    // it was shown, must not hold back every sheet after it.
    leaving.set(
      sheet,
      setTimeout(() => sheetsClosing.gone(sheet), LONGEST_EXIT_MS),
    );
    changed();
  },
  gone(sheet: symbol) {
    const timer = leaving.get(sheet);
    if (timer === undefined) return;
    // Its own timer goes with it, so it cannot cut a later exit short.
    clearTimeout(timer);
    leaving.delete(sheet);
    changed();
  },
};

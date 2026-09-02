/**
 * Hidden windows should not spend a request cycle keeping a background list
 * hot. The packaged host keeps the renderer alive while the document is
 * hidden (another space, another app), and those ticks compete with the next
 * interaction once the person comes back.
 */
export function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** Pause recovery work without waking hidden renderers on a polling timer. */
export function waitUntilDocumentVisible(signal: AbortSignal): Promise<void> {
  if (signal.aborted || documentIsVisible() || typeof document === "undefined") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      document.removeEventListener("visibilitychange", visible);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const visible = () => {
      if (documentIsVisible()) done();
    };
    document.addEventListener("visibilitychange", visible);
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface VisibleIntervalOptions {
  /**
   * Run the tick as soon as the interval is scheduled, not only after the
   * first delay. Chat's sidebar uses this so the first unread mark does not
   * wait a full refresh period after bootstrap.
   */
  readonly runImmediately?: boolean;
}

/**
 * Call `tick` on an interval only while the document is visible. Becoming
 * hidden clears the timer; becoming visible starts it again and ticks once
 * so a list that sat still is current before the person acts on it.
 */
export function scheduleVisibleInterval(
  tick: () => void,
  intervalMs: number,
  options: VisibleIntervalOptions = {},
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const schedule = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = documentIsVisible() ? setInterval(tick, intervalMs) : undefined;
  };
  const onVisibilityChange = () => {
    schedule();
    if (documentIsVisible()) tick();
  };
  schedule();
  if (options.runImmediately === true && documentIsVisible()) tick();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  return () => {
    if (timer !== undefined) clearInterval(timer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

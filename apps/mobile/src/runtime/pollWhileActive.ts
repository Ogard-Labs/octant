/** Whether the app is in front, and word when that changes. */
export interface AppActivity {
  readonly isActive: () => boolean;
  /** Calls `listener` on every change; the returned function stops it. */
  readonly onChange: (listener: (active: boolean) => void) => () => void;
}

/**
 * Runs `run` every `intervalMs` while the app is in front, and once at once
 * when it comes back to the front. A phone in a pocket does not need a
 * refresh, so ticks while the app is in the background do nothing. The
 * returned function stops both the timer and the listener.
 */
export function pollWhileActive(input: {
  readonly run: () => void;
  readonly intervalMs: number;
  readonly activity: AppActivity;
}): () => void {
  const timer = setInterval(() => {
    if (input.activity.isActive()) input.run();
  }, input.intervalMs);
  const stopListening = input.activity.onChange((active) => {
    if (active) input.run();
  });
  return () => {
    clearInterval(timer);
    stopListening();
  };
}

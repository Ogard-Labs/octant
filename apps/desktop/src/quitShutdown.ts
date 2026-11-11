/**
 * Quitting must end the app. Every step that can fail while the app is leaving
 * is bounded here, and a failure is logged instead of shown: a modal error box
 * raised from the quit or window-close path blocks the main thread, so a quit
 * started by a signal or by a person who already walked away never finished.
 */
export type BoundedOutcome = "completed" | "failed" | "timed-out";

/** Saving a few hundred bytes of bounds; anything slower is not worth waiting for. */
export const WINDOW_STATE_FLUSH_BOUND_MS = 2_000;
/**
 * The managed server gets 5 s to exit after SIGTERM and 1 s after SIGKILL
 * before its stop reports failure; the brokers close after that.
 */
export const HOST_STOP_BOUND_MS = 10_000;
/** Ends the app when graceful shutdown has not finished, whatever is holding it. */
export const QUIT_DEADLINE_MS = 15_000;
/** Once shutdown is done, how long the windows get to close before the app exits anyway. */
export const WINDOW_CLOSE_GRACE_MS = 3_000;

async function runBounded(work: () => Promise<void>, boundMs: number): Promise<BoundedOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .then(() => "completed" as const),
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), boundMs);
      }),
    ]);
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

export interface QuitShutdownOutcome {
  readonly windowState: BoundedOutcome;
  readonly host: BoundedOutcome;
}

/**
 * Saves the window state, then stops the host. A failure or a stall in the
 * first never keeps the second from running, and neither rejects: the caller
 * quits whatever the outcome.
 */
export async function shutDownForQuit(options: {
  /** Retires native admission synchronously before any window-state await. */
  readonly closeAdmission?: () => void;
  readonly flushWindowState: () => Promise<void>;
  readonly stopHost: () => Promise<void>;
  readonly log: (message: string) => void;
}): Promise<QuitShutdownOutcome> {
  try {
    options.closeAdmission?.();
  } catch {
    options.log("Octant could not close native admission at quit.");
  }
  const windowState = await runBounded(options.flushWindowState, WINDOW_STATE_FLUSH_BOUND_MS);
  if (windowState !== "completed") {
    options.log(`Octant could not save window state at quit (${windowState}).`);
  }
  const host = await runBounded(options.stopHost, HOST_STOP_BOUND_MS);
  if (host !== "completed") {
    options.log(`Octant could not confirm its local server stopped at quit (${host}).`);
  }
  return { windowState, host };
}

/** The window-close variant: the window closes whether or not the save worked. */
export async function saveWindowStateWithoutBlocking(options: {
  readonly flushWindowState: () => Promise<void>;
  readonly log: (message: string) => void;
}): Promise<void> {
  const outcome = await runBounded(options.flushWindowState, WINDOW_STATE_FLUSH_BOUND_MS);
  if (outcome !== "completed") {
    options.log(`Octant could not save window state at window close (${outcome}).`);
  }
}

/** Calls `forceExit` after `boundMs` unless cancelled. The caller makes `forceExit` end the process. */
export function armQuitDeadline(options: {
  readonly forceExit: () => void;
  readonly boundMs?: number;
}): () => void {
  const timer = setTimeout(options.forceExit, options.boundMs ?? QUIT_DEADLINE_MS);
  return () => clearTimeout(timer);
}

/**
 * Ends the app after a start-up that cannot proceed. The reason is logged and
 * what the failed start still holds is released before the failure is shown,
 * because the error box is modal: on a packaged macOS build a launch whose
 * host missed its readiness deadline sat behind that box with nothing on
 * stdout or stderr, and a SIGTERM sent meanwhile was not acted on until the
 * box was dismissed. A quit requested while the app is releasing (SIGTERM,
 * SIGINT, logout) ends it without showing the box; one that reaches the app
 * while the box is open ends it without waiting for dismissal.
 */
export async function quitAfterStartupFailure(options: {
  readonly message: string;
  readonly log: (message: string) => void;
  /** Resolves when the person dismisses the failure. */
  readonly showFailure: (message: string) => Promise<void>;
  /** Releases what the failed start still holds; bounded and never rejects. */
  readonly shutDown: () => Promise<unknown>;
  /** Receives the call that ends the app on a quit requested from now on. */
  readonly onQuitRequested: (quit: () => void) => void;
  /** Arms the quit deadline once the app is committed to ending. */
  readonly armDeadline: () => void;
  readonly finish: () => void;
}): Promise<void> {
  options.log(`Octant could not start: ${options.message}`);
  let released = false;
  let quitRequested = false;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    options.armDeadline();
    options.finish();
  };
  options.onQuitRequested(() => {
    quitRequested = true;
    if (released) end();
  });
  await options.shutDown();
  released = true;
  if (!quitRequested) {
    try {
      await options.showFailure(options.message);
    } catch {
      options.log("Octant could not show why it did not start.");
    }
  }
  end();
}

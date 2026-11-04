/** Two lease periods cover the existing 15s status retry and bounded native calls. */
export const NIGHTLY_FIRST_WINDOW_GRACE_MS = 30_000;

export function createDesktopClientLifetime(options: {
  readonly currentNightlyWindows: () => number;
  readonly closeLocalWindows: () => Promise<"closed" | "failed">;
  readonly quitHost: (stillRequested: () => boolean) => Promise<"accepted" | "cancelled">;
}) {
  let generation = 0;
  let retaining = false;
  let closing = false;
  let finishing = false;
  let stopped = false;
  let lastCount = options.currentNightlyWindows();
  let grace: ReturnType<typeof setTimeout> | undefined;
  let restart: { readonly finish: (ready?: boolean) => void } | undefined;
  let pendingQuit: Promise<void> | undefined;
  let pendingClose: Promise<"retained" | "quit-required" | "failed"> | undefined;
  const cancelGrace = () => {
    clearTimeout(grace);
    grace = undefined;
    restart = undefined;
  };
  const finishIfEmpty = () => {
    if (
      stopped ||
      finishing ||
      closing ||
      !retaining ||
      grace !== undefined ||
      options.currentNightlyWindows() > 0
    )
      return;
    finishing = true;
    const requested = generation;
    const stillRequested = () =>
      !stopped && retaining && requested === generation && options.currentNightlyWindows() === 0;
    pendingQuit = options.quitHost(stillRequested).then(
      (result) => {
        finishing = false;
        pendingQuit = undefined;
        if (result === "accepted") {
          stopped = true;
          retaining = false;
          generation++;
        } else if (retaining && requested !== generation) {
          finishIfEmpty();
        }
      },
      () => {
        finishing = false;
        pendingQuit = undefined;
        console.warn("Octant could not finish its last-client quit request.");
      },
    );
  };
  return Object.freeze({
    beginHostRestart: (): ((ready?: boolean) => void) => {
      if (restart !== undefined) return restart.finish;
      if (stopped || !retaining || closing || options.currentNightlyWindows() <= 0) return () => {};
      cancelGrace();
      const arm = () => {
        const timer = setTimeout(() => {
          if (grace !== timer) return;
          grace = undefined;
          restart = undefined;
          finishIfEmpty();
        }, NIGHTLY_FIRST_WINDOW_GRACE_MS);
        grace = timer;
        timer.unref();
      };
      const ticket = {
        finish: (ready = true) => {
          if (restart !== ticket) return;
          cancelGrace();
          if (ready && options.currentNightlyWindows() === 0) arm();
          else finishIfEmpty();
        },
      };
      restart = ticket;
      // A stalled restart cannot turn retained intent into indefinite headlessness.
      arm();
      return ticket.finish;
    },
    localWindowAdmission: (): (() => boolean) => {
      const admitted = generation;
      return () => !stopped && !finishing && !closing && !retaining && admitted === generation;
    },
    requestLocalQuit: (): Promise<"retained" | "quit-required" | "failed"> => {
      if (stopped || finishing) return Promise.resolve("quit-required");
      if (pendingClose !== undefined) return pendingClose;
      if (options.currentNightlyWindows() <= 0) return Promise.resolve("quit-required");
      generation++;
      const requested = generation;
      retaining = true;
      closing = true;
      cancelGrace();
      pendingClose = options
        .closeLocalWindows()
        .catch(() => "failed" as const)
        .then((result) => {
          closing = false;
          pendingClose = undefined;
          if (requested !== generation) return "retained";
          if (result === "failed") {
            retaining = false;
            return "failed";
          }
          finishIfEmpty();
          return "retained";
        });
      return pendingClose;
    },
    reopen: async (): Promise<boolean> => {
      if (stopped) return false;
      if (!retaining && !closing && !finishing) return true;
      generation++;
      const requested = generation;
      retaining = false;
      cancelGrace();
      await pendingClose;
      await pendingQuit;
      return !stopped && !finishing && requested === generation;
    },
    nightlyWindowsChanged: (): void => {
      const count = options.currentNightlyWindows();
      const previous = lastCount;
      lastCount = count;
      if (count > 0) {
        if (finishing && retaining) generation++;
        if (restart === undefined) cancelGrace();
      } else if (previous > 0) finishIfEmpty();
    },
    waitForFirstNightlyWindow: (): void => {
      if (stopped || finishing || retaining || closing) return;
      generation++;
      retaining = true;
      cancelGrace();
      if (options.currentNightlyWindows() > 0) return;
      const waiting = generation;
      grace = setTimeout(() => {
        grace = undefined;
        if (waiting === generation) finishIfEmpty();
      }, NIGHTLY_FIRST_WINDOW_GRACE_MS);
      grace.unref();
    },
    dispose: (): void => {
      stopped = true;
      generation++;
      cancelGrace();
    },
  });
}

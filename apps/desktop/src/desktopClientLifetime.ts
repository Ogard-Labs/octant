/** Two lease periods cover the existing 15s status retry and bounded native calls. */
export const NIGHTLY_FIRST_WINDOW_GRACE_MS = 30_000;

export function createDesktopClientLifetime(options: {
  readonly currentNightlyWindows: () => number;
  readonly closeLocalWindows: () => Promise<"closed" | "failed">;
  readonly quitHost: () => Promise<"accepted" | "cancelled">;
}) {
  let generation = 0;
  let retaining = false;
  let closing = false;
  let finishing = false;
  let stopped = false;
  let lastCount = options.currentNightlyWindows();
  let grace: ReturnType<typeof setTimeout> | undefined;
  let pendingClose: Promise<"retained" | "quit-required" | "failed"> | undefined;
  const cancelGrace = () => {
    clearTimeout(grace);
    grace = undefined;
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
    void options.quitHost().then(
      (result) => {
        finishing = false;
        if (result === "accepted") {
          stopped = true;
          retaining = false;
          generation++;
        }
      },
      () => {
        finishing = false;
        console.warn("Octant could not finish its last-client quit request.");
      },
    );
  };
  return Object.freeze({
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
      if (stopped || finishing) return false;
      if (!retaining && !closing) return true;
      generation++;
      const requested = generation;
      retaining = false;
      cancelGrace();
      await pendingClose;
      return !stopped && !finishing && requested === generation;
    },
    nightlyWindowsChanged: (): void => {
      const count = options.currentNightlyWindows();
      const previous = lastCount;
      lastCount = count;
      if (count > 0) cancelGrace();
      else if (previous > 0) finishIfEmpty();
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

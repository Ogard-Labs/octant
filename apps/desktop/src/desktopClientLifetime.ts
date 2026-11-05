/** Two lease periods cover the existing 15s status retry and bounded native calls. */
export const NIGHTLY_FIRST_WINDOW_GRACE_MS = 30_000;

export function createDesktopClientLifetime(options: {
  readonly currentNightlyWindows: () => number;
  readonly closeLocalWindows: () => Promise<"closed" | "failed">;
  readonly quitHost: (stillRequested: () => boolean) => Promise<"accepted" | "cancelled">;
}) {
  let generation = 0;
  let reopens = 0;
  let retaining = false;
  let closing = false;
  let finishing = false;
  let stopped = false;
  let lastCount = options.currentNightlyWindows();
  let grace: ReturnType<typeof setTimeout> | undefined;
  let pendingQuit: Promise<void> | undefined;
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
  const localWindowAdmission = (): (() => boolean) => {
    const admitted = generation;
    return () => !stopped && !finishing && !closing && !retaining && admitted === generation;
  };
  const waitForFirstNightlyWindow = (): void => {
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
  };
  return Object.freeze({
    localWindowAdmission,
    /**
     * Opens a local window under the current admission. A reopen that arrives
     * while a quit is retiring an opening joins that same opening, so when the
     * quit refuses it and a reopen has admitted a new one, the opening retries
     * rather than finishing with no window.
     */
    openLocalWindow: async (
      create: (stillRequested: () => boolean) => Promise<void>,
    ): Promise<void> => {
      for (;;) {
        const stillRequested = localWindowAdmission();
        try {
          await create(stillRequested);
          return;
        } catch (error) {
          if (stillRequested()) throw error;
          if (!localWindowAdmission()()) return;
        }
      }
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
      reopens++;
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
        cancelGrace();
      } else if (previous > 0) finishIfEmpty();
    },
    waitForFirstNightlyWindow,
    /**
     * Captured before a host-only launch starts its host. A person who reopens
     * Stable while the host is still starting asked for its window, so the
     * returned wait then never arms the first-client grace that would stop it.
     */
    firstNightlyWindowWait: (): (() => void) => {
      const requested = reopens;
      return () => {
        if (requested === reopens) waitForFirstNightlyWindow();
      };
    },
    dispose: (): void => {
      stopped = true;
      generation++;
      cancelGrace();
    },
  });
}

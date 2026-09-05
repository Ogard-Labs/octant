import { watch, type FSWatcher } from "node:fs";

/** A live subscription to one directory tree. Closing it is always safe twice. */
export interface WorkFileWatchSubscription {
  close(): void;
}

/**
 * The one filesystem observation the Work turn observer needs, behind a port so
 * the observer can be tested without a real tree and without waiting on the
 * kernel.
 *
 * `relativePath` is whatever the host named, or `undefined` when the host
 * reported a change it could not name. The observer treats an unnamed change as
 * "something under here changed" rather than guessing a path.
 */
export interface WorkFileWatchPort {
  watch(
    canonicalRoot: string,
    onChange: (relativePath: string | undefined) => void,
    onFailure: () => void,
  ): WorkFileWatchSubscription;
}

/**
 * Recursive `node:fs` watching of one canonical directory.
 *
 * Recursion is the platform's, not a walk of our own: macOS backs it with
 * FSEvents, so a large folder costs one subscription rather than one watcher
 * per directory. Names arrive relative to the watched root and are passed
 * through untrusted — the observer, not the port, decides which of them may be
 * recorded against a turn.
 */
export const liveWorkFileWatchPort: WorkFileWatchPort = {
  watch(canonicalRoot, onChange, onFailure) {
    let watcher: FSWatcher;
    try {
      watcher = watch(canonicalRoot, { recursive: true, persistent: false });
    } catch {
      onFailure();
      return { close: () => undefined };
    }
    watcher.on("change", (_event, filename) => {
      onChange(typeof filename === "string" ? filename : undefined);
    });
    watcher.on("error", () => {
      onFailure();
    });
    watcher.on("close", () => {
      onFailure();
    });
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        watcher.removeAllListeners();
        try {
          watcher.close();
        } catch {
          // A watcher the host already tore down needs no second close.
        }
      },
    };
  },
};

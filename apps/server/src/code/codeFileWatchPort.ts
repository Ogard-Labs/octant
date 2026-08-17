import { watch, type FSWatcher } from "node:fs";

/** A live subscription to one directory tree. Closing it is always safe twice. */
export interface CodeFileWatchSubscription {
  close(): void;
}

/**
 * The one filesystem observation the Code watcher needs, behind a port so the
 * service can be tested without a real tree and without waiting on the kernel.
 *
 * `relativePath` is whatever the host named, or `undefined` when the host
 * reported a change it could not name. The service treats an unnamed change as
 * "something under here changed" rather than guessing a path.
 */
export interface CodeFileWatchPort {
  watch(
    canonicalRoot: string,
    onChange: (relativePath: string | undefined) => void,
    onFailure: () => void,
  ): CodeFileWatchSubscription;
}

/**
 * Recursive `node:fs` watching of one canonical directory.
 *
 * Recursion is the platform's, not a walk of our own: macOS backs it with
 * FSEvents, so a large checkout costs one subscription rather than one watcher
 * per directory. Names arrive relative to the watched root and are passed
 * through untrusted — the service, not the port, decides which of them may
 * appear in a notice.
 */
export const liveCodeFileWatchPort: CodeFileWatchPort = {
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

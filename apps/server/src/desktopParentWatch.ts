import type { Readable } from "node:stream";

export interface DesktopParentWatchOptions {
  readonly enabled: boolean;
  readonly input: Readable;
  readonly onDisconnect: () => void;
}

export function watchDesktopParent(options: DesktopParentWatchOptions): () => void {
  if (!options.enabled) return () => undefined;
  let watching = true;
  const cleanup = () => {
    if (!watching) return;
    watching = false;
    options.input.off("end", disconnect);
    options.input.off("close", disconnect);
    // `resume()` below put the stream in flowing mode, and a flowing pipe holds
    // the event loop open. Without this, a host that finished its shutdown on
    // SIGTERM stayed alive for as long as the desktop kept its end of the pipe
    // open, so the desktop never saw the exit it restarts the host on.
    options.input.pause();
  };
  const disconnect = () => {
    if (!watching) return;
    cleanup();
    options.onDisconnect();
  };
  options.input.once("end", disconnect);
  options.input.once("close", disconnect);
  options.input.resume();
  return cleanup;
}

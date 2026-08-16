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

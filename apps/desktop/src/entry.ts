import { CANVAS_PROTOTYPE_HOST_SWITCH, runCanvasPrototypeHost } from "./canvasPrototypeHost";

/**
 * The program the desktop executable runs. A packaged app always runs its own
 * entry, whatever it is started with, so the one executable has two roles: the
 * app, and the prototype host the app starts for running Canvas prototypes.
 * The app's module is loaded only for the app: it takes the single-instance
 * lock and the app's data directory as it loads, which the host must not.
 */
if (process.argv.includes(CANVAS_PROTOTYPE_HOST_SWITCH)) {
  // Not awaited: Electron holds its ready event until the entry module has
  // finished evaluating, and the host waits for ready.
  void runCanvasPrototypeHost();
} else {
  // Built beside this file and loaded by its address, so it is not bundled in.
  await import(new URL("./main.mjs", import.meta.url).href);
}

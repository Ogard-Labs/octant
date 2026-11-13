import {
  CANVAS_PROTOTYPE_HOST_RUNTIME_FILENAME,
  NIGHTLY_CLIENT_RUNTIME_FILENAME,
  TERMINAL_LAUNCHER_RUNTIME_FILENAME,
} from "./runtimePaths";

type CanvasPrototypeHostRuntime = Pick<
  typeof import("./canvasPrototypeHost"),
  "runCanvasPrototypeHost"
>;
type NightlyClientRuntime = Pick<typeof import("./nightlyClient"), "runNightlyClient">;
type TerminalLauncherRuntime = Pick<
  typeof import("@octant/cli/terminal-launcher"),
  "runTerminalLauncher"
>;

function runtimeRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isCanvasPrototypeHostRuntime(value: unknown): value is CanvasPrototypeHostRuntime {
  return runtimeRecord(value) && typeof value.runCanvasPrototypeHost === "function";
}

function isNightlyClientRuntime(value: unknown): value is NightlyClientRuntime {
  return runtimeRecord(value) && typeof value.runNightlyClient === "function";
}

function isTerminalLauncherRuntime(value: unknown): value is TerminalLauncherRuntime {
  return runtimeRecord(value) && typeof value.runTerminalLauncher === "function";
}

/** Loads only the isolated process role selected by the sealed desktop entry. */
export async function loadCanvasPrototypeHostRuntime(): Promise<CanvasPrototypeHostRuntime> {
  const loaded: unknown = await import(
    new URL(CANVAS_PROTOTYPE_HOST_RUNTIME_FILENAME, import.meta.url).href
  );
  if (!isCanvasPrototypeHostRuntime(loaded)) {
    throw new Error("Octant's Canvas prototype runtime is invalid.");
  }
  return loaded;
}

/** The ordinary Stable launch never resolves or parses this Nightly-only runtime. */
export async function loadNightlyClientRuntime(): Promise<NightlyClientRuntime> {
  const loaded: unknown = await import(
    new URL(NIGHTLY_CLIENT_RUNTIME_FILENAME, import.meta.url).href
  );
  if (!isNightlyClientRuntime(loaded)) {
    throw new Error("Octant Nightly's client runtime is invalid.");
  }
  return loaded;
}

/** Loads the terminal role after launch arguments select that role. */
export async function loadTerminalLauncherRuntime(): Promise<TerminalLauncherRuntime> {
  const loaded: unknown = await import(
    new URL(TERMINAL_LAUNCHER_RUNTIME_FILENAME, import.meta.url).href
  );
  if (!isTerminalLauncherRuntime(loaded)) {
    throw new Error("Octant's terminal launcher runtime is invalid.");
  }
  return loaded;
}

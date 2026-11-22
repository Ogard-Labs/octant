import { homedir } from "node:os";
import { recordHostCrashSync } from "@octant/host-runtime/crash-records";
import {
  installProcessErrorNet,
  type ProcessErrorNetHandle,
  type ProcessErrorNetOptions,
} from "@octant/host-runtime/process-error-net";

const DESKTOP_NET_KEY = Symbol.for("octant.desktopProcessErrorNet");

interface DesktopProcessErrorNetState {
  dataDirectory?: string;
  isShuttingDown?: () => boolean;
  handle?: ProcessErrorNetHandle;
}

type GlobalWithDesktopProcessErrorNet = typeof globalThis & {
  [DESKTOP_NET_KEY]?: DesktopProcessErrorNetState;
};

function sharedState(): DesktopProcessErrorNetState {
  const host = globalThis as GlobalWithDesktopProcessErrorNet;
  host[DESKTOP_NET_KEY] ??= {};
  return host[DESKTOP_NET_KEY];
}

export interface DesktopProcessErrorNetContext {
  readonly dataDirectory?: string;
  readonly isShuttingDown?: () => boolean;
}

/**
 * Installs the single desktop main-process error net. Because `entry.mjs` and
 * `main.mjs` are separate desktop bundles, shared state lives under a process-
 * wide symbol so `main.mjs` configures the already-installed net rather than
 * registering duplicate listeners.
 */
export function installDesktopProcessErrorNet(
  options: {
    readonly exit?: (code: number) => void;
    readonly target?: ProcessErrorNetOptions["target"];
    readonly stdioStreams?: ProcessErrorNetOptions["stdioStreams"];
    readonly writeLine?: ProcessErrorNetOptions["writeLine"];
    readonly now?: ProcessErrorNetOptions["now"];
    readonly homeDirectory?: string;
    readonly dataDirectory?: string;
    readonly isShuttingDown?: () => boolean;
  } = {},
): ProcessErrorNetHandle {
  const state = sharedState();
  state.handle?.uninstall();
  if (options.dataDirectory !== undefined) state.dataDirectory = options.dataDirectory;
  if (options.isShuttingDown !== undefined) state.isShuttingDown = options.isShuttingDown;
  const homeDirectory = options.homeDirectory ?? safeHomedir();
  const handle = installProcessErrorNet({
    processName: "desktop",
    ...(options.exit === undefined ? {} : { exit: options.exit }),
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.stdioStreams === undefined ? {} : { stdioStreams: options.stdioStreams }),
    ...(options.writeLine === undefined ? {} : { writeLine: options.writeLine }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
    isShuttingDown: () => state.isShuttingDown?.() === true,
    onFatal: (event) => {
      if (state.dataDirectory === undefined || process.platform === "win32") return;
      recordHostCrashSync(state.dataDirectory, {
        recordedAt: event.timestamp,
        process: "desktop",
        exitReason: event.kind,
        lastLines: event.line.split("\n"),
        ...(homeDirectory === undefined ? {} : { homeDirectory }),
      });
    },
  });
  state.handle = handle;
  return {
    uninstall: () => {
      handle.uninstall();
      if (state.handle === handle) delete state.handle;
    },
  };
}

export function configureDesktopProcessErrorNet(context: DesktopProcessErrorNetContext): void {
  const state = sharedState();
  if (context.dataDirectory === undefined) delete state.dataDirectory;
  else state.dataDirectory = context.dataDirectory;
  if (context.isShuttingDown === undefined) delete state.isShuttingDown;
  else state.isShuttingDown = context.isShuttingDown;
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

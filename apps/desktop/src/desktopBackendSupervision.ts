import {
  HostRuntimePathError,
  nextRestartBackoff,
  ServicePolicyError,
  type RestartBackoff,
} from "@octant/host-runtime";
import {
  AutomaticHostStartupDisabled,
  ServerReadyTimeout,
  type ManagedChildProcess,
} from "./serverProcess";

export type DesktopBackendFailure = "transient" | "fatal";

/** Fatal = a configuration or policy refusal no restart can clear. */
export function classifyDesktopBackendFailure(error: unknown): DesktopBackendFailure {
  if (
    error instanceof AutomaticHostStartupDisabled ||
    error instanceof HostRuntimePathError ||
    error instanceof ServicePolicyError
  ) {
    return "fatal";
  }
  if (error instanceof ServerReadyTimeout) return "transient";
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EADDRINUSE" ||
      error.code === "EADDRNOTAVAIL" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ETIMEDOUT")
  ) {
    return "transient";
  }
  // Unknown failures remain restartable; the crash-loop cap bounds retries.
  return "transient";
}

export interface DesktopBackendSupervisorPorts {
  readonly restart: () => Promise<ManagedChildProcess | undefined>;
  readonly reportFatal: (error: unknown) => void;
  readonly now?: () => number;
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
}

export interface DesktopBackendSupervisorSnapshot {
  readonly failures: number;
  readonly status: "idle" | "supervising" | "waiting-to-restart" | "restarting" | "gave-up";
}

export interface DesktopBackendSupervisor {
  readonly observe: (child: ManagedChildProcess) => void;
  readonly release: () => void;
  readonly snapshot: () => DesktopBackendSupervisorSnapshot;
}

const HEALTHY_AFTER_MS = 60_000;

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(run, delayMs);
  return () => globalThis.clearTimeout(timer);
}

export function createDesktopBackendSupervisor(
  ports: DesktopBackendSupervisorPorts,
): DesktopBackendSupervisor {
  const now = ports.now ?? Date.now;
  const schedule = ports.schedule ?? defaultSchedule;
  let failures = 0;
  let status: DesktopBackendSupervisorSnapshot["status"] = "idle";
  let observedChild: ManagedChildProcess | undefined;
  let released = false;
  let cancelRestart: (() => void) | undefined;
  let cancelHealthy: (() => void) | undefined;
  let removeExitListener: (() => void) | undefined;

  const snapshot = (): DesktopBackendSupervisorSnapshot => ({ failures, status });

  const clearChild = (): void => {
    cancelHealthy?.();
    cancelHealthy = undefined;
    removeExitListener?.();
    removeExitListener = undefined;
    observedChild = undefined;
  };

  const stopRetry = (): void => {
    cancelRestart?.();
    cancelRestart = undefined;
  };

  const gaveUp = (error: unknown): void => {
    stopRetry();
    clearChild();
    status = "gave-up";
    ports.reportFatal(error);
  };

  const scheduleRestart = (backoff: RestartBackoff): void => {
    stopRetry();
    status = "waiting-to-restart";
    cancelRestart = schedule(() => {
      cancelRestart = undefined;
      if (released || status === "gave-up") return;
      status = "restarting";
      void restart();
    }, backoff.delayMs);
  };

  const scheduleTransientRestart = (): void => {
    const backoff = nextRestartBackoff({ failures, now: now() });
    if (backoff.crashLoop) {
      gaveUp(new Error("The managed server kept exiting and could not be restarted."));
      return;
    }
    scheduleRestart(backoff);
  };

  const restart = async (): Promise<void> => {
    try {
      const child = await ports.restart();
      if (released || status === "gave-up") return;
      if (child === undefined) {
        failures += 1;
        scheduleTransientRestart();
        return;
      }
      observe(child);
    } catch (error) {
      if (classifyDesktopBackendFailure(error) === "fatal") {
        gaveUp(error);
        return;
      }
      failures += 1;
      scheduleTransientRestart();
    }
  };

  const onExit = (child: ManagedChildProcess): void => {
    if (released || observedChild !== child) return;
    clearChild();
    const backoff = nextRestartBackoff({ failures, now: now() });
    if (backoff.crashLoop) {
      gaveUp(new Error("The managed server kept exiting and could not be restarted."));
      return;
    }
    failures += 1;
    scheduleRestart(backoff);
  };

  const observe = (child: ManagedChildProcess): void => {
    if (child.once === undefined || child.off === undefined) return;
    stopRetry();
    clearChild();
    released = false;
    observedChild = child;
    status = "supervising";
    const listener = () => onExit(child);
    child.once("exit", listener);
    removeExitListener = () => {
      child.off?.("exit", listener);
    };
    cancelHealthy = schedule(() => {
      cancelHealthy = undefined;
      failures = 0;
    }, HEALTHY_AFTER_MS);
  };

  return {
    observe,
    release: () => {
      released = true;
      stopRetry();
      clearChild();
      status = "idle";
    },
    snapshot,
  };
}

/**
 * The shared update state machine for managed tools: a pinned bundled release,
 * periodic upstream checks, staged-and-verified downloads, activation only
 * while the host reports no work in flight, and rollback on activation failure.
 * Tool-specific release, staging, and verification live behind the injected
 * check/stage/activate callbacks.
 */

export interface ManagedToolUpdateState {
  readonly status: "idle" | "checking" | "downloading" | "staged" | "current" | "failed";
  readonly currentVersion: string;
  readonly availableVersion?: string;
  readonly message?: string;
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function createManagedToolUpdates<
  Release extends { readonly version: string },
  Staged extends { readonly version: string },
>(options: {
  readonly currentVersion: string;
  readonly check: (signal: AbortSignal) => Promise<Release | undefined>;
  /** Returns only after the candidate's integrity and structure are verified. */
  readonly stage: (release: Release, signal: AbortSignal) => Promise<Staged>;
  /** Owns rollback if the verified replacement fails its startup handshake. */
  readonly activate: (staged: Staged) => Promise<boolean>;
  readonly isBusy: () => boolean;
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
  readonly onState?: (state: ManagedToolUpdateState) => void;
}) {
  let state: ManagedToolUpdateState = {
    status: "idle",
    currentVersion: options.currentVersion,
  };
  let enabled = true;
  let automatic = false;
  let closed = false;
  let generation = 0;
  let scheduled: (() => void) | undefined;
  let staged: Staged | undefined;
  let checking: Promise<void> | undefined;
  let applying: Promise<void> | undefined;
  let abort = new AbortController();
  const schedule =
    options.schedule ??
    ((delay, callback) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const publish = (next: ManagedToolUpdateState) => {
    state = next;
    options.onState?.(state);
  };
  const later = (delay = CHECK_INTERVAL_MS) => {
    scheduled?.();
    scheduled = undefined;
    if (!enabled || !automatic || closed) return;
    scheduled = schedule(delay, () => {
      if (!enabled || !automatic || closed) return;
      void check();
    });
  };

  async function applyWhenIdle(): Promise<void> {
    if (closed || !enabled || staged === undefined || options.isBusy()) return;
    if (applying !== undefined) return applying;
    const candidate = staged;
    applying = (async () => {
      try {
        if (await options.activate(candidate)) {
          staged = undefined;
          publish({ status: "current", currentVersion: candidate.version });
        } else {
          staged = undefined;
          publish({
            status: "failed",
            currentVersion: state.currentVersion,
            message: "The new tool did not start. The previous verified tool is retained.",
          });
        }
      } catch {
        publish({
          status: "failed",
          currentVersion: state.currentVersion,
          message: "The tool update could not be activated.",
        });
      }
    })();
    try {
      await applying;
    } finally {
      applying = undefined;
    }
  }

  async function check(): Promise<void> {
    if (closed) return;
    if (checking !== undefined) return checking;
    const run = generation;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]);
    checking = (async () => {
      try {
        publish({ status: "checking", currentVersion: state.currentVersion });
        const release = await options.check(signal);
        if (run !== generation || signal.aborted || closed) return;
        if (
          release === undefined ||
          !isNewerManagedVersion(release.version, state.currentVersion)
        ) {
          publish({
            status: staged === undefined ? "current" : "staged",
            currentVersion: state.currentVersion,
            ...(staged === undefined ? {} : { availableVersion: staged.version }),
          });
          return;
        }
        publish({
          status: "downloading",
          currentVersion: state.currentVersion,
          availableVersion: release.version,
        });
        const verified = await options.stage(release, signal);
        if (run !== generation || signal.aborted || closed) return;
        if (verified.version !== release.version) throw new Error("Verified tool version changed.");
        staged = verified;
        publish({
          status: "staged",
          currentVersion: state.currentVersion,
          availableVersion: verified.version,
        });
        await applyWhenIdle();
      } catch (error) {
        if (run === generation && !closed) {
          const reason = error instanceof Error ? error.message : "";
          const message =
            reason.startsWith("Tool ") || reason.startsWith("The ")
              ? reason.slice(0, 240)
              : "The tool update failed verification or could not be downloaded.";
          publish({
            status: "failed",
            currentVersion: state.currentVersion,
            message,
          });
        }
      }
    })();
    try {
      await checking;
    } finally {
      checking = undefined;
      later();
    }
  }

  return {
    state: () => state,
    restoreVerifiedVersion: (version: string) => {
      if (checking !== undefined || applying !== undefined)
        throw new Error("Tool version must be restored before checking updates.");
      publish({ status: "idle", currentVersion: version });
    },
    check,
    applyWhenIdle,
    configure: (settings: { readonly enabled: boolean; readonly automaticUpdates: boolean }) => {
      enabled = settings.enabled;
      automatic = settings.automaticUpdates;
      if (!enabled || !automatic) {
        generation += 1;
        abort.abort();
        abort = new AbortController();
        if (state.status === "checking" || state.status === "downloading") {
          publish({
            status: staged === undefined ? "idle" : "staged",
            currentVersion: state.currentVersion,
            ...(staged === undefined ? {} : { availableVersion: staged.version }),
          });
        }
      }
      later(0);
    },
    close: async () => {
      closed = true;
      generation += 1;
      scheduled?.();
      abort.abort();
      await checking;
      await applying;
    },
  };
}

export function isNewerManagedVersion(candidate: string, current: string): boolean {
  const stable = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
  if (!stable.test(candidate) || !stable.test(current)) return false;
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) return false;
    if (left !== right) return left > right;
  }
  return false;
}

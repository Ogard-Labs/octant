export type NativeHelperStopOutcome =
  | { readonly status: "stopped" }
  | { readonly status: "failed"; readonly reason: "exit-not-confirmed" };

/** The spawned child only. This does not signal a PID or an owned process group. */
export interface NativeHelperChild {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on(event: "exit" | "error" | "close", listener: () => void): unknown;
  off(event: "exit" | "error" | "close", listener: () => void): unknown;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
}

export function createNativeHelperShutdown(options: {
  readonly child: NativeHelperChild;
  readonly closeGracefully: () => void;
  readonly gracefulMs: number;
  readonly terminateMs: number;
  readonly killMs: number;
}) {
  const child = options.child;
  let state: "running" | "stopping" | "exited" = "running";
  let settleExit = () => {};
  const exited = new Promise<void>((resolve) => {
    settleExit = resolve;
  });
  let settleClose = () => {};
  let channelsClosed = false;
  const closed = new Promise<void>((resolve) => {
    settleClose = resolve;
  });
  const observedExit = () => {
    if (state === "exited") return;
    state = "exited";
    settleExit();
  };
  const finish = () => {
    if (channelsClosed) return;
    channelsClosed = true;
    observedExit();
    child.off("exit", observedExit);
    child.off("error", failedToStart);
    child.off("close", finish);
    settleClose();
  };
  const failedToStart = () => {
    // A later IPC or signal error does not prove that a spawned child exited.
    if (child.pid === undefined) observedExit();
  };
  child.on("exit", observedExit);
  child.on("close", finish);
  child.on("error", failedToStart);
  if (child.exitCode !== null || child.signalCode !== null) finish();
  let stopping: Promise<NativeHelperStopOutcome> | undefined;

  const waitForExit = async (boundMs: number): Promise<boolean> => {
    if (state === "exited") return true;
    if (boundMs <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), boundMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const signal = (value: "SIGTERM" | "SIGKILL") => {
    if (state === "exited") return;
    try {
      child.kill(value);
    } catch {
      /* Exit still needs independent confirmation. */
    }
  };
  const stop = (): Promise<NativeHelperStopOutcome> => {
    if (stopping !== undefined) return stopping;
    let settleStop: (outcome: NativeHelperStopOutcome) => void = () => {};
    stopping = new Promise((resolve) => {
      settleStop = resolve;
    });
    if (channelsClosed) {
      settleStop({ status: "stopped" });
      return stopping;
    }
    if (state !== "exited") state = "stopping";
    void (async () => {
      try {
        options.closeGracefully();
      } catch {
        /* A broken channel does not release the child. */
      }
      if (options.gracefulMs > 0 && (await waitForExit(options.gracefulMs)))
        return { status: "stopped" } as const;
      if (channelsClosed) return { status: "stopped" } as const;
      signal("SIGTERM");
      if (await waitForExit(options.terminateMs)) return { status: "stopped" } as const;
      signal("SIGKILL");
      return (await waitForExit(options.killMs))
        ? ({ status: "stopped" } as const)
        : ({ status: "failed", reason: "exit-not-confirmed" } as const);
    })().then(settleStop);
    return stopping;
  };
  return { exited, closed, state: () => state, stop };
}

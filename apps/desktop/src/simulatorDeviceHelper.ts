import { spawn as spawnProcess } from "node:child_process";

/**
 * Input the device helper delivers to one booted Simulator. Coordinates are
 * fractions of the screen from its top-left corner, so a caller never needs
 * the device's pixel size or the chrome of any window.
 */
export type DeviceHelperRequest =
  /** Asks the helper what it is attached to; delivers nothing. */
  | { readonly op: "hello" }
  | { readonly op: "tap"; readonly x: number; readonly y: number }
  | {
      readonly op: "swipe";
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
      readonly durationMs?: number;
    }
  | {
      readonly op: "touch";
      readonly phase: "down" | "move" | "up";
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly op: "stream-start";
      readonly maxHeight: number;
      readonly quality: number;
      readonly framesPerSecond: number;
    }
  | { readonly op: "stream-stop" }
  | { readonly op: "text"; readonly text: string }
  | { readonly op: "key"; readonly key: string }
  | { readonly op: "button"; readonly button: "home" | "lock" };

export type DeviceHelperReply =
  | {
      readonly status: "delivered";
      /** The device's screen in pixels, when the helper reported one. */
      readonly screen?: { readonly width: number; readonly height: number };
    }
  /** The helper answered and refused: a bad request, or a Simulator it cannot reach. */
  | { readonly status: "refused"; readonly code: string; readonly message: string }
  /** No answer came: the helper is missing, died, or outlived its budget. */
  | { readonly status: "unavailable"; readonly message: string };

export interface DeviceWatchOptions {
  readonly maxHeight: number;
  readonly quality: number;
  readonly framesPerSecond: number;
}

export interface DeviceViewer {
  /** One whole JPEG of the Simulator's screen. */
  readonly onFrame: (jpeg: Uint8Array) => void;
  /** The helper stopped; no more frames will come. Not called after `stop()`. */
  readonly onEnd: () => void;
}

export type DeviceWatch =
  | { readonly status: "watching"; readonly stop: () => void }
  | { readonly status: "refused"; readonly code: string; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string };

/** The part of a child process this module uses, so a test can stand one in. */
export interface DeviceHelperChild {
  readonly stdin: {
    write(chunk: Uint8Array): unknown;
    end(): unknown;
    on(event: "error", listener: () => void): unknown;
  };
  readonly stdout: { on(event: "data", listener: (chunk: Uint8Array) => void): unknown };
  /** File descriptor 3: length-prefixed JPEG frames while a stream is running. */
  readonly frames: {
    on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
    on(event: "error", listener: () => void): unknown;
  };
  on(event: "exit" | "error", listener: () => void): unknown;
  kill(): unknown;
}

export interface SimulatorDeviceHelpersOptions {
  readonly helperPath: string;
  readonly spawn?: (helperPath: string, simulatorId: string) => DeviceHelperChild;
  /** A helper with no request for this long is stopped; the next request starts a new one. */
  readonly idleMs?: number;
}

interface PendingReply {
  readonly settle: (reply: DeviceHelperReply) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RunningHelper {
  readonly child: DeviceHelperChild;
  readonly pending: Map<number, PendingReply>;
  readonly viewers: Set<DeviceViewer>;
  buffered: Buffer;
  bufferedFrames: Buffer;
  /** The newest frame of the running stream, for a viewer who joins a still screen. */
  latestFrame: Uint8Array | undefined;
  nextId: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Settles once the helper has answered the viewers' shared `stream-start`. */
  streaming: Promise<DeviceHelperReply> | undefined;
}

const SIMULATOR_ID = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
const MAXIMUM_REPLY_BYTES = 262_144;
const MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024;
/** The longest budget the input contract allows. */
const LONGEST_INPUT_MS = 10 * 60 * 1_000;
const DEFAULT_IDLE_MS = 120_000;

function frame(value: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function replyFrom(value: unknown): DeviceHelperReply {
  if (typeof value !== "object" || value === null) {
    return {
      status: "unavailable",
      message: "The device helper answered with something unreadable.",
    };
  }
  const reply = value as {
    readonly ok?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
    readonly device?: { readonly screen?: { readonly width?: unknown; readonly height?: unknown } };
  };
  if (reply.ok === true) {
    const width = reply.device?.screen?.width;
    const height = reply.device?.screen?.height;
    return typeof width === "number" && typeof height === "number" && width > 0 && height > 0
      ? { status: "delivered", screen: { width, height } }
      : { status: "delivered" };
  }
  return {
    status: "refused",
    code: typeof reply.code === "string" ? reply.code : "failed",
    message: typeof reply.message === "string" ? reply.message : "The device helper refused.",
  };
}

/**
 * Owns one device helper process per Simulator, started on first use and
 * stopped when idle or when the desktop quits. The helper exits on its own
 * when its stdin closes, so a desktop that dies takes its helpers with it.
 */
export function createSimulatorDeviceHelpers(options: SimulatorDeviceHelpersOptions) {
  const spawn =
    options.spawn ??
    ((helperPath: string, simulatorId: string): DeviceHelperChild => {
      const child = spawnProcess(helperPath, [simulatorId], {
        stdio: ["pipe", "pipe", "ignore", "pipe"],
      });
      const frames = child.stdio[3];
      if (
        child.stdin === null ||
        child.stdout === null ||
        frames === null ||
        frames === undefined
      ) {
        child.kill();
        throw new Error("The device helper started without its pipes.");
      }
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        frames,
        on: (event, listener) => child.on(event, listener),
        kill: () => child.kill(),
      };
    });
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const running = new Map<string, RunningHelper>();
  let disposed = false;

  function stop(simulatorId: string, helper: RunningHelper, message: string): void {
    if (running.get(simulatorId) === helper) running.delete(simulatorId);
    if (helper.idle !== undefined) clearTimeout(helper.idle);
    for (const [, waiting] of helper.pending) {
      clearTimeout(waiting.timer);
      waiting.settle({ status: "unavailable", message });
    }
    helper.pending.clear();
    const viewers = [...helper.viewers];
    helper.viewers.clear();
    for (const viewer of viewers) viewer.onEnd();
    try {
      helper.child.stdin.end();
    } catch {
      // Already closed: the helper is gone, which is the goal.
    }
    helper.child.kill();
  }

  /** Starts the idle clock: nothing is waiting on this helper any more. */
  function restIdle(simulatorId: string, helper: RunningHelper): void {
    if (helper.idle !== undefined) clearTimeout(helper.idle);
    helper.idle = undefined;
    // A helper someone is watching is in use even when no input arrives.
    if (helper.viewers.size > 0) return;
    helper.idle = setTimeout(
      () => stop(simulatorId, helper, "The device helper was stopped while idle."),
      idleMs,
    );
  }

  function start(simulatorId: string): RunningHelper {
    const helper: RunningHelper = {
      child: spawn(options.helperPath, simulatorId),
      pending: new Map(),
      viewers: new Set(),
      buffered: Buffer.alloc(0),
      bufferedFrames: Buffer.alloc(0),
      latestFrame: undefined,
      nextId: 1,
      idle: undefined,
      streaming: undefined,
    };
    helper.child.frames.on("data", (chunk) => {
      helper.bufferedFrames = Buffer.concat([helper.bufferedFrames, chunk]);
      while (helper.bufferedFrames.length >= 4) {
        const length = helper.bufferedFrames.readUInt32BE(0);
        if (length > MAXIMUM_FRAME_BYTES) {
          stop(simulatorId, helper, "The device helper sent an oversized frame.");
          return;
        }
        if (helper.bufferedFrames.length < length + 4) return;
        // Copied: the viewers keep the frame after this buffer moves on.
        const jpeg = Uint8Array.from(helper.bufferedFrames.subarray(4, length + 4));
        helper.bufferedFrames = helper.bufferedFrames.subarray(length + 4);
        // Kept only for a stream somebody is watching or waiting for. A stop is
        // queued, not instant, so the ending stream can present once more after
        // the last viewer left; kept, that frame was the first thing the next
        // viewer saw, however long ago it was taken.
        if (helper.viewers.size > 0 || helper.streaming !== undefined) helper.latestFrame = jpeg;
        for (const viewer of helper.viewers) viewer.onFrame(jpeg);
      }
    });
    helper.child.stdout.on("data", (chunk) => {
      helper.buffered = Buffer.concat([helper.buffered, chunk]);
      while (helper.buffered.length >= 4) {
        const length = helper.buffered.readUInt32BE(0);
        if (length > MAXIMUM_REPLY_BYTES) {
          stop(simulatorId, helper, "The device helper sent an oversized reply.");
          return;
        }
        if (helper.buffered.length < length + 4) return;
        const payload = helper.buffered.subarray(4, length + 4);
        helper.buffered = helper.buffered.subarray(length + 4);
        let value: unknown;
        try {
          value = JSON.parse(payload.toString("utf8"));
        } catch {
          stop(simulatorId, helper, "The device helper sent a reply that is not JSON.");
          return;
        }
        const id = (value as { readonly id?: unknown } | null)?.id;
        const waiting = typeof id === "number" ? helper.pending.get(id) : undefined;
        if (waiting === undefined || typeof id !== "number") continue;
        helper.pending.delete(id);
        clearTimeout(waiting.timer);
        if (helper.pending.size === 0) restIdle(simulatorId, helper);
        waiting.settle(replyFrom(value));
      }
    });
    const gone = () => stop(simulatorId, helper, "The device helper stopped before it answered.");
    helper.child.on("exit", gone);
    helper.child.on("error", gone);
    // A helper that dies under a write reports EPIPE on the stream, later, and
    // not from `write`. With no listener that is an unhandled error event,
    // which would take the desktop's main process down with the helper.
    helper.child.stdin.on("error", gone);
    helper.child.frames.on("error", gone);
    running.set(simulatorId, helper);
    return helper;
  }

  function ask(
    simulatorId: string,
    helper: RunningHelper,
    request: DeviceHelperRequest,
    timeoutMs: number,
    cancelled?: AbortSignal,
  ): Promise<DeviceHelperReply> {
    // A helper with a request in hand is not idle, however long the request
    // takes; the clock starts again when the last answer arrives.
    if (helper.idle !== undefined) clearTimeout(helper.idle);
    helper.idle = undefined;
    const id = helper.nextId;
    helper.nextId += 1;
    return new Promise<DeviceHelperReply>((resolve) => {
      const timer = setTimeout(
        () => stop(simulatorId, helper, "The device helper did not answer in time."),
        timeoutMs,
      );
      // The helper works through one request at a time and cannot be asked to
      // drop one. A cancel that arrives before its answer therefore stops the
      // helper: whatever it had not yet sent to the device is never sent, and
      // the next request starts a fresh one.
      const onCancel = () => {
        if (helper.pending.has(id)) stop(simulatorId, helper, "The action was cancelled.");
      };
      cancelled?.addEventListener("abort", onCancel, { once: true });
      const settle = (reply: DeviceHelperReply) => {
        cancelled?.removeEventListener("abort", onCancel);
        resolve(reply);
      };
      helper.pending.set(id, { settle, timer });
      try {
        helper.child.stdin.write(frame({ ...request, id }));
      } catch {
        stop(simulatorId, helper, "The device helper stopped before it answered.");
      }
    });
  }

  return {
    /**
     * Delivers one input and resolves when the helper says it landed, refused,
     * or `timeoutMs` passed. A timeout stops the helper: what it was doing is
     * unknown, and the next request must not queue behind it.
     */
    send(
      simulatorId: string,
      request: DeviceHelperRequest,
      timeoutMs: number,
      cancelled?: AbortSignal,
    ): Promise<DeviceHelperReply> {
      if (cancelled?.aborted === true) {
        return Promise.resolve({ status: "unavailable", message: "The action was cancelled." });
      }
      if (disposed) {
        return Promise.resolve({ status: "unavailable", message: "The desktop is shutting down." });
      }
      if (!SIMULATOR_ID.test(simulatorId)) {
        return Promise.resolve({
          status: "refused",
          code: "no-such-device",
          message: "That is not a Simulator identifier.",
        });
      }
      let helper: RunningHelper;
      try {
        helper = running.get(simulatorId) ?? start(simulatorId);
      } catch {
        return Promise.resolve({
          status: "unavailable",
          message: "The device helper could not be started.",
        });
      }
      return ask(simulatorId, helper, request, timeoutMs, cancelled);
    },

    /**
     * Shows a viewer the Simulator's screen as it changes. Viewers of one
     * Simulator share a single stream, started with the first viewer's options
     * and stopped with the last viewer; a watched helper is never idle.
     */
    async watch(
      simulatorId: string,
      watchOptions: DeviceWatchOptions,
      viewer: DeviceViewer,
      timeoutMs: number,
    ): Promise<DeviceWatch> {
      if (disposed) return { status: "unavailable", message: "The desktop is shutting down." };
      if (!SIMULATOR_ID.test(simulatorId)) {
        return {
          status: "refused",
          code: "no-such-device",
          message: "That is not a Simulator identifier.",
        };
      }
      let helper: RunningHelper;
      try {
        helper = running.get(simulatorId) ?? start(simulatorId);
      } catch {
        return { status: "unavailable", message: "The device helper could not be started." };
      }
      // The helper answers in order, so a start asked for while an input is
      // still being delivered waits behind it. Its own short deadline would
      // then stop the helper under that input, which may already have typed
      // part of its text; the input's deadline is what catches a helper that
      // truly hangs.
      helper.streaming ??= ask(
        simulatorId,
        helper,
        { op: "stream-start", ...watchOptions },
        helper.pending.size > 0 ? LONGEST_INPUT_MS : timeoutMs,
      );
      const started = await helper.streaming;
      if (started.status !== "delivered") {
        if (running.get(simulatorId) === helper) helper.streaming = undefined;
        return started;
      }
      if (running.get(simulatorId) !== helper) {
        return { status: "unavailable", message: "The device helper stopped before it answered." };
      }
      helper.viewers.add(viewer);
      if (helper.idle !== undefined) clearTimeout(helper.idle);
      // Frames come only when the screen changes, and the helper's first one
      // arrives before its answer does. A viewer is shown the newest frame at
      // once, or a still device would leave it with nothing to draw.
      if (helper.latestFrame !== undefined) viewer.onFrame(helper.latestFrame);
      return {
        status: "watching",
        stop: () => {
          if (!helper.viewers.delete(viewer) || helper.viewers.size > 0) return;
          helper.streaming = undefined;
          helper.latestFrame = undefined;
          if (running.get(simulatorId) === helper) {
            // The helper answers in order, so this waits behind any input still
            // being delivered. It gets the longest an input may take: a short
            // deadline here would stop the helper under that input, which may
            // already have typed part of its text. A helper that truly hangs is
            // stopped by the input's own deadline.
            void ask(simulatorId, helper, { op: "stream-stop" }, LONGEST_INPUT_MS);
          }
        },
      };
    },

    /** True while any input is still waiting for its answer. */
    busy(): boolean {
      for (const helper of running.values()) if (helper.pending.size > 0) return true;
      return false;
    },

    dispose(): void {
      disposed = true;
      for (const [simulatorId, helper] of running) {
        stop(simulatorId, helper, "The desktop is shutting down.");
      }
    },
  };
}

export type SimulatorDeviceHelpers = ReturnType<typeof createSimulatorDeviceHelpers>;

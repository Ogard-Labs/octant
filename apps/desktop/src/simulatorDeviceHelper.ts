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

/** The part of a child process this module uses, so a test can stand one in. */
export interface DeviceHelperChild {
  readonly stdin: {
    write(chunk: Uint8Array): unknown;
    end(): unknown;
    on(event: "error", listener: () => void): unknown;
  };
  readonly stdout: { on(event: "data", listener: (chunk: Uint8Array) => void): unknown };
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
  buffered: Buffer;
  nextId: number;
  idle: ReturnType<typeof setTimeout> | undefined;
}

const SIMULATOR_ID = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
const MAXIMUM_REPLY_BYTES = 262_144;
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
    ((helperPath: string, simulatorId: string): DeviceHelperChild =>
      spawnProcess(helperPath, [simulatorId], { stdio: ["pipe", "pipe", "ignore"] }));
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
    helper.idle = setTimeout(
      () => stop(simulatorId, helper, "The device helper was stopped while idle."),
      idleMs,
    );
  }

  function start(simulatorId: string): RunningHelper {
    const helper: RunningHelper = {
      child: spawn(options.helperPath, simulatorId),
      pending: new Map(),
      buffered: Buffer.alloc(0),
      nextId: 1,
      idle: undefined,
    };
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
    running.set(simulatorId, helper);
    return helper;
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
    ): Promise<DeviceHelperReply> {
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
      // A helper with a request in hand is not idle, however long the request
      // takes; the clock starts again when the last answer arrives.
      if (helper.idle !== undefined) clearTimeout(helper.idle);
      helper.idle = undefined;
      const id = helper.nextId;
      helper.nextId += 1;
      return new Promise<DeviceHelperReply>((settle) => {
        const timer = setTimeout(
          () => stop(simulatorId, helper, "The device helper did not answer in time."),
          timeoutMs,
        );
        helper.pending.set(id, { settle, timer });
        try {
          helper.child.stdin.write(frame({ ...request, id }));
        } catch {
          stop(simulatorId, helper, "The device helper stopped before it answered.");
        }
      });
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

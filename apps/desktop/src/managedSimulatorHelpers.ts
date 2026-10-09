import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import {
  readManagedDeviceEndpoint,
  takeJpegFrames,
  type ManagedDeviceEndpoint,
} from "@octant/domain/managed-device-stream";
import type {
  DeviceHelperReply,
  DeviceHelperRequest,
  DeviceViewer,
  SimulatorDeviceHelpers,
} from "./simulatorDeviceHelper";

const SIMULATOR_ID = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
const READY_MS = 8_000;
const FIRST_FRAME_MS = 5_000;
const CONFIG_POLL_MS = 200;
/** What the device helper types as key positions; it checks the guest layout first. */
const KEY_TYPED_TEXT = /^[A-Za-z0-9 \n]+$/;
/** HID usage of V, and of the left Command modifier. */
const PASTE_KEY = { usage: 25, modifiers: [227] } as const;
/**
 * How long asking the guest whether its input is connected may take. A busy
 * CoreSimulator was observed taking minutes to answer `simctl spawn`; input
 * does not wait that long for a question it can do without.
 */
const INPUT_CONNECTION_MS = 1_500;
/**
 * The guest notification Xcode 27's Device Hub raises when its input daemon
 * takes over touch and buttons. serve-sim's touch and buttons still go to the
 * legacy services then, which accept them and drop them (observed 2026-10-08
 * on Xcode 27.0, 27A266a: taps, swipes and Home exited 0 and moved nothing).
 */
const DEVICE_HUB_INPUT_NOTIFICATION = "com.apple.coredevice.dtuhidd.active";

export const INPUT_DISCONNECTED_MESSAGE =
  "Simulator input is disconnected. Repair input restarts the Simulator's home screen.";

/**
 * Whether the guest's legacy touch and button services still receive what
 * serve-sim sends. `unknown` means the guest did not answer in time.
 */
export type SimulatorInputConnection = "connected" | "disconnected" | "unknown";

/** `aborted` can flip during an await, so this read stays outside control-flow narrowing. */
function actionWasCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The part of the managed-tool service the Simulator pane needs. A missing
 * tool returns no launch spec, and the pane keeps the native device helper.
 */
export interface ManagedSimulatorTools {
  launchSpec(
    tool: string,
    args: ReadonlyArray<string>,
  ): Promise<
    | {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly env: NodeJS.ProcessEnv;
      }
    | undefined
  >;
  trackProcess(tool: string, child: ChildProcess): void;
}

export interface ManagedSimulatorHelpersOptions {
  readonly spawn?: (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly stdio: ["ignore", "pipe", "pipe"];
    },
  ) => ChildProcess;
  readonly fetch?: typeof fetch;
  readonly readyMs?: number;
  readonly firstFrameMs?: number;
  /** Puts text on the Simulator's pasteboard; resolves whether it did. */
  readonly copyToPasteboard?: (udid: string, text: string, signal: AbortSignal) => Promise<boolean>;
  /** Asks the guest whether Device Hub has taken its touch and buttons. */
  readonly inputConnection?: (
    udid: string,
    signal: AbortSignal,
  ) => Promise<SimulatorInputConnection>;
}

interface StreamSession {
  readonly udid: string;
  readonly endpoint: ManagedDeviceEndpoint;
  readonly screen: { readonly width: number; readonly height: number };
  readonly child: ChildProcess;
  readonly viewers: Set<DeviceViewer>;
  latest: Uint8Array | undefined;
  rest: Uint8Array;
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  reading: boolean;
  closed: boolean;
  streamAbort: AbortController | undefined;
  readonly waiters: Array<(frame: Uint8Array | undefined) => void>;
}

/**
 * A helper stand-in used when the native binary is not on disk. serve-sim can
 * still drive the pane. When that stream is absent too, input stays unavailable.
 */
export function createUnavailableSimulatorHelpers(): SimulatorDeviceHelpers {
  const unavailable: DeviceHelperReply = {
    status: "unavailable",
    message: "The device helper could not be started.",
  };
  return {
    send: () => Promise.resolve(unavailable),
    watch: () => Promise.resolve(unavailable),
    busy: () => false,
    dispose: () => undefined,
  };
}

/**
 * Prefers a managed serve-sim stream for one already booted Simulator. The
 * native helper remains the path when the tool is missing, the stream never
 * produces a frame, or the input is a key serve-sim does not accept.
 * A command that fails while the stream is up is not also sent to the helper.
 */
export function createManagedSimulatorHelpers(
  native: SimulatorDeviceHelpers,
  tools: ManagedSimulatorTools,
  options: ManagedSimulatorHelpersOptions = {},
): SimulatorDeviceHelpers {
  const spawn = options.spawn ?? spawnProcess;
  const fetchImpl = options.fetch ?? fetch;
  const readyMs = options.readyMs ?? READY_MS;
  const firstFrameMs = options.firstFrameMs ?? FIRST_FRAME_MS;
  const copyToPasteboard = options.copyToPasteboard ?? simctlPasteboardCopy;
  const inputConnection = options.inputConnection ?? simctlInputConnection;
  const sessions = new Map<string, Promise<StreamSession | undefined>>();
  const live = new Set<ChildProcess>();
  /** Simulators whose finger went down through the native helper. */
  const nativeFingers = new Set<string>();
  let disposed = false;
  let inflight = 0;

  function forget(child: ChildProcess): void {
    child.once("exit", () => {
      live.delete(child);
    });
  }

  async function openSession(udid: string): Promise<StreamSession | undefined> {
    if (disposed) return undefined;
    const spec = await tools.launchSpec("serve-sim", ["--no-preview", "-q", udid]);
    if (spec === undefined || disposed) return undefined;
    const child = spawn(spec.command, spec.args, {
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // An unread stderr pipe fills and stalls the tool. An unhandled spawn
    // error is thrown in Electron main.
    discardChildNoise(child);
    tools.trackProcess("serve-sim", child);
    live.add(child);
    forget(child);
    const endpoint = await readEndpoint(child, udid, AbortSignal.timeout(readyMs));
    child.stdout?.resume();
    if (endpoint === undefined || disposed) {
      child.kill("SIGTERM");
      return undefined;
    }
    const screen = await readScreen(fetchImpl, endpoint, AbortSignal.timeout(readyMs));
    if (screen === undefined || disposed) {
      child.kill("SIGTERM");
      return undefined;
    }
    const session: StreamSession = {
      udid,
      endpoint,
      screen,
      child,
      viewers: new Set(),
      latest: undefined,
      rest: new Uint8Array(),
      reader: undefined,
      reading: false,
      closed: false,
      streamAbort: undefined,
      waiters: [],
    };
    child.once("exit", () => {
      session.closed = true;
      sessions.delete(udid);
      failWaiters(session);
      for (const viewer of session.viewers) viewer.onEnd();
      session.viewers.clear();
    });
    return session;
  }

  function retire(session: StreamSession): void {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.udid);
    session.streamAbort?.abort();
    void session.reader?.cancel();
    failWaiters(session);
    for (const viewer of session.viewers) viewer.onEnd();
    session.viewers.clear();
    session.child.kill("SIGTERM");
  }

  function sessionFor(udid: string): Promise<StreamSession | undefined> {
    const existing = sessions.get(udid);
    if (existing !== undefined) return existing;
    const created = openSession(udid).then((session) => {
      if (session === undefined) sessions.delete(udid);
      return session;
    });
    sessions.set(udid, created);
    return created;
  }

  async function runControl(
    args: ReadonlyArray<string>,
    timeoutMs: number,
    cancelled: AbortSignal | undefined,
  ): Promise<"ok" | "unavailable" | "missing"> {
    const spec = await tools.launchSpec("serve-sim", args);
    if (spec === undefined) return "missing";
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(cancelled === undefined ? [] : [cancelled]),
    ]);
    if (signal.aborted) return "unavailable";
    const child = spawn(spec.command, spec.args, {
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    discardChildNoise(child);
    tools.trackProcess("serve-sim", child);
    live.add(child);
    forget(child);
    inflight += 1;
    try {
      const code = await childExit(child, signal);
      return code === 0 ? "ok" : "unavailable";
    } finally {
      inflight -= 1;
    }
  }

  async function deliver(
    session: StreamSession,
    request: DeviceHelperRequest,
    budgetMs: number,
    cancelled: AbortSignal | undefined,
  ): Promise<
    DeviceHelperReply | "native" | { readonly kind: "disconnected"; readonly remainingMs: number }
  > {
    if (request.op === "hello") {
      return { status: "delivered", screen: session.screen };
    }
    if (request.op === "stream-start" || request.op === "stream-stop") {
      return { status: "delivered" };
    }
    if (request.op === "key") return "native";
    const commands = controlCommands(session.udid, request);
    if (commands === undefined) return "native";
    // serve-sim's command line answers once its socket took the message, not
    // once the guest acted on it, so a Simulator whose input Device Hub took
    // would hear every touch reported as delivered. A finger already down
    // was checked when it went down, and stays on the path it went down on.
    if (request.op === "touch" && request.phase !== "down" && nativeFingers.has(session.udid)) {
      return { kind: "disconnected", remainingMs: budgetMs };
    }
    // The question comes out of the input's own deadline: the broker keeps a
    // margin to answer the server inside it, and a send that started late
    // could land after the server gave the action up and a retry sent it again.
    let timeoutMs = budgetMs;
    if (!(request.op === "touch" && request.phase !== "down")) {
      const askedAt = Date.now();
      const connection = await inputConnection(
        session.udid,
        AbortSignal.any([
          AbortSignal.timeout(Math.min(INPUT_CONNECTION_MS, budgetMs)),
          ...(cancelled === undefined ? [] : [cancelled]),
        ]),
      );
      if (actionWasCancelled(cancelled)) {
        return { status: "unavailable", message: "The action was cancelled." };
      }
      timeoutMs = budgetMs - (Date.now() - askedAt);
      if (timeoutMs <= 0) {
        return { status: "unavailable", message: "Checking the Simulator's input used the time." };
      }
      if (connection === "disconnected") return { kind: "disconnected", remainingMs: timeoutMs };
    }
    let sent = false;
    let gestureOpen = false;
    const releaseGesture = async () => {
      if (!gestureOpen || request.op !== "swipe") return;
      gestureOpen = false;
      await runControl(
        [
          "gesture",
          JSON.stringify({ type: "end", x: request.toX, y: request.toY }),
          "-d",
          session.udid,
        ],
        timeoutMs,
        undefined,
      );
    };
    for (const command of commands) {
      if (command.kind === "wait") {
        await delay(command.ms, cancelled);
        if (actionWasCancelled(cancelled)) {
          await releaseGesture();
          return { status: "unavailable", message: "The action was cancelled." };
        }
        continue;
      }
      const outcome = await runControl(command.args, timeoutMs, cancelled);
      // A command that already reached the stream must not be repeated on the
      // native helper. A missing tool before anything was sent still can.
      // A swipe that already put a finger down lifts it before returning.
      if (outcome !== "ok") {
        if (sent && command.gesture !== "close") await releaseGesture();
        return sent || outcome !== "missing"
          ? { status: "unavailable", message: "The simulator stream did not accept the input." }
          : "native";
      }
      sent = true;
      if (command.gesture === "open") gestureOpen = true;
      if (command.gesture === "close") gestureOpen = false;
    }
    return { status: "delivered" };
  }

  /**
   * serve-sim types US key positions without reading the guest layout, so text
   * never goes to it. Text the device helper can key goes there; punctuation
   * and non-Latin text is pasted through the Simulator pasteboard.
   */
  async function typeText(
    udid: string,
    text: string,
    timeoutMs: number,
    cancelled: AbortSignal | undefined,
  ): Promise<DeviceHelperReply> {
    if (KEY_TYPED_TEXT.test(text)) {
      return native.send(udid, { op: "text", text }, timeoutMs, cancelled);
    }
    const startedAt = Date.now();
    const signal =
      cancelled === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([cancelled, AbortSignal.timeout(timeoutMs)]);
    const copied = await copyToPasteboard(udid, text, signal);
    if (actionWasCancelled(cancelled)) {
      return { status: "unavailable", message: "The action was cancelled." };
    }
    if (!copied) {
      return { status: "unavailable", message: "The Simulator pasteboard could not be set." };
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return { status: "unavailable", message: "Setting the Simulator pasteboard used the time." };
    }
    return native.send(udid, { op: "key", ...PASTE_KEY }, remainingMs, cancelled);
  }

  /**
   * Device Hub's input daemon is what took the input, and the native helper
   * speaks to that daemon, proving it answers before it sends (observed
   * 2026-10-08 on Xcode 27.0: the helper opened Settings on a Simulator whose
   * serve-sim taps were being dropped). When the helper cannot deliver either,
   * the input is refused as disconnected so Repair input can be offered.
   */
  async function disconnectedInput(
    udid: string,
    request: DeviceHelperRequest,
    timeoutMs: number,
    cancelled: AbortSignal | undefined,
  ): Promise<DeviceHelperReply> {
    if (request.op === "touch" && request.phase === "down") nativeFingers.add(udid);
    if (request.op === "touch" && request.phase === "up") nativeFingers.delete(udid);
    const reply = await native.send(udid, request, timeoutMs, cancelled);
    if (reply.status === "delivered") return reply;
    if (request.op === "touch") nativeFingers.delete(udid);
    if (actionWasCancelled(cancelled)) return reply;
    return { status: "refused", code: "input-disconnected", message: INPUT_DISCONNECTED_MESSAGE };
  }

  /**
   * Gives touch and buttons back to the legacy services serve-sim drives, then
   * drops the stream: serve-sim reconnects to them only when it starts again.
   */
  async function repairInput(
    udid: string,
    timeoutMs: number,
    cancelled: AbortSignal | undefined,
  ): Promise<DeviceHelperReply> {
    const outcome = await runControl(["repair-input", "-d", udid], timeoutMs, cancelled);
    if (outcome === "missing") {
      return {
        status: "refused",
        code: "repair-unavailable",
        message: "Repair input needs the managed serve-sim tool, and it is not installed.",
      };
    }
    if (outcome !== "ok") {
      return { status: "unavailable", message: "The Simulator's input could not be repaired." };
    }
    nativeFingers.delete(udid);
    const session = await sessions.get(udid);
    if (session !== undefined) retire(session);
    return { status: "delivered" };
  }

  async function ensureFrames(session: StreamSession): Promise<void> {
    if (session.reading || session.closed) return;
    session.reading = true;
    const abort = new AbortController();
    session.streamAbort = abort;
    let response: Response;
    try {
      response = await fetchImpl(session.endpoint.streamUrl, {
        redirect: "error",
        credentials: "omit",
        signal: abort.signal,
      });
    } catch {
      session.reading = false;
      if (session.streamAbort === abort) session.streamAbort = undefined;
      failWaiters(session);
      return;
    }
    if (!response.ok || response.body === null || session.closed || abort.signal.aborted) {
      await response.body?.cancel();
      session.reading = false;
      if (session.streamAbort === abort) session.streamAbort = undefined;
      failWaiters(session);
      return;
    }
    const reader = response.body.getReader();
    session.reader = reader;
    try {
      while (!session.closed && !abort.signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        const taken = takeJpegFrames(concat(session.rest, next.value));
        session.rest = taken.rest;
        for (const frame of taken.frames) publish(session, frame);
      }
    } catch {
      // The reader is cancelled when the last viewer leaves.
    } finally {
      session.reading = false;
      session.reader = undefined;
      if (session.streamAbort === abort) session.streamAbort = undefined;
      if (!session.closed && !abort.signal.aborted) {
        for (const viewer of session.viewers) viewer.onEnd();
        session.viewers.clear();
      }
      failWaiters(session);
    }
  }

  function stopView(session: StreamSession, viewer: DeviceViewer): void {
    if (!session.viewers.delete(viewer) || session.viewers.size > 0) return;
    session.latest = undefined;
    session.rest = new Uint8Array();
    session.streamAbort?.abort();
    const reader = session.reader;
    session.reader = undefined;
    void reader?.cancel();
  }

  return {
    async send(simulatorId, request, timeoutMs, cancelled) {
      if (actionWasCancelled(cancelled)) {
        return { status: "unavailable", message: "The action was cancelled." };
      }
      if (disposed) return { status: "unavailable", message: "The desktop is shutting down." };
      if (!SIMULATOR_ID.test(simulatorId)) {
        return {
          status: "refused",
          code: "no-such-device",
          message: "That is not a Simulator identifier.",
        };
      }
      if (request.op === "key") return native.send(simulatorId, request, timeoutMs, cancelled);
      if (request.op === "text") return typeText(simulatorId, request.text, timeoutMs, cancelled);
      if (request.op === "repair-input") return repairInput(simulatorId, timeoutMs, cancelled);
      const session = await sessionFor(simulatorId);
      if (actionWasCancelled(cancelled)) {
        return { status: "unavailable", message: "The action was cancelled." };
      }
      if (session === undefined || session.closed) {
        return native.send(simulatorId, request, timeoutMs, cancelled);
      }
      const delivered = await deliver(session, request, timeoutMs, cancelled);
      if (delivered === "native") return native.send(simulatorId, request, timeoutMs, cancelled);
      if ("kind" in delivered) {
        return disconnectedInput(simulatorId, request, delivered.remainingMs, cancelled);
      }
      return delivered;
    },

    async watch(simulatorId, watchOptions, viewer, timeoutMs) {
      if (disposed) return { status: "unavailable", message: "The desktop is shutting down." };
      if (!SIMULATOR_ID.test(simulatorId)) {
        return {
          status: "refused",
          code: "no-such-device",
          message: "That is not a Simulator identifier.",
        };
      }
      const session = await sessionFor(simulatorId);
      if (session === undefined || session.closed) {
        return native.watch(simulatorId, watchOptions, viewer, timeoutMs);
      }
      session.viewers.add(viewer);
      if (session.latest !== undefined) viewer.onFrame(session.latest);
      void ensureFrames(session);
      const frame = await waitForFrame(session, firstFrameMs);
      if (frame === undefined || session.closed || !session.viewers.has(viewer)) {
        const streamFailed = frame === undefined && !session.closed;
        stopView(session, viewer);
        // A session that never produced a frame must not keep later taps on
        // serve-sim while the picture comes from the device helper.
        if (streamFailed) retire(session);
        return native.watch(simulatorId, watchOptions, viewer, timeoutMs);
      }
      return {
        status: "watching",
        stop: () => stopView(session, viewer),
      };
    },

    busy: () => inflight > 0 || native.busy(),

    dispose() {
      disposed = true;
      for (const child of live) child.kill("SIGTERM");
      live.clear();
      for (const pending of sessions.values()) {
        void pending.then((session) => {
          if (session === undefined) return;
          session.closed = true;
          failWaiters(session);
          for (const viewer of session.viewers) viewer.onEnd();
          session.viewers.clear();
          session.streamAbort?.abort();
          void session.reader?.cancel();
        });
      }
      sessions.clear();
      native.dispose();
    },
  };
}

type ControlCommand =
  | {
      readonly kind: "args";
      readonly args: ReadonlyArray<string>;
      readonly gesture?: "open" | "close";
    }
  | { readonly kind: "wait"; readonly ms: number };

function controlCommands(
  udid: string,
  request: DeviceHelperRequest,
): readonly ControlCommand[] | undefined {
  const device = ["-d", udid] as const;
  if (request.op === "tap") {
    return [{ kind: "args", args: ["tap", String(request.x), String(request.y), ...device] }];
  }
  if (request.op === "button") {
    // serve-sim names the sleep/wake control `power`.
    const name = request.button === "lock" ? "power" : request.button;
    return [{ kind: "args", args: ["button", name, ...device] }];
  }
  if (request.op === "touch") {
    const type = request.phase === "down" ? "begin" : request.phase === "move" ? "move" : "end";
    return [
      {
        kind: "args",
        args: ["gesture", JSON.stringify({ type, x: request.x, y: request.y }), ...device],
      },
    ];
  }
  if (request.op === "swipe") {
    return [
      {
        kind: "args",
        gesture: "open",
        args: [
          "gesture",
          JSON.stringify({ type: "begin", x: request.fromX, y: request.fromY }),
          ...device,
        ],
      },
      { kind: "wait", ms: request.durationMs ?? 0 },
      {
        kind: "args",
        args: [
          "gesture",
          JSON.stringify({ type: "move", x: request.toX, y: request.toY }),
          ...device,
        ],
      },
      {
        kind: "args",
        gesture: "close",
        args: [
          "gesture",
          JSON.stringify({ type: "end", x: request.toX, y: request.toY }),
          ...device,
        ],
      },
    ];
  }
  return undefined;
}

function publish(session: StreamSession, frame: Uint8Array): void {
  session.latest = frame;
  for (const viewer of session.viewers) viewer.onFrame(frame);
  const waiting = session.waiters.splice(0);
  for (const waiter of waiting) waiter(frame);
}

function failWaiters(session: StreamSession): void {
  const waiting = session.waiters.splice(0);
  for (const waiter of waiting) waiter(undefined);
}

function waitForFrame(session: StreamSession, timeoutMs: number): Promise<Uint8Array | undefined> {
  if (session.latest !== undefined) return Promise.resolve(session.latest);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = session.waiters.indexOf(finish);
      if (index !== -1) session.waiters.splice(index, 1);
      resolve(undefined);
    }, timeoutMs);
    const finish = (frame: Uint8Array | undefined) => {
      clearTimeout(timer);
      resolve(frame);
    };
    session.waiters.push(finish);
  });
}

async function readScreen(
  fetchImpl: typeof fetch,
  endpoint: ManagedDeviceEndpoint,
  signal: AbortSignal,
): Promise<{ readonly width: number; readonly height: number } | undefined> {
  const configUrl = endpoint.streamUrl.replace(/\/stream\.mjpeg$/, "/config");
  // serve-sim answers 0×0 until its capture has seen the display.
  while (!signal.aborted) {
    const screen = await readConfig(fetchImpl, configUrl, signal);
    if (screen === "error") return undefined;
    if (screen !== "pending") return screen;
    await delay(CONFIG_POLL_MS, signal);
  }
  return undefined;
}

async function readConfig(
  fetchImpl: typeof fetch,
  configUrl: string,
  signal: AbortSignal,
): Promise<{ readonly width: number; readonly height: number } | "pending" | "error"> {
  let response: Response;
  try {
    response = await fetchImpl(configUrl, { redirect: "error", credentials: "omit", signal });
  } catch {
    return "error";
  }
  if (!response.ok) return "error";
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return "error";
  }
  if (!isRecord(body)) return "error";
  const width = body.width;
  const height = body.height;
  if (typeof width !== "number" || typeof height !== "number") return "error";
  if (!Number.isFinite(width) || !Number.isFinite(height)) return "error";
  if (width === 0 && height === 0) return "pending";
  if (width <= 0 || height <= 0 || width > 20_000 || height > 20_000) return "error";
  return { width, height };
}

/** `xcrun simctl pbcopy` reads the text from stdin, so it never reaches argv. */
function simctlPasteboardCopy(udid: string, text: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess("xcrun", ["simctl", "pbcopy", udid], {
        // pbcopy decodes stdin with the locale; a GUI app's environment often has none.
        env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
        stdio: ["pipe", "ignore", "ignore"],
        signal,
      });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
    child.stdin?.once("error", () => undefined);
    child.stdin?.end(text);
  });
}

/**
 * Reads Device Hub's input notification inside the guest. An answer that is
 * neither state, or none in time, is `unknown`: the question went unanswered,
 * which says nothing about the input itself.
 */
function simctlInputConnection(
  udid: string,
  signal: AbortSignal,
): Promise<SimulatorInputConnection> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(
        "xcrun",
        ["simctl", "spawn", udid, "notifyutil", "-g", DEVICE_HUB_INPUT_NOTIFICATION],
        { stdio: ["ignore", "pipe", "ignore"], signal },
      );
    } catch {
      resolve("unknown");
      return;
    }
    let output = "";
    child.stdout?.on("data", (chunk: Uint8Array) => {
      output += Buffer.from(chunk).toString("utf8");
    });
    child.once("error", () => resolve("unknown"));
    // `close`, not `exit`: the process can end before its stdout has drained,
    // and a half-read answer would read as unknown and let serve-sim send.
    child.once("close", (code) => resolve(code === 0 ? readInputConnection(output) : "unknown"));
  });
}

/** `notifyutil -g` prints the notification's name and its state. */
export function readInputConnection(output: string): SimulatorInputConnection {
  const state = output.trim();
  if (state === `${DEVICE_HUB_INPUT_NOTIFICATION} 1`) return "disconnected";
  if (state === `${DEVICE_HUB_INPUT_NOTIFICATION} 0`) return "connected";
  return "unknown";
}

function readEndpoint(
  child: ChildProcess,
  device: string,
  signal: AbortSignal,
): Promise<ManagedDeviceEndpoint | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (value: ManagedDeviceEndpoint | undefined) => {
      if (settled) return;
      settled = true;
      child.stdout?.off("data", onData);
      child.off("close", onClose);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const consider = (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      const endpoint = readManagedDeviceEndpoint(trimmed, device);
      if (endpoint !== undefined) {
        finish(endpoint);
        return;
      }
      // A state line that is not a loopback stream for this device will not
      // be followed by a better one. Log lines are not JSON and can be ignored.
      try {
        const value: unknown = JSON.parse(trimmed);
        if (isRecord(value) && (value.device === device || typeof value.streamUrl === "string")) {
          finish(undefined);
        }
      } catch {
        // Not the tool's state line.
      }
    };
    const onData = (chunk: Uint8Array) => {
      buffer += Buffer.from(chunk).toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consider(line);
    };
    const onClose = () => {
      consider(buffer);
      finish(undefined);
    };
    const onError = () => finish(undefined);
    const onAbort = () => finish(undefined);
    child.stdout?.on("data", onData);
    child.once("close", onClose);
    child.once("error", onError);
    if (signal.aborted) finish(undefined);
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function childExit(child: ChildProcess, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(code);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(null);
    };
    child.once("error", () => finish(1));
    child.once("exit", (code) => finish(code));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function discardChildNoise(child: ChildProcess): void {
  child.on("error", () => undefined);
  child.stderr?.resume();
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

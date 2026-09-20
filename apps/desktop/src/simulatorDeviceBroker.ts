import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ParseResult } from "effect";
import {
  decodeSimulatorDeviceInput,
  decodeSimulatorDeviceWatch,
  SIMULATOR_SCREEN_HEADER,
  type SimulatorDeviceInput,
  type SimulatorDeviceInputResult,
} from "@octant/contracts/simulator-device";
import type { DeviceHelperReply, SimulatorDeviceHelpers } from "./simulatorDeviceHelper";

const HEADER = "x-octant-simulator-device-token";
const PATH = "/v1/simulator-device";
const STREAM_PATH = "/v1/simulator-device/stream";
const WATCH_START_MS = 20_000;
const MAX_BODY_BYTES = 16 * 1024;
/** The helper's answer has to reach the server before the action's own deadline. */
const ANSWER_MARGIN_MS = 2_000;
const SHORTEST_USEFUL_BUDGET_MS = 1_000;
const failure = (status: number) =>
  Response.json({ error: "simulator-device-broker-refused" }, { status });

function result(reply: DeviceHelperReply): SimulatorDeviceInputResult {
  if (reply.status === "delivered") return { kind: "delivered" };
  if (reply.status === "refused") {
    return { kind: "refused", reason: reply.code, message: reply.message };
  }
  return { kind: "unavailable", reason: "helper-unavailable", message: reply.message };
}

/**
 * Turns one workbench input into what the helper understands. A tap arrives as
 * a point on a captured screen; the helper takes fractions of the screen, so
 * the point is divided by the screen size the helper itself reports — the
 * capture and the device share that pixel space.
 */
type Screen = { readonly width: number; readonly height: number };

/** A Simulator's screen size, asked of its helper once; a device never changes it. */
function createScreenLookup(helpers: SimulatorDeviceHelpers) {
  const screens = new Map<string, Screen>();
  return async (
    udid: string,
    budgetMs: number,
    cancelled?: AbortSignal,
  ): Promise<
    | { readonly kind: "screen"; readonly screen: Screen }
    | Exclude<SimulatorDeviceInputResult, { readonly kind: "delivered" }>
  > => {
    const known = screens.get(udid);
    if (known !== undefined) return { kind: "screen", screen: known };
    const described = await helpers.send(udid, { op: "hello" }, budgetMs, cancelled);
    if (described.status === "refused") {
      return { kind: "refused", reason: described.code, message: described.message };
    }
    if (described.status === "unavailable") {
      return { kind: "unavailable", reason: "helper-unavailable", message: described.message };
    }
    if (described.screen === undefined) {
      return {
        kind: "refused",
        reason: "screen-size-unknown",
        message: "The Simulator did not report a screen size.",
      };
    }
    screens.set(udid, described.screen);
    return { kind: "screen", screen: described.screen };
  };
}

export function createSimulatorInputDelivery(
  helpers: SimulatorDeviceHelpers,
  options: {
    readonly now?: () => number;
    readonly screenOf?: ReturnType<typeof createScreenLookup>;
  } = {},
) {
  const now = options.now ?? Date.now;
  const screenOf = options.screenOf ?? createScreenLookup(helpers);
  return async (
    command: SimulatorDeviceInput,
    cancelled?: AbortSignal,
  ): Promise<SimulatorDeviceInputResult> => {
    const budgetMs = command.budgetMs - ANSWER_MARGIN_MS;
    // The answer has to be back before the server gives the action up. A
    // deadline with no room for that is refused: stretching it would let the
    // input land after the server stopped waiting, and a retry would repeat it.
    if (budgetMs < SHORTEST_USEFUL_BUDGET_MS) {
      return {
        kind: "unavailable",
        reason: "deadline-too-short",
        message: "The action's deadline leaves no time to deliver input and answer.",
      };
    }
    // One deadline for everything this input needs. A tap first asks for the
    // screen; giving the tap a fresh budget after that let it land after the
    // server had already given the action up, and a retried action tapped twice.
    const deadline = now() + budgetMs;
    if (command.kind === "type-text") {
      return result(
        await helpers.send(command.udid, { op: "text", text: command.text }, budgetMs, cancelled),
      );
    }
    if (command.kind === "key-press") {
      const key = command.key.toLowerCase();
      return result(
        await helpers.send(
          command.udid,
          key === "home" || key === "lock" ? { op: "button", button: key } : { op: "key", key },
          budgetMs,
          cancelled,
        ),
      );
    }
    const looked = await screenOf(command.udid, budgetMs, cancelled);
    if (looked.kind !== "screen") return looked;
    const screen = looked.screen;
    const remainingMs = deadline - now();
    if (remainingMs < SHORTEST_USEFUL_BUDGET_MS) {
      return {
        kind: "unavailable",
        reason: "deadline-passed",
        message: "Getting the Simulator ready used the action's time; nothing was tapped.",
      };
    }
    const x = command.point.x / screen.width;
    const y = command.point.y / screen.height;
    if (x > 1 || y > 1) {
      return {
        kind: "refused",
        reason: "point-off-screen",
        message: `The point is outside the ${screen.width}×${screen.height} screen.`,
      };
    }
    return result(await helpers.send(command.udid, { op: "tap", x, y }, remainingMs, cancelled));
  };
}

/** Only the desktop's own server child: loopback, no browser origin, the exact token. */
function admitted(headers: Headers, peer: string, token: string): boolean {
  const supplied = Buffer.from(headers.get(HEADER) ?? "");
  const expected = Buffer.from(token);
  return (
    (peer === "127.0.0.1" || peer === "::ffff:127.0.0.1") &&
    !headers.has("origin") &&
    supplied.length === expected.length &&
    timingSafeEqual(supplied, expected)
  );
}

export function simulatorDeviceBrokerHandler(
  deliver: (
    command: SimulatorDeviceInput,
    cancelled?: AbortSignal,
  ) => Promise<SimulatorDeviceInputResult>,
  token: string,
) {
  return async (request: Request, peer = "127.0.0.1"): Promise<Response> => {
    if (!admitted(request.headers, peer, token)) return failure(401);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== PATH || url.search !== "") {
      return failure(400);
    }
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) return failure(413);
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof body !== "object" || body === null || !("input" in body)) return failure(400);
      return Response.json(await deliver(decodeSimulatorDeviceInput(body.input), request.signal));
    } catch (error) {
      return failure(ParseResult.isParseError(error) || error instanceof SyntaxError ? 400 : 503);
    }
  };
}

async function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) return undefined;
    length += chunk.byteLength;
    if (length > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

/**
 * Answers a watch request with the Simulator's screen as it changes: a header
 * naming the screen's pixel size, then length-prefixed JPEG frames until the
 * caller hangs up. A frame is dropped while the caller is still taking the
 * last one, so a slow reader sees the newest screen rather than an old queue.
 */
export function createSimulatorScreenStream(
  helpers: SimulatorDeviceHelpers,
  screenOf = createScreenLookup(helpers),
) {
  return async (body: unknown, outgoing: ServerResponse): Promise<void> => {
    const refuse = (status: number, value: unknown) => {
      outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(value));
    };
    let watch;
    try {
      if (typeof body !== "object" || body === null || !("watch" in body)) throw new SyntaxError();
      watch = decodeSimulatorDeviceWatch(body.watch);
    } catch {
      return refuse(400, { error: "simulator-device-broker-refused" });
    }
    // Listening before the first wait: a viewer who hangs up during the screen
    // lookup closes the response before a later listener would exist, and the
    // watch started afterwards could never be stopped.
    // A viewer can also be gone before this runs — the request body is read
    // first — and a close that already happened is never announced again.
    if (outgoing.destroyed) return;
    let open = true;
    let stopWatching: (() => void) | undefined;
    outgoing.once("close", () => {
      open = false;
      stopWatching?.();
    });
    const looked = await screenOf(watch.udid, WATCH_START_MS);
    if (!open) return;
    if (looked.kind !== "screen") return refuse(409, looked);
    let ready = false;
    let draining = false;
    // The helper sends the screen as it is the moment the stream starts, which
    // is before this answer's headers exist. It is kept and written first, or
    // a still device would show nothing until something on it moved.
    let early: Uint8Array | undefined;
    // While the viewer is still taking a frame, newer ones are not queued —
    // but the newest is kept. A device that goes still after an animation sends
    // nothing more, so without it a slow viewer would stay on an old screen.
    let missed: Uint8Array | undefined;
    const send = (jpeg: Uint8Array) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(jpeg.byteLength);
      outgoing.write(header);
      if (!outgoing.write(jpeg)) {
        draining = true;
        outgoing.once("drain", () => {
          draining = false;
          const newest = missed;
          missed = undefined;
          if (open && newest !== undefined) send(newest);
        });
      }
    };
    const started = await helpers.watch(
      watch.udid,
      {
        maxHeight: watch.maxHeight,
        quality: watch.quality,
        framesPerSecond: watch.framesPerSecond,
      },
      {
        onFrame: (jpeg) => {
          if (!open) return;
          if (draining) missed = jpeg;
          else if (ready) send(jpeg);
          else early = jpeg;
        },
        onEnd: () => {
          open = false;
          outgoing.end();
        },
      },
      WATCH_START_MS,
    );
    if (started.status !== "watching") {
      return refuse(
        409,
        started.status === "refused"
          ? { kind: "refused", reason: started.code, message: started.message }
          : { kind: "unavailable", reason: "helper-unavailable", message: started.message },
      );
    }
    outgoing.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      [SIMULATOR_SCREEN_HEADER]: `${looked.screen.width}x${looked.screen.height}`,
    });
    outgoing.flushHeaders();
    stopWatching = started.stop;
    if (!open) return started.stop();
    ready = true;
    if (early !== undefined) send(early);
  };
}

/** A loopback, token-guarded endpoint the desktop's own server child calls. */
export async function startSimulatorDeviceBroker(helpers: SimulatorDeviceHelpers) {
  const token = randomBytes(32).toString("base64url");
  const screenOf = createScreenLookup(helpers);
  const handle = simulatorDeviceBrokerHandler(
    createSimulatorInputDelivery(helpers, { screenOf }),
    token,
  );
  const stream = createSimulatorScreenStream(helpers, screenOf);
  const server = createServer((incoming, outgoing) => {
    if (incoming.method === "POST" && incoming.url === STREAM_PATH) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      if (!admitted(headers, incoming.socket.remoteAddress ?? "", token)) {
        outgoing.writeHead(401, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "simulator-device-broker-refused" }));
        return;
      }
      void readBody(incoming)
        .then((body) =>
          stream(
            body === undefined ? undefined : JSON.parse(Buffer.from(body).toString("utf8")),
            outgoing,
          ),
        )
        .catch(() => {
          if (!outgoing.headersSent) outgoing.writeHead(400);
          outgoing.end();
        });
      return;
    }
    // The server cancels an action by dropping this connection. That has to
    // reach the helper, or a cold one would finish getting ready and deliver
    // the input seconds after the action was recorded as cancelled.
    const disconnected = new AbortController();
    incoming.once("aborted", () => disconnected.abort());
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) disconnected.abort();
    });
    void (async () => {
      const body = await readBody(incoming);
      if (body === undefined) return failure(413);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(","));
      }
      return handle(
        new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
          method: incoming.method ?? "POST",
          headers,
          signal: disconnected.signal,
          ...(incoming.method === "GET" || incoming.method === "HEAD"
            ? {}
            : { body: Buffer.from(body) }),
        }),
        incoming.socket.remoteAddress ?? "",
      );
    })().then(
      async (response) => {
        outgoing.writeHead(response.status, { "content-type": "application/json" });
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      },
      () => {
        outgoing.writeHead(503);
        outgoing.end();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Simulator device broker did not bind.");
  }
  return {
    token,
    url: `http://127.0.0.1:${address.port}${PATH}`,
    close: async () => {
      helpers.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
export type SimulatorDeviceBroker = Awaited<ReturnType<typeof startSimulatorDeviceBroker>>;

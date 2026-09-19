import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { ParseResult } from "effect";
import {
  decodeSimulatorDeviceInput,
  type SimulatorDeviceInput,
  type SimulatorDeviceInputResult,
} from "@octant/contracts/simulator-device";
import type { DeviceHelperReply, SimulatorDeviceHelpers } from "./simulatorDeviceHelper";

const HEADER = "x-octant-simulator-device-token";
const PATH = "/v1/simulator-device";
const MAX_BODY_BYTES = 16 * 1024;
/** The helper's answer has to reach the server before the action's own deadline. */
const ANSWER_MARGIN_MS = 2_000;
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
export function createSimulatorInputDelivery(helpers: SimulatorDeviceHelpers) {
  const screens = new Map<string, { readonly width: number; readonly height: number }>();
  return async (command: SimulatorDeviceInput): Promise<SimulatorDeviceInputResult> => {
    const budgetMs = Math.max(command.budgetMs - ANSWER_MARGIN_MS, 1_000);
    if (command.kind === "type-text") {
      return result(await helpers.send(command.udid, { op: "text", text: command.text }, budgetMs));
    }
    if (command.kind === "key-press") {
      const key = command.key.toLowerCase();
      return result(
        await helpers.send(
          command.udid,
          key === "home" || key === "lock" ? { op: "button", button: key } : { op: "key", key },
          budgetMs,
        ),
      );
    }
    let screen = screens.get(command.udid);
    if (screen === undefined) {
      const described = await helpers.send(command.udid, { op: "hello" }, budgetMs);
      if (described.status !== "delivered") return result(described);
      if (described.screen === undefined) {
        return {
          kind: "refused",
          reason: "screen-size-unknown",
          message: "The Simulator did not report a screen size to map the tap onto.",
        };
      }
      screen = described.screen;
      screens.set(command.udid, screen);
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
    return result(await helpers.send(command.udid, { op: "tap", x, y }, budgetMs));
  };
}

export function simulatorDeviceBrokerHandler(
  deliver: (command: SimulatorDeviceInput) => Promise<SimulatorDeviceInputResult>,
  token: string,
) {
  return async (request: Request, peer = "127.0.0.1"): Promise<Response> => {
    const supplied = Buffer.from(request.headers.get(HEADER) ?? "");
    const expected = Buffer.from(token);
    if (
      (peer !== "127.0.0.1" && peer !== "::ffff:127.0.0.1") ||
      request.headers.has("origin") ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return failure(401);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== PATH || url.search !== "") {
      return failure(400);
    }
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) return failure(413);
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof body !== "object" || body === null || !("input" in body)) return failure(400);
      return Response.json(await deliver(decodeSimulatorDeviceInput(body.input)));
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

/** A loopback, token-guarded endpoint the desktop's own server child calls. */
export async function startSimulatorDeviceBroker(helpers: SimulatorDeviceHelpers) {
  const token = randomBytes(32).toString("base64url");
  const handle = simulatorDeviceBrokerHandler(createSimulatorInputDelivery(helpers), token);
  const server = createServer((incoming, outgoing) => {
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

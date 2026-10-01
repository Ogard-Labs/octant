import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readManagedDeviceEndpoint } from "@octant/domain/managed-device-stream";
import type { ManagedSimulatorTools } from "./managedSimulatorHelpers";

const PATH = "/v1/managed-device/serve-avd";
const HEADER = "x-octant-managed-device-token";
const SERIAL = /^emulator-[0-9]+$/;
const READY_MS = 8_000;
const MAX_BODY_BYTES = 4 * 1024;

export interface ServeAvdBrokerOptions {
  readonly spawn?: (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly stdio: ["ignore", "pipe", "pipe"];
    },
  ) => ChildProcess;
  readonly readyMs?: number;
}

interface AvdSession {
  readonly origin: string;
  readonly streamUrl: string;
  readonly child: ChildProcess;
}

/**
 * Loopback broker the desktop's server child calls to attach serve-avd to an
 * emulator that is already booted. The tool process stays in Electron main.
 * A missing tool answers 503 so the server keeps using adb.
 */
export async function startServeAvdBroker(
  tools: ManagedSimulatorTools,
  options: ServeAvdBrokerOptions = {},
) {
  const spawn = options.spawn ?? spawnProcess;
  const readyMs = options.readyMs ?? READY_MS;
  const token = randomBytes(32).toString("base64url");
  const sessions = new Map<string, Promise<AvdSession | undefined>>();
  let closed = false;

  function open(serial: string): Promise<AvdSession | undefined> {
    const existing = sessions.get(serial);
    if (existing !== undefined) return existing;
    let slot: Promise<AvdSession | undefined> | undefined;
    const created = launch(serial, () => {
      if (slot !== undefined && sessions.get(serial) === slot) sessions.delete(serial);
    }).then((session) => {
      if (session === undefined && sessions.get(serial) === slot) sessions.delete(serial);
      return session;
    });
    slot = created;
    sessions.set(serial, created);
    return created;
  }

  async function launch(serial: string, onExit: () => void): Promise<AvdSession | undefined> {
    if (closed) return undefined;
    const spec = await tools.launchSpec("serve-avd", [
      "--no-preview",
      "-q",
      "--codec",
      "mjpeg",
      "--host",
      "127.0.0.1",
      serial,
    ]);
    if (spec === undefined || closed) return undefined;
    const child = spawn(spec.command, spec.args, {
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // An unread stderr pipe fills and stalls serve-avd. An unhandled spawn
    // error is thrown in Electron main.
    child.on("error", () => undefined);
    child.stderr?.resume();
    tools.trackProcess("serve-avd", child);
    child.once("exit", onExit);
    const endpoint = await readStdoutEndpoint(child, serial, AbortSignal.timeout(readyMs));
    child.stdout?.resume();
    if (endpoint === undefined || closed) {
      child.kill("SIGTERM");
      return undefined;
    }
    return { origin: endpoint.origin, streamUrl: endpoint.streamUrl, child };
  }

  const server = createServer((incoming, outgoing) => {
    void handle(incoming, outgoing, token, open).catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(503);
      outgoing.end();
    });
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
    throw new Error("serve-avd broker did not bind.");
  }
  return {
    token,
    url: `http://127.0.0.1:${address.port}${PATH}`,
    close: async () => {
      closed = true;
      for (const pending of sessions.values()) {
        const session = await pending;
        session?.child.kill("SIGTERM");
      }
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

export type ServeAvdBroker = Awaited<ReturnType<typeof startServeAvdBroker>>;

async function handle(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  token: string,
  open: (serial: string) => Promise<AvdSession | undefined>,
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  if (!admitted(headers, incoming.socket.remoteAddress ?? "", token)) {
    writeJson(outgoing, 401, { error: "managed-device-broker-refused" });
    return;
  }
  if (incoming.method !== "POST" || incoming.url !== PATH) {
    writeJson(outgoing, 404, { error: "managed-device-broker-refused" });
    return;
  }
  const body = await readBody(incoming);
  const serial = isRecord(body) && typeof body.serial === "string" ? body.serial : undefined;
  if (serial === undefined || !SERIAL.test(serial)) {
    writeJson(outgoing, 400, { error: "managed-device-broker-refused" });
    return;
  }
  const session = await open(serial);
  if (session === undefined) {
    writeJson(outgoing, 503, { error: "managed-device-broker-unavailable" });
    return;
  }
  writeJson(outgoing, 200, { origin: session.origin, streamUrl: session.streamUrl });
}

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

function writeJson(outgoing: ServerResponse, status: number, body: unknown): void {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(body));
}

function readBody(incoming: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    incoming.on("error", reject);
  });
}

function readStdoutEndpoint(
  child: ChildProcess,
  device: string,
  signal: AbortSignal,
): Promise<{ readonly origin: string; readonly streamUrl: string } | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (value: { readonly origin: string; readonly streamUrl: string } | undefined) => {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

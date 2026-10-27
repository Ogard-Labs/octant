/**
 * The host's local-daemon port for desktop drivers.
 *
 * A driver whose provider is run by a daemon on this machine (Cua's
 * `cua daemon`) reaches it only through this port. The driver declares in
 * code one socket path under the home directory and the closed list of
 * methods it calls; the host decides whether a call may go. It connects only
 * to that Unix socket, after checking that nobody but Octant's user could
 * have put it there, never to the daemon's loopback TCP listener, and reads
 * no token file. It frames gRPC-Web over HTTP/1.1 itself, writes every
 * header, and bounds each call in time and bytes. Nothing here logs a method,
 * a header, or a message.
 *
 * The rules are in docs/design/disposable-desktops.md ("The local-daemon
 * port").
 */
import { lstat } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  desktopDaemonMethodDeclared,
  maxDesktopFrameBytes,
  type DesktopDaemonDeclaration,
  type DesktopDaemonPort,
  type DesktopDaemonRequest,
  type DesktopDaemonResult,
} from "@octant/plugin-api/desktop-provider";

export interface DesktopDaemonPortOptions {
  /** The daemon the driver declares in its code. */
  readonly daemon: () => DesktopDaemonDeclaration;
  /**
   * The home directory of the user Octant runs as. Defaults to the one
   * `os.userInfo()` reports: under Node, the packaged desktop's runtime, the
   * one the operating system records, whatever `$HOME` says. Bun, which runs
   * the development and headless servers, reports `$HOME` there when it is
   * set (observed on Bun 1.4.4), so an override can move where the walk
   * starts; the owner and mode checks still hold from that directory down.
   */
  readonly homeDirectory?: string;
  /** The user Octant runs as. Defaults to the process's own. */
  readonly userId?: number;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

/** One exchange, from the connect to the last byte, as for the HTTPS port; the socket checks before it are local reads. */
const DEFAULT_TIMEOUT_MS = 45_000;
/** A daemon's requests are small control messages; the Cua upload sends files in chunks. */
const DEFAULT_MAX_REQUEST_BYTES = 4 * 1_048_576;
/** A frame of the largest screen a recipe allows, uncompressed, as for the HTTPS port. */
const DEFAULT_MAX_RESPONSE_BYTES = maxDesktopFrameBytes({ width: 7_680, height: 4_320 });
/** Room around the one message for frame prefixes and the trailer frame. */
const FRAMING_ALLOWANCE_BYTES = 16_384;
/** The longest status message passed on to the driver. */
const MAX_GRPC_MESSAGE_LENGTH = 1_024;
const REQUEST_FIELDS = new Set(["method", "message", "maxResponseBytes", "stream", "signal"]);
const SOCKET_PATH_SEGMENT = /^[A-Za-z0-9._-]{1,255}$/;
const GRPC_WEB_CONTENT_TYPES = new Set(["application/grpc-web", "application/grpc-web+proto"]);
const DATA_FRAME = 0x00;
const TRAILER_FRAME = 0x80;

type Refusal = Extract<DesktopDaemonResult, { readonly status: "refused" }>["reason"];
type Failure = Extract<DesktopDaemonResult, { readonly status: "failed" }>["reason"];
const refused = (reason: Refusal): DesktopDaemonResult => ({ status: "refused", reason });
const failed = (reason: Failure): DesktopDaemonResult => ({ status: "failed", reason });

export function createDesktopDaemonPort(options: DesktopDaemonPortOptions): DesktopDaemonPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const homeDirectory = options.homeDirectory ?? recordedHomeDirectory();
  const userId = options.userId ?? process.getuid?.();

  return {
    call: async (request) => {
      // The request type has no headers, but a driver that is not
      // type-checked can send any shape; anything beyond these fields could
      // only be an attempt to set what the host owns.
      if (!requestWellFormed(request)) return refused("request-invalid");
      if (request.signal?.aborted === true) return { status: "cancelled" };
      const declaration = options.daemon();
      if (!desktopDaemonMethodDeclared(request.method, declaration.methods)) {
        return refused("method-not-declared");
      }
      if (request.message.byteLength > maxRequestBytes) return refused("request-too-large");
      if (homeDirectory === undefined || userId === undefined) return refused("socket-unsafe");
      const socket = await checkDaemonSocket(homeDirectory, declaration.socketPath, userId);
      if (socket.status === "unsafe") return refused("socket-unsafe");
      if (socket.status === "missing") return failed("daemon-unreachable");
      const limit = Math.min(Math.max(0, request.maxResponseBytes), maxResponseBytes);
      return exchange({
        socketPath: socket.path,
        method: request.method,
        message: request.message,
        timeoutMs,
        limit,
        stream: request.stream === true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    },
  };
}

function recordedHomeDirectory(): string | undefined {
  try {
    return userInfo().homedir;
  } catch {
    return undefined;
  }
}

function requestWellFormed(request: DesktopDaemonRequest): boolean {
  if (typeof request !== "object" || request === null) return false;
  if (!Object.keys(request).every((key) => REQUEST_FIELDS.has(key))) return false;
  return (
    typeof request.method === "string" &&
    request.message instanceof Uint8Array &&
    Number.isSafeInteger(request.maxResponseBytes) &&
    (request.stream === undefined || typeof request.stream === "boolean") &&
    (request.signal === undefined || request.signal instanceof AbortSignal)
  );
}

type SocketCheck =
  | { readonly status: "safe"; readonly path: string }
  | { readonly status: "unsafe" }
  | { readonly status: "missing" };

/**
 * The socket at `relativePath` under `home`, only when nobody but `userId`
 * could have put it there. Every component from the home directory down is
 * read with `lstat`, so a symlink anywhere is refused rather than followed;
 * each directory must belong to `userId` and give no group or other write,
 * and the socket must belong to `userId` with no group or other permission.
 *
 * Node has no peer-credential query for a Unix socket, so who owns the file
 * and who can write its directories are what the host can check. With those
 * held, only Octant's own user could swap the socket between this check and
 * the connect, and that user can already reach the daemon.
 */
async function checkDaemonSocket(
  home: string,
  relativePath: string,
  userId: number,
): Promise<SocketCheck> {
  if (!isAbsolute(home)) return { status: "unsafe" };
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment === "." || segment === ".." || !SOCKET_PATH_SEGMENT.test(segment),
    )
  ) {
    return { status: "unsafe" };
  }
  const root = resolve(home);
  const directories = [root];
  for (const segment of segments.slice(0, -1)) {
    directories.push(join(directories[directories.length - 1] ?? root, segment));
  }
  for (const directory of directories) {
    const entry = await lstat(directory).catch((error: unknown) => missingOr(error));
    if (entry === "missing" || entry === "unsafe") return { status: entry };
    if (entry.isSymbolicLink() || !entry.isDirectory()) return { status: "unsafe" };
    if (entry.uid !== userId || (entry.mode & 0o022) !== 0) return { status: "unsafe" };
  }
  const path = join(root, ...segments);
  const socket = await lstat(path).catch((error: unknown) => missingOr(error));
  if (socket === "missing" || socket === "unsafe") return { status: socket };
  if (socket.isSymbolicLink() || !socket.isSocket()) return { status: "unsafe" };
  if (socket.uid !== userId || (socket.mode & 0o077) !== 0) return { status: "unsafe" };
  return { status: "safe", path };
}

/** A component that does not exist means the daemon is not running; any other error refuses. */
function missingOr(error: unknown): "missing" | "unsafe" {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
    ? "missing"
    : "unsafe";
}

function frameMessage(message: Uint8Array): Uint8Array {
  const framed = new Uint8Array(5 + message.byteLength);
  framed[0] = DATA_FRAME;
  new DataView(framed.buffer).setUint32(1, message.byteLength);
  framed.set(message, 5);
  return framed;
}

/** One gRPC-Web call over HTTP/1.1 on the socket, bounded in time and bytes. */
function exchange(call: {
  readonly socketPath: string;
  readonly method: string;
  readonly message: Uint8Array;
  readonly timeoutMs: number;
  readonly limit: number;
  readonly stream: boolean;
  readonly signal?: AbortSignal;
}): Promise<DesktopDaemonResult> {
  const body = frameMessage(call.message);
  const bodyLimit = call.limit + FRAMING_ALLOWANCE_BYTES;
  return new Promise((settleWith) => {
    let settled = false;
    const outgoing = httpRequest({
      socketPath: call.socketPath,
      method: "POST",
      path: call.method,
      agent: false,
      headers: {
        "content-type": "application/grpc-web+proto",
        "content-length": String(body.byteLength),
        "grpc-timeout": `${call.timeoutMs}m`,
      },
    });
    const settle = (result: DesktopDaemonResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", cancel);
      outgoing.destroy();
      settleWith(result);
    };
    const timer = setTimeout(() => settle(failed("timed-out")), call.timeoutMs);
    const cancel = () => settle({ status: "cancelled" });
    call.signal?.addEventListener("abort", cancel, { once: true });
    // A signal that fired while the socket was being checked fires no event now.
    if (call.signal?.aborted === true) cancel();
    outgoing.on("error", () => settle(failed("daemon-unreachable")));
    outgoing.on("response", (response) => {
      response.on("error", () => settle(failed("daemon-unreachable")));
      response.on("close", () => settle(failed("daemon-unreachable")));
      const contentType = (response.headers["content-type"] ?? "").split(";")[0]?.trim();
      if (response.statusCode !== 200 || !GRPC_WEB_CONTENT_TYPES.has(contentType ?? "")) {
        settle(failed("response-invalid"));
        return;
      }
      const declared = response.headers["content-length"];
      if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > bodyLimit) {
        settle(failed("response-too-large"));
        return;
      }
      const chunks: Array<Buffer> = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > bodyLimit) {
          settle(failed("response-too-large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () =>
        settle(readGrpcWebAnswer(Buffer.concat(chunks), response.headers, call.limit, call.stream)),
      );
    });
    if (!settled) outgoing.end(body);
  });
}

/**
 * One whole answer: uncompressed messages (at most one for a unary call),
 * then a trailer frame with the status, and nothing after it. A daemon that
 * fails before any message may instead send the status in the response
 * headers with no body. `limit` bounds the one message of a unary call and
 * every message of a stream together.
 */
function readGrpcWebAnswer(
  body: Buffer,
  headers: IncomingHttpHeaders,
  limit: number,
  stream: boolean,
): DesktopDaemonResult {
  let offset = 0;
  const messages: Array<Uint8Array> = [];
  let received = 0;
  let trailers: ReadonlyMap<string, string> | undefined;
  while (offset < body.byteLength) {
    if (trailers !== undefined || offset + 5 > body.byteLength) return failed("response-invalid");
    const flag = body[offset];
    const end = offset + 5 + body.readUInt32BE(offset + 1);
    if (end > body.byteLength) return failed("response-invalid");
    const payload = body.subarray(offset + 5, end);
    if (flag === DATA_FRAME) {
      if (!stream && messages.length > 0) return failed("response-invalid");
      received += payload.byteLength;
      if (received > limit) return failed("response-too-large");
      messages.push(new Uint8Array(payload));
    } else if (flag === TRAILER_FRAME) {
      trailers = readTrailers(payload);
      if (trailers === undefined) return failed("response-invalid");
    } else {
      // A compressed frame: the host asks for none, so it reads none.
      return failed("response-invalid");
    }
    offset = end;
  }
  const status =
    trailers ?? (body.byteLength === 0 ? headerTrailers(headers) : new Map<string, string>());
  const code = status.get("grpc-status");
  if (code === undefined || !/^\d{1,2}$/.test(code)) return failed("response-invalid");
  return {
    status: "answered",
    grpcStatus: Number(code),
    grpcMessage: percentDecoded(status.get("grpc-message") ?? "").slice(0, MAX_GRPC_MESSAGE_LENGTH),
    message: messages[0] ?? new Uint8Array(0),
    messages,
  };
}

function readTrailers(payload: Uint8Array): ReadonlyMap<string, string> | undefined {
  const trailers = new Map<string, string>();
  for (const line of new TextDecoder().decode(payload).split("\r\n")) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    trailers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return trailers;
}

function headerTrailers(headers: IncomingHttpHeaders): ReadonlyMap<string, string> {
  const trailers = new Map<string, string>();
  for (const name of ["grpc-status", "grpc-message"]) {
    const value = headers[name];
    if (typeof value === "string") trailers.set(name, value.trim());
  }
  return trailers;
}

/** gRPC percent-encodes its status message; one that does not decode is passed on as written. */
function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// The desktop's half of a port forward from another paired computer: a TCP
// listener on this computer's loopback, where each connection a tool opens is
// carried to the other computer as one WebSocket of binary messages, signed by
// the window that opened the forward. That computer bridges the WebSocket to
// the same port on its own loopback.
//
// The listener holds no key: each connection's upgrade is signed by the window,
// which signs only for a forward it opened. The listener binds 127.0.0.1 alone,
// so only this computer reaches it; anything on this computer that can open a
// loopback connection can, which is what the person is told when they open it.
//
// The WebSocket framing here is the client half of RFC 6455 for binary data
// only. The server's relay endpoint lives in the server app, which the desktop
// does not import; this side needs only to mask what it sends, read what the
// other computer sends, and answer pings.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { RemotePortForward } from "@octant/contracts";
import type {
  RemoteServerForwarderSignRequest,
  RemoteServerForwarderSigning,
  RemoteServerHostUpgrade,
  RemoteServerHostUpgradeRequest,
} from "@octant/client-runtime/remote-server-forwarder";

const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const EMPTY_BODY_DIGEST = createHash("sha256").update("").digest("hex");
/** The largest message the other computer may send, as its relay caps it. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** The most a frame this side writes carries; a larger TCP chunk goes in several. */
const MAX_FRAME_BYTES = 64 * 1024;
/** RFC 6455: a control frame (close, ping, pong) carries at most 125 bytes. */
const MAX_CONTROL_BYTES = 125;

export interface PortForwardListenerPorts {
  /** Asks the window that opened the forward to sign one connection's upgrade. */
  readonly sign: (
    request: RemoteServerForwarderSignRequest,
  ) => Promise<RemoteServerForwarderSigning>;
  /** Sends the upgrade to the paired computer's listener. */
  readonly upgradeToHost: (
    request: RemoteServerHostUpgradeRequest,
  ) => Promise<RemoteServerHostUpgrade>;
  readonly now?: () => number;
}

export type PortForwardListening =
  | {
      readonly status: "listening";
      /** The port on this computer's loopback; the same number as the other's when it was free. */
      readonly port: number;
      readonly close: () => void;
    }
  | { readonly status: "refused"; readonly message: string };

/**
 * Listens on 127.0.0.1 for one forward until it expires or `close` is called.
 * The forward's own port number is tried first, so a tool configured for it
 * works unchanged; another free port is used when it is taken.
 */
export async function listenForPortForward(
  input: { readonly hostId: string; readonly forward: RemotePortForward },
  ports: PortForwardListenerPorts,
): Promise<PortForwardListening> {
  const connections = new Set<Socket>();
  const forwardId = String(input.forward.forwardId);
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    void carry(socket, input.hostId, forwardId, ports);
  });
  const port =
    (await bind(server, Number(input.forward.port))) ?? (await bind(server, 0)) ?? undefined;
  if (port === undefined) {
    return { status: "refused", message: "Octant could not listen on this computer's loopback." };
  }
  const now = ports.now ?? Date.now;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiry);
    server.close();
    for (const socket of connections) socket.destroy();
  };
  const expiry = setTimeout(close, Math.max(0, Number(input.forward.expiresAt) - now()));
  expiry.unref();
  return { status: "listening", port, close };
}

function bind(server: Server, port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const failed = () => {
      server.off("listening", listening);
      resolve(undefined);
    };
    const listening = () => {
      server.off("error", failed);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : undefined);
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

/** Carries one TCP connection to the other computer, or ends it when that is refused. */
async function carry(
  socket: Socket,
  hostId: string,
  forwardId: string,
  ports: PortForwardListenerPorts,
): Promise<void> {
  socket.pause();
  socket.on("error", () => undefined);
  const pathQuery = `/api/server-proxy/${forwardId}`;
  try {
    const signing = await ports.sign({
      hostId,
      grantId: forwardId,
      method: "GET",
      pathQuery,
      bodyDigest: EMPTY_BODY_DIGEST,
    });
    if (signing.status !== "signed" || socket.destroyed) {
      socket.destroy();
      return;
    }
    const key = randomBytes(16).toString("base64");
    const upgrade = await ports.upgradeToHost({
      pathQuery,
      headers: [
        ...Object.entries(signing.headers),
        ["upgrade", "websocket"],
        ["connection", "Upgrade"],
        ["sec-websocket-key", key],
        ["sec-websocket-version", "13"],
      ],
    });
    if (upgrade.status !== "switched") {
      await upgrade.response.body?.cancel().catch(() => undefined);
      socket.destroy();
      return;
    }
    const accept = upgrade.headers.find(([name]) => name.toLowerCase() === "sec-websocket-accept");
    const expected = createHash("sha1").update(`${key}${HANDSHAKE_GUID}`).digest("base64");
    if (accept?.[1] !== expected || socket.destroyed) {
      upgrade.socket.destroy();
      socket.destroy();
      return;
    }
    bridge(socket, upgrade.socket, upgrade.head);
  } catch {
    socket.destroy();
  }
}

const OPCODE = { continuation: 0x0, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** Passes bytes both ways, as masked binary frames toward the other computer. */
export function bridge(tcp: Socket, remote: Duplex, head: Uint8Array): void {
  let pending: Buffer = Buffer.from(head);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    tcp.destroy();
    remote.destroy();
  };
  const sendFrame = (opcode: number, payload: Buffer): boolean => {
    if (remote.destroyed || remote.writableEnded) return false;
    return remote.write(frame(opcode, payload));
  };
  remote.on("error", end);
  remote.on("close", end);
  tcp.on("close", () => {
    if (ended) return;
    sendFrame(OPCODE.close, closePayload(1000));
    remote.end();
    setTimeout(end, 1_000).unref();
  });
  tcp.on("data", (chunk: Buffer) => {
    let flushed = true;
    for (let offset = 0; offset < chunk.byteLength; offset += MAX_FRAME_BYTES) {
      flushed = sendFrame(OPCODE.binary, chunk.subarray(offset, offset + MAX_FRAME_BYTES));
    }
    if (!flushed) {
      tcp.pause();
      remote.once("drain", () => tcp.resume());
    }
  });
  const receive = (chunk: Buffer) => {
    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      const next = readFrame(pending);
      if (next === "incomplete") return;
      if (next === "broken") {
        sendFrame(OPCODE.close, closePayload(1002));
        end();
        return;
      }
      pending = pending.subarray(next.length);
      if (next.opcode === OPCODE.binary || next.opcode === OPCODE.continuation) {
        if (!tcp.write(next.payload)) {
          remote.pause();
          tcp.once("drain", () => remote.resume());
        }
      } else if (next.opcode === OPCODE.ping) {
        sendFrame(OPCODE.pong, next.payload);
      } else if (next.opcode === OPCODE.close) {
        tcp.end();
        sendFrame(OPCODE.close, closePayload(1000));
        remote.end();
        return;
      } else if (next.opcode !== OPCODE.pong) {
        // A text message has no meaning on a byte stream.
        sendFrame(OPCODE.close, closePayload(1003));
        end();
        return;
      }
    }
  };
  remote.on("data", receive);
  if (pending.byteLength > 0) {
    const first = pending;
    pending = Buffer.alloc(0);
    receive(first);
  }
  tcp.resume();
}

function closePayload(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return payload;
}

/** One masked frame, as a client sends every frame. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.byteLength;
  // Every caller bounds what it frames; a larger payload is a broken invariant.
  if (length > MAX_FRAME_BYTES) throw new RangeError("A frame payload is over its bound.");
  const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + 4);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (length < 126 ? length : length <= 0xffff ? 126 : 127);
  if (lengthBytes === 2) header.writeUInt16BE(length, 2);
  if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(length), 2);
  const mask = randomBytes(4);
  mask.copy(header, 2 + lengthBytes);
  const body = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    body[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([header, body]);
}

/**
 * The next whole frame from the other computer, which sends unmasked frames.
 * A masked frame, a reserved bit, or a message over the cap is broken.
 */
function readFrame(
  buffer: Buffer,
):
  | { readonly opcode: number; readonly payload: Buffer; readonly length: number }
  | "incomplete"
  | "broken" {
  if (buffer.byteLength < 2) return "incomplete";
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  if ((first & 0x70) !== 0 || (second & 0x80) !== 0) return "broken";
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.byteLength < 4) return "incomplete";
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.byteLength < 10) return "incomplete";
    if (buffer.readUInt32BE(2) !== 0) return "broken";
    length = buffer.readUInt32BE(6);
    offset = 10;
  }
  if (length > MAX_MESSAGE_BYTES) return "broken";
  const opcode = first & 0x0f;
  // A control frame is final and short, so a ping is never echoed at the size the far end chose.
  if (opcode >= OPCODE.close && (length > MAX_CONTROL_BYTES || (first & 0x80) === 0)) {
    return "broken";
  }
  if (buffer.byteLength < offset + length) return "incomplete";
  return {
    opcode,
    payload: Buffer.from(buffer.subarray(offset, offset + length)),
    length: offset + length,
  };
}

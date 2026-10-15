import { createHash, randomBytes } from "node:crypto";
import type { Socket } from "node:net";

/**
 * The largest WebSocket message either end of a relayed socket may send. A
 * larger one closes the socket with 1009 (message too big) before the host
 * buffers it.
 */
export const WEBSOCKET_RELAY_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One whole WebSocket message: text (as its UTF-8 bytes) or binary. */
export interface WebSocketMessage {
  readonly text: boolean;
  readonly data: Uint8Array;
}

/** One end of a relayed WebSocket, as the relay drives it. */
export interface WebSocketPeer {
  readonly send: (message: WebSocketMessage) => void;
  /**
   * Send a close frame and end the connection. The relay already knows why it
   * closed, so the closing end reports nothing back through its events.
   */
  readonly close: (code: number, reason: string) => void;
}

/** What one end of a relayed WebSocket tells the relay. */
export interface WebSocketPeerEvents {
  readonly message: (message: WebSocketMessage) => void;
  /** The other party closed (with its code), the connection dropped (1006), or it broke the protocol. */
  readonly closed: (code: number, reason: string) => void;
}

/**
 * A WebSocket upgrade the route accepted: the far end already agreed, and the
 * transport finishes the handshake with the client and calls `open`, or calls
 * `cancel` when it cannot.
 */
export interface WebSocketUpgradeAcceptance {
  /** The subprotocol the far end chose, answered to the client in the handshake. */
  readonly protocol: string | undefined;
  readonly open: (client: WebSocketPeer) => WebSocketPeerEvents;
  readonly cancel: () => void;
}

/**
 * Accepted upgrades travel from the route to the listener's transport on the
 * route's own answer, since the fetch boundary between them carries only a
 * `Response`. The answer is never written to the client when the transport
 * takes the acceptance; a transport that cannot upgrade writes it as a 502.
 */
const acceptances = new WeakMap<Response, WebSocketUpgradeAcceptance>();

export function acceptWebSocketUpgrade(
  acceptance: WebSocketUpgradeAcceptance,
  headers: HeadersInit,
): Response {
  const response = new Response(null, { status: 502, headers });
  acceptances.set(response, acceptance);
  return response;
}

/** The acceptance an answer carries, at most once. */
export function takeWebSocketUpgrade(response: Response): WebSocketUpgradeAcceptance | undefined {
  const acceptance = acceptances.get(response);
  acceptances.delete(response);
  return acceptance;
}

/** A `Sec-WebSocket-Key`: the base64 of 16 bytes. */
export function isWebSocketKey(value: string | null | undefined): value is string {
  return (
    value !== null &&
    value !== undefined &&
    /^[A-Za-z0-9+/]{22}==$/.test(value) &&
    Buffer.from(value, "base64").byteLength === 16
  );
}

export function newWebSocketKey(): string {
  return randomBytes(16).toString("base64");
}

export function webSocketAcceptFor(key: string): string {
  return createHash("sha1").update(`${key}${HANDSHAKE_GUID}`).digest("base64");
}

/**
 * A close code that may travel in a close frame. 1005 (no code), 1006
 * (dropped), and 1015 (TLS failure) only describe a close locally, so the
 * relay passes them on as a normal close or as going away.
 */
export function sendableCloseCode(code: number): number {
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014)) return code;
  if (code >= 3000 && code <= 4999) return code;
  return code === 1005 ? 1000 : 1001;
}

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/**
 * One end of a WebSocket over a socket whose handshake is done, framing whole
 * messages per RFC 6455 with no extensions. A server end requires masked frames
 * and sends unmasked ones; a client end the reverse. Pings are answered here.
 * A message over the cap, a reserved bit, or a broken frame closes the socket
 * with 1009 or 1002 before more of it is buffered. Writes the other end does not
 * read pile up to at most twice the message cap, then the socket closes with
 * 1008, so a stalled reader cannot grow the host's memory without bound.
 */
export class WebSocketEndpoint implements WebSocketPeer {
  readonly #socket: Socket;
  readonly #role: "server" | "client";
  readonly #maxMessageBytes: number;
  #events: WebSocketPeerEvents | undefined;
  #pending: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #fragmentText = false;
  #fragmenting = false;
  #closeSent = false;
  #ended = false;

  constructor(socket: Socket, role: "server" | "client", maxMessageBytes: number) {
    this.#socket = socket;
    this.#role = role;
    this.#maxMessageBytes = maxMessageBytes;
  }

  /** Start reading, with any bytes that arrived with the handshake first. */
  start(events: WebSocketPeerEvents, head: Uint8Array): void {
    this.#events = events;
    this.#socket.setTimeout(0);
    this.#socket.setNoDelay(true);
    this.#socket.on("error", () => undefined);
    this.#socket.on("close", () => this.#finish(1006, ""));
    this.#socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    if (head.byteLength > 0) this.#receive(Buffer.from(head));
    // A connection that ended before reading started has already emitted its close.
    if (this.#socket.destroyed) this.#finish(1006, "");
    else this.#socket.resume();
  }

  send(message: WebSocketMessage): void {
    if (this.#closeSent || this.#ended) return;
    this.#write(message.text ? OPCODE.text : OPCODE.binary, Buffer.from(message.data));
    if (this.#socket.writableLength > 2 * this.#maxMessageBytes) {
      this.#fail(1008, "The other end is not reading.");
    }
  }

  close(code: number, reason: string): void {
    this.#ended = true;
    this.#sendClose(code, reason);
  }

  #sendClose(code: number, reason: string): void {
    if (this.#closeSent) return;
    this.#closeSent = true;
    // A close reason fits in a control frame's 125 bytes with the code.
    const text = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + text.byteLength);
    payload.writeUInt16BE(sendableCloseCode(code), 0);
    text.copy(payload, 2);
    this.#write(OPCODE.close, payload);
    this.#socket.end();
    // The other party is expected to close its side; one that does not is cut.
    setTimeout(() => this.#socket.destroy(), 1_000).unref();
  }

  #fail(code: number, reason: string): void {
    this.#sendClose(code, reason);
    this.#finish(code, reason);
  }

  #finish(code: number, reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#pending = Buffer.alloc(0);
    this.#fragments = [];
    this.#events?.closed(code, reason);
  }

  #receive(chunk: Buffer): void {
    if (this.#ended) return;
    this.#pending = this.#pending.byteLength === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    while (!this.#ended) {
      const frame = this.#nextFrame();
      if (frame === undefined) return;
      this.#handle(frame.opcode, frame.fin, frame.payload);
    }
  }

  /** The next whole frame, or nothing while it is still arriving or the connection failed. */
  #nextFrame(): { opcode: number; fin: boolean; payload: Buffer } | undefined {
    const buffer = this.#pending;
    if (buffer.byteLength < 2) return undefined;
    const first = buffer[0] ?? 0;
    const second = buffer[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if ((first & 0x70) !== 0 || masked !== (this.#role === "server")) {
      this.#fail(1002, "");
      return undefined;
    }
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.byteLength < 4) return undefined;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.byteLength < 10) return undefined;
      const high = buffer.readUInt32BE(2);
      length = high === 0 ? buffer.readUInt32BE(6) : Number.POSITIVE_INFINITY;
      offset = 10;
    }
    if (opcode >= OPCODE.close) {
      if (!fin || length > 125) {
        this.#fail(1002, "");
        return undefined;
      }
    } else if (this.#fragmentBytes + length > this.#maxMessageBytes) {
      this.#fail(1009, "");
      return undefined;
    }
    const maskBytes = masked ? 4 : 0;
    const end = offset + maskBytes + length;
    if (buffer.byteLength < end) return undefined;
    const payload = Buffer.from(buffer.subarray(offset + maskBytes, end));
    if (masked) {
      const mask = buffer.subarray(offset, offset + 4);
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
    }
    this.#pending = buffer.subarray(end);
    return { opcode, fin, payload };
  }

  #handle(opcode: number, fin: boolean, payload: Buffer): void {
    switch (opcode) {
      case OPCODE.close: {
        const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.byteLength > 2 ? payload.subarray(2).toString("utf8") : "";
        this.#sendClose(code, "");
        this.#finish(code, reason);
        return;
      }
      case OPCODE.ping:
        if (!this.#closeSent) this.#write(OPCODE.pong, payload);
        return;
      case OPCODE.pong:
        return;
      case OPCODE.text:
      case OPCODE.binary:
        if (this.#fragmenting) {
          this.#fail(1002, "");
          return;
        }
        if (fin) {
          this.#events?.message({ text: opcode === OPCODE.text, data: payload });
          return;
        }
        this.#fragmenting = true;
        this.#fragmentText = opcode === OPCODE.text;
        this.#fragments = [payload];
        this.#fragmentBytes = payload.byteLength;
        return;
      case OPCODE.continuation: {
        if (!this.#fragmenting) {
          this.#fail(1002, "");
          return;
        }
        this.#fragments.push(payload);
        this.#fragmentBytes += payload.byteLength;
        if (!fin) return;
        const data = Buffer.concat(this.#fragments);
        this.#fragmenting = false;
        this.#fragments = [];
        this.#fragmentBytes = 0;
        this.#events?.message({ text: this.#fragmentText, data });
        return;
      }
      default:
        this.#fail(1002, "");
    }
  }

  #write(opcode: number, payload: Buffer): void {
    if (this.#socket.destroyed || this.#socket.writableEnded) return;
    const masked = this.#role === "client";
    const length = payload.byteLength;
    const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
    const header = Buffer.alloc(2 + lengthBytes + (masked ? 4 : 0));
    header[0] = 0x80 | opcode;
    header[1] = (masked ? 0x80 : 0) | (length < 126 ? length : length <= 0xffff ? 126 : 127);
    if (lengthBytes === 2) header.writeUInt16BE(length, 2);
    if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(length), 2);
    if (!masked) {
      this.#socket.write(Buffer.concat([header, payload]));
      return;
    }
    const mask = randomBytes(4);
    mask.copy(header, 2 + lengthBytes);
    const body = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      body[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    this.#socket.write(Buffer.concat([header, body]));
  }
}

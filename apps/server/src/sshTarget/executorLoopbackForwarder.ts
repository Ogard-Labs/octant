import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { fieldValue, readProxyRequestHead } from "../harness/nativeHarnessEgressWire";

/**
 * A proxied launch's forwarder on a macOS target: a listener on a random
 * loopback port of its own, which admits a connection only when its first
 * request presents that launch's egress token. Canonical:
 * docs/design/remote-ssh-environments.md § macOS targets.
 *
 * Seatbelt's `proxied` rule can name only a `localhost` port, and a loopback
 * port is open to every user of the Mac, where Linux puts its forwarder in a
 * network namespace of the launch's own behind an owner-only Unix socket. So
 * the token stands in for the namespace: the launch's proxy variables carry
 * it, nothing else on the target has it, and a connection that does not
 * present it in its first request head is refused here, before a byte of it
 * reaches this host's proxy. The host's proxy checks the token again on every
 * request; this check keeps everyone else from reaching the host at all.
 */

const PROXY_USER = "octant";
/** As the host's proxy reads a head; a longer one is refused there too. */
const MAX_HEAD_BYTES = 32 * 1_024;
/** A connection that has not finished its first head by then is dropped. */
const HEAD_TIMEOUT_MS = 10_000;
/** Connections still owing their first head; past this, new ones are dropped at once. */
const MAX_PENDING_CONNECTIONS = 32;

const REFUSAL = Buffer.from(
  "HTTP/1.1 407 Proxy Authentication Required\r\n" +
    'Proxy-Authenticate: Basic realm="octant"\r\n' +
    "Connection: close\r\n" +
    "Content-Length: 0\r\n\r\n",
  "latin1",
);

export interface LoopbackForwarder {
  readonly port: number;
  /** Stops listening and drops every connection still owing its head. */
  close(): void;
}

/**
 * Whether a `Proxy-Authorization` value presents exactly `octant:<token>`,
 * compared in constant time as the host's proxy compares it.
 */
export function presentsLaunchToken(authorization: string | undefined, token: string): boolean {
  const match = /^basic +([A-Za-z0-9+/]+={0,2})$/i.exec(authorization ?? "");
  if (match === null) return false;
  const presented = Buffer.from(match[1] ?? "", "base64");
  const expected = Buffer.from(`${PROXY_USER}:${token}`, "latin1");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * Listens on `127.0.0.1` at a port the system picks. Each connection that
 * presents `token` is handed to `admitted` paused, with every byte read so
 * far (its first head and anything after it) for the caller to send first.
 * Undefined when it cannot listen.
 */
export async function listenForLaunchToken(
  token: string,
  admitted: (socket: Socket, received: Buffer) => void,
): Promise<LoopbackForwarder | undefined> {
  const pending = new Set<Socket>();
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    if (pending.size >= MAX_PENDING_CONNECTIONS) {
      socket.destroy();
      return;
    }
    pending.add(socket);
    let received = Buffer.alloc(0);
    const settle = () => {
      pending.delete(socket);
      clearTimeout(timer);
      socket.off("data", read);
      socket.off("end", refuse);
    };
    const refuse = () => {
      settle();
      socket.once("finish", () => socket.destroy());
      socket.end(REFUSAL);
    };
    const read = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const head = readProxyRequestHead(received, MAX_HEAD_BYTES);
      if (head.status === "incomplete") return;
      if (
        head.status !== "read" ||
        !presentsLaunchToken(fieldValue(head.head.headers, "proxy-authorization"), token)
      ) {
        refuse();
        return;
      }
      settle();
      socket.pause();
      admitted(socket, received);
    };
    const timer = setTimeout(() => {
      settle();
      socket.destroy();
    }, HEAD_TIMEOUT_MS);
    socket.on("error", () => {
      settle();
      socket.destroy();
    });
    socket.on("data", read);
    socket.once("end", refuse);
  });
  const port = await new Promise<number | undefined>((resolve) => {
    server.once("error", () => resolve(undefined));
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : undefined);
    });
  });
  if (port === undefined) {
    server.close();
    return undefined;
  }
  return {
    port,
    close: () => {
      server.close();
      for (const socket of pending) socket.destroy();
      pending.clear();
    },
  };
}

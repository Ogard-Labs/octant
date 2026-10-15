// The Node implementation of the listener trust rule: a TLS connection to a
// paired host's private listener that carries nothing until the resolved
// address, the connected peer, and the served certificate have passed
// `remoteListenerTrust`. It imports Node modules, so the package barrel does
// not export it and browser and phone bundles never load it.

import { createHash, type X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as connectTcp, isIP, type Socket } from "node:net";
import { Readable } from "node:stream";
import { connect as connectTls, type TLSSocket } from "node:tls";
import {
  judgeListenerAddresses,
  judgeListenerCertificate,
  listenerPinFromSha256,
  ListenerTrustRefused,
  type ListenerCertificateJudgement,
  type ListenerOriginTrust,
  type ListenerTrustRefusal,
} from "./remoteListenerTrust";

/** How long a listener has to finish the TLS handshake before the client gives up. */
export const LISTENER_HANDSHAKE_TIMEOUT_MS = 10_000;

export type ListenerConnection =
  | {
      readonly status: "connected";
      readonly socket: TLSSocket;
      /** The trust to store for the origin from now on; a staged trust that passed is now current. */
      readonly trust: ListenerOriginTrust;
    }
  | { readonly status: "refused"; readonly reason: ListenerTrustRefusal }
  /**
   * The listener could not be reached or did not complete a TLS 1.3
   * handshake the client could judge; nothing was sent. Retrying is safe.
   */
  | { readonly status: "failed"; readonly reason: "unreachable" | "handshake-failed" };

export interface ListenerConnectionOptions {
  /** Exactly an HTTPS origin, as stored with the pairing record. */
  readonly origin: string;
  readonly trust: ListenerOriginTrust;
  readonly now?: () => number;
}

/**
 * The network a connection uses. Product callers always get the system's;
 * only tests replace it, through `testOnlyListenerTls`, so no product caller
 * can route around the address rule or add a trust root.
 */
interface ListenerNetwork {
  /** Every address the name resolves to. */
  readonly resolve: (hostname: string) => Promise<ReadonlyArray<string>>;
  /** Opens TCP to the judged address. The peer it reaches is judged again. */
  readonly dial: (address: string, port: number) => Promise<Socket>;
  /** Platform trust roots in PEM; Node's bundled roots when absent. Never read for a pinned trust. */
  readonly platformRoots?: ReadonlyArray<string>;
  readonly handshakeTimeoutMs: number;
}

const SYSTEM_NETWORK: ListenerNetwork = {
  resolve: resolveAll,
  dial: dialTcp,
  handshakeTimeoutMs: LISTENER_HANDSHAKE_TIMEOUT_MS,
};

/**
 * Connects to a listener origin under its stored trust. A refusal or a
 * failure is a value and the socket is already closed; only an origin that is
 * not exactly an HTTPS origin, which no pairing record holds, throws.
 */
export function connectListener(options: ListenerConnectionOptions): Promise<ListenerConnection> {
  return connectListenerOver(options, SYSTEM_NETWORK);
}

/**
 * Replaceable network seams, for tests only. A test in this package refuses
 * any non-test source that names this export.
 */
export const testOnlyListenerTls = {
  connectListenerOver,
  secureListenerSocket,
  createListenerFetchOver,
} as const;

/**
 * A `fetch` that reaches one listener origin, each request over its own
 * connection that passed the origin's trust. A refusal throws
 * `ListenerTrustRefused` before any request byte is sent; an unreachable
 * listener throws a `TypeError`, as the platform `fetch` does. It never
 * follows a redirect and refuses a URL on any other origin.
 */
export function createListenerFetch(options: ListenerConnectionOptions): typeof globalThis.fetch {
  return createListenerFetchOver(options, SYSTEM_NETWORK);
}

/** Responses to these statuses carry no body, and `Response` refuses one. */
const BODYLESS_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function createListenerFetchOver(
  options: ListenerConnectionOptions,
  network: ListenerNetwork,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== options.origin) {
      throw new TypeError("A listener fetch reaches only the origin it was made for.");
    }
    request.signal.throwIfAborted();
    const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
    const connection = await connectListenerOver(options, network);
    if (connection.status === "refused") throw new ListenerTrustRefused(connection.reason);
    if (connection.status === "failed") throw new TypeError("The listener could not be reached.");
    const socket = connection.socket;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    headers.host = url.host;
    headers.connection = "close";
    if (body !== undefined) headers["content-length"] = String(body.byteLength);
    return await new Promise<Response>((resolve, reject) => {
      const abort = (): void => {
        outgoing.destroy();
        reject(request.signal.reason);
      };
      const outgoing = httpRequest(
        {
          // The judged socket carries the request; no agent may dial another.
          createConnection: () => socket,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers,
        },
        (incoming) => {
          request.signal.removeEventListener("abort", abort);
          try {
            resolve(responseOf(incoming));
          } catch {
            incoming.destroy();
            reject(new TypeError("The listener sent a response Octant cannot read."));
          }
        },
      );
      outgoing.once("error", () => {
        socket.destroy();
        reject(new TypeError("The listener connection failed."));
      });
      request.signal.addEventListener("abort", abort, { once: true });
      outgoing.end(body);
    });
  };
}

function responseOf(incoming: IncomingMessage): Response {
  const status = incoming.statusCode ?? 0;
  const headers = new Headers();
  for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  if (BODYLESS_STATUSES.has(status)) {
    incoming.resume();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers });
}

async function connectListenerOver(
  options: ListenerConnectionOptions,
  network: ListenerNetwork,
): Promise<ListenerConnection> {
  const url = new URL(options.origin);
  if (url.protocol !== "https:" || url.origin !== options.origin) {
    throw new Error("A listener origin must be exactly an HTTPS origin.");
  }
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port === "" ? 443 : Number(url.port);
  let addresses: ReadonlyArray<string>;
  try {
    addresses = isIP(hostname) === 0 ? await network.resolve(hostname) : [hostname];
  } catch {
    return { status: "failed", reason: "unreachable" };
  }
  const resolved = judgeListenerAddresses(addresses);
  if (resolved.status === "refused") return resolved;
  // The judged address is dialled, never the name, so a second lookup cannot
  // answer differently.
  let socket: Socket;
  try {
    socket = await network.dial(resolved.address, port);
  } catch {
    return { status: "failed", reason: "unreachable" };
  }
  const peer = judgeListenerAddresses([socket.remoteAddress]);
  if (peer.status === "refused") {
    socket.destroy();
    return peer;
  }
  return secureListenerSocket({
    socket,
    hostname,
    trust: options.trust,
    now: options.now ?? Date.now,
    handshakeTimeoutMs: network.handshakeTimeoutMs,
    ...(network.platformRoots === undefined ? {} : { platformRoots: network.platformRoots }),
  });
}

/**
 * Runs the TLS handshake over a connected socket whose peer was already
 * judged, and hands the socket over only when the served certificate passes
 * the origin's trust.
 */
function secureListenerSocket(input: {
  readonly socket: Socket;
  readonly hostname: string;
  readonly trust: ListenerOriginTrust;
  readonly now: () => number;
  readonly handshakeTimeoutMs: number;
  readonly platformRoots?: ReadonlyArray<string>;
}): Promise<ListenerConnection> {
  return new Promise((resolve) => {
    const tlsSocket = connectTls({
      socket: input.socket,
      host: input.hostname,
      // Node refuses an IP address as a server name, so SNI goes only with a name.
      ...(isIP(input.hostname) === 0 ? { servername: input.hostname } : {}),
      // TLS 1.2 renegotiation would present a second certificate after the
      // one judged below; TLS 1.3 has no renegotiation, and the listener
      // speaks it.
      minVersion: "TLSv1.3",
      // Node does not refuse the handshake itself: a pinned origin replaces
      // chain validation with the pin, so the judgement below decides, and
      // nothing is written to the socket until it accepts. Platform validation
      // still runs and reports through `authorized`, which only a platform
      // trust reads.
      rejectUnauthorized: false,
      ...(input.platformRoots === undefined ? {} : { ca: [...input.platformRoots] }),
    });
    const fail = (): void => {
      clearTimeout(timer);
      tlsSocket.off("secureConnect", judge);
      tlsSocket.destroy();
      resolve({ status: "failed", reason: "handshake-failed" });
    };
    const judge = (): void => {
      clearTimeout(timer);
      tlsSocket.off("error", fail);
      let judgement: ListenerCertificateJudgement;
      try {
        // Read once: Node hands out the peer certificate only on the first call.
        const certificate = tlsSocket.getPeerX509Certificate();
        judgement = judgeListenerCertificate({
          trust: input.trust,
          servedPin: servedPin(certificate),
          platformTrusted: platformTrusted(tlsSocket.authorized, certificate, input.hostname),
          now: input.now(),
        });
      } catch {
        // A certificate or clock the client cannot read never accepts.
        tlsSocket.destroy();
        resolve({ status: "failed", reason: "handshake-failed" });
        return;
      }
      if (judgement.status === "refused") {
        tlsSocket.destroy();
        resolve(judgement);
        return;
      }
      resolve({ status: "connected", socket: tlsSocket, trust: judgement.trust });
    };
    const timer = setTimeout(fail, input.handshakeTimeoutMs);
    tlsSocket.once("error", fail);
    tlsSocket.once("secureConnect", judge);
  });
}

/**
 * Platform validation, with the server identity checked here as well: Bun
 * reported `authorized` for a preconnected socket whose certificate named
 * another host when the origin was an IP address, which carries no SNI.
 */
function platformTrusted(
  authorized: boolean,
  certificate: X509Certificate | undefined,
  hostname: string,
): boolean {
  if (!authorized || certificate === undefined) return false;
  return (
    (isIP(hostname) === 0 ? certificate.checkHost(hostname) : certificate.checkIP(hostname)) !==
    undefined
  );
}

function servedPin(certificate: X509Certificate | undefined): string | undefined {
  if (certificate === undefined) return undefined;
  const spki = certificate.publicKey.export({ type: "spki", format: "der" });
  return listenerPinFromSha256(createHash("sha256").update(spki).digest());
}

async function resolveAll(hostname: string): Promise<ReadonlyArray<string>> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

function dialTcp(address: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: address, port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

// How one host reaches another host's private listener: directly, over a
// connection that must present the certificate key the caller pinned, and only
// at a Tailscale, RFC 1918, or IPv6 ULA address. There is no relay, no proxy,
// and no fallback to the platform's own trust roots: the pin replaces them, so
// a listener's self-made certificate is checked by its key.

import { createHash, X509Certificate } from "node:crypto";
import { request as httpRequest } from "node:http";
import { lookup } from "node:dns/promises";
import { connect as connectTcp, isIP, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { classifyRemoteListenerAddress } from "@octant/domain";
import { digestFromListenerPin } from "./hubCrypto";

const HANDSHAKE_TIMEOUT_MS = 10_000;
// A host that drops packets silently never answers the dial; without its own
// limit the dial outlives the request's deadline.
const DIAL_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1_024;

export type HubFetchInit = {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  /** The most answer bytes this request takes; absent, 256 KiB. */
  readonly maxResponseBytes?: number;
};

export type HubFetch = (url: string, init?: HubFetchInit) => Promise<Response>;

/** A fetch that reaches one listener origin, held to its certificate pin. */
export type HubTransport = (target: { readonly origin: string; readonly pin: string }) => HubFetch;

/** The network a connection uses; only tests replace it. */
export interface HubNetwork {
  /** Every address the name resolves to. */
  readonly resolve: (hostname: string) => Promise<ReadonlyArray<string>>;
  /**
   * Opens TCP to an address that was judged private. When `signal` aborts
   * while the connection is still being made, the attempt is closed at once,
   * so a host that never answers does not keep sockets open across retries.
   */
  readonly dial: (address: string, port: number, signal: AbortSignal) => Promise<Socket>;
}

export type HubTransportRefusal = "not-private" | "pin-mismatch" | "wrong-origin" | "invalid-pin";

export class HubTransportRefused extends Error {
  readonly reason: HubTransportRefusal;

  constructor(reason: HubTransportRefusal) {
    super(`Octant refused to reach that listener: ${reason}.`);
    this.name = "HubTransportRefused";
    this.reason = reason;
  }
}

export const SYSTEM_NETWORK: HubNetwork = {
  resolve: async (hostname) => {
    if (isIP(hostname) !== 0) return [hostname];
    return (await lookup(hostname, { all: true })).map((entry) => entry.address);
  },
  dial: (address, port, signal) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = connectTcp({ host: address, port });
      const onAbort = () => {
        socket.destroy();
        reject(signal.reason);
      };
      const onError = (error: Error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("error", onError);
      socket.once("connect", () => {
        signal.removeEventListener("abort", onAbort);
        socket.off("error", onError);
        resolve(socket);
      });
    }),
};

/**
 * Dials within the timeout and the caller's signal. Giving up aborts the
 * attempt itself, and a connection that still arrives afterwards is closed, so
 * nothing holds it open.
 */
async function dialWithin(
  network: HubNetwork,
  address: string,
  port: number,
  signal: AbortSignal | undefined,
): Promise<Socket> {
  signal?.throwIfAborted();
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(new Error("dial timed out")), DIAL_TIMEOUT_MS);
  const onAbort = () => giveUp.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const dialled = network.dial(address, port, giveUp.signal);
  const gaveUp = new Promise<never>((_resolve, reject) => {
    giveUp.signal.addEventListener("abort", () => reject(giveUp.signal.reason), { once: true });
  });
  try {
    return await Promise.race([dialled, gaveUp]);
  } catch (error) {
    dialled.then(
      (socket) => socket.destroy(),
      () => undefined,
    );
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const isPrivateAddress = (address: string): boolean => {
  const sourceClass = classifyRemoteListenerAddress(address.replace(/^::ffff:/, ""));
  return sourceClass === "lan-private" || sourceClass === "tailscale";
};

/**
 * A TLS connection to one listener origin's private address, handed over only
 * after the served key matches the pin. The device relay's tunnel runs on it.
 */
export async function openPinnedSocket(
  target: { readonly origin: string; readonly pin: string },
  network: HubNetwork = SYSTEM_NETWORK,
  signal?: AbortSignal,
): Promise<TLSSocket> {
  const url = new URL(target.origin);
  const expectedDigest = digestFromListenerPin(target.pin);
  if (expectedDigest === undefined) throw new HubTransportRefused("invalid-pin");
  signal?.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await network.resolve(hostname);
  // Every address the name resolves to must be private, so a name that also
  // resolves to a public address is never dialled.
  const first = addresses[0];
  if (first === undefined || !addresses.every(isPrivateAddress)) {
    throw new HubTransportRefused("not-private");
  }
  const tcp = await dialWithin(network, first, Number(url.port || 443), signal);
  if (tcp.remoteAddress !== undefined && !isPrivateAddress(tcp.remoteAddress)) {
    tcp.destroy();
    throw new HubTransportRefused("not-private");
  }
  const secure = connectTls({
    socket: tcp,
    // The pin judges the certificate, not a name or a chain.
    rejectUnauthorized: false,
    minVersion: "TLSv1.3",
    // No server name: a listener that also holds a certificate for its
    // tailnet name serves that one to a client naming it, and the pin
    // is the key of the listener's own certificate.
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("handshake timed out")),
        HANDSHAKE_TIMEOUT_MS,
      );
      secure.once("secureConnect", () => {
        clearTimeout(timer);
        resolve();
      });
      secure.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const leaf = secure.getPeerCertificate(true);
    const served = createHash("sha256")
      .update(new X509Certificate(leaf.raw).publicKey.export({ format: "der", type: "spki" }))
      .digest("hex");
    if (served !== expectedDigest) throw new HubTransportRefused("pin-mismatch");
  } catch (error) {
    secure.destroy();
    throw error;
  }
  return secure;
}

export function createPinnedHubTransport(network: HubNetwork = SYSTEM_NETWORK): HubTransport {
  return ({ origin, pin }) =>
    async (input, init = {}) => {
      const url = new URL(input);
      if (url.origin !== origin) throw new HubTransportRefused("wrong-origin");
      const secure = await openPinnedSocket({ origin, pin }, network, init.signal);
      return await new Promise<Response>((resolve, reject) => {
        const body = init.body === undefined ? undefined : Buffer.from(init.body, "utf8");
        const outgoing = httpRequest(
          {
            // With no agent, the request uses exactly this connection.
            createConnection: () => secure,
            method: init.method ?? "GET",
            path: `${url.pathname}${url.search}`,
            headers: {
              ...init.headers,
              host: url.host,
              connection: "close",
              ...(body === undefined ? {} : { "content-length": String(body.byteLength) }),
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            let received = 0;
            incoming.on("data", (chunk: Buffer) => {
              received += chunk.byteLength;
              if (received > (init.maxResponseBytes ?? MAX_RESPONSE_BYTES)) {
                secure.destroy();
                reject(new Error("response too large"));
                return;
              }
              chunks.push(chunk);
            });
            incoming.once("end", () => {
              const status = incoming.statusCode ?? 502;
              const bodyless = status === 204 || status === 205 || status === 304;
              const headers = new Headers();
              for (const [name, value] of Object.entries(incoming.headers)) {
                if (typeof value === "string") headers.set(name, value);
              }
              resolve(new Response(bodyless ? null : Buffer.concat(chunks), { status, headers }));
            });
            incoming.once("error", reject);
          },
        );
        const abort = (): void => {
          outgoing.destroy();
          reject(init.signal?.reason);
        };
        init.signal?.addEventListener("abort", abort, { once: true });
        outgoing.once("error", reject);
        outgoing.end(body);
      }).finally(() => secure.destroy());
    };
}

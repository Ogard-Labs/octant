// The Node implementation of the listener trust rule: a TLS connection to a
// paired host's private listener that carries nothing until the resolved
// address, the connected peer, and the served certificate have passed
// `remoteListenerTrust`. It imports Node modules, so the package barrel does
// not export it and browser and phone bundles never load it.

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect as connectTcp, isIP, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import {
  judgeListenerAddresses,
  judgeListenerCertificate,
  listenerPinFromSha256,
  type ListenerOriginTrust,
  type ListenerTrustRefusal,
} from "./remoteListenerTrust";

export type ListenerConnection =
  | {
      readonly status: "connected";
      readonly socket: TLSSocket;
      /** The trust to store for the origin from now on; a staged trust that passed is now current. */
      readonly trust: ListenerOriginTrust;
    }
  | { readonly status: "refused"; readonly reason: ListenerTrustRefusal };

export interface ListenerConnectionOptions {
  /** Exactly an HTTPS origin, as stored with the pairing record. */
  readonly origin: string;
  readonly trust: ListenerOriginTrust;
  readonly now?: () => number;
  /** Platform trust roots in PEM; Node's bundled roots when absent. Never read for a pinned trust. */
  readonly platformRoots?: ReadonlyArray<string>;
  /** Every address the name resolves to; the system resolver when absent. */
  readonly resolve?: (hostname: string) => Promise<ReadonlyArray<string>>;
  /** Opens TCP to the judged address; `net.connect` when absent. The peer it reaches is judged again. */
  readonly dial?: (address: string, port: number) => Promise<Socket>;
}

/**
 * Connects to a listener origin under its stored trust. A refusal is a value
 * and the socket is already closed; a network failure rejects.
 */
export async function connectListener(
  options: ListenerConnectionOptions,
): Promise<ListenerConnection> {
  const url = new URL(options.origin);
  if (url.protocol !== "https:" || url.origin !== options.origin) {
    throw new Error("A listener origin must be exactly an HTTPS origin.");
  }
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = url.port === "" ? 443 : Number(url.port);
  const addresses =
    isIP(hostname) === 0 ? await (options.resolve ?? resolveAll)(hostname) : [hostname];
  const resolved = judgeListenerAddresses(addresses);
  if (resolved.status === "refused") return resolved;
  // The judged address is dialled, never the name, so a second lookup cannot
  // answer differently.
  const socket = await (options.dial ?? dialTcp)(resolved.address, port);
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
    ...(options.platformRoots === undefined ? {} : { platformRoots: options.platformRoots }),
  });
}

/**
 * Runs the TLS handshake over a connected socket whose peer was already
 * judged, and hands the socket over only when the served certificate passes
 * the origin's trust.
 */
export function secureListenerSocket(input: {
  readonly socket: Socket;
  readonly hostname: string;
  readonly trust: ListenerOriginTrust;
  readonly now: () => number;
  readonly platformRoots?: ReadonlyArray<string>;
}): Promise<ListenerConnection> {
  return new Promise((resolve, reject) => {
    const tlsSocket = connectTls({
      socket: input.socket,
      host: input.hostname,
      // Node refuses an IP address as a server name, so SNI goes only with a name.
      ...(isIP(input.hostname) === 0 ? { servername: input.hostname } : {}),
      // Node does not refuse the handshake itself: a pinned origin replaces
      // chain validation with the pin, so the judgement below decides, and
      // nothing is written to the socket until it accepts. Platform validation
      // still runs and reports through `authorized`, which only a platform
      // trust reads.
      rejectUnauthorized: false,
      ...(input.platformRoots === undefined ? {} : { ca: [...input.platformRoots] }),
    });
    const fail = (error: Error): void => {
      tlsSocket.destroy();
      reject(error);
    };
    tlsSocket.once("error", fail);
    tlsSocket.once("secureConnect", () => {
      tlsSocket.off("error", fail);
      const judgement = judgeListenerCertificate({
        trust: input.trust,
        servedPin: servedPin(tlsSocket),
        platformTrusted: tlsSocket.authorized,
        now: input.now(),
      });
      if (judgement.status === "refused") {
        tlsSocket.destroy();
        resolve(judgement);
        return;
      }
      resolve({ status: "connected", socket: tlsSocket, trust: judgement.trust });
    });
  });
}

function servedPin(socket: TLSSocket): string | undefined {
  const certificate = socket.getPeerX509Certificate();
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

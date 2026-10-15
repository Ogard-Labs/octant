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
  | { readonly status: "refused"; readonly reason: ListenerTrustRefusal };

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
 * Connects to a listener origin under its stored trust. A refusal is a value
 * and the socket is already closed; a network failure, a handshake that does
 * not finish in time, or a listener that cannot speak TLS 1.3 rejects.
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
} as const;

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
  const addresses = isIP(hostname) === 0 ? await network.resolve(hostname) : [hostname];
  const resolved = judgeListenerAddresses(addresses);
  if (resolved.status === "refused") return resolved;
  // The judged address is dialled, never the name, so a second lookup cannot
  // answer differently.
  const socket = await network.dial(resolved.address, port);
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
  return new Promise((resolve, reject) => {
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
    const fail = (error: Error): void => {
      clearTimeout(timer);
      tlsSocket.off("secureConnect", judge);
      tlsSocket.destroy();
      reject(error);
    };
    const judge = (): void => {
      clearTimeout(timer);
      tlsSocket.off("error", fail);
      let judgement: ListenerCertificateJudgement;
      try {
        judgement = judgeListenerCertificate({
          trust: input.trust,
          servedPin: servedPin(tlsSocket),
          platformTrusted: tlsSocket.authorized,
          now: input.now(),
        });
      } catch (error) {
        // A certificate the client cannot read is never accepted.
        tlsSocket.destroy();
        reject(
          error instanceof Error ? error : new Error("The listener's certificate is unreadable."),
        );
        return;
      }
      if (judgement.status === "refused") {
        tlsSocket.destroy();
        resolve(judgement);
        return;
      }
      resolve({ status: "connected", socket: tlsSocket, trust: judgement.trust });
    };
    const timer = setTimeout(
      () => fail(new Error("The listener did not finish the TLS handshake in time.")),
      input.handshakeTimeoutMs,
    );
    tlsSocket.once("error", fail);
    tlsSocket.once("secureConnect", judge);
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

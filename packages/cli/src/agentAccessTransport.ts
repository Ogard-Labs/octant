import { createHash, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { connect as connectTcp, isIP, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { classifyRemoteListenerAddress } from "@octant/domain";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

export interface AgentListenerTarget {
  readonly origin: string;
  /** `sha256-<base64url SPKI hash>`; absent, the system's authorities judge the certificate. */
  readonly pin?: string;
}

export interface AgentListenerResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export type AgentListenerFetch = (input: {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}) => Promise<AgentListenerResponse>;

export class AgentListenerRefused extends Error {
  constructor(readonly reason: "not-private" | "pin-mismatch" | "invalid-pin") {
    super(
      reason === "not-private"
        ? "Octant refused to reach that address: agent access works only on the person's own network (LAN or Tailscale)."
        : reason === "pin-mismatch"
          ? "The listener's certificate is not the one the connection code named. Ask for a new connection code."
          : "The connection's certificate pin is not valid.",
    );
    this.name = "AgentListenerRefused";
  }
}

/** The network a connection uses; only tests replace it. */
export interface AgentListenerNetwork {
  readonly resolve: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly dial: (address: string, port: number) => Promise<Socket>;
}

const SYSTEM_NETWORK: AgentListenerNetwork = {
  resolve: async (hostname) =>
    isIP(hostname) !== 0
      ? [hostname]
      : (await lookup(hostname, { all: true })).map((entry) => entry.address),
  dial: (address, port) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = connectTcp({ host: address, port });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(socket);
      });
    }),
};

const isPrivate = (address: string): boolean => {
  const sourceClass = classifyRemoteListenerAddress(address.replace(/^::ffff:/, ""));
  return sourceClass === "lan-private" || sourceClass === "tailscale";
};

/**
 * POSTs to another host's private listener the way the host's own pinned
 * transport does: only to an address on the person's own network, and with a
 * pin, only to the certificate key the connection code named. Without a pin
 * (the person serves their own certificate, such as a Tailscale one), the
 * system's authorities and the host name judge it.
 */
export function agentListenerFetch(
  target: AgentListenerTarget,
  network: AgentListenerNetwork = SYSTEM_NETWORK,
): AgentListenerFetch {
  return async ({ path, headers, body, signal }) => {
    const url = new URL(path, target.origin);
    const expectedDigest = target.pin === undefined ? undefined : pinDigest(target.pin);
    if (target.pin !== undefined && expectedDigest === undefined) {
      throw new AgentListenerRefused("invalid-pin");
    }
    signal?.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await network.resolve(hostname);
    const first = addresses[0];
    if (first === undefined || !addresses.every(isPrivate)) {
      throw new AgentListenerRefused("not-private");
    }
    const tcp = await network.dial(first, Number(url.port || 443));
    const secure = connectTls({
      socket: tcp,
      // With a pin, the pin judges the certificate, not a name or a chain.
      rejectUnauthorized: expectedDigest === undefined,
      minVersion: "TLSv1.3",
      ...(expectedDigest === undefined && isIP(hostname) === 0 ? { servername: hostname } : {}),
    });
    try {
      await handshake(secure);
      if (expectedDigest !== undefined) {
        const leaf = secure.getPeerCertificate(true);
        const served = createHash("sha256")
          .update(new X509Certificate(leaf.raw).publicKey.export({ format: "der", type: "spki" }))
          .digest("hex");
        if (served !== expectedDigest) throw new AgentListenerRefused("pin-mismatch");
      }
    } catch (error) {
      secure.destroy();
      throw error;
    }
    return await new Promise<AgentListenerResponse>((resolve, reject) => {
      const payload = Buffer.from(body, "utf8");
      const outgoing = httpRequest(
        {
          createConnection: () => secure,
          method: "POST",
          path: `${url.pathname}${url.search}`,
          headers: {
            ...headers,
            host: url.host,
            connection: "close",
            "content-length": String(payload.byteLength),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let received = 0;
          incoming.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > MAX_RESPONSE_BYTES) {
              secure.destroy();
              reject(new Error("The listener's answer was too large."));
              return;
            }
            chunks.push(chunk);
          });
          incoming.once("end", () =>
            resolve({
              status: incoming.statusCode ?? 502,
              contentType: String(incoming.headers["content-type"] ?? ""),
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          incoming.once("error", reject);
        },
      );
      const abort = (): void => {
        outgoing.destroy();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      outgoing.once("error", reject);
      outgoing.end(payload);
    }).finally(() => secure.destroy());
  };
}

function handshake(secure: TLSSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The listener did not answer in time.")),
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
}

function pinDigest(pin: string): string | undefined {
  if (!pin.startsWith("sha256-")) return undefined;
  const bytes = Buffer.from(pin.slice("sha256-".length), "base64url");
  return bytes.byteLength === 32 ? bytes.toString("hex") : undefined;
}

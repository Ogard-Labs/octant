import { createServer, type Server } from "node:http";
import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/**
 * Whether a host name is covered by the allow-list. `*.example.com` covers the
 * names under example.com, never example.com itself and never a name that only
 * ends in the same letters (`evilexample.com`).
 */
export function hostIsAllowed(host: string, allowed: ReadonlyArray<string>): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name.length === 0 || isIP(name) !== 0) return false;
  return allowed.some((pattern) => {
    const rule = pattern.toLowerCase();
    return rule.startsWith("*.")
      ? name.length > rule.length - 1 && name.endsWith(rule.slice(1))
      : name === rule;
  });
}

/** An address that is this computer or its local network: never a destination for a connector. */
export function isLocalNetworkAddress(address: string): boolean {
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) return isLocalNetworkAddress(lower.slice(7));
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd")
    );
  }
  const parts = address.split(".").map(Number);
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export interface HostAllowListProxy {
  /** The loopback port a confined process may be granted. */
  readonly port: number;
  readonly stop: () => Promise<void>;
}

export interface HostAllowListProxyOptions {
  readonly allowedHosts: ReadonlyArray<string>;
  /** Test seam; the host uses the system resolver. */
  readonly resolve?: (host: string) => Promise<string>;
  /** Test seam: a test tunnels to a loopback echo server, which the host never allows. */
  readonly refuseLocalNetwork?: boolean;
  readonly upstreamPort?: number;
}

/**
 * A CONNECT-only proxy on the loopback interface that tunnels HTTPS to the
 * listed hosts and refuses everything else. The macOS sandbox cannot name a
 * host, so a connector's process is granted this one port and the host names
 * come from here. Only port 443 is tunnelled, and a name that resolves to this
 * computer or a local network is refused after resolution, so an allowed name
 * cannot be pointed at something inside the network.
 */
export async function startHostAllowListProxy(
  options: HostAllowListProxyOptions,
): Promise<HostAllowListProxy> {
  const resolve =
    options.resolve ?? (async (host: string) => (await lookup(host, { verbatim: true })).address);
  const sockets = new Set<Socket | Duplex>();
  const server: Server = createServer((_request, response) => {
    response.writeHead(405, { Allow: "CONNECT" }).end();
  });
  server.on("connect", (request, client, head) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const refuse = (status: string) => {
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    const target = parseAuthority(request.url ?? "");
    if (
      target === undefined ||
      target.port !== 443 ||
      !hostIsAllowed(target.host, options.allowedHosts)
    ) {
      refuse("403 Forbidden");
      return;
    }
    void resolve(target.host).then(
      (address) => {
        if (options.refuseLocalNetwork !== false && isLocalNetworkAddress(address)) {
          refuse("403 Forbidden");
          return;
        }
        const upstream = connect({ host: address, port: options.upstreamPort ?? 443 });
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        upstream.on("error", () => {
          if (client.writable && !upstream.writableEnded) refuse("502 Bad Gateway");
          client.destroy();
        });
        upstream.on("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
      },
      () => refuse("502 Bad Gateway"),
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The connector proxy could not bind a loopback port.");
  }
  return {
    port: address.port,
    stop: () =>
      new Promise<void>((resolveStop) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolveStop());
      }),
  };
}

function parseAuthority(value: string): { host: string; port: number } | undefined {
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  if (match === null) return undefined;
  return { host: match[1] ?? "", port: Number(match[2]) };
}

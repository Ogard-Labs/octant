import type { EgressProxyEndpoint } from "./threadEgressPolicy";

/**
 * What a `proxied` launch needs beside its OS rules: the proxy variables its
 * clients read, and on Linux the forwarder that carries a loopback connection
 * inside the capsule to the host proxy's Unix socket. Canonical:
 * docs/architecture.md § Harness tool egress rules.
 */

/**
 * The loopback port the Linux forwarder listens on inside the capsule's
 * private network namespace. Nothing else listens there, so a fixed port is
 * enough; the host side is a per-launch Unix socket.
 */
export const LINUX_EGRESS_FORWARDER_PORT = 3128;

/**
 * The proxy variables a launch carries. They are advisory: a client that
 * ignores them reaches nothing, because the OS rules deny direct egress. The
 * token is the command's to read; it is worthless once the launch ends.
 */
export function proxiedLaunchEnvironment(
  endpoint: EgressProxyEndpoint,
  token: string,
): Readonly<Record<string, string>> {
  const port = endpoint.kind === "loopback" ? endpoint.port : LINUX_EGRESS_FORWARDER_PORT;
  const url = `http://octant:${token}@127.0.0.1:${String(port)}`;
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    ALL_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    all_proxy: url,
    NO_PROXY: "",
    no_proxy: "",
    NODE_USE_ENV_PROXY: "1",
  };
}

/**
 * The Linux forwarder, run by the host's own JavaScript runtime as the first
 * process in the capsule: `forwarder <socket> <port> <command> [args...]`. It
 * listens on 127.0.0.1:<port>, relays each connection byte for byte to the
 * socket, then runs the command and exits with its status. It holds no policy;
 * the token and every decision stay with the host proxy. When it cannot listen
 * or start the command it exits 125 before the command runs.
 */
export const LINUX_EGRESS_FORWARDER_SOURCE = `"use strict";
const net = require("node:net");
const os = require("node:os");
const { spawn } = require("node:child_process");
const [socketPath, portText, executable, ...args] = process.argv.slice(2);
function refuse(message) {
  process.stderr.write("octant-egress-forwarder: " + message + "\\n");
  process.exit(125);
}
if (!socketPath || !executable || !/^[0-9]{1,5}$/.test(portText || "")) refuse("invalid arguments");
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  const upstream = net.connect({ path: socketPath, allowHalfOpen: true });
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", end);
  upstream.on("error", end);
  client.on("close", end);
  upstream.on("close", end);
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on("error", (error) => refuse("cannot listen: " + error.message));
server.listen({ host: "127.0.0.1", port: Number(portText), exclusive: true }, () => {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, { stdio: "inherit", env: environment });
  child.on("error", (error) => refuse("cannot start the command: " + error.message));
  child.on("exit", (code, signal) => {
    const number = signal === null ? 0 : os.constants.signals[signal] || 0;
    process.exit(code === null ? 128 + number : code);
  });
});
`;

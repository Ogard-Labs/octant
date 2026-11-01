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
 *
 * `forwarder <socket> <port> --inbound <inbound-socket> <inbound-port> ...`
 * also listens on the inbound socket and relays each connection the host
 * opens there to 127.0.0.1:<inbound-port> inside the capsule and to nothing
 * else. A debug session's child connection uses it. The command starts only
 * after the host's first connection, which carries nothing: until then only
 * the forwarder runs in the capsule, so the socket the host found is the
 * forwarder's own, and the host keeps a link to it the capsule cannot reach.
 *
 * `forwarder <socket> <port> --loopback <port> ... <command> [args...]` also
 * listens on each such loopback port inside the capsule and carries each
 * connection to that port on the host's loopback through the proxy, as a
 * `CONNECT 127.0.0.1:<port>` with the credential `HTTPS_PROXY` names, so the
 * proxy decides and records it as any other request. A provider runtime's
 * tool bridge uses it. A refusal closes the connection.
 *
 * `forwarder <socket> <port> --child-seccomp <filter> <command> [args...]`
 * opens the filter file before anything else runs and hands it to the
 * command as file descriptor 3. That form starts a launch whose own process
 * is denied (Plan): the command is a nested Bubblewrap that loads the filter
 * onto the workload, so the forwarder can start it while the workload still
 * cannot fork or start another program.
 */
export const LINUX_EGRESS_FORWARDER_SOURCE = `"use strict";
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const { spawn } = require("node:child_process");
const [socketPath, portText, ...rest] = process.argv.slice(2);
function refuse(message) {
  process.stderr.write("octant-egress-forwarder: " + message + "\\n");
  process.exit(125);
}
let inbound;
if (rest[0] === "--inbound") {
  if (!rest[1] || !/^[0-9]{1,5}$/.test(rest[2] || "")) refuse("invalid inbound relay");
  inbound = { path: rest[1], port: Number(rest[2]) };
  rest.splice(0, 3);
}
const loopbackPorts = [];
while (rest[0] === "--loopback") {
  if (!/^[0-9]{1,5}$/.test(rest[1] || "")) refuse("invalid loopback relay");
  loopbackPorts.push(Number(rest[1]));
  rest.splice(0, 2);
}
let childFilter;
if (rest[0] === "--child-seccomp") {
  try {
    childFilter = fs.openSync(rest[1] || "", "r");
  } catch (error) {
    refuse("cannot open the filter: " + error.message);
  }
  rest.splice(0, 2);
}
const [executable, ...args] = rest;
if (!socketPath || !executable || !/^[0-9]{1,5}$/.test(portText || "")) refuse("invalid arguments");
function relay(client, upstream) {
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
}
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  relay(client, net.connect({ path: socketPath, allowHalfOpen: true }));
});
function proxyAuthorization() {
  try {
    const url = new URL(process.env.HTTPS_PROXY || "");
    if (url.username === "") return "";
    const credential = decodeURIComponent(url.username) + ":" + decodeURIComponent(url.password);
    return "Proxy-Authorization: Basic " + Buffer.from(credential).toString("base64") + "\\r\\n";
  } catch {
    return "";
  }
}
function loopbackServer(port) {
  return net.createServer({ allowHalfOpen: true }, (client) => {
    client.pause();
    const upstream = net.connect({ path: socketPath, allowHalfOpen: true });
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    // Until the proxy answers, either side closing ends both.
    client.on("close", end);
    upstream.on("close", end);
    const target = "127.0.0.1:" + port;
    upstream.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n" + proxyAuthorization() + "\\r\\n");
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const at = head.indexOf("\\r\\n\\r\\n");
      if (at === -1) {
        if (head.length > 8192) end();
        return;
      }
      upstream.off("data", onData);
      if (!/^HTTP\\/1\\.[01] 200 /.test(head.subarray(0, at).toString("latin1"))) return end();
      const rest = head.subarray(at + 4);
      if (rest.length > 0) client.write(rest);
      relay(client, upstream);
      client.resume();
    };
    upstream.on("data", onData);
  });
}
function listenLoopback(index, then) {
  if (index >= loopbackPorts.length) return then();
  const relayServer = loopbackServer(loopbackPorts[index]);
  relayServer.on("error", (error) => refuse("cannot listen on a loopback relay: " + error.message));
  relayServer.listen({ host: "127.0.0.1", port: loopbackPorts[index], exclusive: true }, () =>
    listenLoopback(index + 1, then),
  );
}
function listenInbound(then) {
  if (inbound === undefined) return then();
  let started = false;
  const inboundServer = net.createServer({ allowHalfOpen: true }, (client) => {
    if (!started) {
      started = true;
      client.destroy();
      return then();
    }
    relay(client, net.connect({ host: "127.0.0.1", port: inbound.port, allowHalfOpen: true }));
  });
  inboundServer.on("error", (error) => refuse("cannot listen inbound: " + error.message));
  inboundServer.listen({ path: inbound.path, exclusive: true });
}
server.on("error", (error) => refuse("cannot listen: " + error.message));
listenInbound(() => listenLoopback(0, () => server.listen({ host: "127.0.0.1", port: Number(portText), exclusive: true }, () => {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, {
    stdio: childFilter === undefined ? "inherit" : ["inherit", "inherit", "inherit", childFilter],
    env: environment,
  });
  if (childFilter !== undefined) fs.closeSync(childFilter);
  child.on("error", (error) => refuse("cannot start the command: " + error.message));
  child.on("exit", (code, signal) => {
    const number = signal === null ? 0 : os.constants.signals[signal] || 0;
    process.exit(code === null ? 128 + number : code);
  });
})));
`;

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, connect, type ListenOptions, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { registeredServerFor, remoteHostsNamedBy } from "@octant/domain/shield-server-policy";
import { openKeyAgent } from "./sshKeyAgent";
import type { ServerSshKeys } from "./sshKeyBrokerClient";

/**
 * How a confined command reaches the person's registered servers without the
 * network or the key files being open to it. Canonical: docs/architecture.md
 * § Octant Shield (servers as built).
 *
 * For one command the host opens, and closes when the command ends:
 *
 * - a relay per server the command names, which carries bytes to that
 *   server's address and nowhere else. On macOS it is a loopback port the
 *   Seatbelt profile opens alone; on Linux it is a Unix socket the capsule's
 *   forwarder carries one loopback port inside the capsule to, since
 *   Bubblewrap's private network cannot name a host port. Either way `ssh`
 *   reaches no other host;
 * - an SSH agent socket the host owns, which passes the person's agent only
 *   the requests that list keys and sign a login, so the command can neither
 *   read a key nor add, remove, or lock one. A server that signs in with a
 *   key Octant keeps gets an agent socket of its own instead, which offers
 *   that key alone and has the credential broker sign;
 * - an SSH config, known-hosts file, and `ssh`/`scp`/`rsync` wrappers in the
 *   command's own read-only script folder, so the command cannot rewrite
 *   them. The config names each server by its alias, with the person's
 *   address, port, and recorded host keys, and turns off forwarding, proxy
 *   commands, and local commands.
 *
 * The person's own SSH config and known hosts are read here, on the host, by
 * `ssh -G` and `ssh-keygen -F`; the command never reads them.
 */

export interface ServerSshAccess {
  /** Put first on the command's `PATH`: `ssh`, `scp`, and `rsync` that use the config below. */
  readonly binDirectory: string;
  /** macOS: host loopback ports the sandbox may connect to, one per server. */
  readonly relayPorts: ReadonlyArray<number>;
  /**
   * Linux: per server, the loopback port the config names inside the capsule
   * and the host relay's socket the forwarder carries it to.
   */
  readonly relaySockets: ReadonlyArray<ServerRelaySocket>;
  /** The private folder that holds the host's sockets, which a Linux capsule binds read-only. */
  readonly socketDirectory: string | undefined;
  /** The host-owned agent socket, when the person has an agent. */
  readonly agentSocket: string | undefined;
  /** One agent socket per server that signs in with a key Octant keeps. */
  readonly keySockets: ReadonlyArray<string>;
  /** Closes the relays and the agent socket. Safe to call more than once. */
  readonly close: () => Promise<void>;
}

export interface ServerRelaySocket {
  readonly port: number;
  readonly socketPath: string;
}

/** A server as the person's SSH config resolves its alias on this computer. */
export interface ResolvedServer {
  readonly hostname: string;
  readonly port: number;
  /** The name the person's known-hosts files record its keys under. */
  readonly hostKeyName: string;
  readonly knownHostsFiles: ReadonlyArray<string>;
  /** The person's config reaches it through a jump host or a proxy program. */
  readonly proxied: boolean;
}

export interface ServerSshAccessOptions {
  /** The person's SSH agent socket, read when a command starts. */
  readonly personAgentSocket: () => string | undefined;
  /** Resolves an alias the way the person's own `ssh` would. */
  readonly resolve?: (alias: string) => Promise<ResolvedServer | undefined>;
  /** The person's recorded keys for a host, as known-hosts lines. */
  readonly knownHostLines?: (
    hostKeyName: string,
    files: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<string>>;
  /** Where the agent sockets live: a socket path must stay under 104 bytes. */
  readonly socketParent?: string;
  /**
   * `unix-socket` for a Linux capsule, whose forwarder carries a port inside
   * it to each relay's socket; `loopback` (the default) for Seatbelt.
   */
  readonly relays?: "loopback" | "unix-socket";
  /** The keys Octant keeps for servers that sign in with one; absent without a credential broker. */
  readonly keys?: Pick<ServerSshKeys, "publicKey" | "signLogin"> | undefined;
}

/** A registered server as a command's access needs it. */
export type ServerSshAccessServer = Pick<ShieldServer, "alias" | "user"> &
  Partial<Pick<ShieldServer, "serverId" | "signIn">>;

const SSH = "/usr/bin/ssh";
const SCP = "/usr/bin/scp";
const RSYNC = "/usr/bin/rsync";
const SSH_KEYGEN = "/usr/bin/ssh-keygen";
const RESOLVE_TIMEOUT_MS = 5_000;
const MAX_SOCKET_PATH = 103;
/** The agent protocol's own bound on one message. */
const MAX_AGENT_MESSAGE = 256 * 1024;
/**
 * The first loopback port a Linux capsule's forwarder listens on for a
 * server; the capsule's network is its own, so a fixed range is enough.
 */
const CAPSULE_RELAY_FIRST_PORT = 2201;
const AGENT_FAILURE = Buffer.from([0, 0, 0, 1, 5]);
const AGENT_REQUEST_IDENTITIES = 11;
const AGENT_SIGN_REQUEST = 13;
const AGENT_EXTENSION = 27;
/** Binds a signature to the server's host key; it widens nothing. */
const SESSION_BIND = "session-bind@openssh.com";

/**
 * Opens access for one command to the registered servers it names as one
 * plain `ssh`, `scp`, or `rsync` call: the call Shield judged. A command that
 * does more, or names no registered server, gets none.
 */
export function openServerSshAccessFor(
  command: string,
  directory: string,
  servers: ReadonlyArray<ServerSshAccessServer>,
  options: ServerSshAccessOptions,
): Promise<ServerSshAccess | undefined> {
  const named = remoteHostsNamedBy(command).flatMap((host) => {
    const server = registeredServerFor(servers, host);
    return server === undefined ? [] : [server];
  });
  return openServerSshAccess(named, directory, options);
}

/**
 * Opens access to `servers` for one command, in `directory`: the command's
 * own script folder, which it reads and cannot write. Undefined when there is
 * nothing to open or a path cannot be written safely into the config.
 */
export async function openServerSshAccess(
  servers: ReadonlyArray<ServerSshAccessServer>,
  directory: string,
  options: ServerSshAccessOptions,
): Promise<ServerSshAccess | undefined> {
  if (servers.length === 0) return undefined;
  const resolve = options.resolve ?? resolveWithPersonConfig;
  const knownHostLines = options.knownHostLines ?? readKnownHostLines;
  const sshDirectory = join(await realpath(directory), "ssh");
  if (!quotable(sshDirectory)) return undefined;
  const closers: Array<() => Promise<void>> = [];
  const close = async () => {
    for (const closer of closers.splice(0).reverse()) await closer().catch(() => undefined);
  };
  const unixRelays = options.relays === "unix-socket";
  try {
    const octantKeys = options.keys !== undefined && servers.some(usesOctantKey);
    const socketDirectory =
      unixRelays || octantKeys || options.personAgentSocket() !== undefined
        ? await openSocketDirectory(options, closers)
        : undefined;
    const agentSocket =
      socketDirectory === undefined
        ? undefined
        : await openAgentProxy(options, socketDirectory, closers);
    const relayPorts: number[] = [];
    const relaySockets: ServerRelaySocket[] = [];
    const keySockets: string[] = [];
    const entries: string[] = [];
    const knownHosts: string[] = [];
    for (const server of servers) {
      const resolved = await resolve(server.alias).catch(() => undefined);
      // A jump host or proxy program would run outside the relay; the
      // command gets no path to that server, and ssh says it cannot resolve it.
      if (resolved === undefined || resolved.proxied) continue;
      let port: number;
      if (unixRelays && socketDirectory !== undefined) {
        const socketPath = join(socketDirectory, `relay-${String(relaySockets.length)}`);
        if (!socketPathFits(socketPath)) throw new Error("The relay socket path is too long.");
        closers.push(
          (await openRelay(resolved.hostname, resolved.port, { path: socketPath })).close,
        );
        port = CAPSULE_RELAY_FIRST_PORT + relaySockets.length;
        relaySockets.push({ port, socketPath });
      } else {
        const relay = await openRelay(resolved.hostname, resolved.port, {
          port: 0,
          host: "127.0.0.1",
        });
        closers.push(relay.close);
        port = relay.port;
        relayPorts.push(port);
      }
      for (const line of await knownHostLines(resolved.hostKeyName, resolved.knownHostsFiles).catch(
        () => [],
      )) {
        const rewritten = knownHostLineFor(server.alias, line);
        if (rewritten !== undefined) knownHosts.push(rewritten);
      }
      // The person chose Octant's key for this server, so its login never
      // falls back to their agent: without a key here it offers none.
      let identityAgent = usesOctantKey(server) ? undefined : agentSocket;
      if (usesOctantKey(server) && options.keys !== undefined && socketDirectory !== undefined) {
        const keySocket = join(socketDirectory, `key-${String(keySockets.length)}`);
        if (!socketPathFits(keySocket)) throw new Error("The key socket path is too long.");
        const keyAgent = await openKeyAgent(
          keySocket,
          String(server.serverId),
          `octant ${server.alias}`,
          options.keys,
        );
        if (keyAgent !== undefined) {
          closers.push(keyAgent.close);
          keySockets.push(keySocket);
          identityAgent = keySocket;
        }
      }
      entries.push(configEntry(server, port, sshDirectory, identityAgent));
    }
    if (relayPorts.length + relaySockets.length === 0) {
      await close();
      return undefined;
    }
    const binDirectory = join(sshDirectory, "bin");
    await mkdir(binDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(sshDirectory, "config"), `${entries.join("\n")}\n`, { mode: 0o600 });
    await writeFile(join(sshDirectory, "known_hosts"), `${knownHosts.join("\n")}\n`, {
      mode: 0o600,
    });
    const config = join(sshDirectory, "config");
    await writeWrapper(binDirectory, "ssh", `exec ${SSH} -F '${config}' "$@"`);
    await writeWrapper(binDirectory, "scp", `exec ${SCP} -F '${config}' "$@"`);
    await writeWrapper(binDirectory, "rsync", `exec ${RSYNC} --rsh="${SSH} -F '${config}'" "$@"`);
    return {
      binDirectory,
      relayPorts,
      relaySockets,
      socketDirectory,
      agentSocket,
      keySockets,
      close,
    };
  } catch {
    await close();
    return undefined;
  }
}

function usesOctantKey(server: ServerSshAccessServer): boolean {
  return server.signIn === "octant-key" && server.serverId !== undefined;
}

/** A path the config and the wrappers can carry inside quotes. */
function quotable(path: string): boolean {
  return !/["'\\$`\n\r]/.test(path) && !path.includes("\u0000");
}

function configEntry(
  server: Pick<ShieldServer, "alias" | "user">,
  relayPort: number,
  sshDirectory: string,
  agentSocket: string | undefined,
): string {
  return [
    `Host ${server.alias}`,
    "  HostName 127.0.0.1",
    `  Port ${String(relayPort)}`,
    `  User ${server.user}`,
    // Keys are checked under the alias, since the relay's address says
    // nothing about which server answers.
    `  HostKeyAlias ${server.alias}`,
    "  CheckHostIP no",
    "  StrictHostKeyChecking yes",
    "  UpdateHostKeys no",
    `  UserKnownHostsFile "${join(sshDirectory, "known_hosts")}"`,
    "  GlobalKnownHostsFile none",
    `  IdentityAgent ${agentSocket === undefined ? "none" : `"${agentSocket}"`}`,
    "  IdentityFile none",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  ClearAllForwardings yes",
    "  PermitLocalCommand no",
    "  ProxyCommand none",
    "  ProxyJump none",
    "  ControlMaster no",
    "  ControlPath none",
    "  BatchMode yes",
  ].join("\n");
}

async function writeWrapper(directory: string, name: string, line: string): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\n${line}\n`, { mode: 0o500 });
  await chmod(path, 0o500);
}

/** One known-hosts line recorded under `alias`, its marker kept; undefined for a comment. */
export function knownHostLineFor(alias: string, line: string): string | undefined {
  const fields = line.trim().split(/\s+/);
  if (fields.length === 0 || (fields[0] ?? "").startsWith("#")) return undefined;
  const marker = (fields[0] ?? "").startsWith("@") ? fields.shift() : undefined;
  const [, type, key] = fields;
  if (type === undefined || key === undefined) return undefined;
  return `${marker === undefined ? "" : `${marker} `}${alias} ${type} ${key}`;
}

function run(command: string, args: ReadonlyArray<string>): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      [...args],
      { timeout: RESOLVE_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => resolvePromise(error === null ? stdout : undefined),
    );
  });
}

/**
 * `ssh -G` prints the configuration the person's own `ssh` would use for an
 * alias, without connecting. `configFile` stands in for the person's config
 * in tests.
 */
export async function resolveWithPersonConfig(
  alias: string,
  configFile?: string,
): Promise<ResolvedServer | undefined> {
  const output = await run(SSH, [
    ...(configFile === undefined ? [] : ["-F", configFile]),
    "-G",
    alias,
  ]);
  if (output === undefined) return undefined;
  const settings = new Map<string, string>();
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) settings.set(line.slice(0, space).toLowerCase(), line.slice(space + 1).trim());
  }
  const hostname = settings.get("hostname");
  const port = Number(settings.get("port") ?? "22");
  if (hostname === undefined || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  const home = homedir();
  const files = [settings.get("userknownhostsfile"), settings.get("globalknownhostsfile")]
    .flatMap((value) => (value ?? "").split(/\s+/))
    .filter((file) => file.length > 0 && file !== "none")
    .map((file) => (file.startsWith("~/") ? join(home, file.slice(2)) : file));
  const proxied = ["proxycommand", "proxyjump"].some((key) => {
    const value = settings.get(key);
    return value !== undefined && value !== "none";
  });
  return {
    hostname,
    port,
    hostKeyName:
      settings.get("hostkeyalias") ?? (port === 22 ? hostname : `[${hostname}]:${String(port)}`),
    knownHostsFiles: files,
    proxied,
  };
}

/** The person's recorded keys for a host, hashed entries included, read by `ssh-keygen -F`. */
async function readKnownHostLines(
  hostKeyName: string,
  files: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const lines: string[] = [];
  for (const file of files) {
    const output = await run(SSH_KEYGEN, ["-F", hostKeyName, "-f", file]);
    if (output === undefined) continue;
    lines.push(
      ...output.split("\n").filter((line) => line.trim().length > 0 && !line.startsWith("#")),
    );
  }
  return lines;
}

async function listen(server: Server, at: ListenOptions): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(at, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function closer(server: Server, sockets: Set<Socket>): () => Promise<void> {
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  };
}

/** A listener that carries each connection to one server's address and nowhere else. */
async function openRelay(
  hostname: string,
  port: number,
  at: ListenOptions,
): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect({ host: hostname, port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await listen(server, at);
  const address = server.address();
  if (address === null || (typeof address === "string") !== (at.path !== undefined)) {
    await closer(server, sockets)();
    throw new Error("The relay is not listening.");
  }
  return {
    port: typeof address === "string" ? 0 : address.port,
    close: closer(server, sockets),
  };
}

/** A private folder for this command's sockets, removed when it ends. */
async function openSocketDirectory(
  options: ServerSshAccessOptions,
  closers: Array<() => Promise<void>>,
): Promise<string> {
  const parent = await realpath(options.socketParent ?? tmpdir());
  const socketDirectory = await mkdtemp(join(parent, "octant-ssh-"));
  closers.push(() => rm(socketDirectory, { recursive: true, force: true }));
  return socketDirectory;
}

function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path) <= MAX_SOCKET_PATH && quotable(path);
}

/**
 * The host-owned agent socket: requests pass to the person's agent one at a
 * time, and only listing keys, signing, and binding a session to a host key
 * reach it. Every other request (adding, removing, or locking keys, or any
 * extension) is answered with a failure here.
 */
async function openAgentProxy(
  options: ServerSshAccessOptions,
  socketDirectory: string,
  closers: Array<() => Promise<void>>,
): Promise<string | undefined> {
  const upstreamPath = options.personAgentSocket();
  if (upstreamPath === undefined) return undefined;
  const socketPath = join(socketDirectory, "agent");
  if (!socketPathFits(socketPath)) throw new Error("The agent socket path is too long.");
  const sockets = new Set<Socket>();
  const server = createServer((client) => relayAgent(client, upstreamPath, sockets));
  await listen(server, { path: socketPath });
  closers.push(closer(server, sockets));
  return socketPath;
}

function relayAgent(client: Socket, upstreamPath: string, sockets: Set<Socket>): void {
  const upstream = connect(upstreamPath);
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      end();
    });
    socket.on("error", end);
  }
  let pending = Buffer.alloc(0);
  let reply = Buffer.alloc(0);
  let waiting = false;
  const frame = (buffer: Buffer): number | undefined => {
    if (buffer.length < 4) return undefined;
    const length = buffer.readUInt32BE(0);
    if (length === 0 || length > MAX_AGENT_MESSAGE) return -1;
    return buffer.length < 4 + length ? undefined : 4 + length;
  };
  const next = () => {
    while (!waiting) {
      const size = frame(pending);
      if (size === undefined) return;
      if (size === -1) return end();
      const message = pending.subarray(0, size);
      pending = pending.subarray(size);
      if (agentRequestAllowed(message)) {
        waiting = true;
        upstream.write(message);
      } else {
        client.write(AGENT_FAILURE);
      }
    }
  };
  client.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_AGENT_MESSAGE + 4) return end();
    next();
  });
  upstream.on("data", (chunk: Buffer) => {
    reply = Buffer.concat([reply, chunk]);
    for (;;) {
      const size = frame(reply);
      if (size === undefined) return;
      if (size === -1) return end();
      client.write(reply.subarray(0, size));
      reply = reply.subarray(size);
      waiting = false;
      next();
    }
  });
}

export function agentRequestAllowed(message: Buffer): boolean {
  const type = message[4];
  if (type === AGENT_REQUEST_IDENTITIES || type === AGENT_SIGN_REQUEST) return true;
  if (type !== AGENT_EXTENSION || message.length < 9) return false;
  const nameLength = message.readUInt32BE(5);
  return (
    message.length >= 9 + nameLength &&
    message.subarray(9, 9 + nameLength).toString("latin1") === SESSION_BIND
  );
}

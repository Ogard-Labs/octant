import { mkdtemp, realpath, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedSessionBinding, type SessionBinding } from "./sshSessionBind";

/**
 * The SSH agent socket a provider runtime's own commands sign in through,
 * below Full access. Canonical: docs/architecture.md § Octant Shield
 * (provider runtimes' own commands).
 *
 * A runtime runs its shell commands itself, so Octant cannot open a path per
 * command as it does for a harness command. It gives the whole launch one
 * agent socket instead, which signs a login only on a connection `ssh` first
 * bound to the host key of one of the Project's registered servers (OpenSSH's
 * `session-bind@openssh.com`, whose host-key signature is checked here), for
 * that session and that server's registered user. So the runtime's `ssh` can
 * sign in to a registered server and to nothing else; reaching the server
 * still needs the runtime's own network. The keys are the person's agent's,
 * passed on only to list and sign, and the key Octant keeps for a server
 * that signs in with one, which the credential broker signs with.
 */

export interface RuntimeAgentServer {
  readonly serverId: string;
  readonly user: string;
  /** The server's host keys as the person's known-hosts files record them, in SSH wire form. */
  readonly hostKeys: ReadonlyArray<Buffer>;
  /** The public key blob of the key Octant keeps for it, when it signs in with one. */
  readonly octantKey?: Buffer | undefined;
  /** It was registered to sign in with Octant's key: the person's agent never signs for it. */
  readonly octantOnly?: boolean;
}

export interface RuntimeServerAgentOptions {
  /** The registered servers of the launch's Project, read again at each binding. */
  readonly servers: () => Promise<ReadonlyArray<RuntimeAgentServer>>;
  /** The person's SSH agent socket, read at each connection. */
  readonly personAgentSocket: () => string | undefined;
  /** Signs a login with the key Octant keeps for a server. */
  readonly signWithOctantKey: (serverId: string, data: Buffer) => Promise<Buffer | undefined>;
  /** Where the socket's private folder goes: a socket path must stay under 104 bytes. */
  readonly socketParent?: string;
}

export interface RuntimeServerAgent {
  readonly socketPath: string;
  /** The socket's private folder, which a Linux capsule binds read-only. */
  readonly socketDirectory: string;
  readonly close: () => Promise<void>;
}

const MAX_AGENT_MESSAGE = 256 * 1024;
const MAX_SOCKET_PATH = 103;
const AGENT_FAILURE = 5;
const AGENT_SUCCESS = 6;
const AGENT_REQUEST_IDENTITIES = 11;
const AGENT_IDENTITIES_ANSWER = 12;
const AGENT_SIGN_REQUEST = 13;
const AGENT_EXTENSION = 27;
const USERAUTH_REQUEST = 50;
const HOSTBOUND_PUBLICKEY = "publickey-hostbound-v00@openssh.com";

export async function openRuntimeServerAgent(
  options: RuntimeServerAgentOptions,
): Promise<RuntimeServerAgent | undefined> {
  const parent = await realpath(options.socketParent ?? tmpdir());
  const socketDirectory = await mkdtemp(join(parent, "octant-runtime-ssh-"));
  const socketPath = join(socketDirectory, "agent");
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    await rm(socketDirectory, { recursive: true, force: true });
    return undefined;
  }
  const sockets = new Set<Socket>();
  const server = createServer((client) => serveConnection(client, options, sockets));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: socketPath }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    await rm(socketDirectory, { recursive: true, force: true });
    return undefined;
  }
  let closing: Promise<void> | undefined;
  return {
    socketPath,
    socketDirectory,
    close: () => {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(socketDirectory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}

interface ConnectionState {
  /** The one server this connection proved it reached; undefined until then. */
  bound: { readonly binding: SessionBinding; readonly server: RuntimeAgentServer } | undefined;
  /** A second or forwarded binding was offered: this connection signs nothing. */
  refused: boolean;
}

function serveConnection(
  client: Socket,
  options: RuntimeServerAgentOptions,
  sockets: Set<Socket>,
): void {
  sockets.add(client);
  client.on("close", () => sockets.delete(client));
  client.on("error", () => client.destroy());
  const state: ConnectionState = { bound: undefined, refused: false };
  let pending = Buffer.alloc(0);
  let working = false;
  const next = async () => {
    if (working) return;
    working = true;
    try {
      for (;;) {
        if (pending.length < 4) return;
        const length = pending.readUInt32BE(0);
        if (length === 0 || length > MAX_AGENT_MESSAGE) return void client.destroy();
        if (pending.length < 4 + length) return;
        const message = pending.subarray(4, 4 + length);
        pending = pending.subarray(4 + length);
        const reply = await answer(message, state, options).catch(() => failure());
        if (client.destroyed) return;
        client.write(reply);
      }
    } finally {
      working = false;
    }
  };
  client.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_AGENT_MESSAGE + 4) return void client.destroy();
    void next();
  });
}

async function answer(
  message: Buffer,
  state: ConnectionState,
  options: RuntimeServerAgentOptions,
): Promise<Buffer> {
  switch (message[0]) {
    case AGENT_EXTENSION:
      return bind(message, state, options);
    case AGENT_REQUEST_IDENTITIES:
      return identities(options);
    case AGENT_SIGN_REQUEST:
      return signLogin(message, state, options);
    default:
      return failure();
  }
}

/**
 * `ssh` binds each connection once, to the server it reached. A binding is
 * kept only when its host key signed it, it was not forwarded from another
 * host, and the host key is a registered server's; anything else leaves the
 * connection unable to sign.
 */
async function bind(
  message: Buffer,
  state: ConnectionState,
  options: RuntimeServerAgentOptions,
): Promise<Buffer> {
  const binding = verifiedSessionBinding(message);
  if (binding === undefined) return failure();
  if (binding.forwarding || state.bound !== undefined || state.refused) {
    state.refused = true;
    state.bound = undefined;
    return failure();
  }
  const server = (await options.servers()).find((candidate) =>
    candidate.hostKeys.some((key) => key.equals(binding.hostKey)),
  );
  if (server === undefined) {
    state.refused = true;
    return failure();
  }
  state.bound = { binding, server };
  return frame(Buffer.from([AGENT_SUCCESS]));
}

/** The person's agent's keys, then the keys Octant keeps for the Project's servers. */
async function identities(options: RuntimeServerAgentOptions): Promise<Buffer> {
  const keys: Array<{ readonly blob: Buffer; readonly comment: Buffer }> = [];
  const upstream = options.personAgentSocket();
  if (upstream !== undefined) {
    const reply = await ask(upstream, frame(Buffer.from([AGENT_REQUEST_IDENTITIES])));
    if (reply !== undefined && reply[0] === AGENT_IDENTITIES_ANSWER) {
      const reader = sshReader(reply.subarray(1));
      const count = reader.uint32() ?? 0;
      for (let index = 0; index < count && index < 1_024; index += 1) {
        const blob = reader.string();
        const comment = reader.string();
        if (blob === undefined || comment === undefined) break;
        keys.push({ blob, comment });
      }
    }
  }
  for (const server of await options.servers()) {
    if (server.octantKey === undefined || server.octantKey.length === 0) continue;
    if (keys.some((key) => key.blob.equals(server.octantKey ?? Buffer.alloc(0)))) continue;
    keys.push({ blob: server.octantKey, comment: Buffer.from("octant", "latin1") });
  }
  const count = Buffer.alloc(4);
  count.writeUInt32BE(keys.length);
  return frame(
    Buffer.concat([
      Buffer.from([AGENT_IDENTITIES_ANSWER]),
      count,
      ...keys.flatMap((key) => [sshString(key.blob), sshString(key.comment)]),
    ]),
  );
}

/**
 * Signs only a public-key login request, on a connection bound to a
 * registered server, for that very session and that server's registered
 * user. The key Octant keeps for the bound server signs through the broker;
 * any other key goes to the person's agent.
 */
async function signLogin(
  message: Buffer,
  state: ConnectionState,
  options: RuntimeServerAgentOptions,
): Promise<Buffer> {
  const bound = state.bound;
  if (bound === undefined || state.refused) return failure();
  const request = sshReader(message.subarray(1));
  const blob = request.string();
  const data = request.string();
  if (blob === undefined || data === undefined) return failure();
  const login = sshReader(data);
  const sessionId = login.string();
  if (sessionId === undefined || !sessionId.equals(bound.binding.sessionId)) return failure();
  if (login.byte() !== USERAUTH_REQUEST) return failure();
  if (login.string()?.toString("utf8") !== bound.server.user) return failure();
  if (login.string()?.toString("latin1") !== "ssh-connection") return failure();
  const method = login.string()?.toString("latin1");
  if (method !== "publickey" && method !== HOSTBOUND_PUBLICKEY) return failure();
  if (login.byte() !== 1 || login.string() === undefined) return failure();
  if (login.string()?.equals(blob) !== true) return failure();
  // The host-bound form (OpenSSH 8.9 and later) names the server's host key
  // too; it must be the key this connection bound to.
  if (method === HOSTBOUND_PUBLICKEY && login.string()?.equals(bound.binding.hostKey) !== true) {
    return failure();
  }
  if (!login.done()) return failure();
  if (bound.server.octantKey?.equals(blob) === true) {
    const signature = await options.signWithOctantKey(bound.server.serverId, data);
    return signature === undefined
      ? failure()
      : frame(Buffer.concat([Buffer.from([14]), sshString(signature)]));
  }
  if (bound.server.octantOnly === true) return failure();
  const upstream = options.personAgentSocket();
  if (upstream === undefined) return failure();
  const reply = await ask(upstream, frame(message));
  return reply === undefined ? failure() : frame(reply);
}

/** One request to the person's agent on a connection of its own; undefined when it does not answer. */
function ask(socketPath: string, request: Buffer): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const upstream = connect(socketPath);
    let reply = Buffer.alloc(0);
    const done = (value: Buffer | undefined) => {
      upstream.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), 30_000);
    upstream.on("error", () => {
      clearTimeout(timer);
      done(undefined);
    });
    upstream.on("data", (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length > MAX_AGENT_MESSAGE + 4) {
        clearTimeout(timer);
        return done(undefined);
      }
      if (reply.length >= 4 && reply.length >= 4 + reply.readUInt32BE(0)) {
        clearTimeout(timer);
        done(reply.subarray(4, 4 + reply.readUInt32BE(0)));
      }
    });
    upstream.write(request);
  });
}

function failure(): Buffer {
  return frame(Buffer.from([AGENT_FAILURE]));
}

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function frame(body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function sshReader(data: Buffer) {
  let offset = 0;
  return {
    byte: (): number | undefined => (offset < data.length ? data[offset++] : undefined),
    uint32: (): number | undefined => {
      if (offset + 4 > data.length) return undefined;
      const value = data.readUInt32BE(offset);
      offset += 4;
      return value;
    },
    string: (): Buffer | undefined => {
      if (offset + 4 > data.length) return undefined;
      const length = data.readUInt32BE(offset);
      if (offset + 4 + length > data.length) return undefined;
      const value = data.subarray(offset + 4, offset + 4 + length);
      offset += 4 + length;
      return value;
    },
    done: () => offset === data.length,
  };
}

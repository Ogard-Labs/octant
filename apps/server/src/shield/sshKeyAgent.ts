import { createServer, type Server, type Socket } from "node:net";
import type { ServerSshKeys } from "./sshKeyBrokerClient";

/**
 * An SSH agent socket that holds one registered server's Octant key, for one
 * command. Canonical: docs/architecture.md § Octant Shield (servers as built).
 *
 * It lists that key and passes each sign request for it to the credential
 * broker, which signs only a login for that key. It holds no private key and
 * answers every other request (adding, removing, or locking keys, any
 * extension) with a failure, so a command can neither read the key nor change
 * what the socket offers.
 */

/** The agent protocol's own bound on one message. */
const MAX_AGENT_MESSAGE = 256 * 1024;
const AGENT_FAILURE = 5;
const AGENT_REQUEST_IDENTITIES = 11;
const AGENT_IDENTITIES_ANSWER = 12;
const AGENT_SIGN_REQUEST = 13;
const AGENT_SIGN_RESPONSE = 14;

export interface KeyAgent {
  readonly close: () => Promise<void>;
}

/**
 * Listens on `socketPath` for one server's key. Undefined when the broker has
 * no key for that server: the command then offers ssh no key for it.
 */
export async function openKeyAgent(
  socketPath: string,
  serverId: string,
  comment: string,
  keys: Pick<ServerSshKeys, "publicKey" | "signLogin">,
): Promise<KeyAgent | undefined> {
  const publicLine = await keys.publicKey(serverId);
  if (publicLine === undefined) return undefined;
  const blob = Buffer.from(publicLine.split(" ")[1] ?? "", "base64");
  const identities = frame(
    Buffer.concat([
      Buffer.from([AGENT_IDENTITIES_ANSWER]),
      uint32(1),
      sshString(blob),
      sshString(Buffer.from(comment, "utf8")),
    ]),
  );
  const answer = async (message: Buffer): Promise<Buffer> => {
    const type = message[0];
    if (type === AGENT_REQUEST_IDENTITIES) return identities;
    if (type !== AGENT_SIGN_REQUEST) return frame(Buffer.from([AGENT_FAILURE]));
    const request = readSignRequest(message);
    if (request === undefined || !request.blob.equals(blob)) {
      return frame(Buffer.from([AGENT_FAILURE]));
    }
    const signature = await keys.signLogin(serverId, request.data);
    return signature === undefined
      ? frame(Buffer.from([AGENT_FAILURE]))
      : frame(Buffer.concat([Buffer.from([AGENT_SIGN_RESPONSE]), sshString(signature)]));
  };
  const sockets = new Set<Socket>();
  const server = createServer((client) => serve(client, answer, sockets));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: socketPath }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { close: () => closeServer(server, sockets) };
}

/** Answers one request at a time, in order, as the agent protocol expects. */
function serve(
  client: Socket,
  answer: (message: Buffer) => Promise<Buffer>,
  sockets: Set<Socket>,
): void {
  sockets.add(client);
  client.on("close", () => sockets.delete(client));
  client.on("error", () => client.destroy());
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
        const reply = await answer(message).catch(() => frame(Buffer.from([AGENT_FAILURE])));
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

function readSignRequest(
  message: Buffer,
): { readonly blob: Buffer; readonly data: Buffer } | undefined {
  let offset = 1;
  const string = (): Buffer | undefined => {
    if (offset + 4 > message.length) return undefined;
    const length = message.readUInt32BE(offset);
    if (offset + 4 + length > message.length) return undefined;
    const value = message.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
    return value;
  };
  const blob = string();
  const data = string();
  return blob === undefined || data === undefined ? undefined : { blob, data };
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function sshString(value: Buffer): Buffer {
  return Buffer.concat([uint32(value.length), value]);
}

function frame(body: Buffer): Buffer {
  return Buffer.concat([uint32(body.length), body]);
}

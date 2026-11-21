// Install, update and removal reach a server over the host's shared SSH
// connection, which offers the person's own agent. A server registered with
// "A key Octant keeps" accepts only that key, so its calls go through an agent
// socket that offers that one key instead, never falling back to the person's.

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ServerAddress,
  ServerCall,
  ServerCallInput,
} from "../serverProjects/serverConnection";
import { openKeyAgent } from "./sshKeyAgent";
import type { ServerSshKeys } from "./sshKeyBrokerClient";

interface RegisteredServer {
  readonly serverId: string;
  readonly alias: string;
  readonly user: string;
  readonly signIn?: string | undefined;
}

export function keptKeyServerConnection(options: {
  readonly connection: {
    readonly run: (server: ServerAddress, input: ServerCallInput) => Promise<ServerCall>;
  };
  readonly servers: () => ReadonlyArray<RegisteredServer>;
  /** Absent when this host has no credential broker, so no kept key can sign. */
  readonly keys: Pick<ServerSshKeys, "publicKey" | "signLogin"> | undefined;
  /** A short folder for the socket: a socket path must stay under 104 bytes. */
  readonly socketParent?: string;
}): { readonly run: (server: ServerAddress, input: ServerCallInput) => Promise<ServerCall> } {
  return {
    run: async (server, input) => {
      const registered = options
        .servers()
        .find((entry) => entry.alias === server.alias && entry.user === server.user);
      if (registered?.signIn !== "octant-key") return options.connection.run(server, input);
      const noKey: ServerCall = {
        status: "unreachable",
        message: `Octant holds no key for ${server.alias}, which signs in with a key Octant keeps. Nothing ran.`,
      };
      if (options.keys === undefined) return noKey;
      const folder = await mkdtemp(join(options.socketParent ?? "/tmp", "octant-key-"));
      try {
        const socket = join(folder, "agent");
        const agent = await openKeyAgent(
          socket,
          registered.serverId,
          `octant ${server.alias}`,
          options.keys,
        );
        if (agent === undefined) return noKey;
        try {
          return await options.connection.run(server, { ...input, identityAgent: socket });
        } finally {
          await agent.close();
        }
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  };
}

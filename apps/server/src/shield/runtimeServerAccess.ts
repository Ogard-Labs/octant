import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { openRuntimeServerAgent, type RuntimeAgentServer } from "./runtimeServerAgent";
import {
  knownHostLineFor,
  readKnownHostLines,
  resolveWithPersonConfig,
  sshConfigEntry,
  writeSshWrappers,
  type ResolvedServer,
} from "./serverSshAccess";
import { hostKeyOfKnownHostLine } from "./sshSessionBind";
import type { ServerSshKeys } from "./sshKeyBrokerClient";

/**
 * How a provider runtime's own commands reach the Project's registered
 * servers below Full access. Canonical: docs/architecture.md § Octant Shield
 * (provider runtimes' own commands).
 *
 * The runtime gets, for the life of its launch, a private folder it reads and
 * cannot write: an SSH config naming each registered server by its alias at
 * the address the person's own `ssh -G` resolves, with the registered user,
 * the host keys the person's known-hosts files record, and forwarding, proxy
 * commands, and local commands off; `ssh`, `scp`, and `rsync` wrappers that
 * use it, first on `PATH`; and an agent socket that signs a login only on a
 * connection bound to one of those servers' host keys. Reaching the address
 * is the runtime's own network: open while Network limits are off.
 */

export interface RuntimeServerAccess {
  /** The private folder: a read root for the launch. */
  readonly folder: string;
  /** `SSH_AUTH_SOCK` and a `PATH` with the wrappers first. */
  readonly environment: Readonly<Record<string, string>>;
  readonly close: () => Promise<void>;
}

export interface RuntimeServerAccessOptions {
  readonly personAgentSocket: () => string | undefined;
  readonly keys?: Pick<ServerSshKeys, "publicKey" | "signLogin"> | undefined;
  readonly resolve?: (alias: string) => Promise<ResolvedServer | undefined>;
  readonly knownHostLines?: (
    hostKeyName: string,
    files: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<string>>;
  readonly socketParent?: string;
}

type AccessServer = Pick<ShieldServer, "serverId" | "alias" | "user" | "signIn">;

/**
 * Opens the folder for the servers `servers()` names now. The agent reads the
 * list again at each connection, so a server removed while the runtime runs
 * signs nothing more; one added later is reached from the next launch.
 */
export async function openRuntimeServerAccess(
  servers: () => ReadonlyArray<AccessServer>,
  path: string | undefined,
  options: RuntimeServerAccessOptions,
): Promise<RuntimeServerAccess | undefined> {
  const now = servers();
  if (now.length === 0) return undefined;
  const resolve = options.resolve ?? resolveWithPersonConfig;
  const knownHostLines = options.knownHostLines ?? readKnownHostLines;
  const prepared: Array<{
    readonly server: AccessServer;
    readonly resolved: ResolvedServer;
    readonly lines: ReadonlyArray<string>;
  }> = [];
  for (const server of now) {
    const resolved = await resolve(server.alias).catch(() => undefined);
    // A jump host or proxy program would run a program the runtime chose;
    // that server gets no entry, as it gets no relay for a harness command.
    if (resolved === undefined || resolved.proxied) continue;
    const lines = await knownHostLines(resolved.hostKeyName, resolved.knownHostsFiles).catch(
      () => [],
    );
    prepared.push({ server, resolved, lines });
  }
  if (prepared.length === 0) return undefined;
  const octantKeys = new Map<string, Buffer>();
  for (const { server } of prepared) {
    if (server.signIn !== "octant-key" || options.keys === undefined) continue;
    const line = await options.keys.publicKey(String(server.serverId));
    if (line !== undefined) octantKeys.set(String(server.serverId), Buffer.from(line.split(" ")[1] ?? "", "base64"));
  }
  const agentServers = (): ReadonlyArray<RuntimeAgentServer> => {
    const registered = new Set(servers().map((server) => String(server.serverId)));
    return prepared.flatMap(({ server, lines }) =>
      registered.has(String(server.serverId))
        ? [
            {
              serverId: String(server.serverId),
              user: server.user,
              hostKeys: lines.flatMap((line) => {
                const key = hostKeyOfKnownHostLine(line);
                return key === undefined ? [] : [key];
              }),
              // A server registered to sign in with Octant's key never signs
              // in with the person's agent, here as for a harness command.
              ...(server.signIn === "octant-key"
                ? { octantKey: octantKeys.get(String(server.serverId)) ?? Buffer.alloc(0), octantOnly: true }
                : {}),
            },
          ]
        : [],
    );
  };
  const agent = await openRuntimeServerAgent({
    servers: async () => agentServers(),
    personAgentSocket: options.personAgentSocket,
    signWithOctantKey: async (serverId, data) => options.keys?.signLogin(serverId, data),
    ...(options.socketParent === undefined ? {} : { socketParent: options.socketParent }),
  });
  if (agent === undefined) return undefined;
  try {
    const folder = agent.socketDirectory;
    const binDirectory = join(folder, "bin");
    await mkdir(binDirectory, { mode: 0o700 });
    const knownHosts = prepared.flatMap(({ server, lines }) =>
      lines.flatMap((line) => {
        const rewritten = knownHostLineFor(server.alias, line);
        return rewritten === undefined ? [] : [rewritten];
      }),
    );
    await writeFile(join(folder, "known_hosts"), `${knownHosts.join("\n")}\n`, { mode: 0o600 });
    await writeFile(
      join(folder, "config"),
      `${prepared
        .map(({ server, resolved }) =>
          sshConfigEntry(server, resolved.hostname, resolved.port, folder, agent.socketPath),
        )
        .join("\n")}\n`,
      { mode: 0o600 },
    );
    await writeSshWrappers(binDirectory, join(folder, "config"));
    return {
      folder,
      environment: {
        SSH_AUTH_SOCK: agent.socketPath,
        PATH: [binDirectory, ...(path === undefined || path === "" ? [] : [path])].join(":"),
      },
      close: agent.close,
    };
  } catch {
    await agent.close();
    return undefined;
  }
}

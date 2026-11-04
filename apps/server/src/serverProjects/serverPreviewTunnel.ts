import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import {
  SERVER_CONNECTION_OPTIONS,
  serverSshEnvironment,
  type ServerAddress,
} from "./serverConnection";

export interface ServerPreviewView {
  readonly projectId: string;
  readonly remotePort: number;
  readonly localPort: number;
  readonly endpoint: string;
  readonly status: "listening" | "lost" | "stopped" | "revoked";
}
export type ServerPreviewResult =
  | { readonly kind: "tunnel"; readonly view: ServerPreviewView }
  | { readonly kind: "refused"; readonly reason: string };
interface Preview {
  readonly projectId: string;
  readonly owner: string;
  readonly identity: string;
  readonly server: ServerAddress;
  readonly remotePort: number;
  readonly localPort: number;
  readonly listener: Server;
  readonly streams: Map<Socket, ChildProcessWithoutNullStreams>;
  readonly expiresAt: number;
  readonly ownerCurrent: () => boolean;
  status: ServerPreviewView["status"];
}
export interface ServerPreviewOptions {
  readonly address: (
    projectId: string,
  ) => { readonly server: ServerAddress; readonly identity: string } | undefined;
  readonly ownerCurrent: (owner: string) => boolean;
  readonly agentSocket: () => string | undefined;
  readonly record: (record: ServerPreviewView & { readonly owner: string }) => boolean;
  readonly sshPath?: string;
  readonly configFile?: string;
}

/** Stdio forwarding survives ClearAllForwardings, which removes configured listeners. */
export function serverPreviewSshArguments(
  server: ServerAddress,
  port: number,
  configFile?: string,
): ReadonlyArray<string> {
  return [
    ...(configFile === undefined ? [] : ["-F", configFile]),
    ...[
      ...SERVER_CONNECTION_OPTIONS,
      "ControlMaster=no",
      "ControlPath=none",
      "ExitOnForwardFailure=yes",
    ].flatMap((option) => ["-o", option]),
    "-T",
    "-W",
    `127.0.0.1:${String(port)}`,
    "-l",
    server.user,
    "--",
    server.alias,
  ];
}

/** Owns listeners and SSH streams only. It never starts a program on the server. */
export class ServerPreviewTunnels {
  readonly #options: ServerPreviewOptions;
  readonly #previews = new Map<string, Preview>();
  readonly #pending = new Set<string>();
  readonly #sweep: ReturnType<typeof setInterval>;
  #closed = false;
  constructor(options: ServerPreviewOptions) {
    this.#options = options;
    this.#sweep = setInterval(() => {
      void this.reconcile();
    }, 1_000);
    this.#sweep.unref();
  }
  read(projectId: string, owner: string): ServerPreviewView | undefined {
    const preview = this.#previews.get(projectId);
    return preview?.owner === owner ? this.#view(preview) : undefined;
  }
  async start(
    projectId: string,
    owner: string,
    remotePort: number,
    localPort: number,
    ownerCurrent: () => boolean = () => this.#options.ownerCurrent(owner),
  ): Promise<ServerPreviewResult> {
    if (this.#closed || !this.#options.ownerCurrent(owner)) return refused("owner-revoked");
    const address = this.#options.address(projectId);
    if (address === undefined) return refused("project-unavailable");
    if (
      !Number.isInteger(remotePort) ||
      remotePort < 1 ||
      remotePort > 65535 ||
      !Number.isInteger(localPort) ||
      localPort < 0 ||
      localPort > 65535
    )
      return refused("invalid-port");
    const existing = this.#previews.get(projectId);
    if (this.#pending.has(projectId) || (existing !== undefined && existing.status !== "stopped"))
      return refused("already-owned");
    if (this.#previews.size >= 64 && existing === undefined) return refused("too-many-tunnels");
    this.#pending.add(projectId);
    const listener = createServer((socket) => this.#accept(projectId, socket));
    try {
      const port = await new Promise<number | undefined>((resolve) => {
        listener.once("error", () => resolve(undefined));
        listener.listen(localPort, "127.0.0.1", () => {
          const bound = listener.address();
          resolve(bound !== null && typeof bound !== "string" ? bound.port : undefined);
        });
      });
      if (port === undefined) return refused("port-unavailable");
      const preview: Preview = {
        projectId,
        owner,
        identity: address.identity,
        server: address.server,
        remotePort,
        localPort: port,
        listener,
        streams: new Map(),
        expiresAt: Date.now() + 60 * 60 * 1_000,
        ownerCurrent,
        status: "listening",
      };
      if (
        !this.#current(preview) ||
        this.#closed ||
        !this.#options.record({ ...this.#view(preview), owner })
      ) {
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        return refused("authority-or-record-unavailable");
      }
      this.#previews.set(projectId, preview);
      return { kind: "tunnel", view: this.#view(preview) };
    } finally {
      this.#pending.delete(projectId);
    }
  }
  async stop(projectId: string, owner: string): Promise<ServerPreviewResult> {
    const preview = this.#previews.get(projectId);
    if (preview?.owner !== owner) return refused("not-owned");
    await this.#end(preview, "stopped");
    return { kind: "tunnel", view: this.#view(preview) };
  }
  async reconnect(projectId: string, owner: string): Promise<ServerPreviewResult> {
    const preview = this.#previews.get(projectId);
    if (preview?.owner !== owner || preview.status !== "lost") return refused("not-reconnectable");
    if (!this.#current(preview)) {
      await this.#end(preview, "revoked");
      return refused("binding-changed");
    }
    // One explicit attempt at the same local and remote addresses. No automatic retry.
    this.#previews.delete(projectId);
    const result = await this.start(
      projectId,
      owner,
      preview.remotePort,
      preview.localPort,
      preview.ownerCurrent,
    );
    if (result.kind === "refused") this.#previews.set(projectId, preview);
    return result;
  }
  async reconcile(): Promise<void> {
    await Promise.all(
      [...this.#previews.values()]
        .filter((preview) => preview.status === "listening" && !this.#current(preview))
        .map((preview) => this.#end(preview, "revoked")),
    );
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#sweep);
    await Promise.all([...this.#previews.values()].map((preview) => this.#end(preview, "stopped")));
  }
  #current(preview: Preview): boolean {
    return (
      preview.ownerCurrent() &&
      this.#options.ownerCurrent(preview.owner) &&
      Date.now() < preview.expiresAt &&
      this.#options.address(preview.projectId)?.identity === preview.identity
    );
  }
  #view(preview: Preview): ServerPreviewView {
    return {
      projectId: preview.projectId,
      remotePort: preview.remotePort,
      localPort: preview.localPort,
      endpoint: `http://127.0.0.1:${String(preview.localPort)}`,
      status: preview.status,
    };
  }
  #accept(projectId: string, socket: Socket): void {
    const preview = this.#previews.get(projectId);
    if (
      preview === undefined ||
      preview.status !== "listening" ||
      !this.#current(preview) ||
      preview.streams.size >= 8
    ) {
      socket.destroy();
      if (preview !== undefined && !this.#current(preview)) void this.#end(preview, "revoked");
      return;
    }
    const child = spawn(
      this.#options.sshPath ?? "ssh",
      [...serverPreviewSshArguments(preview.server, preview.remotePort, this.#options.configFile)],
      {
        env: serverSshEnvironment(process.env, this.#options.agentSocket()),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    preview.streams.set(socket, child);
    // No stderr or page bytes are retained. SSH alone handles trust and authentication.
    child.stderr.resume();
    child.stdin.on("error", () => socket.destroy());
    let clientClosed = false;
    let remoteEnded = false;
    child.stdout.once("end", () => {
      remoteEnded = true;
    });
    const clientEnded = () => {
      if (remoteEnded) return;
      clientClosed = true;
      child.kill("SIGTERM");
    };
    socket.on("error", clientEnded);
    socket.on("close", clientEnded);
    child.on("error", () => {
      void this.#end(preview, "lost");
    });
    child.on("close", (code) => {
      preview.streams.delete(socket);
      socket.destroy();
      if (code !== 0 && !clientClosed && preview.status === "listening")
        void this.#end(preview, "lost");
    });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  }
  async #end(preview: Preview, status: ServerPreviewView["status"]): Promise<void> {
    if (preview.status === status) return;
    preview.status = status;
    const exits = [...preview.streams].map(
      ([socket, child]) =>
        new Promise<void>((resolve) => {
          const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
          force.unref();
          child.once("close", () => {
            clearTimeout(force);
            resolve();
          });
          socket.destroy();
          child.kill("SIGTERM");
        }),
    );
    await Promise.all([
      new Promise<void>((resolve) => preview.listener.close(() => resolve())),
      ...exits,
    ]);
    this.#options.record({ ...this.#view(preview), owner: preview.owner });
  }
}
function refused(reason: string): ServerPreviewResult {
  return { kind: "refused", reason };
}

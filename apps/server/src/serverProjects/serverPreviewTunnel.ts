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
export type ServerPreviewCleanup = { readonly status: "settled" | "unsettled" };

const CLEANUP_WAIT_MS = 3_000;

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
  cleanup?: Promise<void>;
  recordedStatus?: ServerPreviewView["status"];
}

interface PreviewOpening {
  readonly projectId: string;
  readonly owner: string;
  readonly remotePort: number;
  readonly localPort: number;
  readonly server: ServerAddress;
  readonly identity: string;
  readonly ownerCurrent: () => boolean;
  readonly previous: Preview | undefined;
  readonly previousStatus: "stopped" | "lost" | "revoked";
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
  /**
   * The server's process authority clock. A tunnel's hour runs on it, so a
   * wall clock set back cannot keep a tunnel open longer.
   */
  readonly now: () => number;
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
  readonly #pending = new Map<string, Promise<ServerPreviewResult>>();
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
    if (this.#closed || !this.#options.ownerCurrent(owner) || !ownerCurrent())
      return refused("owner-revoked");
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
    // A revoked preview has released its owner (window closed, lifetime
    // expired or binding changed); keeping it would refuse every later start
    // until the host restarts, since only that gone owner could stop it.
    if (
      this.#pending.has(projectId) ||
      (existing !== undefined && existing.status !== "stopped" && existing.status !== "revoked")
    )
      return refused("already-owned");
    if (this.#previews.size >= 64 && existing === undefined) return refused("too-many-tunnels");
    return this.#queueStart({
      projectId,
      owner,
      remotePort,
      localPort,
      ownerCurrent,
      server: address.server,
      identity: address.identity,
      previous: existing,
      previousStatus: existing?.status === "revoked" ? "revoked" : "stopped",
    });
  }
  async stop(projectId: string, owner: string): Promise<ServerPreviewResult> {
    const preview = this.#previews.get(projectId);
    if (preview?.owner !== owner) return refused("not-owned");
    const cleanup = await this.#end(preview, "stopped");
    return cleanup.status === "unsettled"
      ? refused("cleanup-unsettled")
      : { kind: "tunnel", view: this.#view(preview) };
  }
  async reconnect(projectId: string, owner: string): Promise<ServerPreviewResult> {
    const preview = this.#previews.get(projectId);
    if (preview?.owner !== owner || preview.status !== "lost") return refused("not-reconnectable");
    if (!this.#current(preview)) {
      const cleanup = await this.#end(preview, "revoked");
      return refused(cleanup.status === "unsettled" ? "cleanup-unsettled" : "binding-changed");
    }
    // Keep the old ownership visible until its receipt settles and the same
    // endpoint has reopened. Stop can still cancel this pending reconnect.
    return this.#queueStart({
      projectId,
      owner,
      remotePort: preview.remotePort,
      localPort: preview.localPort,
      ownerCurrent: preview.ownerCurrent,
      server: preview.server,
      identity: preview.identity,
      previous: preview,
      previousStatus: "lost",
    });
  }
  async reconcile(): Promise<void> {
    await Promise.all(
      [...this.#previews.values()]
        .filter(
          (preview) =>
            (preview.status === "listening" || preview.status === "lost") &&
            !this.#current(preview),
        )
        .map((preview) => this.#end(preview, "revoked")),
    );
  }
  async close(): Promise<ServerPreviewCleanup> {
    this.#closed = true;
    clearInterval(this.#sweep);
    const [starting, ending] = await Promise.all([
      cleanupWithin(Promise.all(this.#pending.values())),
      Promise.all([...this.#previews.values()].map((preview) => this.#end(preview, "stopped"))),
    ]);
    return {
      status:
        starting.status === "settled" && ending.every((result) => result.status === "settled")
          ? "settled"
          : "unsettled",
    };
  }
  #queueStart(input: PreviewOpening): Promise<ServerPreviewResult> {
    if (this.#closed) return Promise.resolve(refused("owner-revoked"));
    if (this.#pending.has(input.projectId)) return Promise.resolve(refused("already-owned"));
    // Register before listening or awaiting old cleanup, so shutdown owns the
    // whole opening attempt, including a listener not yet in the catalog.
    const opening = Promise.resolve()
      .then(() => this.#open(input))
      .finally(() => {
        this.#pending.delete(input.projectId);
      });
    this.#pending.set(input.projectId, opening);
    return opening;
  }
  async #open(input: PreviewOpening): Promise<ServerPreviewResult> {
    if (input.previous?.cleanup !== undefined) {
      const cleanup = await cleanupWithin(input.previous.cleanup);
      if (cleanup.status === "unsettled") return refused("cleanup-unsettled");
    }
    if (!this.#openingCurrent(input)) return refused("authority-or-record-unavailable");
    const listener = createServer((socket) => this.#accept(input.projectId, socket));
    const port = await new Promise<number | undefined>((resolve) => {
      listener.once("error", () => resolve(undefined));
      listener.listen(input.localPort, "127.0.0.1", () => {
        const bound = listener.address();
        resolve(bound !== null && typeof bound !== "string" ? bound.port : undefined);
      });
    });
    if (port === undefined) return refused("port-unavailable");
    const preview: Preview = {
      projectId: input.projectId,
      owner: input.owner,
      identity: input.identity,
      server: input.server,
      remotePort: input.remotePort,
      localPort: port,
      listener,
      streams: new Map(),
      expiresAt: this.#options.now() + 60 * 60 * 1_000,
      ownerCurrent: input.ownerCurrent,
      status: "listening",
    };
    if (
      !this.#openingCurrent(input) ||
      !this.#options.record({ ...this.#view(preview), owner: input.owner })
    ) {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      return refused("authority-or-record-unavailable");
    }
    this.#previews.set(input.projectId, preview);
    return { kind: "tunnel", view: this.#view(preview) };
  }
  #openingCurrent(input: PreviewOpening): boolean {
    return (
      !this.#closed &&
      this.#options.ownerCurrent(input.owner) &&
      input.ownerCurrent() &&
      this.#options.address(input.projectId)?.identity === input.identity &&
      (input.previous === undefined ||
        (this.#previews.get(input.projectId) === input.previous &&
          input.previous.status === input.previousStatus))
    );
  }
  #current(preview: Preview): boolean {
    return (
      preview.ownerCurrent() &&
      this.#options.ownerCurrent(preview.owner) &&
      this.#options.now() < preview.expiresAt &&
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
      if (preview.status === "listening") void this.#end(preview, "lost");
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
  async #end(preview: Preview, status: ServerPreviewView["status"]): Promise<ServerPreviewCleanup> {
    preview.status = status;
    // A status change is not a cleanup receipt. Retain actual settlement even
    // when a caller times out, so another stop, restart or shutdown must await it.
    preview.cleanup ??= Promise.resolve().then(() => this.#cleanup(preview));
    const cleanup = await cleanupWithin(preview.cleanup);
    if (cleanup.status === "settled" && preview.recordedStatus !== preview.status) {
      if (this.#options.record({ ...this.#view(preview), owner: preview.owner })) {
        preview.recordedStatus = preview.status;
      }
    }
    return cleanup;
  }
  async #cleanup(preview: Preview): Promise<void> {
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
  }
}
function refused(reason: string): ServerPreviewResult {
  return { kind: "refused", reason };
}

/** A deadline reports uncertainty; it never releases the retained resource receipt. */
async function cleanupWithin(settlement: Promise<unknown>): Promise<ServerPreviewCleanup> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settlement.then(
        (): ServerPreviewCleanup => ({ status: "settled" }),
        (): ServerPreviewCleanup => ({ status: "unsettled" }),
      ),
      new Promise<ServerPreviewCleanup>((resolve) => {
        timer = setTimeout(() => resolve({ status: "unsettled" }), CLEANUP_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

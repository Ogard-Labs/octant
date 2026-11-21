import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import {
  decodeRemoteServerGrantId,
  type EventActor,
  type RemoteServerGrantId,
} from "@octant/contracts";
import type { ServerPortForwardCloseReason } from "@octant/contracts/server-projects";
import type { RelayUpstreamStream } from "../remote/remoteServerProxyRelay";
import {
  pinnedHostKeyOptions,
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
  readonly grantId?: RemoteServerGrantId;
}
export type ServerPreviewResult =
  | { readonly kind: "tunnel"; readonly view: ServerPreviewView }
  | { readonly kind: "refused"; readonly reason: string };
export type ServerPreviewCleanup = { readonly status: "settled" | "unsettled" };

/**
 * A forward of one TCP port on the server's loopback to this computer's
 * `127.0.0.1`. It is the preview's raw relay without its browser link: the
 * same streams, owner, hour and binding checks, journaled with the ports alone.
 */
export interface ServerPortForwardView {
  readonly projectId: string;
  readonly remotePort: number;
  readonly localPort: number;
  readonly status: ServerPreviewView["status"];
}
export type ServerPortForwardResult =
  | { readonly kind: "forward"; readonly view: ServerPortForwardView }
  | Refusal;
export type ServerPortForwardRecord = {
  readonly projectId: string;
  readonly remotePort: number;
  readonly localPort: number;
} & (
  | { readonly event: "opened" }
  | { readonly event: "closed"; readonly reason: ServerPortForwardCloseReason }
);

type Refusal = { readonly kind: "refused"; readonly reason: string };
/** A tunnel this class holds, before it is shown as a preview or a forward. */
type Held = { readonly kind: "held"; readonly preview: Preview } | Refusal;
type TunnelKind = "preview" | "forward";

export interface ServerPreviewDevicePrincipal {
  readonly kind: "person-paired-device";
  readonly credentialGeneration: number;
  readonly actor: EventActor;
}

export type ServerPreviewRelayStreamResult =
  | {
      readonly kind: "opened";
      readonly stream: RelayUpstreamStream;
      readonly port: number;
      readonly onActivity: () => void;
    }
  | { readonly kind: "refused"; readonly reason: "grant-closed" | "server-unreachable" | "busy" };

const CLEANUP_WAIT_MS = 3_000;
const DEVICE_PREVIEW_QUIET_MS = 60_000;

interface PreviewDeviceOwnership {
  readonly credentialGeneration: number;
  readonly sessionId: string;
  readonly actor: EventActor;
  lastSeenMs: number;
}

interface Preview {
  readonly kind: TunnelKind;
  readonly projectId: string;
  readonly owner: string;
  readonly identity: string;
  readonly server: ServerAddress;
  readonly remotePort: number;
  readonly localPort: number;
  readonly listener: Server | undefined;
  readonly grantId: RemoteServerGrantId | undefined;
  readonly device: PreviewDeviceOwnership | undefined;
  readonly streams: Map<Duplex, ChildProcessWithoutNullStreams>;
  readonly expiresAt: number;
  readonly ownerCurrent: () => boolean;
  status: ServerPreviewView["status"];
  cleanup?: Promise<void>;
  recordedStatus?: ServerPreviewView["status"];
}

interface PreviewOpening {
  readonly kind: TunnelKind;
  readonly projectId: string;
  readonly owner: string;
  readonly remotePort: number;
  readonly localPort: number;
  readonly server: ServerAddress;
  readonly identity: string;
  readonly ownerCurrent: () => boolean;
  readonly previous: Preview | undefined;
  readonly previousStatus: "stopped" | "lost" | "revoked";
  readonly relayed?: {
    readonly grantId?: RemoteServerGrantId;
    readonly device: PreviewDeviceOwnership;
  };
}
export interface ServerPreviewOptions {
  readonly address: (
    projectId: string,
  ) => { readonly server: ServerAddress; readonly identity: string } | undefined;
  readonly ownerCurrent: (owner: string) => boolean;
  readonly agentSocket: () => string | undefined;
  readonly record: (
    record: ServerPreviewView & { readonly owner: string },
    principal?: ServerPreviewDevicePrincipal,
  ) => boolean;
  /** Journals a port forward's opening and closing; with none, no forward opens. */
  readonly recordForward?: (record: ServerPortForwardRecord) => boolean;
  readonly sshPath?: string;
  readonly configFile?: string;
  /** Why no stream may go to a server now, such as its machine being suspended. */
  readonly refuses?: (server: ServerAddress) => string | undefined;
  /** The known hosts file holding a server's pinned keys, when the host pinned any. */
  readonly pinnedKnownHosts?: (server: ServerAddress) => string | undefined;
  /** How long a device-owned preview stays open with no poll or relayed traffic; 60s by default. */
  readonly deviceQuietMs?: number;
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
  pinnedKnownHosts?: string,
): ReadonlyArray<string> {
  return [
    ...(configFile === undefined ? [] : ["-F", configFile]),
    ...[
      ...SERVER_CONNECTION_OPTIONS,
      ...pinnedHostKeyOptions(pinnedKnownHosts),
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

/** A Project's preview and its forward are held apart, so both can be open at once. */
function tunnelKey(kind: TunnelKind, projectId: string): string {
  return kind === "forward" ? `forward:${projectId}` : projectId;
}

/** Owns listeners and SSH streams only. It never starts a program on the server. */
export class ServerPreviewTunnels {
  readonly #options: ServerPreviewOptions;
  readonly #previews = new Map<string, Preview>();
  readonly #pending = new Map<string, Promise<Held>>();
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
    if (preview?.owner !== owner) return undefined;
    if (preview.device !== undefined) preview.device.lastSeenMs = this.#options.now();
    return this.#view(preview);
  }
  hasRelayGrant(grantId: string): boolean {
    for (const preview of this.#previews.values()) {
      if (preview.grantId !== undefined && String(preview.grantId) === grantId) return true;
    }
    return false;
  }
  /**
   * Open one dedicated SSH stdio stream (`ssh -W 127.0.0.1:<remotePort>`) for
   * a paired device's relayed preview request under `/api/server-proxy/<grantId>/`.
   */
  openRelayStream(
    grantId: string,
    principal: {
      readonly deviceId: string;
      readonly credentialGeneration: number;
      readonly admittedBy?: "host-person" | "hub-roster";
    },
  ): ServerPreviewRelayStreamResult {
    if (principal.admittedBy !== "host-person") {
      return { kind: "refused", reason: "grant-closed" };
    }
    let matched: Preview | undefined;
    for (const candidate of this.#previews.values()) {
      if (candidate.grantId !== undefined && String(candidate.grantId) === grantId) {
        matched = candidate;
        break;
      }
    }
    if (
      matched === undefined ||
      matched.device === undefined ||
      matched.owner !== principal.deviceId ||
      matched.device.credentialGeneration !== principal.credentialGeneration ||
      matched.status !== "listening"
    ) {
      return { kind: "refused", reason: "grant-closed" };
    }
    if (!this.#current(matched)) {
      void this.#end(matched, "revoked");
      return { kind: "refused", reason: "grant-closed" };
    }
    if (this.#options.refuses?.(matched.server) !== undefined) {
      return { kind: "refused", reason: "server-unreachable" };
    }
    if (matched.streams.size >= 8) {
      return { kind: "refused", reason: "busy" };
    }
    matched.device.lastSeenMs = this.#options.now();
    const preview = matched;
    const child = spawn(
      this.#options.sshPath ?? "ssh",
      [
        ...serverPreviewSshArguments(
          preview.server,
          preview.remotePort,
          this.#options.configFile,
          this.#options.pinnedKnownHosts?.(preview.server),
        ),
      ],
      {
        env: serverSshEnvironment(process.env, this.#options.agentSocket()),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stream = new SshStdioDuplex(child, () => {
      if (preview.device !== undefined) preview.device.lastSeenMs = this.#options.now();
    });
    preview.streams.set(stream, child);
    child.stderr.resume();
    let clientClosed = false;
    stream.once("close", () => {
      clientClosed = true;
      child.kill("SIGTERM");
    });
    child.on("error", () => {
      preview.streams.delete(stream);
      stream.destroy();
      if (preview.status === "listening") void this.#end(preview, "lost");
    });
    child.on("close", (code) => {
      preview.streams.delete(stream);
      if (!stream.destroyed) stream.destroy();
      if (code !== 0 && !clientClosed && preview.status === "listening") {
        void this.#end(preview, "lost");
      }
    });
    return {
      kind: "opened",
      stream,
      port: preview.remotePort,
      onActivity: () => {
        if (preview.device !== undefined) preview.device.lastSeenMs = this.#options.now();
      },
    };
  }
  async startRelayed(input: {
    readonly projectId: string;
    readonly owner: string;
    readonly remotePort: number;
    readonly credentialGeneration: number;
    readonly sessionId: string;
    readonly actor: EventActor;
    readonly ownerCurrent: () => boolean;
  }): Promise<ServerPreviewResult> {
    if (this.#closed || !input.ownerCurrent()) return refused("owner-revoked");
    const address = this.#options.address(input.projectId);
    if (address === undefined) return refused("project-unavailable");
    if (!Number.isInteger(input.remotePort) || input.remotePort < 1 || input.remotePort > 65535) {
      return refused("invalid-port");
    }
    const existing = this.#previews.get(input.projectId);
    if (
      this.#pending.has(input.projectId) ||
      (existing !== undefined && existing.status !== "stopped" && existing.status !== "revoked")
    ) {
      return refused("already-owned");
    }
    if (this.#previews.size >= 64 && existing === undefined) return refused("too-many-tunnels");
    return this.#previewResult(
      await this.#queueStart({
        kind: "preview",
        projectId: input.projectId,
        owner: input.owner,
        remotePort: input.remotePort,
        localPort: 0,
        ownerCurrent: input.ownerCurrent,
        server: address.server,
        identity: address.identity,
        previous: existing,
        previousStatus: existing?.status === "revoked" ? "revoked" : "stopped",
        relayed: {
          device: {
            credentialGeneration: input.credentialGeneration,
            sessionId: input.sessionId,
            actor: input.actor,
            lastSeenMs: this.#options.now(),
          },
        },
      }),
    );
  }
  async start(
    projectId: string,
    owner: string,
    remotePort: number,
    localPort: number,
    ownerCurrent: () => boolean = () => this.#options.ownerCurrent(owner),
  ): Promise<ServerPreviewResult> {
    return this.#previewResult(
      await this.#startOwned("preview", projectId, owner, remotePort, localPort, ownerCurrent),
    );
  }
  /**
   * Forwards one TCP port on the server's loopback to this computer's
   * `127.0.0.1`, on the same port number when it is free and another free one
   * otherwise. Only a local window's caller reaches this.
   */
  async startForward(
    projectId: string,
    owner: string,
    remotePort: number,
    ownerCurrent: () => boolean = () => this.#options.ownerCurrent(owner),
  ): Promise<ServerPortForwardResult> {
    if (this.#options.recordForward === undefined) return refused("forward-unavailable");
    return this.#forwardResult(
      await this.#startOwned("forward", projectId, owner, remotePort, remotePort, ownerCurrent),
    );
  }
  readForward(projectId: string, owner: string): ServerPortForwardView | undefined {
    const forward = this.#previews.get(tunnelKey("forward", projectId));
    return forward?.owner === owner ? forwardView(forward) : undefined;
  }
  async stopForward(projectId: string, owner: string): Promise<ServerPortForwardResult> {
    return this.#forwardResult(await this.#stopOwned(tunnelKey("forward", projectId), owner));
  }
  async #startOwned(
    kind: TunnelKind,
    projectId: string,
    owner: string,
    remotePort: number,
    localPort: number,
    ownerCurrent: () => boolean,
  ): Promise<Held> {
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
    const key = tunnelKey(kind, projectId);
    const existing = this.#previews.get(key);
    // A revoked preview has released its owner (window closed, lifetime
    // expired or binding changed); keeping it would refuse every later start
    // until the host restarts, since only that gone owner could stop it.
    if (
      this.#pending.has(key) ||
      (existing !== undefined && existing.status !== "stopped" && existing.status !== "revoked")
    )
      return refused("already-owned");
    if (this.#previews.size >= 64 && existing === undefined) return refused("too-many-tunnels");
    return this.#queueStart({
      kind,
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
    return this.#previewResult(await this.#stopOwned(tunnelKey("preview", projectId), owner));
  }
  async #stopOwned(key: string, owner: string): Promise<Held> {
    const preview = this.#previews.get(key);
    if (preview?.owner !== owner) return refused("not-owned");
    if (preview.device !== undefined) preview.device.lastSeenMs = this.#options.now();
    const cleanup = await this.#end(preview, "stopped");
    return cleanup.status === "unsettled"
      ? refused("cleanup-unsettled")
      : { kind: "held", preview };
  }
  #previewResult(held: Held): ServerPreviewResult {
    return held.kind === "held" ? { kind: "tunnel", view: this.#view(held.preview) } : held;
  }
  #forwardResult(held: Held): ServerPortForwardResult {
    return held.kind === "held" ? { kind: "forward", view: forwardView(held.preview) } : held;
  }
  async reconnect(projectId: string, owner: string): Promise<ServerPreviewResult> {
    const preview = this.#previews.get(projectId);
    if (preview?.owner !== owner || preview.status !== "lost") return refused("not-reconnectable");
    if (preview.device !== undefined) preview.device.lastSeenMs = this.#options.now();
    if (!this.#current(preview)) {
      const cleanup = await this.#end(preview, "revoked");
      return refused(cleanup.status === "unsettled" ? "cleanup-unsettled" : "binding-changed");
    }
    // Keep the old ownership visible until its receipt settles and the same
    // endpoint has reopened. Stop can still cancel this pending reconnect.
    return this.#previewResult(
      await this.#queueStart({
        kind: "preview",
        projectId,
        owner,
        remotePort: preview.remotePort,
        localPort: preview.localPort,
        ownerCurrent: preview.ownerCurrent,
        server: preview.server,
        identity: preview.identity,
        previous: preview,
        previousStatus: "lost",
        ...(preview.device === undefined
          ? {}
          : {
              relayed: {
                ...(preview.grantId === undefined ? {} : { grantId: preview.grantId }),
                device: { ...preview.device, lastSeenMs: this.#options.now() },
              },
            }),
      }),
    );
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
  #queueStart(input: PreviewOpening): Promise<Held> {
    const key = tunnelKey(input.kind, input.projectId);
    if (this.#closed) return Promise.resolve(refused("owner-revoked"));
    if (this.#pending.has(key)) return Promise.resolve(refused("already-owned"));
    // Register before listening or awaiting old cleanup, so shutdown owns the
    // whole opening attempt, including a listener not yet in the catalog.
    const opening = Promise.resolve()
      .then(() => this.#open(input))
      .finally(() => {
        this.#pending.delete(key);
      });
    this.#pending.set(key, opening);
    return opening;
  }
  async #open(input: PreviewOpening): Promise<Held> {
    const key = tunnelKey(input.kind, input.projectId);
    if (input.previous?.cleanup !== undefined) {
      const cleanup = await cleanupWithin(input.previous.cleanup);
      if (cleanup.status === "unsettled") return refused("cleanup-unsettled");
    }
    if (!this.#openingCurrent(input)) return refused("authority-or-record-unavailable");
    // Checked here, after any old cleanup, so a start and a reconnect both
    // refuse a suspended machine before they listen.
    if (this.#options.refuses?.(input.server) !== undefined) return refused("machine-suspended");
    if (input.relayed !== undefined) {
      const grantId =
        input.relayed.grantId ??
        decodeRemoteServerGrantId(`rsg_${randomBytes(32).toString("hex")}`);
      const preview: Preview = {
        kind: input.kind,
        projectId: input.projectId,
        owner: input.owner,
        identity: input.identity,
        server: input.server,
        remotePort: input.remotePort,
        localPort: 0,
        listener: undefined,
        grantId,
        device: input.relayed.device,
        streams: new Map(),
        expiresAt: this.#options.now() + 60 * 60 * 1_000,
        ownerCurrent: input.ownerCurrent,
        status: "listening",
      };
      if (
        !this.#openingCurrent(input) ||
        !this.#options.record(
          { ...this.#view(preview), owner: input.owner },
          {
            kind: "person-paired-device",
            credentialGeneration: input.relayed.device.credentialGeneration,
            actor: input.relayed.device.actor,
          },
        )
      ) {
        return refused("authority-or-record-unavailable");
      }
      this.#previews.set(key, preview);
      return { kind: "held", preview };
    }
    let listener = createServer((socket) => this.#accept(key, socket));
    let port = await listenOnLoopback(listener, input.localPort);
    if (port === undefined && input.kind === "forward") {
      // A forward takes the server's port number when this computer has it
      // free, as a forward from another Octant computer does, else any free one.
      listener = createServer((socket) => this.#accept(key, socket));
      port = await listenOnLoopback(listener, 0);
    }
    if (port === undefined) return refused("port-unavailable");
    const bound = listener;
    const preview: Preview = {
      kind: input.kind,
      projectId: input.projectId,
      owner: input.owner,
      identity: input.identity,
      server: input.server,
      remotePort: input.remotePort,
      localPort: port,
      listener: bound,
      grantId: undefined,
      device: undefined,
      streams: new Map(),
      expiresAt: this.#options.now() + 60 * 60 * 1_000,
      ownerCurrent: input.ownerCurrent,
      status: "listening",
    };
    if (!this.#openingCurrent(input) || !this.#recordOpened(preview)) {
      await new Promise<void>((resolve) => bound.close(() => resolve()));
      return refused("authority-or-record-unavailable");
    }
    this.#previews.set(key, preview);
    return { kind: "held", preview };
  }
  #recordOpened(preview: Preview): boolean {
    if (preview.kind === "preview") {
      return this.#options.record({ ...this.#view(preview), owner: preview.owner });
    }
    if (this.#options.recordForward?.({ event: "opened", ...forwardPorts(preview) }) !== true) {
      return false;
    }
    preview.recordedStatus = "listening";
    return true;
  }
  #openingCurrent(input: PreviewOpening): boolean {
    const ownerOk =
      input.relayed !== undefined
        ? input.ownerCurrent()
        : this.#options.ownerCurrent(input.owner) && input.ownerCurrent();
    return (
      !this.#closed &&
      ownerOk &&
      this.#options.address(input.projectId)?.identity === input.identity &&
      (input.previous === undefined ||
        (this.#previews.get(tunnelKey(input.kind, input.projectId)) === input.previous &&
          input.previous.status === input.previousStatus))
    );
  }
  #current(preview: Preview): boolean {
    const now = this.#options.now();
    const quietLimit = this.#options.deviceQuietMs ?? DEVICE_PREVIEW_QUIET_MS;
    const ownerOk =
      preview.device !== undefined
        ? preview.ownerCurrent() && now - preview.device.lastSeenMs <= quietLimit
        : preview.ownerCurrent() && this.#options.ownerCurrent(preview.owner);
    return (
      ownerOk &&
      now < preview.expiresAt &&
      this.#options.address(preview.projectId)?.identity === preview.identity
    );
  }
  #view(preview: Preview): ServerPreviewView {
    return {
      projectId: preview.projectId,
      remotePort: preview.remotePort,
      localPort: preview.localPort,
      endpoint:
        preview.grantId !== undefined
          ? `/api/server-proxy/${String(preview.grantId)}/`
          : `http://127.0.0.1:${String(preview.localPort)}`,
      status: preview.status,
      ...(preview.grantId === undefined ? {} : { grantId: preview.grantId }),
    };
  }
  #accept(key: string, socket: Socket): void {
    const preview = this.#previews.get(key);
    if (
      preview === undefined ||
      preview.status !== "listening" ||
      !this.#current(preview) ||
      preview.streams.size >= 8 ||
      // Each stream spawns ssh itself, so the refusal a call gets applies here too.
      this.#options.refuses?.(preview.server) !== undefined
    ) {
      socket.destroy();
      if (preview !== undefined && !this.#current(preview)) void this.#end(preview, "revoked");
      return;
    }
    const child = spawn(
      this.#options.sshPath ?? "ssh",
      [
        ...serverPreviewSshArguments(
          preview.server,
          preview.remotePort,
          this.#options.configFile,
          this.#options.pinnedKnownHosts?.(preview.server),
        ),
      ],
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
    if (preview.kind === "forward") {
      // A forward is journaled closed once, however its status changes after.
      if (
        cleanup.status === "settled" &&
        preview.recordedStatus !== preview.status &&
        (preview.recordedStatus !== "listening" ||
          this.#options.recordForward?.({
            event: "closed",
            ...forwardPorts(preview),
            reason: this.#forwardCloseReason(preview),
          }) === true)
      ) {
        preview.recordedStatus = preview.status;
      }
      return cleanup;
    }
    if (cleanup.status === "settled" && preview.recordedStatus !== preview.status) {
      const devicePrincipal: ServerPreviewDevicePrincipal | undefined =
        preview.device === undefined
          ? undefined
          : {
              kind: "person-paired-device",
              credentialGeneration: preview.device.credentialGeneration,
              actor: preview.device.actor,
            };
      if (this.#options.record({ ...this.#view(preview), owner: preview.owner }, devicePrincipal)) {
        preview.recordedStatus = preview.status;
      }
    }
    return cleanup;
  }
  #forwardCloseReason(preview: Preview): ServerPortForwardCloseReason {
    if (preview.status === "lost") return "lost";
    if (preview.status === "stopped") return this.#closed ? "host-stopped" : "stopped";
    return this.#options.now() >= preview.expiresAt ? "expired" : "revoked";
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
      preview.listener === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve) => preview.listener?.close(() => resolve())),
      ...exits,
    ]);
  }
}

/**
 * Wraps one `ssh -W 127.0.0.1:<port>` child's stdin/stdout as a Duplex stream
 * compatible with `http.request` and `WebSocketEndpoint`, so a paired device's
 * server Project preview rides the private listener's existing relay without
 * opening a loopback listener on this host.
 */
class SshStdioDuplex extends Duplex {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #onActivity: () => void;
  #timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  #timeoutMs = 0;
  #timeoutCallback: (() => void) | undefined;

  constructor(child: ChildProcessWithoutNullStreams, onActivity: () => void) {
    super();
    this.#child = child;
    this.#onActivity = onActivity;
    child.stdout.on("data", (chunk: Buffer) => {
      this.#touch();
      if (!this.push(chunk)) child.stdout.pause();
    });
    child.stdout.on("end", () => {
      this.push(null);
    });
    child.stdout.on("error", (error) => {
      this.destroy(error);
    });
    child.stdin.on("error", (error) => {
      if (!this.destroyed) this.destroy(error);
    });
  }

  setNoDelay(_noDelay?: boolean): this {
    return this;
  }

  setTimeout(timeout: number, callback?: () => void): this {
    this.#clearTimeout();
    this.#timeoutMs = timeout;
    this.#timeoutCallback = callback;
    if (timeout > 0) this.#armTimeout();
    return this;
  }

  override _read(_size: number): void {
    this.#child.stdout.resume();
  }

  override _write(
    chunk: Buffer | Uint8Array | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#touch();
    if (this.#child.stdin.destroyed) {
      callback(new Error("SSH preview stream closed."));
      return;
    }
    this.#child.stdin.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#child.stdin.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#clearTimeout();
    this.#child.stdout.destroy();
    this.#child.stdin.destroy();
    callback(error);
  }

  #touch(): void {
    this.#onActivity();
    if (this.#timeoutMs > 0) this.#armTimeout();
  }

  #armTimeout(): void {
    this.#clearTimeout();
    this.#timeoutTimer = setTimeout(() => {
      this.#timeoutCallback?.();
      this.emit("timeout");
    }, this.#timeoutMs);
    this.#timeoutTimer.unref?.();
  }

  #clearTimeout(): void {
    if (this.#timeoutTimer !== undefined) {
      clearTimeout(this.#timeoutTimer);
      this.#timeoutTimer = undefined;
    }
  }
}
function refused(reason: string): Refusal {
  return { kind: "refused", reason };
}

function forwardPorts(preview: Preview): {
  readonly projectId: string;
  readonly remotePort: number;
  readonly localPort: number;
} {
  return {
    projectId: preview.projectId,
    remotePort: preview.remotePort,
    localPort: preview.localPort,
  };
}

function forwardView(preview: Preview): ServerPortForwardView {
  return { ...forwardPorts(preview), status: preview.status };
}

/** Listens on `127.0.0.1` alone; the port it took, or none when it is taken. */
function listenOnLoopback(listener: Server, port: number): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve) => {
    listener.once("error", () => resolve(undefined));
    listener.listen(port, "127.0.0.1", () => {
      const bound = listener.address();
      resolve(bound !== null && typeof bound !== "string" ? bound.port : undefined);
    });
  });
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

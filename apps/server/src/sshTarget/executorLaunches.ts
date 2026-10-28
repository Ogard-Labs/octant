import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { connect as netConnect, createServer, isIP, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Schema } from "effect";
import {
  SSH_EXECUTOR_MAX_COMMAND_OUTPUT_BYTES,
  SSH_EXECUTOR_MAX_PLACED_PROCESSES,
  SshEgressAddress,
  type SshExecutorCommandRanReply,
  type SshExecutorDialFrame,
  type SshExecutorFrame,
  type SshExecutorResolveFrame,
  type SshExecutorRunCommandRequest,
  type SshExecutorStreamFrame,
} from "@octant/contracts/ssh-executor-protocol";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { MACOS_GIT_SHIM_READ_PATHS } from "../process/gitSeatbeltLaunch";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import type { EgressProxyEndpoint } from "../process/threadEgressPolicy";
import { postureGrants } from "./executorAttestation";
import { listenForLaunchToken } from "./executorLoopbackForwarder";
import { ExecutorStreams, joinToStream, type ExecutorStream } from "./executorStreams";

/**
 * The executor's launches of native-harness commands, and the egress of a
 * proxied one. Canonical: docs/design/remote-ssh-environments.md § Native
 * harness on a target.
 *
 * A command runs as a local harness command does: `/bin/sh` and a script the
 * executor wrote in its own owner-only script directory, through the same
 * owned-process-group port, confined by this build's ProcessConfinementPort
 * with the grants its posture's canaries attested. Its environment is built
 * here on the target; nothing of the host's crosses.
 *
 * A proxied launch, a command or a placed process, reaches only its own
 * forwarder. On Linux that is a Unix socket in a fresh owner-only directory of
 * this session's, which the capsule's own forwarder relays to. On macOS,
 * where Seatbelt can name only a `localhost` port, it is a loopback listener
 * on a random port that admits only connections presenting the launch's
 * egress token (`executorLoopbackForwarder.ts`). Each connection it admits
 * becomes a stream to the host that names the launch, where that launch's own
 * egress proxy decides and journals it. The host answers by asking this
 * executor to resolve a name and to open a connection to an address it
 * checked; the executor does both only while a proxied launch runs.
 */

/** The most connections one launch holds open to its forwarder, as its proxy allows. */
const MAX_FORWARDED_CONNECTIONS = 144;
/** The most connections the host's proxies may have the target open at once. */
export const MAX_DIALED_CONNECTIONS = 144;
/** A command and every placed process may be proxied at once. */
const MAX_PROXIED_LAUNCHES = 1 + SSH_EXECUTOR_MAX_PLACED_PROCESSES;
const RESOLVE_TIMEOUT_MS = 10_000;
/** The longest Unix socket path the kernel takes, without its terminating zero. */
const MAX_SOCKET_PATH_BYTES = 107;
const DIAL_TIMEOUT_MS = 10_000;
const isEgressAddress = Schema.is(SshEgressAddress);

export interface ExecutorLaunchEnvironment {
  readonly platform: NodeJS.Platform;
  /** This session's owner-only directory; without it no command runs. */
  readonly sessionDirectory: string | undefined;
  readonly confinement?: ProcessConfinementPort;
  readonly bwrapPath?: string;
}

const unavailable: SshExecutorCommandRanReply = {
  kind: "command-ran",
  termination: "unavailable",
  stdout: "",
  stderr: "",
};

interface ProxiedLaunch {
  /** Stops the forwarder listening and removes what it left on disk. */
  readonly close: () => void;
  readonly forwarded: Set<ExecutorStream>;
}

/**
 * The egress of every proxied launch running now, a command and the placed
 * processes: each launch's forwarder and the streams it carries, and the
 * target connections the host asked for.
 */
export class ExecutorEgress {
  readonly #send: (frame: SshExecutorFrame) => void;
  readonly #platform: NodeJS.Platform;
  readonly #forwarded: ExecutorStreams;
  readonly #hostOpened: ExecutorStreams;
  readonly #launches = new Map<number, ProxiedLaunch>();
  readonly #dialed = new Set<ExecutorStream>();

  /**
   * `hostOpened` is the session's one registry of the streams the host opens
   * (even ids): the connections its proxies ask for here, and the placed
   * processes' streams, so an id is never new twice.
   */
  constructor(
    send: (frame: SshExecutorFrame) => void,
    hostOpened: ExecutorStreams,
    platform: NodeJS.Platform,
  ) {
    this.#send = send;
    this.#platform = platform;
    this.#hostOpened = hostOpened;
    this.#forwarded = new ExecutorStreams({
      send,
      opens: "odd",
      maxStreams: MAX_FORWARDED_CONNECTIONS * MAX_PROXIED_LAUNCHES,
    });
  }

  /**
   * Opens the forwarder for proxied launch `launch` (its request id), or
   * undefined when it cannot listen. `token` is the launch's egress token,
   * which a macOS forwarder requires of every connection.
   */
  async open(
    sessionDirectory: string,
    launch: number,
    token: string,
  ): Promise<EgressProxyEndpoint | undefined> {
    if (this.#launches.has(launch) || this.#launches.size >= MAX_PROXIED_LAUNCHES) {
      return undefined;
    }
    return this.#platform === "darwin"
      ? this.#openLoopback(launch, token)
      : this.#openUnixSocket(sessionDirectory, launch);
  }

  async #openLoopback(launch: number, token: string): Promise<EgressProxyEndpoint | undefined> {
    const forwarder = await listenForLaunchToken(token, (socket, received) =>
      this.#forward(socket, launch, received),
    );
    if (forwarder === undefined) return undefined;
    if (this.#launches.has(launch)) {
      forwarder.close();
      return undefined;
    }
    this.#launches.set(launch, { close: () => forwarder.close(), forwarded: new Set() });
    return { kind: "loopback", port: forwarder.port };
  }

  async #openUnixSocket(
    sessionDirectory: string,
    launch: number,
  ): Promise<EgressProxyEndpoint | undefined> {
    let directory: string;
    try {
      directory = mkdtempSync(join(sessionDirectory, "e-"));
      chmodSync(directory, 0o700);
    } catch {
      return undefined;
    }
    const path = join(directory, "s");
    // Node binds a longer socket path cut short without a word, and the
    // forwarder would then connect to a name nothing listens on.
    if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
      rmSync(directory, { recursive: true, force: true });
      return undefined;
    }
    const server: Server = createServer({ allowHalfOpen: true }, (socket) =>
      this.#forward(socket, launch, undefined),
    );
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen({ path, exclusive: true }, () => resolve(true));
    });
    if (!listening || this.#launches.has(launch)) {
      server.close();
      rmSync(directory, { recursive: true, force: true });
      return undefined;
    }
    this.#launches.set(launch, {
      close: () => {
        server.close();
        rmSync(directory, { recursive: true, force: true });
      },
      forwarded: new Set(),
    });
    return { kind: "unix-socket", path };
  }

  /**
   * Ends one launch's egress: its forwarder and every connection it
   * forwarded close. Once no proxied launch runs, the connections the host
   * asked for close too.
   */
  close(launch: number): void {
    const entry = this.#launches.get(launch);
    this.#launches.delete(launch);
    if (entry !== undefined) {
      for (const stream of entry.forwarded) stream.destroy();
      entry.close();
    }
    if (this.#launches.size === 0) {
      for (const stream of this.#dialed) stream.destroy();
    }
  }

  /** The session is gone: everything closes without a word to the host. */
  abandon(): void {
    this.#forwarded.abandonAll();
    for (const stream of this.#dialed) stream.abandon();
    for (const entry of this.#launches.values()) entry.close();
    this.#launches.clear();
  }

  receive(
    frame: SshExecutorDialFrame | SshExecutorResolveFrame | SshExecutorStreamFrame,
  ): "accepted" | "violated" {
    switch (frame.type) {
      case "dial":
        return this.#dial(frame);
      case "resolve":
        void this.#resolve(frame);
        return "accepted";
      default:
        return (frame.stream % 2 === 1 ? this.#forwarded : this.#hostOpened).receive(frame);
    }
  }

  /** `received` is what a macOS forwarder already read while it checked the token. */
  #forward(socket: Socket, launch: number, received: Buffer | undefined): void {
    socket.on("error", () => socket.destroy());
    const entry = this.#launches.get(launch);
    const stream =
      entry === undefined || entry.forwarded.size >= MAX_FORWARDED_CONNECTIONS
        ? undefined
        : this.#forwarded.open();
    if (entry === undefined || stream === undefined) {
      socket.destroy();
      return;
    }
    entry.forwarded.add(stream);
    stream.once("close", () => entry.forwarded.delete(stream));
    this.#send({ type: "stream-open", stream: stream.id, launch });
    if (received !== undefined) stream.write(received);
    joinToStream(socket, stream);
  }

  #dial(frame: SshExecutorDialFrame): "accepted" | "violated" {
    const stream =
      this.#dialed.size >= MAX_DIALED_CONNECTIONS ? "full" : this.#hostOpened.adopt(frame.stream);
    if (stream === "violated") return "violated";
    if (stream === "full") {
      // Past the limit the id is still the host's next, so it is taken and
      // closed rather than left for a later frame to reuse.
      const taken = this.#hostOpened.adopt(frame.stream);
      if (taken === "violated") return "violated";
      if (taken !== "refused") taken.destroy();
      return "accepted";
    }
    if (stream === "refused") return "accepted";
    this.#dialed.add(stream);
    stream.once("close", () => this.#dialed.delete(stream));
    // Only an address, never a name: the host's proxy checked this address,
    // and a lookup here could answer differently.
    if (this.#launches.size === 0 || isIP(frame.address) === 0) {
      this.#send({ type: "dialed", stream: frame.stream, connected: false });
      stream.destroy();
      return "accepted";
    }
    const socket = netConnect({
      host: frame.address,
      port: frame.port,
      allowHalfOpen: true,
      lookup: (_hostname, _options, callback) =>
        callback(new Error("the executor never resolves at connect"), "", 0),
    });
    let settled = false;
    const timer = setTimeout(() => fail(), DIAL_TIMEOUT_MS);
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      this.#send({ type: "dialed", stream: frame.stream, connected: false });
      stream.destroy();
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", fail);
      socket.on("error", () => socket.destroy());
      if (stream.destroyed) {
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);
      this.#send({ type: "dialed", stream: frame.stream, connected: true });
      joinToStream(socket, stream);
    });
    return "accepted";
  }

  async #resolve(frame: SshExecutorResolveFrame): Promise<void> {
    let addresses: ReadonlyArray<string> = [];
    if (this.#launches.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const answers = await Promise.race([
          lookup(frame.host, { all: true, verbatim: true }),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), RESOLVE_TIMEOUT_MS);
          }),
        ]);
        addresses = (answers ?? []).map((answer) => answer.address).filter(isEgressAddress);
      } catch {
        addresses = [];
      } finally {
        clearTimeout(timer);
      }
    }
    this.#send({
      type: "resolved",
      question: frame.question,
      addresses: addresses.slice(0, 32).filter(isEgressAddress),
    });
  }
}

/**
 * Runs one command in the bound root. A proxied command gets its forwarder
 * first; a command that cannot be confined, or whose forwarder cannot listen,
 * never runs and reports `unavailable`.
 */
export async function runExecutorCommand(
  environment: ExecutorLaunchEnvironment,
  root: string,
  request: SshExecutorRunCommandRequest,
  egress: ExecutorEgress,
  signal: AbortSignal,
  launch: number,
): Promise<SshExecutorCommandRanReply> {
  const session = environment.sessionDirectory;
  if (session === undefined) return unavailable;
  const scripts = join(session, "scripts");
  const work = join(session, "work");
  try {
    mkdirSync(scripts, { recursive: true, mode: 0o700 });
    mkdirSync(work, { recursive: true, mode: 0o700 });
  } catch {
    return unavailable;
  }
  const token = request.egressToken;
  let endpoint: EgressProxyEndpoint | undefined;
  if (request.network === "proxied") {
    if (token === undefined) return unavailable;
    endpoint = await egress.open(session, launch, token);
    if (endpoint === undefined) return unavailable;
  }
  // Once the forwarder is open, every path below must close it and answer:
  // a failure that escaped here would leave no reply, the forwarder and its
  // `resolve` and `dial` answering until the host timed the session out.
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(scripts, "octant-harness-"));
    const script = join(directory, "command.sh");
    await writeFile(script, `${request.command}\n`, { mode: 0o600 });
    const base =
      environment.confinement ??
      makeProcessConfinementLive({
        platform: environment.platform,
        ...(environment.bwrapPath === undefined ? {} : { sandboxPath: environment.bwrapPath }),
      });
    // Full access launches as it does on this host: with the writing
    // postures' grants and its own network.
    const grants = postureGrants(
      request.posture === "full-access" ? "auto-accept-edits" : request.posture,
    );
    const port = new RepositoryTestProcessPort({
      platform: environment.platform,
      // Whatever the launch asks for, it runs with its posture's grants: the
      // ones its canaries attested.
      confinement: { prepare: (input) => base.prepare({ ...input, ...grants }) },
      temporaryDirectory: work,
      harnessShellScriptDirectory: scripts,
      // As a terminal does: the xcode-select shim's two links, and nothing
      // else under the denied `/private/var`.
      ...(environment.platform === "darwin" ? { literalReadPaths: MACOS_GIT_SHIM_READ_PATHS } : {}),
      networkEgress: request.network === "none" ? "none" : "allow",
    });
    const result = await port.executeShellScript(
      {
        script,
        cwd: root,
        environment: { NO_COLOR: "1", TERM: "dumb" },
        timeoutMs: request.timeoutMs,
        ...(endpoint === undefined || token === undefined
          ? {}
          : { egressProxy: { endpoint, token } }),
      },
      signal,
    );
    return {
      kind: "command-ran",
      termination: result.termination,
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      stdout: lastBytes(result.stdout),
      stderr: lastBytes(result.stderr),
    };
  } catch {
    return unavailable;
  } finally {
    egress.close(launch);
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}

/** A command's output, kept to its last bytes: what the harness shows the model. */
function lastBytes(bytes: Uint8Array): string {
  const start = Math.max(0, bytes.byteLength - SSH_EXECUTOR_MAX_COMMAND_OUTPUT_BYTES);
  return Buffer.from(bytes.subarray(start)).toString("base64");
}

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { connect as netConnect, createServer, isIP, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Schema } from "effect";
import {
  SSH_EXECUTOR_MAX_COMMAND_OUTPUT_BYTES,
  SshEgressAddress,
  type SshExecutorCommandRanReply,
  type SshExecutorDialFrame,
  type SshExecutorFrame,
  type SshExecutorResolveFrame,
  type SshExecutorRunCommandRequest,
  type SshExecutorStreamFrame,
} from "@octant/contracts/ssh-executor-protocol";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import { postureGrants } from "./executorAttestation";
import { ExecutorStreams, joinToStream } from "./executorStreams";

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
 * A proxied command reaches only its forwarder, a Unix socket in this
 * session's owner-only directory. Each connection to it becomes a stream to
 * the host, where the launch's own egress proxy decides and journals it. The
 * host answers by asking this executor to resolve a name and to open a
 * connection to an address it checked; the executor does both only while that
 * command runs, and opens no TCP listener at all.
 */

/** The most connections a command holds open to its forwarder, as its proxy allows. */
const MAX_FORWARDED_CONNECTIONS = 144;
/** The most connections the host's proxy may have the target open at once. */
const MAX_DIALED_CONNECTIONS = 144;
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

/**
 * The egress of the one command that may run at a time: its forwarder, the
 * streams it carries, and the target connections the host asked for.
 */
export class ExecutorEgress {
  readonly #send: (frame: SshExecutorFrame) => void;
  readonly #forwarded: ExecutorStreams;
  readonly #dialed: ExecutorStreams;
  #launch: { readonly server: Server; readonly directory: string } | undefined;

  constructor(send: (frame: SshExecutorFrame) => void) {
    this.#send = send;
    // The executor opens odd streams (forwarded connections) and adopts the
    // host's even ones (dialed connections); one registry per direction keeps
    // each limit its own.
    this.#forwarded = new ExecutorStreams({
      send,
      opens: "odd",
      maxStreams: MAX_FORWARDED_CONNECTIONS,
    });
    this.#dialed = new ExecutorStreams({
      send,
      opens: "odd",
      maxStreams: MAX_DIALED_CONNECTIONS,
    });
  }

  /**
   * Opens the forwarder for a proxied command in a fresh owner-only directory
   * of the session's, or undefined when it cannot listen.
   */
  async open(sessionDirectory: string): Promise<string | undefined> {
    if (this.#launch !== undefined) return undefined;
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
    const server = createServer({ allowHalfOpen: true }, (socket) => this.#forward(socket));
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen({ path, exclusive: true }, () => resolve(true));
    });
    if (!listening) {
      server.close();
      rmSync(directory, { recursive: true, force: true });
      return undefined;
    }
    this.#launch = { server, directory };
    return path;
  }

  /** Ends the command's egress: the forwarder and every stream close. */
  close(): void {
    const launch = this.#launch;
    this.#launch = undefined;
    this.#forwarded.closeAll();
    this.#dialed.closeAll();
    if (launch === undefined) return;
    launch.server.close();
    rmSync(launch.directory, { recursive: true, force: true });
  }

  /** The session is gone: everything closes without a word to the host. */
  abandon(): void {
    this.#forwarded.abandonAll();
    this.#dialed.abandonAll();
    const launch = this.#launch;
    this.#launch = undefined;
    if (launch === undefined) return;
    launch.server.close();
    rmSync(launch.directory, { recursive: true, force: true });
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
        return (frame.stream % 2 === 1 ? this.#forwarded : this.#dialed).receive(frame);
    }
  }

  #forward(socket: Socket): void {
    socket.on("error", () => socket.destroy());
    const stream = this.#launch === undefined ? undefined : this.#forwarded.open();
    if (stream === undefined) {
      socket.destroy();
      return;
    }
    this.#send({ type: "stream-open", stream: stream.id });
    joinToStream(socket, stream);
  }

  #dial(frame: SshExecutorDialFrame): "accepted" | "violated" {
    const stream = this.#dialed.adopt(frame.stream);
    if (stream === "violated") return "violated";
    if (stream === "refused") return "accepted";
    // Only an address, never a name: the host's proxy checked this address,
    // and a lookup here could answer differently.
    if (this.#launch === undefined || isIP(frame.address) === 0) {
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
    if (this.#launch !== undefined) {
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
  let proxyPath: string | undefined;
  if (request.network === "proxied") {
    proxyPath = await egress.open(session);
    if (proxyPath === undefined) return unavailable;
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
      networkEgress: request.network === "none" ? "none" : "allow",
    });
    const token = request.egressToken;
    const result = await port.executeShellScript(
      {
        script,
        cwd: root,
        environment: { NO_COLOR: "1", TERM: "dumb" },
        timeoutMs: request.timeoutMs,
        ...(proxyPath === undefined || token === undefined
          ? {}
          : { egressProxy: { endpoint: { kind: "unix-socket", path: proxyPath }, token } }),
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
    egress.close();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}

/** A command's output, kept to its last bytes: what the harness shows the model. */
function lastBytes(bytes: Uint8Array): string {
  const start = Math.max(0, bytes.byteLength - SSH_EXECUTOR_MAX_COMMAND_OUTPUT_BYTES);
  return Buffer.from(bytes.subarray(start)).toString("base64");
}

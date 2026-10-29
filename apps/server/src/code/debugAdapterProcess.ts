import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { connect as connectSocket } from "node:net";
import { chmod, link, lstat, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  persistProcessReceipt,
  reconcileProcessReceipts,
  type OwnedProcessReceiptHandle,
} from "../process/nodeOwnedProcessReceipt";
import { proxiedLaunchEnvironment } from "../process/proxiedNetworkEgress";
import {
  makeProcessConfinementLive,
  ProcessConfinementError,
  type ConfinedProcessLaunch,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import type { OsNetworkEgress } from "../process/threadEgressPolicy";
import type {
  DebugSessionEgress,
  DebugSessionEgressScope,
  DebugSessionEgressStart,
} from "./debugSessionEgress";

/**
 * Launches one debug session's capsule: the adapter, which then starts the
 * program as its own child inside the same confinement. Canonical:
 * docs/design/language-services.md § Session process model (decision DB4).
 *
 * Both are confined as the thread's terminal is: the checkout writable,
 * programs and child processes allowed, the system's reads, the adapter's
 * stored version readable, and a per-session state folder, made fresh at
 * every start and removed at the end, as `HOME` and `TMPDIR`. Sibling
 * sessions' state folders are denied. The network is the session's own
 * egress proxy below Full access and the open network under it; a host with
 * no proxy refuses the session rather than running it open or with none. The
 * environment is built from nothing: no provider key, token, broker
 * credential, or `OCTANT_*` value reaches the capsule, beside the two child
 * ports the host chose for a session that declares children. The capsule's process
 * group is recorded before the adapter is used, so a restarted host reaps it.
 */

const RECEIPT_SUPERVISOR = "debug-session";
const STOP_GRACE_MS = 2_000;
const MINIMAL_PATH = "/usr/bin:/bin";

export type DebugSessionNetwork =
  | { readonly kind: "proxied"; readonly egress: DebugSessionEgressScope }
  | { readonly kind: "allow" };

export interface DebugAdapterLaunchInput {
  /** The session id: one receipt and one state folder per session. */
  readonly sessionId: string;
  /** Absolute, verified path of the adapter's binary. */
  readonly executable: string;
  /** The adapter's stored version, readable inside the capsule. */
  readonly installRoot: string;
  /** The canonical checkout root, writable. */
  readonly checkoutRoot: string;
  /** The parent of every session's state folder; siblings are denied. */
  readonly stateRoot: string;
  readonly network: DebugSessionNetwork;
  /** The configuration's environment, which the person confirmed. */
  readonly environment: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  /**
   * The one loopback port a macOS adapter that declares a debug port may
   * bind and reach. On Linux the capsule's own network namespace keeps
   * loopback inside it, so no port is opened.
   */
  readonly debugPort?: number;
  /**
   * The two host-chosen ports of an adapter that declares children: `child`,
   * where the adapter listens for a child's connection, and `childServer`,
   * where it listens for the child process itself. Both reach the capsule as
   * `OCTANT_DEBUG_CHILD_PORT` and `OCTANT_DEBUG_CHILD_SERVER_PORT`; on macOS
   * the profile opens both on `localhost`, and on Linux under `proxied` the
   * child port is relayed through a socket in the session's state folder.
   */
  readonly childPorts?: { readonly child: number; readonly childServer: number };
}

/**
 * Where the host opens a child connection: the child port on loopback (macOS,
 * and Linux under Full access, where the capsule shares the host's network),
 * or the host's own link to the relay's socket (Linux under `proxied`, whose
 * private namespace hides its loopback from the host).
 */
export type DebugChildEndpoint =
  | { readonly kind: "loopback"; readonly port: number }
  | { readonly kind: "unix-socket"; readonly path: string };

export interface DebugAdapterProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** Present when the session declared children. */
  readonly childEndpoint?: DebugChildEndpoint;
  /** Settles once the capsule's leader has exited, however it ended. */
  readonly exited: Promise<void>;
  /** Ends the capsule's process group, closes its egress, and removes its state and receipt. */
  readonly kill: () => Promise<void>;
}

export type DebugAdapterLaunchOutcome =
  | { readonly status: "launched"; readonly process: DebugAdapterProcess }
  /** No usable Seatbelt or Bubblewrap, or no egress proxy below Full access; nothing started. */
  | { readonly status: "confinement-unavailable" }
  /** The state folder, the proxy, the receipt, or the spawn failed; nothing runs. */
  | { readonly status: "failed" };

export interface DebugAdapterProcessPortOptions {
  readonly confinement?: ProcessConfinementPort;
  readonly egress?: DebugSessionEgress;
  /** Required: a session whose receipt cannot be written does not run. */
  readonly receiptDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly spawn?: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => ChildProcess;
}

export class DebugAdapterProcessPort {
  readonly #confinement: ProcessConfinementPort;
  readonly #egress: DebugSessionEgress | undefined;
  readonly #receiptDirectory: string;
  readonly #platform: NodeJS.Platform;
  readonly #processIdentity: ((pid: number) => Promise<string | undefined>) | undefined;
  readonly #spawn: NonNullable<DebugAdapterProcessPortOptions["spawn"]>;

  constructor(options: DebugAdapterProcessPortOptions) {
    this.#confinement = options.confinement ?? makeProcessConfinementLive();
    this.#egress = options.egress;
    this.#receiptDirectory = options.receiptDirectory;
    this.#platform = options.platform ?? process.platform;
    this.#processIdentity = options.processIdentity;
    this.#spawn =
      options.spawn ??
      ((command, args, spawnOptions) =>
        nodeSpawn(command, [...args], {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          windowsHide: true,
        }));
  }

  /** Whether this host can confine a session's network below Full access. */
  get proxies(): boolean {
    return this.#egress !== undefined;
  }

  async launch(input: DebugAdapterLaunchInput): Promise<DebugAdapterLaunchOutcome> {
    for (const path of [input.executable, input.installRoot, input.checkoutRoot, input.stateRoot]) {
      if (!isAbsolute(path)) return { status: "failed" };
    }
    if (input.network.kind === "proxied" && this.#egress === undefined) {
      return { status: "confinement-unavailable" };
    }
    const stateDirectory = join(input.stateRoot, input.sessionId);
    const temporaryDirectory = join(stateDirectory, "tmp");
    try {
      await prepareStateDirectory(input.stateRoot, stateDirectory, temporaryDirectory);
    } catch {
      return { status: "failed" };
    }
    // The host's own link to the Linux relay's socket: beside the state
    // folder, under the root every capsule has hidden, so nothing in the
    // capsule can replace what it names.
    const relayDirectory = join(input.stateRoot, `${input.sessionId}.relay`);
    const removeState = async () => {
      await rm(stateDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rm(relayDirectory, { recursive: true, force: true }).catch(() => undefined);
    };

    let proxy: Extract<DebugSessionEgressStart, { status: "listening" }> | undefined;
    if (input.network.kind === "proxied" && this.#egress !== undefined) {
      const started = await this.#egress
        .start(input.network.egress)
        .catch((): DebugSessionEgressStart => ({ status: "refused" }));
      if (started.status !== "listening") {
        await removeState();
        return { status: "failed" };
      }
      proxy = started;
    }
    const closeNetwork = async () => {
      await proxy?.close().catch(() => undefined);
    };
    const networkEgress: OsNetworkEgress =
      proxy === undefined ? "allow" : { kind: "proxied", endpoint: proxy.endpoint };
    const darwin = this.#platform === "darwin";
    const debugPort = darwin ? input.debugPort : undefined;
    const childPorts = input.childPorts;
    const relaySocket =
      childPorts !== undefined && !darwin && proxy !== undefined
        ? join(stateDirectory, "child.sock")
        : undefined;
    let childEndpoint: DebugChildEndpoint | undefined =
      childPorts === undefined || relaySocket !== undefined
        ? undefined
        : { kind: "loopback", port: childPorts.child };
    const loopbackRules = darwin
      ? [
          ...(debugPort === undefined ? [] : debugPortSeatbeltRules(debugPort)),
          ...(childPorts === undefined
            ? []
            : [
                ...debugPortSeatbeltRules(childPorts.child),
                ...debugPortSeatbeltRules(childPorts.childServer),
              ]),
        ]
      : [];

    let launch: ConfinedProcessLaunch;
    try {
      launch = this.#confinement.prepare({
        executable: input.executable,
        args: [],
        boundRoot: input.checkoutRoot,
        writeBoundRoot: true,
        temporaryDirectory,
        additionalWriteRoots: [stateDirectory],
        readRoots: [input.checkoutRoot, input.installRoot],
        privateHomeAllowPaths: [input.checkoutRoot, input.installRoot, stateDirectory],
        allowFileReadStar: true,
        allowProcessExec: true,
        allowProcessFork: true,
        networkEgress,
        additionalDenyReadPaths: [input.stateRoot],
        additionalDenyWritePaths: [input.stateRoot],
        isolatedRoots: [input.stateRoot],
        ...(loopbackRules.length === 0 ? {} : { extraRules: loopbackRules }),
        ...(relaySocket === undefined || childPorts === undefined
          ? {}
          : { inboundRelay: { socketPath: relaySocket, port: childPorts.child } }),
      });
    } catch (error) {
      await closeNetwork();
      await removeState();
      if (error instanceof ProcessConfinementError) return { status: "confinement-unavailable" };
      return { status: "failed" };
    }

    let child: ChildProcess;
    try {
      child = this.#spawn(launch.command, launch.args, {
        cwd: input.checkoutRoot,
        env: sessionEnvironment({
          stateDirectory,
          temporaryDirectory,
          configured: input.environment,
          proxy,
          childPorts,
        }),
      });
    } catch {
      await closeNetwork();
      await removeState();
      return { status: "failed" };
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const { stdin, stdout, stderr, pid } = child;
    if (stdin === null || stdout === null || pid === undefined) {
      killGroup(pid, "SIGKILL");
      await closeNetwork();
      await removeState();
      return { status: "failed" };
    }
    // The adapter's own stderr is its diagnostics, not the program's output,
    // which arrives as `output` events; draining it keeps a chatty adapter
    // from blocking on a full pipe.
    stderr?.resume();

    let receipt: OwnedProcessReceiptHandle;
    try {
      receipt = await persistProcessReceipt(
        {
          supervisor: RECEIPT_SUPERVISOR,
          receiptDirectory: this.#receiptDirectory,
          ...(this.#processIdentity === undefined
            ? {}
            : { processIdentity: this.#processIdentity }),
        },
        input.sessionId,
        pid,
      );
      await receipt.ready;
    } catch {
      // Without a durable receipt a host restart could not reap this capsule,
      // so it does not run at all.
      await stopGroup(pid, exited);
      await closeNetwork();
      await removeState();
      return { status: "failed" };
    }
    if (relaySocket !== undefined) {
      const linked = await holdRelaySocket(relaySocket, relayDirectory, exited);
      if (linked === undefined) {
        await stopGroup(pid, exited);
        await receipt.remove().catch(() => undefined);
        await closeNetwork();
        await removeState();
        return { status: "failed" };
      }
      childEndpoint = { kind: "unix-socket", path: linked };
    }
    let finished: Promise<void> | undefined;
    // The program and anything it started share the capsule's group, so the
    // group is ended before the receipt goes, whether the adapter left on its
    // own or was stopped.
    const finish = () => {
      finished ??= (async () => {
        killGroup(pid, "SIGKILL");
        await receipt.remove().catch(() => undefined);
        await closeNetwork();
        await removeState();
      })();
      return finished;
    };
    void exited.then(finish);

    return {
      status: "launched",
      process: {
        stdin,
        stdout,
        ...(childEndpoint === undefined ? {} : { childEndpoint }),
        exited,
        kill: async () => {
          await stopGroup(pid, exited);
          await finish();
        },
      },
    };
  }

  /** Ends every capsule a previous run of this host left behind. */
  async reconcile(): Promise<void> {
    await reconcileProcessReceipts({
      supervisor: RECEIPT_SUPERVISOR,
      receiptDirectory: this.#receiptDirectory,
      ...(this.#processIdentity === undefined ? {} : { processIdentity: this.#processIdentity }),
      shutdownTimeoutMs: STOP_GRACE_MS,
    });
  }
}

/**
 * The capsule's environment. The configuration's entries come first, so the
 * person may set `PATH` or the locale for their program; the state folder
 * the proxy variables, and the child ports are the host's and come last, so
 * no entry moves the session's writes, its network, or where a child's
 * connection is accepted. The configuration schema already
 * refuses `OCTANT_*` names and the credential names the host keeps from
 * children.
 */
function sessionEnvironment(input: {
  readonly stateDirectory: string;
  readonly temporaryDirectory: string;
  readonly configured: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly proxy: Extract<DebugSessionEgressStart, { status: "listening" }> | undefined;
  readonly childPorts: DebugAdapterLaunchInput["childPorts"];
}): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {
    PATH: MINIMAL_PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
  };
  for (const entry of input.configured) environment[entry.key] = entry.value;
  environment.HOME = input.stateDirectory;
  environment.TMPDIR = input.temporaryDirectory;
  if (input.childPorts !== undefined) {
    environment.OCTANT_DEBUG_CHILD_PORT = String(input.childPorts.child);
    environment.OCTANT_DEBUG_CHILD_SERVER_PORT = String(input.childPorts.childServer);
  }
  if (input.proxy !== undefined) {
    Object.assign(environment, proxiedLaunchEnvironment(input.proxy.endpoint, input.proxy.token));
  }
  return environment;
}

/**
 * Seatbelt's `none` and `proxied` deny loopback, so an adapter that declares
 * a debug port gets this one port on `localhost` to bind, accept on, and
 * connect to, and nothing else there (decision DB6); one that declares
 * children gets its two child ports on the same terms (DB9). Measured with
 * debugpy 1.8.22 under `sandbox-exec` on macOS on 2026-10-28: a child stopped
 * at its breakpoint with its two ports opened this way, and never connected
 * back with its server port left closed.
 */
function debugPortSeatbeltRules(port: number): ReadonlyArray<string> {
  const address = `localhost:${String(port)}`;
  return [
    `(allow network-bind (local ip "${address}"))`,
    `(allow network-inbound (local ip "${address}"))`,
    `(allow network-outbound (remote ip "${address}"))`,
  ];
}

const RELAY_WAIT_MS = 10_000;

/**
 * Takes hold of the Linux relay's socket before anything but the forwarder
 * runs in the capsule. The socket sits in the state folder, which the
 * program can write: had the host connected by that path, the program could
 * swap it for a link to any socket the host can reach. So the host waits for
 * the forwarder's socket, refuses anything else there (a link, a file), hard
 * links that inode into a folder the capsule cannot see, and then opens the
 * one connection that lets the forwarder start the adapter. Every child
 * connection after uses the host's link, whatever the folder holds by then.
 */
async function holdRelaySocket(
  relaySocket: string,
  relayDirectory: string,
  exited: Promise<void>,
): Promise<string | undefined> {
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + RELAY_WAIT_MS;
  for (;;) {
    const metadata = await lstat(relaySocket).catch(() => undefined);
    if (metadata !== undefined) {
      if (!metadata.isSocket()) return undefined;
      break;
    }
    if (gone || Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const held = join(relayDirectory, "child.sock");
  try {
    await rm(relayDirectory, { recursive: true, force: true });
    await mkdir(relayDirectory, { mode: 0o700 });
    await link(relaySocket, held);
    const linkedMetadata = await lstat(held);
    if (!linkedMetadata.isSocket()) return undefined;
  } catch {
    return undefined;
  }
  const started = await new Promise<boolean>((resolve) => {
    const socket = connectSocket({ path: held });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  return started ? held : undefined;
}

async function stopGroup(pid: number | undefined, exited: Promise<void>): Promise<void> {
  killGroup(pid, "SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_GRACE_MS).unref?.()),
  ]);
  if (!stopped) killGroup(pid, "SIGKILL");
  await exited;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid < 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Makes this session's owner-only state folder anew. A previous session's
 * folder of the same name cannot exist (ids are fresh), but one a crashed
 * run left is removed first, since confinement grants a launch root in its
 * resolved form and a link left there would grant its target.
 */
async function prepareStateDirectory(
  stateRoot: string,
  stateDirectory: string,
  temporaryDirectory: string,
): Promise<void> {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  await rm(stateDirectory, { recursive: true, force: true });
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  for (const directory of [stateDirectory, temporaryDirectory]) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Debug session state is not a plain directory.");
    }
    await chmod(directory, 0o700);
  }
}

import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  SSH_EXECUTOR_MAX_PLACED_PROCESSES,
  SSH_EXECUTOR_MAX_PROCESS_STDERR_BYTES,
  type SshExecutorFrame,
  type SshExecutorProcessRefusedReply,
  type SshExecutorProcessStartedReply,
  type SshExecutorRefusedReply,
  type SshExecutorReply,
  type SshExecutorStartProcessRequest,
  type SshExecutorStopProcessFrame,
  type SshPlacedProcessRefusalReason,
} from "@octant/contracts/ssh-executor-protocol";
import { proxiedLaunchEnvironment } from "../process/proxiedNetworkEgress";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import type { ExecutorEgress } from "./executorLaunches";
import type { ResolvedRoot } from "./executorReads";
import {
  checkAccountState,
  checkRuntimeBinary,
  openRuntimeHome,
  runtimeLaunchGrants,
  type ExecutorRuntimeGrantEnvironment,
} from "./executorRuntimeGrants";
import type { ExecutorStream, ExecutorStreams } from "./executorStreams";

/**
 * Provider runtimes this host places on the target: each a long-lived
 * confined process beside the request slot, its standard input and output a
 * stream the host opened. Canonical: docs/design/remote-ssh-environments.md §
 * Runtime placement (R1).
 *
 * A start is answered at once and frees the request slot, so reads, file
 * tools, and commands keep running one at a time beside the runtimes. A
 * runtime runs with its posture's attested runtime grants (R2) on this host's
 * proxy for its launch in every posture (R3), and its environment is built
 * here: nothing of the host's crosses. Its output starts
 * only once the reply that names its stream was written. When it exits, its
 * output is delivered, its stream closes, and `process-ended` carries its exit
 * and the last of its standard error. Every runtime dies with the session.
 */

const STOP_GRACE_MS = 5_000;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

export interface ExecutorProcessEnvironment extends ExecutorRuntimeGrantEnvironment {
  readonly platform: NodeJS.Platform;
  /** This session's owner-only directory; without it no runtime starts. */
  readonly sessionDirectory: string | undefined;
  readonly path: string | undefined;
  readonly language: string | undefined;
  /** Resolves a bound root (or a managed worktree of it) as reads do. */
  readonly resolveRoot: (root: string) => Promise<ResolvedRoot>;
  readonly confinement?: ProcessConfinementPort;
  readonly bwrapPath?: string;
}

interface PlacedProcess {
  readonly launch: number;
  readonly stream: ExecutorStream;
  readonly child: ChildProcess;
  readonly directory: string;
  stderr: Buffer;
  exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
  outputDone: boolean;
  killTimer: NodeJS.Timeout | undefined;
}

type StartReply = SshExecutorProcessStartedReply | SshExecutorProcessRefusedReply;

function refusedStart(reason: SshPlacedProcessRefusalReason): SshExecutorProcessRefusedReply {
  return { kind: "process-refused", reason };
}

export class ExecutorProcesses {
  readonly #send: (frame: SshExecutorFrame) => void;
  readonly #environment: ExecutorProcessEnvironment;
  readonly #hostOpened: ExecutorStreams;
  readonly #egress: ExecutorEgress;
  /** Running processes by stream, and those starting, which count toward the bound. */
  readonly #running = new Map<number, PlacedProcess>();
  readonly #ended = new Set<number>();
  #starting = 0;
  #abandoned = false;

  constructor(
    send: (frame: SshExecutorFrame) => void,
    environment: ExecutorProcessEnvironment,
    hostOpened: ExecutorStreams,
    egress: ExecutorEgress,
  ) {
    this.#send = send;
    this.#environment = environment;
    this.#hostOpened = hostOpened;
    this.#egress = egress;
  }

  /**
   * Starts one runtime for request `launch`. The stream is taken before
   * anything waits, so a connection the host's proxy asks for meanwhile
   * cannot take a higher id first and make this one look reused.
   */
  async start(
    request: SshExecutorStartProcessRequest,
    launch: number,
  ): Promise<StartReply | SshExecutorRefusedReply> {
    // Its end is the `process-ended` frame, so the stream is not closed on
    // its own when both directions end: a close would reach the host first
    // and cost it the output it has not read yet.
    const stream = this.#hostOpened.adopt(request.stream, false);
    if (stream === "violated" || stream === "refused") return refusedStart("unavailable");
    if (this.#running.size + this.#starting >= SSH_EXECUTOR_MAX_PLACED_PROCESSES) {
      stream.abandon();
      return refusedStart("busy");
    }
    this.#starting += 1;
    let started: StartReply | SshExecutorRefusedReply;
    try {
      started = await this.#launch(request, launch, stream);
    } catch {
      started = refusedStart("unavailable");
    } finally {
      this.#starting -= 1;
    }
    if (started.kind !== "process-started") stream.abandon();
    return started;
  }

  /** The reply naming a started process's stream was written: its output may follow now. */
  replied(launch: number, reply: SshExecutorReply): void {
    if (reply.kind !== "process-started") return;
    const placed = this.#running.get(reply.stream);
    if (placed === undefined || placed.launch !== launch) return;
    const { child, stream } = placed;
    if (child.stdout !== null) child.stdout.pipe(stream);
    if (child.stdin !== null) stream.pipe(child.stdin);
  }

  receive(frame: SshExecutorStopProcessFrame): "accepted" | "violated" {
    const placed = this.#running.get(frame.stream);
    if (placed === undefined) {
      // A stop can cross the process's own end; one for a process never
      // started names nothing.
      return this.#ended.has(frame.stream) ? "accepted" : "violated";
    }
    this.#stop(placed);
    return "accepted";
  }

  /** The session is gone: every runtime is killed, and nothing is sent. */
  abandon(): void {
    this.#abandoned = true;
    for (const placed of this.#running.values()) {
      clearTimeout(placed.killTimer);
      killGroup(placed.child, "SIGKILL");
      placed.stream.abandon();
      rmSync(placed.directory, { recursive: true, force: true });
    }
    this.#running.clear();
  }

  async #launch(
    request: SshExecutorStartProcessRequest,
    launch: number,
    stream: ExecutorStream,
  ): Promise<StartReply | SshExecutorRefusedReply> {
    const environment = this.#environment;
    const session = environment.sessionDirectory;
    // Runtimes are placed on Linux targets only, until a macOS target's
    // proxied forwarder is settled.
    if (environment.platform !== "linux" || session === undefined) {
      return refusedStart("unavailable");
    }
    const resolved = await environment.resolveRoot(request.root);
    if (resolved.status === "refused") return { kind: "refused", reason: resolved.reason };
    const root = resolved.canonical;
    const binary = checkRuntimeBinary(environment, root, request.executable);
    if (binary.status === "refused") return refusedStart(binary.reason);
    const home = openRuntimeHome(environment, root, request.home);
    if (home.status === "refused") return refusedStart(home.reason);
    const accountState = checkAccountState(environment, root, request.accountState);
    if (accountState.status === "refused") return refusedStart(accountState.reason);
    const fixedVariables = Object.fromEntries(
      (request.fixedVariables ?? []).map((variable) => [variable.name, variable.value]),
    );
    // An account-state path's variable is set here to the path it resolved
    // to; a fixed value of the same name would point the runtime elsewhere.
    if (
      Object.keys(fixedVariables).some((name) =>
        Object.hasOwn(accountState.value.environment, name),
      )
    ) {
      return refusedStart("account-state-not-confinable");
    }
    const deniedPaths = deniedRootPaths(root, request.deniedRootEntries ?? []);
    if (this.#abandoned) return refusedStart("unavailable");

    const directory = join(session, "processes", String(request.stream));
    const temporaryDirectory = join(directory, "tmp");
    let proxyPath: string | undefined;
    let child: ChildProcess;
    try {
      mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
      proxyPath = await this.#egress.open(session, launch);
      // The session can end while the forwarder starts listening.
      if (proxyPath === undefined || this.#abandoned) {
        if (proxyPath !== undefined) this.#egress.close(launch);
        rmSync(directory, { recursive: true, force: true });
        return refusedStart("unavailable");
      }
      const endpoint = { kind: "unix-socket" as const, path: proxyPath };
      const confinement =
        environment.confinement ??
        makeProcessConfinementLive({
          platform: environment.platform,
          ...(environment.bwrapPath === undefined ? {} : { sandboxPath: environment.bwrapPath }),
        });
      const prepared = confinement.prepare({
        executable: binary.value.path,
        args: request.args,
        ...runtimeLaunchGrants({
          posture: request.posture,
          root,
          home: home.value,
          temporaryDirectory,
          binaryFolders: binary.value.readFolders,
          accountState: accountState.value,
          deniedPaths,
          networkEgress: { kind: "proxied", endpoint },
        }),
      });
      child = spawn(prepared.command, [...prepared.args], {
        cwd: root,
        // Its own process group, so a stop reaches everything it started.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        // The driver's constants go first, so every variable the executor
        // sets itself is set over a fixed one of the same name.
        env: {
          ...fixedVariables,
          HOME: home.value,
          TMPDIR: temporaryDirectory,
          PATH: environment.path ?? DEFAULT_PATH,
          LANG: environment.language ?? "C.UTF-8",
          ...accountState.value.environment,
          ...proxiedLaunchEnvironment(endpoint, request.egressToken),
        },
      });
    } catch {
      if (proxyPath !== undefined) this.#egress.close(launch);
      rmSync(directory, { recursive: true, force: true });
      return refusedStart("unavailable");
    }
    const placed: PlacedProcess = {
      launch,
      stream,
      child,
      directory,
      stderr: Buffer.alloc(0),
      exit: undefined,
      outputDone: false,
      killTimer: undefined,
    };
    this.#running.set(stream.id, placed);
    child.stdin?.on("error", () => undefined);
    child.stderr?.on("data", (chunk: Buffer) => {
      const joined = Buffer.concat([placed.stderr, chunk]);
      placed.stderr = joined.subarray(
        Math.max(0, joined.byteLength - SSH_EXECUTOR_MAX_PROCESS_STDERR_BYTES),
      );
    });
    // A runtime that could not start ends as one that exited.
    child.once("error", () => this.#exited(placed, null, null));
    child.once("close", (code, signal) => this.#exited(placed, code, signal));
    stream.once("finish", () => this.#outputDelivered(placed));
    // The host closed the stream: no one speaks to the runtime any more.
    stream.once("close", () => {
      if (placed.exit === undefined) this.#stop(placed);
      this.#outputDelivered(placed);
    });
    return { kind: "process-started", stream: stream.id };
  }

  #stop(placed: PlacedProcess): void {
    if (placed.exit !== undefined) {
      // It already exited and only its output waits for room the host will
      // not grant now; what is left is dropped.
      this.#outputDelivered(placed);
      return;
    }
    killGroup(placed.child, "SIGTERM");
    placed.killTimer ??= setTimeout(() => killGroup(placed.child, "SIGKILL"), STOP_GRACE_MS);
  }

  #exited(placed: PlacedProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (placed.exit !== undefined) return;
    placed.exit = { code, signal };
    clearTimeout(placed.killTimer);
    this.#report(placed);
  }

  #outputDelivered(placed: PlacedProcess): void {
    placed.outputDone = true;
    this.#report(placed);
  }

  /**
   * Once it exited and its output is out, its end is sent and nothing more
   * for its stream: the end says the stream is over, so the host can still
   * read what it holds of the output rather than have a close discard it.
   */
  #report(placed: PlacedProcess): void {
    const { exit } = placed;
    if (exit === undefined || !placed.outputDone || this.#abandoned) return;
    if (this.#running.get(placed.stream.id) !== placed) return;
    this.#running.delete(placed.stream.id);
    this.#ended.add(placed.stream.id);
    placed.stream.abandon();
    this.#egress.close(placed.launch);
    rmSync(placed.directory, { recursive: true, force: true });
    this.#send({
      type: "process-ended",
      stream: placed.stream.id,
      ...(exit.code === null ? {} : { exitCode: exit.code }),
      ...(exit.signal === null ? {} : { signal: exit.signal }),
      stderr: placed.stderr.toString("base64"),
    });
  }
}

/**
 * The denied root entries that exist as the runtime starts. Bubblewrap makes
 * a missing path as the mount point of its cover, which would put an empty
 * file or folder in the person's root; a missing entry holds nothing to load
 * at start, and one made later is covered at the next launch. A local launch
 * on Linux skips missing entries the same way (`acpProcess.ts`).
 */
function deniedRootPaths(root: string, entries: ReadonlyArray<string>): ReadonlyArray<string> {
  return entries
    .map((entry) => join(root, entry))
    .filter((path) => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    });
}

/** Signals the runtime's whole process group, so nothing it started outlives it. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

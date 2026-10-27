import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { OutsideProviderDriverReference, ProviderInstanceId } from "@octant/contracts";
import { isOutsideDriverHostConfined } from "@octant/plugin-host/activation";
import type {
  ExtensionProcessHandle,
  ExtensionRuntimeStartInput,
  ExtensionSupervisor,
  OutsideDriverRuntime,
} from "../extensions/extensionSupervisor";
import type { OutsideDriverChannel } from "./outsideHarnessEndpointProxy";

/**
 * The confined process behind each outside provider driver instance.
 *
 * One provider instance owns at most one process, started through the
 * extension supervisor under the driver profile (the process port chooses the
 * profile and the environment; no caller can widen either). Its stdin and
 * stdout become the channel the host proxy speaks the wire protocol over, and
 * its stderr stays with the supervisor's bounded capture, never a client.
 *
 * A process that exits on its own is a crash. The next use may start it again,
 * up to the supervisor's limit of two restarts a minute; a third crash in that
 * window quarantines the instance's driver at that digest, and every later
 * start is refused until the instance binds another digest or the host
 * restarts.
 */

/** Why no process was started. Each is Octant's; nothing a driver wrote. */
export type OutsideDriverProcessRefusal =
  /** This platform has no confinement for a driver process (Linux, Windows). */
  | "host-prohibited"
  /** The server runs on neither Bun nor Electron's Node, the runtimes a driver runs on. */
  | "runtime-unavailable"
  /** This instance's driver already has its process. */
  | "already-running"
  /** The driver crashed past the limit at this digest. */
  | "quarantined"
  /** The launch was not the installed package's own, or did not start. */
  | "start-failed";

export type OutsideDriverProcessStart =
  | { readonly status: "started"; readonly channel: OutsideDriverChannel }
  | { readonly status: "refused"; readonly reason: OutsideDriverProcessRefusal };

export interface OutsideDriverProcessStartInput {
  readonly instanceId: ProviderInstanceId;
  /** The exact package the instance binds; the supervisor re-verifies it. */
  readonly driver: OutsideProviderDriverReference;
  /** The installed package's content root, read-only to the driver. */
  readonly packageRoot: string;
  /** The package's one entry module, inside `packageRoot`. */
  readonly entryPoint: string;
  readonly signal?: AbortSignal;
}

/** What the server knows of the runtime it runs on. */
export interface OutsideDriverRuntimeHost {
  readonly versions: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  /** Electron's process type; absent when Electron runs as Node. */
  readonly type?: string | undefined;
}

/**
 * A driver runs on the runtime that runs this server and on nothing else, so
 * the host ships no second runtime: the server's own Bun in development, and
 * in the packaged app the Electron executable the server already runs on as
 * Node. Electron's own main process, plain Node, or anything unrecognised
 * gives no runtime, and every driver start is refused as `runtime-unavailable`.
 */
export function resolveOutsideDriverRuntime(
  host: OutsideDriverRuntimeHost,
): OutsideDriverRuntime | undefined {
  if (!isAbsolute(host.execPath)) return undefined;
  if (host.versions.bun !== undefined) return { kind: "bun", path: host.execPath };
  if (host.versions.electron !== undefined && host.type === undefined) {
    return { kind: "electron-node", path: host.execPath };
  }
  return undefined;
}

export interface OutsideDriverProcessLimits {
  /** The largest line the host reads before handing it to the proxy to refuse. */
  readonly messageBytes: number;
  readonly maxCrashRestarts: number;
  readonly crashWindowMs: number;
}

const DEFAULT_LIMITS: OutsideDriverProcessLimits = {
  messageBytes: 4_194_304,
  maxCrashRestarts: 2,
  crashWindowMs: 60_000,
};

export interface OutsideDriverProcessesOptions {
  readonly supervisor: Pick<ExtensionSupervisor, "startInteractive" | "stopInteractive">;
  readonly platform: NodeJS.Platform;
  /** The runtime that runs this server, or nothing when no driver may run on it. */
  readonly runtime: OutsideDriverRuntime | undefined;
  /** Where each process's private temporary folder is made and removed. */
  readonly temporaryRoot: string;
  readonly now?: () => number;
  readonly limits?: Partial<OutsideDriverProcessLimits>;
}

interface RunningDriver {
  readonly stop: () => Promise<void>;
  /** Whether it is already on its way out: stopped by the host, or exited. */
  readonly ending: () => boolean;
}

export class OutsideDriverProcesses {
  readonly #supervisor: OutsideDriverProcessesOptions["supervisor"];
  readonly #platform: NodeJS.Platform;
  readonly #runtime: OutsideDriverRuntime | undefined;
  readonly #temporaryRoot: string;
  readonly #now: () => number;
  readonly #limits: OutsideDriverProcessLimits;
  readonly #running = new Map<string, RunningDriver>();
  /** Crash times per instance and digest; a digest past the limit is quarantined. */
  readonly #crashes = new Map<string, ReadonlyArray<number>>();
  readonly #quarantined = new Set<string>();

  constructor(options: OutsideDriverProcessesOptions) {
    this.#supervisor = options.supervisor;
    this.#platform = options.platform;
    this.#runtime = options.runtime;
    this.#temporaryRoot = options.temporaryRoot;
    this.#now = options.now ?? Date.now;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async start(input: OutsideDriverProcessStartInput): Promise<OutsideDriverProcessStart> {
    // Decided before any folder or process exists: a host without confinement
    // never starts a driver, rather than starting it unconfined.
    if (!isOutsideDriverHostConfined(this.#platform)) return refused("host-prohibited");
    const runtime = this.#runtime;
    if (runtime === undefined || !isAbsolute(runtime.path)) return refused("runtime-unavailable");
    const instanceKey = String(input.instanceId);
    // A process on its way out is waited for, so its successor never overlaps it.
    const previous = this.#running.get(instanceKey);
    if (previous?.ending() === true) await previous.stop();
    if (this.#running.has(instanceKey)) return refused("already-running");
    const crashKey = `${instanceKey}\u0000${String(input.driver.digest)}`;
    if (this.#quarantined.has(crashKey)) return refused("quarantined");
    if (!isInside(input.packageRoot, input.entryPoint)) return refused("start-failed");

    // Claimed before the next await, so a second start for this instance
    // cannot slip in while this one is still starting.
    let stopRequested = false;
    let driverProcess: ExtensionProcessHandle | undefined;
    let temporaryDirectory: string | undefined;
    let runtimeInput: ExtensionRuntimeStartInput | undefined;
    let cleanup: Promise<void> | undefined;
    const closedListeners: Array<() => void> = [];
    let exited = false;
    const release = (): Promise<void> => {
      cleanup ??= (async () => {
        if (runtimeInput !== undefined) {
          await this.#supervisor.stopInteractive(runtimeInput).catch(() => undefined);
        }
        if (temporaryDirectory !== undefined) {
          await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
        if (this.#running.get(instanceKey) === running) this.#running.delete(instanceKey);
      })();
      return cleanup;
    };
    const running: RunningDriver = {
      stop: () => {
        stopRequested = true;
        return release();
      },
      ending: () => stopRequested || cleanup !== undefined,
    };
    this.#running.set(instanceKey, running);

    try {
      const folder = await mkdtemp(join(this.#temporaryRoot, "octant-driver-"));
      // A stop during that await already ran the cleanup, before this folder
      // or any process existed; starting now would leave both with no owner.
      if (stopRequested) {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined);
        return refused("start-failed");
      }
      temporaryDirectory = folder;
      runtimeInput = {
        extensionId: input.driver.extensionId,
        packageId: input.driver.packageId,
        componentId: input.driver.componentId,
        version: input.driver.version,
        digest: input.driver.digest,
        entryPoint: input.entryPoint,
        command: runtime.path,
        args: [input.entryPoint],
        cwd: input.packageRoot,
        // The process port replaces this with the driver's fixed environment.
        env: {},
        // The caller resolved the component effective on the activation
        // ladder; the supervisor still asks the package store whether this
        // launch is the installed package's own.
        effective: true,
        approved: true,
        authority: { kind: "trusted-extension", extensionId: input.driver.extensionId },
        sandbox: {
          kind: "outside-driver",
          runtime: runtime.kind,
          instanceId: instanceKey,
          packageRoot: input.packageRoot,
          temporaryDirectory,
        },
      };
      const started = await this.#supervisor.startInteractive(
        runtimeInput,
        input.signal ?? new AbortController().signal,
      );
      driverProcess = started.process;
    } catch {
      await release();
      return refused("start-failed");
    }
    if (stopRequested) {
      await release();
      return refused("start-failed");
    }

    const { stdin, stdout } = driverProcess;
    if (stdin === undefined || stdout === undefined) {
      await release();
      return refused("start-failed");
    }
    // `wait` settles even for a process that ended before this line ran, which
    // an exit listener added now would never hear: a driver that throws on
    // import can be gone before its start returns.
    void driverProcess.wait.then(() => {
      if (stopRequested) return;
      exited = true;
      this.#recordCrash(crashKey);
      void release();
      for (const listener of closedListeners) listener();
    });
    return {
      status: "started",
      channel: stdioChannel({
        stdin,
        stdout,
        messageBytes: this.#limits.messageBytes,
        // A listener added after the exit still hears it.
        onClosed: (listener) => {
          if (exited) queueMicrotask(listener);
          else closedListeners.push(listener);
        },
        stop: () => void running.stop(),
        stopped: running.ending,
      }),
    };
  }

  /** Drains one instance's process and removes its temporary folder. */
  async stop(instanceId: ProviderInstanceId): Promise<void> {
    await this.#running.get(String(instanceId))?.stop();
  }

  #recordCrash(crashKey: string): void {
    const now = this.#now();
    const recent = [
      ...(this.#crashes.get(crashKey) ?? []).filter(
        (time) => now - time <= this.#limits.crashWindowMs,
      ),
      now,
    ];
    this.#crashes.set(crashKey, recent);
    if (recent.length > this.#limits.maxCrashRestarts) this.#quarantined.add(crashKey);
  }
}

function refused(reason: OutsideDriverProcessRefusal): OutsideDriverProcessStart {
  return { status: "refused", reason };
}

function isInside(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
  const path = relative(root, candidate);
  return path !== "" && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

/**
 * A driver's stdin and stdout as lines. Lines are split on bytes, so a
 * character split across chunks is never torn; a line still unfinished past
 * the cap is handed on as it stands, so the proxy's own cap refuses it and
 * stops the driver rather than this buffer growing without end.
 */
function stdioChannel(input: {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly messageBytes: number;
  readonly onClosed: (listener: () => void) => void;
  readonly stop: () => void;
  readonly stopped: () => boolean;
}): OutsideDriverChannel {
  const listeners: Array<(line: string) => void> = [];
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const deliver = (bytes: Buffer) => {
    const line = bytes.toString("utf8");
    for (const listener of listeners) listener(line);
  };
  // A write to a driver that already exited fails with EPIPE; the exit is
  // reported through `onClosed`, so the write error itself is not news.
  input.stdin.on("error", () => undefined);
  input.stdout.on("data", (chunk: Buffer | string) => {
    if (input.stopped()) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    let start = 0;
    for (let end = bytes.indexOf(0x0a); end !== -1; end = bytes.indexOf(0x0a, start)) {
      pending.push(bytes.subarray(start, end));
      const line = Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      deliver(line);
      start = end + 1;
      if (input.stopped()) return;
    }
    const rest = bytes.subarray(start);
    pending.push(rest);
    pendingBytes += rest.byteLength;
    if (pendingBytes > input.messageBytes) {
      const overlong = Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      deliver(overlong);
    }
  });
  return {
    write: (line) => {
      if (input.stopped()) return;
      input.stdin.write(`${line}\n`);
    },
    onLine: (listener) => listeners.push(listener),
    onClosed: input.onClosed,
    stop: input.stop,
  };
}

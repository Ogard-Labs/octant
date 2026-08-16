import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodePty from "node-pty";
import {
  persistProcessReceipt,
  reconcileProcessReceipts,
  type OwnedProcessReceiptHandle,
} from "../process/nodeOwnedProcessReceipt";
import {
  makeSeatbeltConfinementLive,
  SeatbeltConfinementError,
  type SeatbeltConfinementPort,
} from "../process/seatbeltProfile";
import type { OsNetworkEgress } from "../process/threadEgressPolicy";

export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
export const MAX_TERMINAL_COLUMNS = 500;
export const MAX_TERMINAL_ROWS = 500;

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  pause(): void;
  resume(): void;
}

interface PtyForkOptions {
  readonly name: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalProcessHandle {
  write(data: string): void;
  resize(columns: number, rows: number): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void;
  pause(): void;
  resume(): void;
  close(): Promise<void>;
  readonly receiptReady?: Promise<void>;
}

export interface TerminalLaunchInput {
  readonly shell: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly columns: number;
  readonly rows: number;
}

interface TerminalProcessDependencies {
  readonly spawn?: (shell: string, args: readonly string[], options: PtyForkOptions) => PtyProcess;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly waitForExit?: (process: PtyProcess, timeoutMs: number) => Promise<boolean>;
  readonly processGroupExists?: (pid: number) => boolean;
  readonly gracefulTimeoutMs?: number;
  readonly receiptDirectory?: string;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly ensurePtyHelperExecutable?: () => void;
  readonly confinement?: SeatbeltConfinementPort;
  readonly platform?: NodeJS.Platform;
  readonly sandboxPath?: string;
  readonly temporaryDirectory?: string;
  readonly networkEgress?: OsNetworkEgress;
  readonly seatbeltHomeDirectory?: string;
  readonly seatbeltUsersDirectory?: string;
}

export interface NodePtySpawnHelperLocation {
  readonly packageRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}

export function ensureNodePtySpawnHelperExecutable(
  location: NodePtySpawnHelperLocation = {},
): void {
  const platform = location.platform ?? process.platform;
  if (platform !== "darwin") return;
  const architecture = location.architecture ?? process.arch;
  const packageRoot = location.packageRoot ?? resolveNodePtyPackageRoot();
  const nativeDirectories = [
    join(packageRoot, "build", "Release"),
    join(packageRoot, "build", "Debug"),
    join(packageRoot, "prebuilds", `${platform}-${architecture}`),
  ];
  const nativeDirectory = nativeDirectories.find((candidate) =>
    existsSync(join(candidate, "pty.node")),
  );
  if (nativeDirectory === undefined) {
    throw new Error("The node-pty native runtime is unavailable for this Mac.");
  }
  const helperPath = join(nativeDirectory, "spawn-helper");
  if (!existsSync(helperPath) || !statSync(helperPath).isFile()) {
    throw new Error("The node-pty spawn helper is unavailable for this Mac.");
  }
  const mode = statSync(helperPath).mode;
  if ((mode & 0o111) === 0o111) return;
  try {
    chmodSync(helperPath, mode | 0o111);
  } catch (error) {
    throw new Error("The node-pty spawn helper could not be made executable.", { cause: error });
  }
}

export class TerminalProcessPort {
  readonly #dependencies: {
    readonly spawn: NonNullable<TerminalProcessDependencies["spawn"]>;
    readonly killProcessGroup: NonNullable<TerminalProcessDependencies["killProcessGroup"]>;
    readonly waitForExit: NonNullable<TerminalProcessDependencies["waitForExit"]>;
    readonly processGroupExists: NonNullable<TerminalProcessDependencies["processGroupExists"]>;
    readonly gracefulTimeoutMs: number;
    readonly receiptDirectory: string | undefined;
    readonly processIdentity: ((pid: number) => Promise<string | undefined>) | undefined;
    readonly ensurePtyHelperExecutable: () => void;
    readonly confinement: SeatbeltConfinementPort;
    readonly temporaryDirectory: string;
    readonly networkEgress: OsNetworkEgress;
  };

  constructor(dependencies: TerminalProcessDependencies = {}) {
    const nativeBunPtyAvailable =
      dependencies.spawn === undefined &&
      typeof globalThis.Bun !== "undefined" &&
      typeof globalThis.Bun.Terminal === "function";
    const platform = dependencies.platform ?? process.platform;
    this.#dependencies = {
      spawn:
        dependencies.spawn ??
        (nativeBunPtyAvailable
          ? spawnBunPty
          : (shell, args, options) => nodePty.spawn(shell, [...args], options)),
      killProcessGroup:
        dependencies.killProcessGroup ?? ((pid, signal) => process.kill(pid, signal)),
      waitForExit: dependencies.waitForExit ?? waitForPtyExit,
      processGroupExists: dependencies.processGroupExists ?? defaultProcessGroupExists,
      gracefulTimeoutMs: dependencies.gracefulTimeoutMs ?? 1_000,
      receiptDirectory: dependencies.receiptDirectory,
      processIdentity: dependencies.processIdentity,
      ensurePtyHelperExecutable:
        dependencies.ensurePtyHelperExecutable ??
        (dependencies.spawn !== undefined || nativeBunPtyAvailable
          ? () => undefined
          : ensureNodePtySpawnHelperExecutable),
      temporaryDirectory:
        dependencies.temporaryDirectory ??
        process.env.TMPDIR ??
        process.env.TMP ??
        process.env.TEMP ??
        "/tmp",
      networkEgress: dependencies.networkEgress ?? "allow",
      confinement:
        dependencies.confinement ??
        makeSeatbeltConfinementLive({
          platform,
          ...(dependencies.sandboxPath === undefined
            ? {}
            : { sandboxPath: dependencies.sandboxPath }),
          ...(dependencies.seatbeltHomeDirectory === undefined
            ? {}
            : { homeDirectory: dependencies.seatbeltHomeDirectory }),
          ...(dependencies.seatbeltUsersDirectory === undefined
            ? {}
            : { usersDirectory: dependencies.seatbeltUsersDirectory }),
        }),
    };
  }

  start(input: TerminalLaunchInput): TerminalProcessHandle {
    validateLaunch(input);
    this.#dependencies.ensurePtyHelperExecutable();
    let launch: { readonly command: string; readonly args: readonly string[] };
    try {
      const shellDirectory = dirname(input.shell);
      launch = this.#dependencies.confinement.prepare({
        executable: input.shell,
        args: [],
        boundRoot: input.cwd,
        temporaryDirectory: this.#dependencies.temporaryDirectory,
        networkEgress: this.#dependencies.networkEgress,
        allowFileReadStar: true,
        readRoots: [
          input.cwd,
          this.#dependencies.temporaryDirectory,
          shellDirectory,
          dirname(shellDirectory),
        ],
      });
    } catch (error) {
      if (error instanceof SeatbeltConfinementError) throw error;
      throw new SeatbeltConfinementError(
        "incompatible",
        "Terminal Seatbelt confinement could not be prepared.",
      );
    }
    const pty = this.#dependencies.spawn(launch.command, launch.args, {
      name: "xterm-256color",
      cwd: input.cwd,
      env: { ...input.environment },
      cols: input.columns,
      rows: input.rows,
    });
    let receipt: OwnedProcessReceiptHandle = {
      ready: Promise.resolve(),
      remove: async () => undefined,
    };
    const receiptReady = persistProcessReceipt(
      {
        supervisor: "terminal",
        ...(this.#dependencies.receiptDirectory === undefined
          ? {}
          : { receiptDirectory: this.#dependencies.receiptDirectory }),
        ...(this.#dependencies.processIdentity === undefined
          ? {}
          : { processIdentity: this.#dependencies.processIdentity }),
      },
      `${input.cwd}:${pty.pid}`,
      pty.pid,
    )
      .then((value) => {
        receipt = value;
        return value.ready;
      })
      .catch((error) => {
        if (this.#dependencies.receiptDirectory !== undefined) {
          try {
            this.#dependencies.killProcessGroup(-Math.abs(pty.pid), "SIGKILL");
          } catch {
            // The failed receipt remains a fail-closed launch failure.
          }
        }
        throw error;
      });
    pty.onExit(() => void this.#removeReceiptWhenReleased(pty, receiptReady, () => receipt));
    let closeOperation: Promise<void> | undefined;
    return {
      write: (data) => {
        if (Buffer.byteLength(data, "utf8") > MAX_TERMINAL_INPUT_BYTES) {
          throw new Error("Terminal input is too large.");
        }
        pty.write(data);
      },
      resize: (columns, rows) => {
        validateGeometry(columns, rows);
        pty.resize(columns, rows);
      },
      onData: (listener) => {
        const disposable = pty.onData(listener);
        return () => disposable.dispose();
      },
      onExit: (listener) => {
        const disposable = pty.onExit(listener);
        return () => disposable.dispose();
      },
      pause: () => pty.pause(),
      resume: () => pty.resume(),
      close: () => {
        closeOperation ??= this.#close(pty);
        return closeOperation.then(async () => {
          await receiptReady.catch(() => undefined);
          await receipt.remove();
        });
      },
      receiptReady,
    };
  }

  async reconcile(): Promise<void> {
    await reconcileProcessReceipts({
      supervisor: "terminal",
      ...(this.#dependencies.receiptDirectory === undefined
        ? {}
        : { receiptDirectory: this.#dependencies.receiptDirectory }),
      ...(this.#dependencies.processIdentity === undefined
        ? {}
        : { processIdentity: this.#dependencies.processIdentity }),
      processGroupExists: this.#dependencies.processGroupExists,
      ...(this.#dependencies.killProcessGroup === undefined
        ? {}
        : {
            killProcessGroup: (pid, signal) =>
              this.#dependencies.killProcessGroup(-Math.abs(pid), signal),
          }),
      shutdownTimeoutMs: this.#dependencies.gracefulTimeoutMs,
    });
  }

  async #close(pty: PtyProcess): Promise<void> {
    const groupId = -Math.abs(pty.pid);
    if (!signalProcessGroupIfPresent(this.#dependencies.killProcessGroup, groupId, "SIGTERM"))
      return;
    if (
      (await this.#dependencies.waitForExit(pty, this.#dependencies.gracefulTimeoutMs)) &&
      (await this.#waitForProcessGroupExit(pty.pid))
    )
      return;
    if (!signalProcessGroupIfPresent(this.#dependencies.killProcessGroup, groupId, "SIGKILL"))
      return;
    if (
      !(await this.#dependencies.waitForExit(pty, this.#dependencies.gracefulTimeoutMs)) ||
      !(await this.#waitForProcessGroupExit(pty.pid))
    ) {
      throw new Error("Terminal process group did not exit.");
    }
  }

  async #removeReceiptWhenReleased(
    pty: PtyProcess,
    receiptReady: Promise<void>,
    getReceipt: () => OwnedProcessReceiptHandle,
  ): Promise<void> {
    try {
      await receiptReady;
      if (await this.#waitForProcessGroupExit(pty.pid)) await getReceipt().remove();
    } catch {
      // Receipt creation failed closed; there is no durable handle to remove.
    }
  }

  async #waitForProcessGroupExit(pid: number): Promise<boolean> {
    const deadline = Date.now() + this.#dependencies.gracefulTimeoutMs;
    while (this.#dependencies.processGroupExists(pid)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  }
}

function spawnBunPty(shell: string, args: readonly string[], options: PtyForkOptions): PtyProcess {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const decoder = new TextDecoder();
  const pendingOutput: string[] = [];
  let paused = false;
  let exitEvent: { exitCode: number; signal?: number } | undefined;
  let terminal: Bun.Terminal | undefined;

  const publishData = (data: string): void => {
    if (data.length === 0) return;
    if (paused || dataListeners.size === 0) {
      pendingOutput.push(data);
      return;
    }
    for (const listener of dataListeners) listener(data);
  };
  const flushOutput = (): void => {
    if (paused || dataListeners.size === 0 || pendingOutput.length === 0) return;
    const data = pendingOutput.splice(0).join("");
    for (const listener of dataListeners) listener(data);
  };
  const subprocess = Bun.spawn([shell, ...args], {
    cwd: options.cwd,
    detached: true,
    env: { ...options.env, TERM: options.name },
    terminal: {
      cols: options.cols,
      rows: options.rows,
      name: options.name,
      data: (_terminal, data) => publishData(decoder.decode(data, { stream: true })),
    },
    onExit: (_subprocess, exitCode, signalCode) => {
      const trailing = decoder.decode();
      if (trailing.length > 0) publishData(trailing);
      exitEvent = {
        exitCode: exitCode ?? 1,
        ...(signalCode === null ? {} : { signal: signalCode }),
      };
      for (const listener of exitListeners) listener(exitEvent);
      terminal?.close();
    },
  });
  terminal = subprocess.terminal;
  if (terminal === undefined) {
    subprocess.kill("SIGKILL");
    throw new Error("The Bun terminal runtime is unavailable.");
  }

  return {
    pid: subprocess.pid,
    write: (data) => {
      terminal!.write(data);
    },
    resize: (columns, rows) => terminal!.resize(columns, rows),
    onData: (listener) => {
      dataListeners.add(listener);
      flushOutput();
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      if (exitEvent !== undefined) queueMicrotask(() => listener(exitEvent!));
      return { dispose: () => exitListeners.delete(listener) };
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      flushOutput();
    },
  };
}

function resolveNodePtyPackageRoot(): string {
  const entry = fileURLToPath(import.meta.resolve("node-pty"));
  return resolve(dirname(entry), "..");
}

function validateLaunch(input: TerminalLaunchInput): void {
  if (!isAbsolute(input.shell) || !isAbsolute(input.cwd))
    throw new Error("Terminal launch is invalid.");
  validateGeometry(input.columns, input.rows);
  for (const [name, value] of Object.entries(input.environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || value.includes("\0"))
      throw new Error("Terminal environment is invalid.");
  }
}

function validateGeometry(columns: number, rows: number): void {
  if (
    !Number.isSafeInteger(columns) ||
    columns < 1 ||
    columns > MAX_TERMINAL_COLUMNS ||
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > MAX_TERMINAL_ROWS
  ) {
    throw new Error("Terminal geometry is invalid.");
  }
}

async function waitForPtyExit(pty: PtyProcess, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let disposable: { dispose(): void } | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      disposable?.dispose();
      resolve(value);
    };
    disposable = pty.onExit(() => finish(true));
    if (settled) disposable.dispose();
    else timeout = setTimeout(() => finish(false), timeoutMs);
  });
}

function defaultProcessGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroupIfPresent(
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void,
  pid: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    killProcessGroup(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

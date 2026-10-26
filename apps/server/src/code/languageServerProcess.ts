import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  persistProcessReceipt,
  reconcileProcessReceipts,
  type OwnedProcessReceiptHandle,
} from "../process/nodeOwnedProcessReceipt";
import {
  makeProcessConfinementLive,
  ProcessConfinementError,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";

/**
 * Launches one `static` language server as a confined child of the host.
 * Canonical: docs/design/language-services.md § Launch classes.
 *
 * The launch is the class's whole grant and nothing more: the checkout bound
 * read-only, the server's own install readable, its private cache the only
 * writable place, no network, and no program but its own binary (Linux also
 * loads the no-fork filter Plan uses; Seatbelt denies exec). The environment
 * is built from nothing, so no provider key, token, or `OCTANT_*` value
 * reaches the child. A durable receipt lets a restarted host reap a server
 * the previous run left behind.
 */

const RECEIPT_SUPERVISOR = "language-server";
/** The per-server cache bound; past it the cache is cleared before the next start. */
export const LANGUAGE_SERVER_CACHE_CAP_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_ENTRIES_WALKED = 100_000;
const STOP_GRACE_MS = 2_000;
const MINIMAL_PATH = "/usr/bin:/bin";

export interface LanguageServerLaunchInput {
  /** Stable owner of the receipt: one server per checkout, component, and class. */
  readonly ownerId: string;
  /** Absolute, resolved path of the server binary the component names. */
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  /** The component's own install, readable so the server finds its bundled files. */
  readonly installRoot: string;
  /** The canonical checkout root, bound read-only. */
  readonly checkoutRoot: string;
  /** This server's private cache directory; the only place it may write. */
  readonly cacheDirectory: string;
  /** The parent of every server's cache, denied so siblings stay unreadable. */
  readonly cacheRoot: string;
}

export interface LanguageServerProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** Settles once the child has exited, however it ended. */
  readonly exited: Promise<void>;
  /** Ends the child's process group and removes its receipt. */
  readonly kill: () => Promise<void>;
}

export type LanguageServerLaunchOutcome =
  | { readonly status: "launched"; readonly process: LanguageServerProcess }
  /** No usable Seatbelt or Bubblewrap on this host; nothing was started. */
  | { readonly status: "confinement-unavailable" }
  | { readonly status: "failed" };

export interface LanguageServerProcessPortOptions {
  readonly confinement?: ProcessConfinementPort;
  readonly receiptDirectory?: string;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly spawn?: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => ChildProcess;
}

export class LanguageServerProcessPort {
  readonly #confinement: ProcessConfinementPort;
  readonly #receiptDirectory: string | undefined;
  readonly #processIdentity: ((pid: number) => Promise<string | undefined>) | undefined;
  readonly #spawn: NonNullable<LanguageServerProcessPortOptions["spawn"]>;

  constructor(options: LanguageServerProcessPortOptions = {}) {
    this.#confinement = options.confinement ?? makeProcessConfinementLive();
    this.#receiptDirectory = options.receiptDirectory;
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

  async launch(input: LanguageServerLaunchInput): Promise<LanguageServerLaunchOutcome> {
    for (const path of [
      input.executable,
      input.installRoot,
      input.checkoutRoot,
      input.cacheDirectory,
      input.cacheRoot,
    ]) {
      if (!isAbsolute(path)) return { status: "failed" };
    }
    const temporaryDirectory = join(input.cacheDirectory, "tmp");
    try {
      await prepareCacheDirectory(input.cacheRoot, input.cacheDirectory, temporaryDirectory);
    } catch {
      return { status: "failed" };
    }
    let launch: { readonly command: string; readonly args: ReadonlyArray<string> };
    try {
      launch = this.#confinement.prepare({
        executable: input.executable,
        args: input.args,
        boundRoot: input.checkoutRoot,
        writeBoundRoot: false,
        temporaryDirectory,
        additionalWriteRoots: [input.cacheDirectory],
        readRoots: [input.installRoot],
        privateHomeAllowPaths: [input.checkoutRoot, input.installRoot, input.cacheDirectory],
        // Seatbelt needs the system's own libraries readable to start any
        // binary; the home folder and the default private paths stay denied.
        allowFileReadStar: true,
        networkEgress: "none",
        allowProcessExec: false,
        allowProcessFork: false,
        additionalDenyReadPaths: [input.cacheRoot],
        isolatedRoots: [input.cacheRoot],
      });
    } catch (error) {
      if (error instanceof ProcessConfinementError) return { status: "confinement-unavailable" };
      return { status: "failed" };
    }

    let child: ChildProcess;
    try {
      child = this.#spawn(launch.command, launch.args, {
        cwd: input.checkoutRoot,
        env: { HOME: input.cacheDirectory, TMPDIR: temporaryDirectory, PATH: MINIMAL_PATH },
      });
    } catch {
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
      return { status: "failed" };
    }
    // The server's own stderr carries nothing Octant shows; draining it keeps
    // a chatty server from blocking on a full pipe.
    stderr?.resume();

    let receipt: OwnedProcessReceiptHandle;
    try {
      receipt = await persistProcessReceipt(
        {
          supervisor: RECEIPT_SUPERVISOR,
          ...(this.#receiptDirectory === undefined
            ? {}
            : { receiptDirectory: this.#receiptDirectory }),
          ...(this.#processIdentity === undefined
            ? {}
            : { processIdentity: this.#processIdentity }),
        },
        input.ownerId,
        pid,
      );
      await receipt.ready;
    } catch {
      // Without a durable receipt a host restart could not reap this child,
      // so it does not run at all.
      await stopGroup(pid, exited);
      return { status: "failed" };
    }
    // A static server cannot fork, and the sandbox runtime ends its capsule
    // with it (`--die-with-parent`), so the leader's exit is the group's.
    void exited.then(() => receipt.remove());

    return {
      status: "launched",
      process: {
        stdin,
        stdout,
        exited,
        kill: async () => {
          await stopGroup(pid, exited);
          await receipt.remove();
        },
      },
    };
  }

  /** Ends every server a previous run of this host left behind. */
  async reconcile(): Promise<void> {
    await reconcileProcessReceipts({
      supervisor: RECEIPT_SUPERVISOR,
      ...(this.#receiptDirectory === undefined ? {} : { receiptDirectory: this.#receiptDirectory }),
      ...(this.#processIdentity === undefined ? {} : { processIdentity: this.#processIdentity }),
      shutdownTimeoutMs: STOP_GRACE_MS,
    });
  }
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
 * Creates this server's owner-only cache, and clears it first when it has
 * grown past its bound. A cache holds nothing the server cannot rebuild, so
 * clearing the whole of it is the simplest eviction that keeps the bound.
 */
async function prepareCacheDirectory(
  cacheRoot: string,
  cacheDirectory: string,
  temporaryDirectory: string,
): Promise<void> {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await chmod(cacheRoot, 0o700);
  if ((await directorySize(cacheDirectory)) > LANGUAGE_SERVER_CACHE_CAP_BYTES) {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  await chmod(cacheDirectory, 0o700);
  await chmod(temporaryDirectory, 0o700);
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  let walked = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    let names: ReadonlyArray<string>;
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      walked += 1;
      // A cache too large to even list is past its bound.
      if (walked > MAX_CACHE_ENTRIES_WALKED) return Number.POSITIVE_INFINITY;
      const path = join(directory, name);
      const metadata = await lstat(path).catch(() => undefined);
      if (metadata === undefined) continue;
      if (metadata.isDirectory()) pending.push(path);
      else total += metadata.size;
    }
  }
  return total;
}

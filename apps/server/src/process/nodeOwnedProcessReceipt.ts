import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_RECEIPT_BYTES = 4_096;
const MAX_RECEIPTS = 256;

export interface OwnedProcessReceipt {
  readonly schemaVersion: 1;
  readonly supervisor: string;
  readonly ownerId: string;
  readonly pid: number;
  readonly processIdentity: string;
  readonly startedAt: string;
}

export interface ProcessReceiptOptions {
  readonly receiptDirectory?: string;
  readonly supervisor: string;
  readonly shutdownTimeoutMs?: number;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly processGroupExists?: (pid: number) => Promise<boolean> | boolean;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface OwnedProcessReceiptHandle {
  readonly ready: Promise<void>;
  readonly remove: () => Promise<void>;
}

export function validateReceiptDirectory(receiptDirectory: string | undefined): void {
  if (receiptDirectory !== undefined && !isAbsolute(receiptDirectory)) {
    throw new Error("Process receipt directory must be an absolute path.");
  }
}

export async function persistProcessReceipt(
  options: ProcessReceiptOptions,
  ownerId: string,
  pid: number,
): Promise<OwnedProcessReceiptHandle> {
  validateReceiptDirectory(options.receiptDirectory);
  if (options.receiptDirectory === undefined) {
    return { ready: Promise.resolve(), remove: async () => undefined };
  }
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error("Owned process did not expose a valid pid.");
  const identity = await (options.processIdentity ?? readProcessIdentity)(pid);
  if (identity === undefined) throw new Error("Owned process identity is unavailable.");
  const directory = options.receiptDirectory;
  const path = join(directory, receiptName(options.supervisor, ownerId, pid));
  const receipt: OwnedProcessReceipt = {
    schemaVersion: 1,
    supervisor: options.supervisor,
    ownerId,
    pid,
    processIdentity: identity,
    startedAt: new Date().toISOString(),
  };
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  const ready = (async () => {
    const serialized = JSON.stringify(receipt);
    if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES)
      throw new Error("Process ownership receipt exceeded its bound.");
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const handle = await open(temporaryPath, "w", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  })();
  return {
    ready,
    remove: async () => {
      await unlink(path).catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    },
  };
}

export async function reconcileProcessReceipts(options: ProcessReceiptOptions): Promise<void> {
  validateReceiptDirectory(options.receiptDirectory);
  if (options.receiptDirectory === undefined) return;
  let names: string[];
  try {
    names = (await readdir(options.receiptDirectory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (names.length > MAX_RECEIPTS) {
    throw new Error("Too many process ownership receipts.");
  }
  const identity = options.processIdentity ?? readProcessIdentity;
  const processGroupExists = options.processGroupExists ?? defaultProcessGroupExists;
  for (const name of names) {
    if (!/^receipt-[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(options.receiptDirectory, name);
    let receipt: OwnedProcessReceipt | undefined;
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_RECEIPT_BYTES)
        throw new Error("Invalid receipt size.");
      receipt = parseReceipt(JSON.parse(await readFile(path, "utf8")));
      if (receipt.supervisor !== options.supervisor) continue;
      const leaderIdentity = await identity(receipt.pid);
      if (
        leaderIdentity !== receipt.processIdentity &&
        !(leaderIdentity === undefined && (await processGroupExists(receipt.pid)))
      ) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      await terminateOwnedProcess(
        receipt.pid,
        receipt.processIdentity,
        options.shutdownTimeoutMs ?? 2_000,
        identity,
        options.killProcessGroup ?? signalProcessGroup,
        processGroupExists,
      );
      await unlink(path).catch(() => undefined);
    } catch (error) {
      // Only disappearance of the receipt file itself is benign. Once the
      // receipt has parsed, an ENOENT from identity observation is an
      // observation failure and must not be treated as an absent leader.
      if (receipt === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export async function terminateOwnedProcess(
  pid: number,
  expectedIdentity: string,
  timeoutMs: number,
  processIdentity: (pid: number) => Promise<string | undefined>,
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void = signalProcessGroup,
  processGroupExists: (pid: number) => Promise<boolean> | boolean = defaultProcessGroupExists,
): Promise<void> {
  const owns = async () => {
    const identity = await processIdentity(pid);
    if (identity === expectedIdentity) return true;
    // The recorded leader may have exited while descendants remain in its
    // detached group. Keep ownership of that group and finish termination.
    return identity === undefined && (await processGroupExists(pid));
  };
  if (!(await owns())) return;
  killProcessGroup(pid, "SIGTERM");
  if (await waitUntilReleased(pid, owns, timeoutMs, processGroupExists)) return;
  killProcessGroup(pid, "SIGKILL");
  if (!(await waitUntilReleased(pid, owns, timeoutMs, processGroupExists)))
    throw new Error("Owned process did not terminate after SIGKILL.");
}

function parseReceipt(value: unknown): OwnedProcessReceipt {
  if (typeof value !== "object" || value === null) throw new Error("Invalid receipt.");
  const receipt = value as Partial<OwnedProcessReceipt>;
  if (
    receipt.schemaVersion !== 1 ||
    typeof receipt.supervisor !== "string" ||
    typeof receipt.ownerId !== "string" ||
    !Number.isSafeInteger(receipt.pid) ||
    (receipt.pid as number) < 1 ||
    typeof receipt.processIdentity !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.processIdentity) ||
    typeof receipt.startedAt !== "string"
  )
    throw new Error("Invalid receipt.");
  return receipt as OwnedProcessReceipt;
}

function receiptName(supervisor: string, ownerId: string, pid: number): string {
  return `receipt-${createHash("sha256").update(`${supervisor}\0${ownerId}\0${pid}`).digest("hex")}.json`;
}

async function waitUntilReleased(
  pid: number,
  owns: () => Promise<boolean>,
  timeoutMs: number,
  processGroupExists?: (pid: number) => Promise<boolean> | boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ((await owns()) || (processGroupExists !== undefined && (await processGroupExists(pid)))) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
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

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function readProcessIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === "linux") {
    let processStat: string;
    try {
      processStat = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      // ENOENT for the leader's proc entry is the only absence signal. Other
      // read failures are an observation error and must fail closed.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
    const commandEnd = processStat.lastIndexOf(")");
    const fields =
      commandEnd < 0
        ? []
        : processStat
            .slice(commandEnd + 1)
            .trim()
            .split(/\s+/);
    if (fields[2] !== String(pid) || fields[19] === undefined) {
      if (!processLeaderExists(pid)) return undefined;
      throw new Error("Owned process identity could not be observed.");
    }
    return hashIdentity(["linux", String(pid), bootId.trim(), fields[19]]);
  }
  if (process.platform === "darwin") {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "/bin/ps",
        ["-o", "pid=,pgid=,lstart=", "-p", String(pid)],
        { timeout: 1_000, maxBuffer: 4_096 },
      ));
    } catch (error) {
      if (!processLeaderExists(pid)) return undefined;
      throw error;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(stdout);
    if (match?.[1] !== String(pid) || match[2] !== String(pid) || match[3] === undefined) {
      if (!processLeaderExists(pid)) return undefined;
      throw new Error("Owned process identity could not be observed.");
    }
    return hashIdentity(["darwin", match[1], match[2], match[3]]);
  }
  if (!processLeaderExists(pid)) return undefined;
  throw new Error("Owned process identity is unavailable on this platform.");
}

function processLeaderExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function hashIdentity(parts: ReadonlyArray<string>): string {
  return `sha256:${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

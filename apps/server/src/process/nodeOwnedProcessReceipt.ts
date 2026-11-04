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

/**
 * The supervisor's receipts, read without acting on them, for a caller that
 * reaps each one on its own schedule. A receipt that does not parse is
 * reported rather than skipped: an owned process nobody can identify must not
 * look like no process at all.
 */
export async function readOwnedProcessReceipts(
  options: Pick<ProcessReceiptOptions, "receiptDirectory" | "supervisor">,
): Promise<ReadonlyArray<{ readonly path: string; readonly receipt: OwnedProcessReceipt }>> {
  validateReceiptDirectory(options.receiptDirectory);
  if (options.receiptDirectory === undefined) return [];
  let names: string[];
  try {
    names = (await readdir(options.receiptDirectory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.length > MAX_RECEIPTS) throw new Error("Too many process ownership receipts.");
  const receipts: Array<{ readonly path: string; readonly receipt: OwnedProcessReceipt }> = [];
  for (const name of names) {
    if (!/^receipt-[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(options.receiptDirectory, name);
    let metadata;
    try {
      metadata = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.size > MAX_RECEIPT_BYTES)
      throw new Error("Invalid receipt size.");
    const receipt = parseReceipt(JSON.parse(await readFile(path, "utf8")));
    if (receipt.supervisor === options.supervisor) receipts.push({ path, receipt });
  }
  return receipts;
}

export async function terminateOwnedProcess(
  pid: number,
  expectedIdentity: string,
  timeoutMs: number,
  processIdentity: (pid: number) => Promise<string | undefined>,
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void = signalProcessGroup,
  processGroupExists: (pid: number) => Promise<boolean> | boolean = defaultProcessGroupExists,
  witnesses: ReadonlyArray<ProcessGroupWitness> = [],
  observeGroup: (
    pid: number,
  ) => Promise<ReadonlyArray<ProcessGroupWitness>> = readProcessGroupWitnesses,
): Promise<void> {
  // Only a matching live leader can establish new evidence. A persisted
  // leaderless group may have been reused since the previous host session.
  const observed = await captureProcessGroupWitnesses(
    pid,
    expectedIdentity,
    processIdentity,
    observeGroup,
  );
  const known = [...witnesses, ...observed];
  const owns = () =>
    ownsProcessGroup(
      pid,
      expectedIdentity,
      processIdentity,
      processGroupExists,
      known,
      observeGroup,
    );
  if (!(await owns())) return;
  killProcessGroup(pid, "SIGTERM");
  if (await waitUntilReleased(owns, timeoutMs)) return;
  if (!(await owns())) return;
  killProcessGroup(pid, "SIGKILL");
  if (!(await waitUntilReleased(owns, timeoutMs)))
    throw new Error("Owned process did not terminate after SIGKILL.");
}

export interface ProcessGroupWitness {
  readonly pid: number;
  readonly processIdentity: string;
}

/** Capture members only while the launch leader proves which group this is. */
export async function captureProcessGroupWitnesses(
  pid: number,
  expectedIdentity: string,
  processIdentity: (pid: number) => Promise<string | undefined>,
  observeGroup: (
    pid: number,
  ) => Promise<ReadonlyArray<ProcessGroupWitness>> = readProcessGroupWitnesses,
): Promise<ReadonlyArray<ProcessGroupWitness>> {
  if ((await processIdentity(pid)) !== expectedIdentity) return [];
  let members: ReadonlyArray<ProcessGroupWitness>;
  try {
    members = await observeGroup(pid);
  } catch {
    // Descendant evidence is optional while the live leader still proves
    // ownership. Failure adds no witness; it can never authorize a later
    // leaderless signal. That path must observe surviving membership itself.
    return [];
  }
  if ((await processIdentity(pid)) !== expectedIdentity) return [];
  return members.filter((member) => member.pid !== pid);
}

/** An existing PGID alone never establishes ownership after its leader exits. */
export async function ownsProcessGroup(
  pid: number,
  expectedIdentity: string,
  processIdentity: (pid: number) => Promise<string | undefined>,
  processGroupExists: (pid: number) => Promise<boolean> | boolean = defaultProcessGroupExists,
  witnesses: ReadonlyArray<ProcessGroupWitness> = [],
  observeGroup: (
    pid: number,
  ) => Promise<ReadonlyArray<ProcessGroupWitness>> = readProcessGroupWitnesses,
): Promise<boolean> {
  const identity = await processIdentity(pid);
  if (identity === expectedIdentity) return true;
  if (identity !== undefined || !(await processGroupExists(pid))) return false;
  if (witnesses.length > 0) {
    const members = await observeGroup(pid);
    if (
      members.some((member) =>
        witnesses.some(
          (witness) =>
            witness.pid === member.pid && witness.processIdentity === member.processIdentity,
        ),
      )
    )
      return true;
  }
  throw new Error("Process group ownership is uncertain after its leader exited.");
}

/** No command or environment is requested; every sample rechecks group membership. */
export async function readProcessGroupWitnesses(
  pid: number,
): Promise<ReadonlyArray<ProcessGroupWitness>> {
  const maxMembers = 256;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid process group.");
  if (process.platform === "darwin") {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "/bin/ps",
        ["-g", String(pid), "-o", "pid=,pgid=,lstart="],
        { timeout: 1_000, maxBuffer: 32_768 },
      ));
    } catch (error) {
      if (!defaultProcessGroupExists(pid)) return [];
      throw error;
    }
    const lines = stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "");
    if (lines.length > maxMembers) throw new Error("Too many owned process group members.");
    return lines.map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (match?.[1] === undefined || match[2] !== String(pid) || match[3] === undefined)
        throw new Error("Process group membership could not be observed.");
      return {
        pid: Number(match[1]),
        processIdentity: hashIdentity(["darwin", match[1], match[2], match[3]]),
      };
    });
  }
  if (process.platform === "linux") {
    let stdout: string;
    try {
      // procps ps -g selects sessions, unlike BSD ps. pgrep -g selects PGID.
      ({ stdout } = await execFileAsync("/usr/bin/pgrep", ["-g", String(pid)], {
        timeout: 1_000,
        maxBuffer: 4_096,
      }));
    } catch (error) {
      if (!defaultProcessGroupExists(pid)) return [];
      throw error;
    }
    const members = stdout.trim().split(/\s+/);
    if (members.length > maxMembers) throw new Error("Too many owned process group members.");
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const witnesses: ProcessGroupWitness[] = [];
    for (const member of members) {
      if (!/^[1-9]\d*$/.test(member)) throw new Error("Invalid process group member.");
      let processStat: string;
      try {
        processStat = await readFile(`/proc/${member}/stat`, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") continue;
        throw error;
      }
      const end = processStat.lastIndexOf(")");
      if (end < 0) throw new Error("Process group membership could not be observed.");
      const fields = processStat
        .slice(end + 1)
        .trim()
        .split(/\s+/);
      if (fields[2] !== String(pid)) continue;
      if (fields[19] === undefined)
        throw new Error("Process group identity could not be observed.");
      witnesses.push({
        pid: Number(member),
        processIdentity: hashIdentity(["linux", member, bootId, fields[19]]),
      });
    }
    return witnesses;
  }
  throw new Error("Process group observation is unavailable on this platform.");
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
  owns: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await owns()) {
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

export async function readProcessIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === "linux") {
    let processStat: string;
    try {
      processStat = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      // ENOENT for the leader's proc entry, or ESRCH when the leader is reaped
      // between opening its entry and reading it (seen while a killed
      // Bubblewrap launch was reaped mid-read), is the only absence signal.
      // Other read failures are an observation error and must fail closed.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return undefined;
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

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  execFile,
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionProcessExit,
  ExtensionProcessHandle,
  ExtensionProcessPort,
  ExtensionProcessReceipt,
  ExtensionProcessStartInput,
} from "./extensionSupervisor";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const SAFE_PATH = "/usr/bin:/bin";
const READY_HANDSHAKE = "OCTANT_EXTENSION_READY";
const MAX_HANDSHAKE_BYTES = 1_024;
const MAX_RECEIPT_BYTES = 4_096;
const MAX_RECEIPTS = 256;
const execFileAsync = promisify(execFile);

// Executable components become ready only after emitting this complete stdout line.

export interface NodeExtensionProcessPortOptions {
  readonly spawn?: typeof nodeSpawn;
  readonly shutdownTimeoutMs?: number;
  readonly receiptDirectory?: string;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly sandboxPath?: string;
}

interface DurableReceipt {
  readonly schemaVersion: 2;
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly version: string;
  readonly digest: string;
  readonly pid: number;
  readonly processIdentity: string;
  readonly startedAt: string;
}

export function createNodeExtensionProcessPort(
  options: NodeExtensionProcessPortOptions = {},
): ExtensionProcessPort {
  const spawn = options.spawn ?? nodeSpawn;
  const processIdentity = options.processIdentity ?? readProcessIdentity;
  const shutdownTimeoutMs = bounded(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
  const platform = options.platform ?? process.platform;
  const sandboxPath = options.sandboxPath ?? "/usr/bin/sandbox-exec";
  if (options.receiptDirectory !== undefined && !isAbsolute(options.receiptDirectory)) {
    throw new Error("Extension receipt directory must be an absolute path.");
  }
  return {
    start: (input) =>
      startProcess(
        spawn,
        input,
        shutdownTimeoutMs,
        options.receiptDirectory,
        processIdentity,
        platform,
        sandboxPath,
      ),
    receipts: () => readReceipts(options.receiptDirectory, shutdownTimeoutMs, processIdentity),
  };
}

async function startProcess(
  spawn: typeof nodeSpawn,
  input: ExtensionProcessStartInput,
  shutdownTimeoutMs: number,
  receiptDirectory: string | undefined,
  processIdentity: (pid: number) => Promise<string | undefined>,
  platform: NodeJS.Platform,
  sandboxPath: string,
): Promise<ExtensionProcessHandle> {
  if (!isAbsolute(input.command) || !isAbsolute(input.cwd)) {
    throw new Error("Extension process launch metadata must use absolute paths.");
  }
  if (input.signal.aborted)
    throw new DOMException("Extension process was interrupted.", "AbortError");

  let child: ChildProcessWithoutNullStreams;
  try {
    const launch = await prepareProcessLaunch(input, platform, sandboxPath);
    child = spawn(launch.command, launch.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: { PATH: SAFE_PATH, ...input.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Extension process could not be started.");
  }

  const wait = new Promise<ExtensionProcessExit>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => undefined);
  let outputBytes = 0;
  let outputOverflowed = false;
  let handshakeBuffer = "";
  let termination: Promise<void> | undefined;
  let receiptPath: string | undefined;
  let ownedProcessIdentity: string | undefined;
  const stop = (): Promise<void> => {
    termination ??= terminate(child, shutdownTimeoutMs, ownedProcessIdentity, processIdentity);
    return termination;
  };
  const capture = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
    outputBytes += bytes;
    if (outputBytes > input.maxOutputBytes && !outputOverflowed) {
      outputOverflowed = true;
      readyReject(new Error("Extension output budget was exceeded."));
      void stop().catch(() => undefined);
    }
  };
  const consumeReady = (chunk: Buffer | string) => {
    capture(chunk);
    if (readySettled || outputOverflowed) return;
    handshakeBuffer = `${handshakeBuffer}${chunk.toString()}`.slice(-MAX_HANDSHAKE_BYTES);
    const lines = handshakeBuffer.split(/\r?\n/);
    handshakeBuffer = lines.pop() ?? "";
    if (lines.some((line) => line === READY_HANDSHAKE)) {
      readySettled = true;
      readyResolve();
    }
  };
  // Interactive stdio stdout is the MCP JSON-RPC transport. Protocol framing
  // owns its per-message bound; only stderr remains diagnostic output.
  if (input.readiness !== "spawn") child.stdout.on("data", consumeReady);
  child.stderr.on("data", capture);
  child.once("close", () => {
    if (!readySettled) {
      readySettled = true;
      readyReject(new Error("Extension process exited before readiness handshake."));
    }
  });
  child.once("error", () => {
    if (!readySettled) {
      readySettled = true;
      readyReject(new Error("Extension process could not be started."));
    }
  });

  const cancel = () => stop();
  const onAbort = () => void stop().catch(() => undefined);
  input.signal.addEventListener("abort", onAbort, { once: true });
  void wait.finally(() => {
    input.signal.removeEventListener("abort", onAbort);
    if (receiptPath !== undefined) void unlink(receiptPath).catch(() => undefined);
  });

  try {
    await waitForSpawn(child);
    if (child.pid === undefined) throw new Error("Extension process did not expose a valid pid.");
    ownedProcessIdentity = await processIdentity(child.pid);
    if (ownedProcessIdentity === undefined) {
      signalProcessGroup(child.pid, "SIGKILL");
      throw new Error("Extension process identity is unavailable.");
    }
    if (receiptDirectory !== undefined) {
      await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
      await chmod(receiptDirectory, 0o700);
      receiptPath = join(receiptDirectory, receiptName(input));
      await writeReceipt(receiptPath, input, child.pid, ownedProcessIdentity);
    }
    if (input.readiness === "spawn" && !readySettled) {
      readySettled = true;
      readyResolve();
    }
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }

  return {
    pid: child.pid ?? -1,
    ready,
    wait,
    stop,
    cancel,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    once: child.once.bind(child),
  };
}

async function prepareProcessLaunch(
  input: ExtensionProcessStartInput,
  platform: NodeJS.Platform,
  sandboxPath: string,
): Promise<{ readonly command: string; readonly args: string[] }> {
  if (input.sandbox === undefined) {
    return { command: input.command, args: [...input.args] };
  }
  if (input.sandbox.kind !== "macos-seatbelt" || platform !== "darwin") {
    throw new Error("Extension process sandbox is unavailable on this host.");
  }
  if (!isAbsolute(sandboxPath)) {
    throw new Error("Extension process sandbox path must be absolute.");
  }
  try {
    await access(sandboxPath, constants.X_OK);
  } catch {
    throw new Error("Extension process sandbox is unavailable on this host.");
  }
  const executable = await realpath(input.command).catch(() => input.command);
  const executableDirectory = dirname(executable);
  const executableRuntime = dirname(executableDirectory);
  const readRoots = uniqueAbsolutePaths([
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/dev",
    "/private/etc",
    "/private/var/db",
    "/Library/Apple",
    executableDirectory,
    executableRuntime,
    input.cwd,
    ...input.sandbox.allowRead,
  ]);
  const writeRoots = uniqueAbsolutePaths(input.sandbox.allowWrite);
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    ...readRoots.map((path) => seatbeltRule("file-read*", path)),
    ...writeRoots.map((path) => seatbeltRule("file-write*", path)),
    '(allow file-write-data (literal "/dev/null"))',
    ...(input.sandbox.allowNetwork ? ["(allow network*)"] : []),
  ].join("\n");
  return {
    command: sandboxPath,
    args: ["-p", `${profile}\n`, "--", input.command, ...input.args],
  };
}

function uniqueAbsolutePaths(paths: ReadonlyArray<string>): string[] {
  const unique = new Set<string>();
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error("Extension sandbox paths must be absolute.");
    unique.add(path);
  }
  return [...unique].sort();
}

function seatbeltRule(operation: "file-read*" | "file-write*", path: string): string {
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `(allow ${operation} (subpath "${escaped}"))`;
}

async function readReceipts(
  receiptDirectory: string | undefined,
  shutdownTimeoutMs: number,
  processIdentity: (pid: number) => Promise<string | undefined>,
): Promise<ReadonlyArray<ExtensionProcessReceipt>> {
  if (receiptDirectory === undefined) return [];
  let names: string[];
  try {
    names = (await readdir(receiptDirectory)).sort().slice(0, MAX_RECEIPTS);
  } catch {
    return [];
  }
  const receipts: ExtensionProcessReceipt[] = [];
  for (const name of names) {
    if (!/^receipt-[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(receiptDirectory, name);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_RECEIPT_BYTES) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      const receipt = parseReceipt(JSON.parse(await readFile(path, "utf8")));
      if (
        !processGroupExists(receipt.pid) ||
        (await processIdentity(receipt.pid)) !== receipt.processIdentity
      ) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      receipts.push({
        extensionId: receipt.extensionId,
        packageId: receipt.packageId,
        componentId: receipt.componentId,
        version: receipt.version,
        digest: receipt.digest,
        state: "running",
        stop: () =>
          terminatePid(receipt.pid, shutdownTimeoutMs, receipt.processIdentity, processIdentity),
        remove: () => unlink(path).catch(() => undefined),
      });
    } catch {
      await unlink(path).catch(() => undefined);
    }
  }
  return receipts;
}

async function writeReceipt(
  path: string,
  input: ExtensionProcessStartInput,
  pid: number | undefined,
  processIdentity: string,
): Promise<void> {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Extension process did not expose a valid pid.");
  }
  const receipt: DurableReceipt = {
    schemaVersion: 2,
    extensionId: input.extensionId,
    packageId: input.packageId,
    componentId: input.componentId,
    version: input.version,
    digest: input.digest,
    pid,
    processIdentity,
    startedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(receipt);
  if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES) {
    throw new Error("Extension ownership receipt exceeded its bound.");
  }
  await writeFile(path, serialized, { mode: 0o600 });
  await chmod(path, 0o600);
}

function parseReceipt(value: unknown): DurableReceipt {
  if (typeof value !== "object" || value === null) throw new Error("Invalid receipt.");
  const receipt = value as Partial<DurableReceipt>;
  if (
    receipt.schemaVersion !== 2 ||
    typeof receipt.extensionId !== "string" ||
    typeof receipt.packageId !== "string" ||
    typeof receipt.componentId !== "string" ||
    typeof receipt.version !== "string" ||
    typeof receipt.digest !== "string" ||
    !Number.isSafeInteger(receipt.pid) ||
    (receipt.pid as number) < 1 ||
    typeof receipt.processIdentity !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.processIdentity) ||
    typeof receipt.startedAt !== "string"
  ) {
    throw new Error("Invalid receipt.");
  }
  return receipt as DurableReceipt;
}

function receiptName(input: ExtensionProcessStartInput): string {
  const identity = [
    input.extensionId,
    input.packageId,
    input.componentId,
    input.version,
    input.digest,
  ].join("\0");
  return `receipt-${createHash("sha256").update(identity).digest("hex")}.json`;
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(new Error("Extension process could not be started.")));
  });
}

async function terminate(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  expectedIdentity: string | undefined,
  processIdentity: (pid: number) => Promise<string | undefined>,
): Promise<void> {
  if (child.pid === undefined) return;
  await terminatePid(child.pid, timeoutMs, expectedIdentity, processIdentity);
}

async function terminatePid(
  pid: number,
  timeoutMs: number,
  expectedIdentity: string | undefined,
  processIdentity: (pid: number) => Promise<string | undefined>,
): Promise<void> {
  if (!(await ownsProcess(pid, expectedIdentity, processIdentity))) return;
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForOwnedProcessExit(pid, timeoutMs, expectedIdentity, processIdentity)) return;
  if (!(await ownsProcess(pid, expectedIdentity, processIdentity))) return;
  signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForOwnedProcessExit(pid, timeoutMs, expectedIdentity, processIdentity))) {
    throw new Error("Extension process group did not terminate after SIGKILL.");
  }
}

async function ownsProcess(
  pid: number,
  expectedIdentity: string | undefined,
  processIdentity: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
  if (!processGroupExists(pid)) return false;
  if (expectedIdentity === undefined) return false;
  return (await processIdentity(pid)) === expectedIdentity;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" && process.platform !== "win32") {
      process.kill(pid, signal);
      return;
    }
    if (code !== "ESRCH") throw error;
  }
}

async function waitForOwnedProcessExit(
  pid: number,
  timeoutMs: number,
  expectedIdentity: string | undefined,
  processIdentity: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ((await ownsProcess(pid, expectedIdentity, processIdentity)) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return !(await ownsProcess(pid, expectedIdentity, processIdentity));
}

async function readProcessIdentity(pid: number): Promise<string | undefined> {
  try {
    if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
    if (process.platform === "linux") {
      const [processStat, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const commandEnd = processStat.lastIndexOf(")");
      if (commandEnd < 0) return undefined;
      const fields = processStat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/);
      const processGroupId = fields[2];
      const startTicks = fields[19];
      if (processGroupId !== String(pid) || startTicks === undefined) return undefined;
      return hashProcessIdentity(["linux", String(pid), bootId.trim(), startTicks]);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync(
        "/bin/ps",
        ["-o", "pid=,pgid=,lstart=", "-p", String(pid)],
        { timeout: 1_000, maxBuffer: 4_096 },
      );
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(stdout);
      if (match?.[1] !== String(pid) || match[2] !== String(pid) || match[3] === undefined) {
        return undefined;
      }
      return hashProcessIdentity(["darwin", match[1], match[2], match[3]]);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function hashProcessIdentity(parts: ReadonlyArray<string>): string {
  return `sha256:${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

function bounded(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value < 1 ? fallback : value;
}

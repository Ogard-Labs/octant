import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  makeProcessConfinementLive,
  SEATBELT_DENY_SERVER_CONTROL_SOCKETS,
  seatbeltAllowLiteralMetadataRule,
  seatbeltAllowLiteralReadRule,
} from "../process/seatbeltProfile";
import {
  captureProcessGroupWitnesses,
  ownsProcessGroup,
  readProcessIdentity,
  terminateOwnedProcess,
  type ProcessGroupWitness,
} from "../process/nodeOwnedProcessReceipt";
import type {
  ExtensionProcessExit,
  ExtensionProcessHandle,
  ExtensionProcessPort,
  ExtensionProcessReceipt,
  ExtensionProcessStartInput,
  OutsideDriverProcessSandbox,
  CanvasExportProcessSandbox,
} from "./extensionSupervisor";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const SAFE_PATH = "/usr/bin:/bin";
const READY_HANDSHAKE = "OCTANT_EXTENSION_READY";
const MAX_HANDSHAKE_BYTES = 1_024;
const MAX_RECEIPT_BYTES = 4_096;
const MAX_RECEIPTS = 256;

// Executable components become ready only after emitting this complete stdout line.

export interface NodeExtensionProcessPortOptions {
  readonly spawn?: typeof nodeSpawn;
  readonly shutdownTimeoutMs?: number;
  readonly receiptDirectory?: string;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly sandboxPath?: string;
  /** The home folder whose private paths the driver profile denies; the host's by default. */
  readonly homeDirectory?: string;
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
        options.homeDirectory,
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
  homeDirectory: string | undefined,
): Promise<ExtensionProcessHandle> {
  if (!isAbsolute(input.command) || !isAbsolute(input.cwd)) {
    throw new Error("Extension process launch metadata must use absolute paths.");
  }
  if (input.signal.aborted)
    throw new DOMException("Extension process was interrupted.", "AbortError");

  let child: ChildProcessWithoutNullStreams;
  try {
    const launch = await prepareProcessLaunch(input, platform, sandboxPath, homeDirectory);
    child = spawn(launch.command, launch.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env:
        input.sandbox?.kind === "outside-driver" || input.sandbox?.kind === "canvas-export"
          ? outsideDriverEnvironment(input.sandbox)
          : { PATH: SAFE_PATH, ...input.env },
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
  const readiness = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let ownershipReadyResolve!: () => void;
  const ownershipReady = new Promise<void>((resolve) => {
    ownershipReadyResolve = resolve;
  });
  let witnesses: ReadonlyArray<ProcessGroupWitness> = [];
  const ready = Promise.all([readiness, ownershipReady]).then(async () => {
    if (child.pid !== undefined && ownedProcessIdentity !== undefined) {
      const observed = await captureProcessGroupWitnesses(
        child.pid,
        ownedProcessIdentity,
        processIdentity,
      );
      if (observed.length > 0) witnesses = observed;
    }
  });
  void ready.catch(() => undefined);
  let outputBytes = 0;
  let outputOverflowed = false;
  let handshakeBuffer = "";
  let termination: Promise<void> | undefined;
  let receiptPath: string | undefined;
  let ownedProcessIdentity: string | undefined;
  const stop = (): Promise<void> => {
    termination ??= (async () => {
      if (child.pid === undefined) return;
      if (ownedProcessIdentity === undefined) {
        // The ChildProcess handle still identifies the direct launch. Without
        // its stable group identity it cannot authorize a negative-PID signal.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await waitForDirectChildExit(wait, shutdownTimeoutMs);
      } else {
        await terminateOwnedProcess(
          child.pid,
          ownedProcessIdentity,
          shutdownTimeoutMs,
          processIdentity,
          undefined,
          undefined,
          witnesses,
        );
      }
      if (receiptPath !== undefined) await unlink(receiptPath).catch(() => undefined);
    })();
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
  void wait
    .then(async () => {
      input.signal.removeEventListener("abort", onAbort);
      if (
        receiptPath === undefined ||
        child.pid === undefined ||
        ownedProcessIdentity === undefined
      )
        return;
      // A closed leader does not establish that all its descendants have exited.
      if (
        !(await ownsProcessGroup(
          child.pid,
          ownedProcessIdentity,
          processIdentity,
          undefined,
          witnesses,
        ))
      ) {
        await unlink(receiptPath).catch(() => undefined);
      }
    })
    .catch(() => undefined);

  try {
    await waitForSpawn(child);
    if (child.pid === undefined) throw new Error("Extension process did not expose a valid pid.");
    ownedProcessIdentity = await processIdentity(child.pid);
    if (ownedProcessIdentity === undefined) {
      throw new Error("Extension process identity is unavailable.");
    }
    witnesses = await captureProcessGroupWitnesses(
      child.pid,
      ownedProcessIdentity,
      processIdentity,
    );
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
  } finally {
    ownershipReadyResolve();
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
  homeDirectory: string | undefined,
): Promise<{ readonly command: string; readonly args: string[] }> {
  if (input.sandbox === undefined) {
    return { command: input.command, args: [...input.args] };
  }
  if (input.sandbox.kind === "outside-driver" || input.sandbox.kind === "canvas-export") {
    return await prepareOutsideDriverLaunch(
      input,
      input.sandbox,
      platform,
      sandboxPath,
      homeDirectory,
    );
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
    ...homebrewRuntimeRoots(executable),
    input.cwd,
    ...input.sandbox.allowRead,
  ]);
  // Measured on macOS with node 22 and 26: node aborts at start unless it can
  // read "/" itself, realpaths its entry script by lstat-ing every parent
  // folder, and is launched through the PATH symlink (`/opt/homebrew/bin/node`),
  // which must be readable before exec. These grant names and metadata only,
  // never the contents of a parent folder.
  const readLiterals = uniqueAbsolutePaths([
    "/",
    ...(executable === input.command ? [] : [input.command]),
  ]);
  const metadataLiterals = uniqueAbsolutePaths(
    [...readRoots, ...readLiterals].flatMap((path) => parentFolders(path)),
  );
  const writeRoots = uniqueAbsolutePaths(input.sandbox.allowWrite);
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    ...readRoots.map((path) => seatbeltRule("file-read*", path)),
    ...readLiterals.map((path) => seatbeltLiteral("file-read*", path)),
    ...metadataLiterals.map((path) => seatbeltLiteral("file-read-metadata", path)),
    ...writeRoots.map((path) => seatbeltRule("file-write*", path)),
    '(allow file-write-data (literal "/dev/null"))',
    ...(input.sandbox.allowNetwork ? ["(allow network*)"] : []),
    ...SEATBELT_DENY_SERVER_CONTROL_SOCKETS,
  ].join("\n");
  return {
    command: sandboxPath,
    args: ["-p", `${profile}\n`, "--", input.command, ...input.args],
  };
}

/**
 * The system roots the extension profile above measured an interpreted
 * runtime reading to start, less what a driver has no use for: `/bin` and
 * `/sbin` hold only programs it may not exec, and `/dev` is narrowed to the
 * data devices, because the person's own terminals are devices there that
 * their user may read. `/Library/Apple` holds Apple's add-ons outside the
 * sealed system, Rosetta's translator among them, which only an Intel
 * runtime on Apple Silicon loads. `/usr` is narrowed to the loader and
 * libraries in `lib` and the ICU and zone data in `share`: the rest holds
 * programs it may not exec and, in `local`, whatever the person installed.
 * `/private/var/db` is narrowed to the zone data the time-zone link leads
 * to. `/System` is not read at all: Bun and Electron's Node started, served
 * a driver's handshake, probe, and streamed send, and gave the same Intl,
 * crypto, zlib, worker, and `os` answers with no read under it, since the
 * system frameworks they link come from the shared cache the loader maps
 * without a file read. Each narrowing is listed in the outside driver
 * specification, so a runtime that fails to start without one can have that
 * one restored.
 */
const OUTSIDE_DRIVER_SYSTEM_READ_ROOTS = [
  "/usr/lib",
  "/usr/share",
  "/private/var/db/timezone",
] as const;
/**
 * The data volume. Since macOS 10.15 the person's files live on a volume
 * mounted at `/System/Volumes/Data`, and every folder the sealed system volume
 * links there (`/Users`, `/private`, `/opt`, `/Applications`, `/Library`,
 * `/usr/local`) can be spelled beneath it too:
 * `/System/Volumes/Data/Users/<name>/...` is the file `/Users/<name>/...`. The
 * home and `/private` denials name only the short spelling. No grant reaches
 * `/System` now, but the volume stays denied whole after every grant, so a
 * `/System` grant restored for some runtime cannot reopen the home folder
 * by that spelling.
 */
const OUTSIDE_DRIVER_DENIED_SYSTEM_ROOTS = ["/System/Volumes/Data"];
const OUTSIDE_DRIVER_DEVICE_READS = ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"];
/**
 * Of `/private/etc`, only the link naming the host's time zone, which a
 * runtime follows to give the driver local time. The rest (the host's user
 * and group lists, its hosts and name-service files, its SSH and sudo
 * configuration) is nothing a driver with no network or exec has a use for.
 * A runtime opens that link as `/etc/localtime`, through the root link `/etc`;
 * without a read of that link itself, Bun and Electron's Node both fell back
 * to UTC. The link is granted alone, never as a folder, so every other name
 * through it still resolves into the denied `/private/etc`.
 */
const OUTSIDE_DRIVER_SYSTEM_FILE_READS = ["/etc", "/private/etc/localtime"];

/**
 * The whole environment an outside driver gets, whatever the caller passed:
 * the system search path, a fixed locale, and its own temporary folder as both
 * `TMPDIR` and `HOME`, so a runtime that keeps a cache under its home writes
 * only into the folder removed at stop and learns no path of the person's.
 * Nothing is inherited: no provider or cloud key, no broker coordinates, no
 * Project or checkout path. Electron's executable runs as Node only with
 * `ELECTRON_RUN_AS_NODE=1`, so that runtime gets that one switch and nothing
 * else: no `NODE_OPTIONS`, which would reach its Node through the default
 * fuses, and no flag, since the entry is the command line's one argument.
 */
function outsideDriverEnvironment(
  sandbox: OutsideDriverProcessSandbox | CanvasExportProcessSandbox,
): Readonly<Record<string, string>> {
  return {
    PATH: SAFE_PATH,
    LANG: "en_US.UTF-8",
    HOME: sandbox.temporaryDirectory,
    TMPDIR: sandbox.temporaryDirectory,
    ...(sandbox.runtime === "electron-node" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
}

/**
 * What a driver's runtime reads to start. Bun reads its own folder and
 * nothing beside it: it is one self-contained executable linking only the
 * system's libraries, so neither the folder above it (`~/.bun`, which holds
 * its install cache) nor, for a Homebrew Bun, the prefix's other formulae
 * and OpenSSL config are read. Those grants were the extension profile's,
 * whose Node loads modules from beside its folder and Homebrew libraries.
 * Electron's Node loads Electron's framework, ICU data, and V8 snapshot from
 * the app bundle that holds its executable (`<name>.app/Contents/MacOS/<name>`),
 * so that bundle is the read root, taken from the runtime's own path. An
 * Electron outside an app bundle is not a layout this profile was measured
 * for, so it is refused rather than guessed at.
 */
function outsideDriverRuntimeReadRoots(
  runtime: string,
  kind: OutsideDriverProcessSandbox["runtime"],
): ReadonlyArray<string> {
  if (kind === "bun") {
    return [dirname(runtime)];
  }
  const executableFolder = dirname(runtime);
  const contents = dirname(executableFolder);
  const bundle = dirname(contents);
  if (
    basename(executableFolder) !== "MacOS" ||
    basename(contents) !== "Contents" ||
    !bundle.endsWith(".app")
  ) {
    throw new Error("Extension process sandbox is unavailable on this host.");
  }
  return [bundle];
}

/**
 * The temporary folder is the one place a driver may write, and the profile
 * grants it whole, so it is checked here rather than trusted to the caller:
 * a real folder (not a link to somewhere else), owned by this user and
 * closed to everyone else, empty, and apart from the package it may only
 * read and from the home folder whose private paths the profile denies. The
 * driver process owner makes exactly such a folder for every start.
 */
async function assertOwnTemporaryFolder(
  sandbox: OutsideDriverProcessSandbox | CanvasExportProcessSandbox,
  homeDirectory: string | undefined,
): Promise<void> {
  const folder = sandbox.temporaryDirectory;
  const overlaps = (left: string, right: string) =>
    isInsideOrEqual(left, right) || isInsideOrEqual(right, left);
  const status = await lstat(folder).catch(() => undefined);
  const owner = process.getuid?.();
  if (
    status === undefined ||
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (owner !== undefined && status.uid !== owner) ||
    (status.mode & 0o077) !== 0 ||
    (await readdir(folder).catch(() => undefined))?.length !== 0 ||
    overlaps(folder, sandbox.packageRoot) ||
    (homeDirectory !== undefined && isInsideOrEqual(homeDirectory, folder))
  ) {
    throw new Error("Outside driver temporary folder is not its own.");
  }
}

function isInsideOrEqual(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && !fromRoot.split(/[\\/]/).includes(".."));
}

/**
 * An outside provider driver runs under the shared confinement builder's
 * deny-default Seatbelt profile, stricter than an MCP server's: no network, no
 * exec but the runtime itself, no fork, the package read-only, and writes only
 * into the process's own temporary folder. Extension processes have no Linux
 * confinement, so any other platform refuses before a process exists.
 */
async function prepareOutsideDriverLaunch(
  input: ExtensionProcessStartInput,
  sandbox: OutsideDriverProcessSandbox | CanvasExportProcessSandbox,
  platform: NodeJS.Platform,
  sandboxPath: string,
  homeDirectory: string | undefined,
): Promise<{ readonly command: string; readonly args: string[] }> {
  if (platform !== "darwin") {
    throw new Error("Extension process sandbox is unavailable on this host.");
  }
  if (!isAbsolute(sandbox.packageRoot) || !isAbsolute(sandbox.temporaryDirectory)) {
    throw new Error("Extension sandbox paths must be absolute.");
  }
  await assertOwnTemporaryFolder(sandbox, homeDirectory);
  let args = input.args;
  if (sandbox.kind === "canvas-export") {
    if (args[0] !== sandbox.workerEntryPoint)
      throw new Error("Canvas export bootstrap does not match its launch.");
    // Bun enumerates the entry's directory before loading it. Stage only the
    // trusted bootstrap in the already-private scratch folder; never grant a
    // read of the host checkout to satisfy module discovery.
    const stagedWorker = join(sandbox.temporaryDirectory, "canvas-export-bootstrap.mjs");
    await copyFile(sandbox.workerEntryPoint, stagedWorker, constants.COPYFILE_EXCL);
    await chmod(stagedWorker, 0o400);
    args = [stagedWorker, ...args.slice(1)];
  }
  const runtime = await realpath(input.command).catch(() => input.command);
  const readRoots = uniqueAbsolutePaths([
    sandbox.packageRoot,
    ...outsideDriverRuntimeReadRoots(runtime, sandbox.runtime),
    ...OUTSIDE_DRIVER_SYSTEM_READ_ROOTS,
  ]);
  // As for the extension profile: the runtime reads "/" and stats every parent
  // folder of what it loads, and starts through a PATH link that must itself
  // be readable. Names and metadata only, never a parent folder's contents.
  const readLiterals = uniqueAbsolutePaths([
    "/",
    ...OUTSIDE_DRIVER_DEVICE_READS,
    ...OUTSIDE_DRIVER_SYSTEM_FILE_READS,
    ...(runtime === input.command ? [] : [input.command]),
  ]);
  const metadataLiterals = uniqueAbsolutePaths(
    [...readRoots, ...readLiterals, sandbox.temporaryDirectory].flatMap((path) =>
      parentFolders(path),
    ),
  );
  const launch = makeProcessConfinementLive({
    platform,
    sandboxPath,
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
  }).prepare({
    executable: input.command,
    args,
    boundRoot: sandbox.packageRoot,
    writeBoundRoot: false,
    temporaryDirectory: sandbox.temporaryDirectory,
    readRoots,
    networkEgress: "none",
    // The builder lets every launch read the system's public TLS files so
    // that an offline one fails at the socket rather than before it. A
    // driver never opens a socket, so it reads none of them.
    additionalDenyReadPaths: ["/private/etc/ssl"],
    // Denied after the read roots, not among the denials above: those come
    // before the roots, so a later `/System` grant would open the volume again.
    isolatedRoots: OUTSIDE_DRIVER_DENIED_SYSTEM_ROOTS,
    allowProcessExec: false,
    allowProcessFork: false,
    interpreterSearchPath: SAFE_PATH,
    extraRules: [
      ...readLiterals.map(seatbeltAllowLiteralReadRule),
      ...metadataLiterals.map(seatbeltAllowLiteralMetadataRule),
    ],
  });
  return { command: launch.command, args: [...launch.args] };
}

function uniqueAbsolutePaths(paths: ReadonlyArray<string>): string[] {
  const unique = new Set<string>();
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error("Extension sandbox paths must be absolute.");
    unique.add(path);
  }
  return [...unique].sort();
}

/**
 * A runtime installed by Homebrew (`<prefix>/Cellar/<formula>/<version>/...`)
 * loads its libraries through `<prefix>/opt/<dependency>` links into other
 * formulae, and OpenSSL reads `<prefix>/etc/openssl@3`. Without them node
 * aborted before running a line. These hold installed software only; the
 * prefix's `var` (service data) and the rest of `etc` stay unreadable.
 */
function homebrewRuntimeRoots(executable: string): ReadonlyArray<string> {
  const marker = "/Cellar/";
  const index = executable.indexOf(marker);
  if (index <= 0) return [];
  const prefix = executable.slice(0, index);
  return [join(prefix, "Cellar"), join(prefix, "opt"), join(prefix, "etc", "openssl@3")];
}

function parentFolders(path: string): ReadonlyArray<string> {
  const parents: string[] = [];
  for (let current = dirname(path); current !== dirname(current); current = dirname(current)) {
    parents.push(current);
  }
  return parents;
}

function seatbeltLiteral(operation: "file-read*" | "file-read-metadata", path: string): string {
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `(allow ${operation} (literal "${escaped}"))`;
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
    names = (await readdir(receiptDirectory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.length > MAX_RECEIPTS) throw new Error("Too many extension ownership receipts.");
  const receipts: ExtensionProcessReceipt[] = [];
  for (const name of names) {
    if (!/^receipt-[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(receiptDirectory, name);
    let receipt: DurableReceipt | undefined;
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_RECEIPT_BYTES)
        throw new Error("Invalid receipt size.");
      receipt = parseReceipt(JSON.parse(await readFile(path, "utf8")));
      if (!(await ownsProcessGroup(receipt.pid, receipt.processIdentity, processIdentity))) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      const owned = receipt;
      let termination: Promise<void> | undefined;
      receipts.push({
        extensionId: owned.extensionId,
        packageId: owned.packageId,
        componentId: owned.componentId,
        version: owned.version,
        digest: owned.digest,
        state: "running",
        stop: () =>
          (termination ??= terminateOwnedProcess(
            owned.pid,
            owned.processIdentity,
            shutdownTimeoutMs,
            processIdentity,
          )),
        remove: () => unlink(path).catch(() => undefined),
      });
    } catch (error) {
      if (receipt === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
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

async function waitForDirectChildExit(
  wait: Promise<ExtensionProcessExit>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      wait,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Extension launch did not exit after SIGKILL.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function bounded(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value < 1 ? fallback : value;
}

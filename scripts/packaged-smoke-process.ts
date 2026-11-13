import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  readHostInteractionMark,
  type HostInteractionMark,
} from "../apps/desktop/src/interactionTrace";
import { decodeHostInfoReceipt } from "../packages/host-runtime/src/hostInfo";
import { BoundedHostLogStore } from "../packages/host-runtime/src/logs";

export interface SmokeChildProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly pid: number | undefined;
}

export interface BoundedCommandHandle {
  readonly exit: Promise<number | null>;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
  readonly terminate: () => Promise<void>;
}

const DEFAULT_PACKAGED_SMOKE_SERVER_PORT = 13_773;

/**
 * The port every packaged smoke gives its app. A developer's own Octant
 * normally holds the default, so `OCTANT_SMOKE_SERVER_PORT` moves the smoke
 * to a free one; an unusable value fails loudly rather than falling back.
 */
export function packagedSmokeServerPort(source: NodeJS.ProcessEnv): number {
  const raw = source.OCTANT_SMOKE_SERVER_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PACKAGED_SMOKE_SERVER_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65_535) {
    throw new Error("OCTANT_SMOKE_SERVER_PORT must be a TCP port between 1 and 65535.");
  }
  return port;
}

export const PACKAGED_SMOKE_SERVER_PORT = packagedSmokeServerPort(process.env);
/** What the app last wrote, for a poll that timed out before it could answer. */
export function appOutputContext(outputTail: () => string): string {
  const output = outputTail().replace(/\s+/g, " ").trim();
  return output.length === 0 ? "" : ` The app last wrote: ${output.slice(-800)}`;
}

/**
 * The last few kilobytes a packaged app wrote, for a failure that has to say
 * why. A smoke that discards the app's output can report only the symptom it
 * polls for — a bundle whose server dies on a missing import reads as "was not
 * storage-ready" — and the line that names the import is gone with it.
 */
export function boundedOutputTail(maxBytes = 4_096): {
  readonly append: (chunk: Buffer | string) => void;
  readonly text: () => string;
} {
  let buffer = "";
  return {
    append(chunk) {
      buffer = (buffer + chunk.toString()).slice(-maxBytes);
    },
    text() {
      return buffer;
    },
  };
}

/**
 * Launch the packaged app the way a smoke must: detached, with its output kept.
 */
export function spawnPackagedApplication(input: {
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}): { readonly child: ChildProcess; readonly outputTail: () => string } {
  const child = spawn(input.executable, [...(input.args ?? [])], {
    detached: true,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = boundedOutputTail();
  child.stdout?.on("data", (chunk: Buffer) => output.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.append(chunk));
  return { child, outputTail: output.text };
}

/**
 * The desktop's local launch marks (`OCTANT_PERF_TRACE=1`), read line by line
 * as they arrive. The bounded output tail keeps only the last few kilobytes, so
 * the early launch marks would be gone by the time a slow stage gave up.
 */
export function collectHostInteractionMarks(
  stream: NodeJS.ReadableStream | null | undefined,
): () => ReadonlyArray<HostInteractionMark> {
  const marks: HostInteractionMark[] = [];
  let partial = "";
  stream?.on("data", (chunk: Buffer | string) => {
    const lines = (partial + chunk.toString()).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const mark = readHostInteractionMark(line);
      if (mark !== undefined) marks.push(mark);
    }
  });
  return () => [...marks];
}

export interface ColdLaunchPhase {
  readonly phase: string;
  /** Undefined when the phase was never observed. */
  readonly sinceLaunchMs: number | undefined;
}

/**
 * Where a cold launch spent its time, from the moment the smoke started the
 * app. Each phase is its first occurrence: a later Chat refresh sends the same
 * request again and says nothing about launch.
 */
export function coldLaunchPhases(input: {
  readonly launchedAt: number;
  readonly marks: ReadonlyArray<HostInteractionMark>;
  readonly hostListeningAt: number | undefined;
  readonly serverReadyAt: number | undefined;
}): ReadonlyArray<ColdLaunchPhase> {
  const first = (layer: HostInteractionMark["layer"], name: string) =>
    input.marks.find((mark) => mark.layer === layer && mark.name === name)?.at;
  const since = (at: number | undefined) => (at === undefined ? undefined : at - input.launchedAt);
  const failedAt = first("renderer", "chat-bootstrap-failed");
  return [
    { phase: "desktop starts the host", sinceLaunchMs: since(first("server", "host-start")) },
    { phase: "host listening", sinceLaunchMs: since(input.hostListeningAt) },
    { phase: "server.ready", sinceLaunchMs: since(input.serverReadyAt) },
    { phase: "window opened", sinceLaunchMs: since(first("native-window", "ready-to-show")) },
    {
      phase: "Chat bootstrap request sent",
      sinceLaunchMs: since(first("renderer", "chat-bootstrap-sent")),
    },
    {
      phase: "Chat bootstrap answered",
      sinceLaunchMs: since(first("renderer", "chat-bootstrap-answered")),
    },
    ...(failedAt === undefined
      ? []
      : [{ phase: "Chat bootstrap failed", sinceLaunchMs: since(failedAt) }]),
  ];
}

export function formatColdLaunchPhases(phases: ReadonlyArray<ColdLaunchPhase>): string {
  return [
    "Cold launch phases (ms since the smoke started the app):",
    ...phases.map(({ phase, sinceLaunchMs }) =>
      sinceLaunchMs === undefined ? `  ${phase}: not observed` : `  ${phase}: ${sinceLaunchMs}`,
    ),
  ].join("\n");
}

/**
 * When the host was listening and when it reported ready, read from the files
 * the host already writes: its host-info receipt (written once it listens) and
 * the `server.ready` line of its service log. A file that is missing or
 * unreadable reads as not observed; a timing report never fails a smoke.
 */
export async function readHostStartupTimes(input: {
  readonly dataDirectory: string;
  readonly logsDirectory: string;
}): Promise<{
  readonly hostListeningAt: number | undefined;
  readonly serverReadyAt: number | undefined;
}> {
  const hostListeningAt = await readFile(join(input.dataDirectory, "octant-host.json"), "utf8")
    .then((text) => Date.parse(decodeHostInfoReceipt(text).updatedAt))
    .catch(() => undefined);
  const serverReadyAt = await new BoundedHostLogStore({
    path: join(input.logsDirectory, "service.log"),
  })
    .read({ limit: 2_000 })
    .then(({ entries }) => {
      const ready = entries.find((entry) => entry.event === "server.ready");
      return ready === undefined ? undefined : Date.parse(ready.timestamp);
    })
    .catch(() => undefined);
  return {
    hostListeningAt: Number.isNaN(hostListeningAt) ? undefined : hostListeningAt,
    serverReadyAt: Number.isNaN(serverReadyAt) ? undefined : serverReadyAt,
  };
}

/**
 * Where a packaged smoke launches the app from: a copy outside the checkout.
 *
 * Node resolves a bare import by walking up from the importing file, so a
 * bundle launched where it was built reaches the repository's own
 * `node_modules` for anything the app neither bundles nor copies — the server
 * starts, the smoke passes, and the app a person installs fails at the same
 * import. Somebody who installs Octant runs it from outside any checkout, so
 * the smokes run it from the same kind of place.
 *
 * A checkout with no built bundle is returned as it is: the smoke's own
 * precondition then reports the missing app instead of this step.
 */
export function stagePackagedAppBundle(sourceBundle: string): string {
  if (!existsSync(sourceBundle)) return sourceBundle;
  const root = mkdtempSync(join(tmpdir(), "octant-packaged-app."));
  const appBundle = join(root, basename(sourceBundle));
  cloneBundle(sourceBundle, appBundle);
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  return appBundle;
}

function cloneBundle(source: string, destination: string): void {
  // An APFS clone stages half a gigabyte in milliseconds; anywhere else falls
  // back to a recursive copy.
  if (process.platform === "darwin") {
    try {
      execFileSync("/bin/cp", ["-cR", source, destination], { stdio: "ignore" });
      return;
    } catch {
      rmSync(destination, { recursive: true, force: true });
    }
  }
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

export const PACKAGED_SMOKE_SERVER_URL = `http://127.0.0.1:${PACKAGED_SMOKE_SERVER_PORT}`;
export const PACKAGED_SMOKE_PROCESS_PROBE_TIMEOUT_MS = 10_000;

export type StartBoundedCommand = (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) => BoundedCommandHandle;

interface CleanupPackagedProcessOptions {
  readonly child: SmokeChildProcess;
  readonly requestQuit: () => Promise<void>;
  readonly waitForExit: (child: SmokeChildProcess, timeoutMs: number) => Promise<boolean>;
  readonly signalGroup: (pid: number, signal: "SIGKILL" | "SIGTERM") => void;
  readonly waitForServerCleanup: () => Promise<void>;
  readonly assertNoProcesses: () => Promise<void>;
  readonly gracefulTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
}

/**
 * A failed smoke request has to say what the server said. Without the body a
 * probe failure reads as "status 400" while the answer - discovery-only, an
 * unrecognized version, a missing privilege - sits unread in the response.
 */
export async function describeFailedResponse(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  const detail = body.replace(/\s+/g, " ").trim().slice(0, 500);
  return new Error(
    detail.length === 0
      ? `${label} failed with status ${response.status}.`
      : `${label} failed with status ${response.status}: ${detail}`,
  );
}

export function sanitizedPackagedEnvironment(
  source: NodeJS.ProcessEnv,
  dataDirectory: string,
): NodeJS.ProcessEnv {
  return {
    ...(source.HOME === undefined ? {} : { HOME: source.HOME }),
    ...(source.TMPDIR === undefined ? {} : { TMPDIR: source.TMPDIR }),
    ...(source.LANG === undefined ? {} : { LANG: source.LANG }),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    OCTANT_DATA_DIR: dataDirectory,
  };
}

export function packagedServerEnvironment(
  source: NodeJS.ProcessEnv,
  dataDirectory: string,
): NodeJS.ProcessEnv {
  return {
    ...sanitizedPackagedEnvironment(source, dataDirectory),
    OCTANT_SERVER_PORT: String(PACKAGED_SMOKE_SERVER_PORT),
  };
}

export async function cleanupPackagedProcess(
  options: CleanupPackagedProcessOptions,
): Promise<void> {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 2_000;
  let failure: unknown;

  try {
    if (!hasExited(options.child)) {
      await options.requestQuit().catch(() => undefined);
      if (!(await options.waitForExit(options.child, gracefulTimeoutMs))) {
        const pid = options.child.pid;
        if (pid === undefined) throw new Error("Packaged Octant process has no process ID.");
        options.signalGroup(pid, "SIGTERM");
        if (!(await options.waitForExit(options.child, gracefulTimeoutMs))) {
          options.signalGroup(pid, "SIGKILL");
          if (!(await options.waitForExit(options.child, forceTimeoutMs))) {
            throw new Error("Packaged Octant process group did not exit after SIGKILL.");
          }
        }
      }
    }
  } catch (error) {
    failure = error;
  }

  for (const verifyCleanup of [options.waitForServerCleanup, options.assertNoProcesses]) {
    try {
      await verifyCleanup();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

export async function waitForProcessCleanup(
  assertNoProcesses: (probeTimeoutMs: number) => Promise<void>,
  options: {
    readonly timeoutMs: number;
    readonly probeTimeoutMs?: number;
    readonly intervalMs?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 50;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  while (true) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      await assertNoProcesses(
        Math.min(options.probeTimeoutMs ?? PACKAGED_SMOKE_PROCESS_PROBE_TIMEOUT_MS, remainingMs),
      );
      return;
    } catch (error) {
      // A probe given all the time left is stopped by a timer, and a timer may
      // fire a millisecond before the wall clock reaches the deadline. Judged
      // strictly, that last probe was retried with nothing left and its second
      // failure replaced "timed out" (seen on a hosted macOS runner).
      if (Date.now() + 1 >= deadline) throw error;
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  }
}

export async function runBoundedCommand(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  startCommand: StartBoundedCommand = startBoundedCommand,
): Promise<string> {
  const handle = startCommand(command, args, env);
  const timedOut = Symbol("timed-out");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: number | null | typeof timedOut;
  try {
    result = await Promise.race([
      handle.exit,
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (result === timedOut) {
    let terminationFailed = false;
    try {
      await handle.terminate();
    } catch {
      terminationFailed = true;
    }
    await Promise.allSettled([handle.exit, handle.stdout, handle.stderr]);
    throw new Error(
      terminationFailed
        ? `${command} timed out and process cleanup failed.`
        : `${command} timed out.`,
    );
  }

  const [stdout, stderr] = await Promise.all([handle.stdout, handle.stderr]);
  if (result !== 0) throw new Error(`${command} exited with ${result}: ${stderr.trim()}`);
  return stdout;
}

function startBoundedCommand(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): BoundedCommandHandle {
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return {
    exit,
    stdout: readStream(child.stdout),
    stderr: readStream(child.stderr),
    terminate: () => terminateCommand(child, 200),
  };
}

async function terminateCommand(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  signalCommand(child, "SIGTERM");
  if (await waitForCommandExit(child, timeoutMs)) return;
  signalCommand(child, "SIGKILL");
  if (!(await waitForCommandExit(child, timeoutMs))) {
    throw new Error("Packaged cleanup probe did not exit after SIGKILL.");
  }
}

function signalCommand(child: ChildProcess, signal: "SIGKILL" | "SIGTERM"): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForCommandExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return child.exitCode !== null || child.signalCode !== null;
}

async function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return "";
  let output = "";
  for await (const chunk of stream) output += String(chunk);
  return output;
}

function hasExited(child: SmokeChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

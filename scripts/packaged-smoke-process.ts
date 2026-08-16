import { spawn, type ChildProcess } from "node:child_process";

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

export const PACKAGED_SMOKE_SERVER_PORT = 13_773;
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
      if (Date.now() >= deadline) throw error;
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

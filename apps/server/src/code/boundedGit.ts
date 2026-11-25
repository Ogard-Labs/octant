import { spawn, type ChildProcess } from "node:child_process";

/** The longest an ordinary Git read or ref change may run before it is stopped. */
export const GIT_READ_TIME_LIMIT_MS = 2 * 60 * 1_000;

/** The longest a Git change to a worktree folder (add, remove, fetch) may run. */
export const GIT_MUTATION_TIME_LIMIT_MS = 15 * 60 * 1_000;

/** How long a stopped Git gets to leave on SIGTERM before its process group is killed. */
export const GIT_KILL_GRACE_MS = 2_000;

/**
 * How long, after the kill, the host waits for the pipes to close before it
 * closes them itself: a grandchild that outlives its parent can hold them open.
 */
const PIPE_CLOSE_MS = 1_000;

export interface BoundedGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The time limit stopped it, not the caller's signal. */
  readonly timedOut: boolean;
}

export interface BoundedGitOptions {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly graceMs?: number;
  readonly maxBuffer?: number;
}

/**
 * Runs Git and returns only after the child has exited. Stopping it (the
 * caller's signal or the time limit) sends SIGTERM to its process group, waits
 * a short grace, then SIGKILL, and waits for the close, so the per-receipt lock
 * the caller holds is never released while Git, or a hook it started, still
 * writes in the folder. A stop by the caller's signal rejects with its reason;
 * the time limit resolves with `timedOut`, which the caller chooses to treat as
 * a failed read or an interrupted change.
 */
export function runBoundedGit(options: BoundedGitOptions): Promise<BoundedGitResult> {
  const { signal } = options;
  signal.throwIfAborted();
  return new Promise<BoundedGitResult>((resolve, reject) => {
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    const grace = options.graceMs ?? GIT_KILL_GRACE_MS;
    const child = spawn(options.executable, [...options.args], {
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let stopped: "aborted" | "timeout" | "buffer" | undefined;
    let settled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const stop = (why: "aborted" | "timeout" | "buffer") => {
      if (stopped !== undefined || settled) return;
      stopped = why;
      signalTree(child, "SIGTERM");
      timers.push(setTimeout(() => signalTree(child, "SIGKILL"), grace));
    };
    const onAbort = () => stop("aborted");
    const collect = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (next.length > maxBuffer) stop("buffer");
      return next.length > maxBuffer ? next.slice(0, maxBuffer) : next;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });
    child.once("error", (error) => {
      // Never started: nothing can still be running.
      if (child.pid === undefined) finish(() => reject(error));
    });
    child.once("exit", () => {
      timers.push(
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, PIPE_CLOSE_MS),
      );
    });
    child.once("close", (code) => {
      finish(() => {
        if (stopped === "aborted") reject(signal.reason ?? new Error("git was stopped"));
        else if (stopped === "buffer") reject(new Error("git output exceeded its limit"));
        else {
          resolve({
            exitCode: code ?? 1,
            stdout,
            stderr,
            timedOut: stopped === "timeout",
          });
        }
      });
    });

    signal.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => stop("timeout"), options.timeoutMs));
  });
}

function signalTree(child: ChildProcess, name: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    if (name === "SIGKILL") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill(name);
    }
    return;
  }
  try {
    process.kill(-pid, name);
  } catch {
    try {
      child.kill(name);
    } catch {
      // Already gone.
    }
  }
}

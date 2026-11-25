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

/** How often a stopped process group is looked at to see whether it is gone. */
const GROUP_POLL_MS = 20;

/** How long after SIGKILL a process group may stay before it is reported as surviving. */
export const GIT_GROUP_CONFIRM_MS = 10_000;

/** How often a surviving group is looked at, and sent SIGKILL again. */
const SURVIVOR_POLL_MS = 250;

/**
 * Groups that outlived the kill and the confirmation time: a process stuck in
 * the kernel cannot be killed until it returns. Each entry settles when its
 * group is finally gone.
 */
const survivors = new Set<Promise<void>>();

/**
 * Settles when every process group a stopped Git left behind is gone. A lock
 * that guards a folder Git was writing in waits on it before it lets go, so a
 * helper that outlived its Git is never writing while the next operation runs.
 */
export async function waitForSurvivingGit(): Promise<void> {
  while (survivors.size > 0) await Promise.all([...survivors]);
}

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
  /** How long after SIGKILL the group may stay before it is reported as surviving. */
  readonly confirmMs?: number;
  /** Whether any process of the group led by this pid is still there; tests replace it. */
  readonly probeGroup?: (pid: number) => boolean;
  readonly maxBuffer?: number;
}

/**
 * Whether any process of the group led by `pid` exists. A group lives as long
 * as one member does, whether or not its leader or its pipes are gone. Windows
 * has no groups: only the root process is looked at, and its descendants are
 * stopped by `taskkill /T` at the stop, while the root still names them.
 */
function groupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

/**
 * Runs Git and returns only after the child has exited. Stopping it (the
 * caller's signal or the time limit) sends SIGTERM to its process group, waits
 * a short grace, then SIGKILL, and settles only once the whole group is
 * confirmed gone, however the direct child and its pipes ended: the per-receipt
 * lock the caller holds is never released while Git, or a hook it started,
 * still writes in the folder. A group that is still there `confirmMs` after
 * SIGKILL is registered as surviving (see `waitForSurvivingGit`) and the call
 * settles anyway, so a process stuck in the kernel cannot hang the caller. A
 * stop by the caller's signal rejects with its reason; the time limit resolves
 * with `timedOut`, which the caller chooses to treat as a failed read or an
 * interrupted change.
 */
export function runBoundedGit(options: BoundedGitOptions): Promise<BoundedGitResult> {
  const { signal } = options;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("git was stopped"));
  return new Promise<BoundedGitResult>((resolve, reject) => {
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    const grace = options.graceMs ?? GIT_KILL_GRACE_MS;
    const confirm = options.confirmMs ?? GIT_GROUP_CONFIRM_MS;
    const probe = options.probeGroup ?? groupExists;
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
    let closed = false;
    let groupGone = false;
    let code: number | null = null;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const settleIfDone = () => {
      if (!closed || (stopped !== undefined && !groupGone)) return;
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
    };
    const watchGroup = (pid: number, killedAt: number) => {
      const look = () => {
        if (settled) return;
        if (!probe(pid)) {
          groupGone = true;
          settleIfDone();
          return;
        }
        if (Date.now() >= killedAt + confirm) {
          // Still there after SIGKILL: keep looking after this call has gone,
          // and let the lock that guards the folder wait for it.
          const surviving: Promise<void> = outlive(pid, probe, child).then(() => {
            survivors.delete(surviving);
          });
          survivors.add(surviving);
          groupGone = true;
          closed = true;
          settleIfDone();
          return;
        }
        timers.push(setTimeout(look, GROUP_POLL_MS));
      };
      look();
    };
    const stop = (why: "aborted" | "timeout" | "buffer") => {
      if (stopped !== undefined || settled) return;
      stopped = why;
      signalTree(child, "SIGTERM");
      const killedAt = Date.now() + grace;
      // The escalation is never cancelled by the direct child leaving: only the
      // group being gone ends it.
      timers.push(setTimeout(() => signalTree(child, "SIGKILL"), grace));
      if (child.pid === undefined) {
        groupGone = true;
        return;
      }
      watchGroup(child.pid, killedAt);
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
    child.once("close", (exitCode) => {
      code = exitCode;
      closed = true;
      settleIfDone();
    });

    signal.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => stop("timeout"), options.timeoutMs));
  });
}

/** Looks at a group that survived SIGKILL until it is gone, killing it again each time. */
function outlive(
  pid: number,
  probe: (pid: number) => boolean,
  child: ChildProcess,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const look = () => {
      if (!probe(pid)) {
        resolve();
        return;
      }
      signalTree(child, "SIGKILL");
      setTimeout(look, SURVIVOR_POLL_MS);
    };
    setTimeout(look, SURVIVOR_POLL_MS);
  });
}

function signalTree(child: ChildProcess, name: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // Windows has no process groups and no SIGTERM for console programs: the
    // tree is ended at once, while the root still names it.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
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

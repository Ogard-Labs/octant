import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

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
const GROUP_POLL_MS = 50;

/** How long after SIGKILL a process group may stay before it is reported as surviving. */
export const GIT_GROUP_CONFIRM_MS = 10_000;

/** How often a surviving group is looked at, and sent SIGKILL again. */
const SURVIVOR_POLL_MS = 250;

/** The receipts the running code works for, so a Git it starts is known to be theirs. */
const workingFor = new AsyncLocalStorage<ReadonlyArray<string>>();

/**
 * Groups that outlived the kill and the confirmation time, by the receipts
 * whose folder they may still write in: a process stuck in the kernel cannot
 * be killed until it returns. Each entry settles when its group is finally gone.
 */
const survivors = new Map<string, Set<Promise<void>>>();

/** Runs `run` so that every Git it starts counts as working in this receipt's folder. */
export function forReceipt<T>(receiptId: string, run: () => T): T {
  return workingFor.run([...(workingFor.getStore() ?? []), receiptId], run);
}

/**
 * Settles when every process group a stopped Git left behind for this receipt
 * is gone. The receipt's lock waits on it before it lets go, so a helper that
 * outlived its Git is never writing while the next operation runs. A helper
 * left by another receipt's Git is not waited on: one that never leaves would
 * otherwise hold up every worktree on the host.
 */
export async function waitForSurvivingGit(receiptId: string): Promise<void> {
  for (;;) {
    const left = survivors.get(receiptId);
    if (left === undefined) return;
    await Promise.all(left);
  }
}

function registerSurvivor(receiptIds: ReadonlyArray<string>, gone: Promise<void>): void {
  for (const receiptId of receiptIds) {
    const left = survivors.get(receiptId) ?? new Set();
    survivors.set(receiptId, left);
    left.add(gone);
    void gone.then(() => {
      left.delete(gone);
      if (left.size === 0) survivors.delete(receiptId);
    });
  }
}

export interface BoundedGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The time limit stopped it, not the caller's signal. */
  readonly timedOut: boolean;
}

/** `killed` says the group has been sent SIGKILL. */
type GroupProbe = (pid: number, killed: boolean) => boolean | Promise<boolean>;

export interface BoundedGitOptions {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly graceMs?: number;
  /** How long after SIGKILL the group may stay before it is reported as surviving. */
  readonly confirmMs?: number;
  /** Whether any process of the group led by this pid still runs; tests replace it. */
  readonly probeGroup?: GroupProbe;
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

interface GroupMember {
  readonly group: number;
  readonly running: boolean;
}

/** Whether one process runs, and in which group, as `/proc/<pid>/stat` states them. */
export function memberFromStat(stat: string): GroupMember | undefined {
  // The command name is in parentheses and may hold any character.
  const fields = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const [state, , group] = fields;
  if (state === undefined || group === undefined) return undefined;
  // A process whose first thread has exited reads as a zombie while its other
  // threads, which may still write, are counted here.
  const threads = Number(fields[17]);
  return { group: Number(group), running: !/^[ZX]/i.test(state) || threads > 1 };
}

async function readProcesses(): Promise<ReadonlyArray<GroupMember>> {
  if (process.platform === "linux") {
    const ids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const stats = await Promise.all(
      // A process that left since the listing has no file to read.
      ids.map((id) => readFile(`/proc/${id}/stat`, "utf8").catch(() => "")),
    );
    return stats.flatMap((stat) => memberFromStat(stat) ?? []);
  }
  const listed = await new Promise<string>((resolve, reject) => {
    execFile("/bin/ps", ["-axo", "pgid=,stat="], { timeout: 5_000 }, (error, stdout) =>
      error === null ? resolve(stdout) : reject(error),
    );
  });
  return listed.split("\n").flatMap((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return group === undefined || state === undefined
      ? []
      : { group: Number(group), running: !state.startsWith("Z") };
  });
}

async function hasRunningMember(pid: number): Promise<boolean> {
  const members = (await readProcesses()).filter((member) => member.group === pid);
  // A group the list does not name at all left between the two looks, or is
  // hidden from this process: the next look decides.
  return members.length === 0 || members.some((member) => member.running);
}

/**
 * Whether any process of the group still runs. A signal also reaches one that
 * has exited and that its parent has not reaped yet; such a process writes
 * nothing more and cannot be killed, so a group of only those is gone. That is
 * only asked once the group has been sent SIGKILL: before it, a member can
 * start another while the list is being read, and the list would miss it. The
 * second SIGKILL and list are for one that was being started as the first
 * landed. A process list that cannot be read answers that one is still there.
 */
async function groupRuns(pid: number, killed: boolean): Promise<boolean> {
  if (!groupExists(pid)) return false;
  if (!killed || process.platform === "win32") return true;
  try {
    if (await hasRunningMember(pid)) return true;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Gone meanwhile, or macOS, which refuses to signal only exited processes.
    }
    return await hasRunningMember(pid);
  } catch {
    return groupExists(pid);
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
  const receiptIds = workingFor.getStore() ?? [];
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("git was stopped"));
  return new Promise<BoundedGitResult>((resolve, reject) => {
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    const grace = options.graceMs ?? GIT_KILL_GRACE_MS;
    const confirm = options.confirmMs ?? GIT_GROUP_CONFIRM_MS;
    const probe = options.probeGroup ?? groupRuns;
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
    let killed = false;
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
      const look = async (): Promise<void> => {
        const present = await probe(pid, killed);
        if (settled) return;
        if (!present) {
          groupGone = true;
          settleIfDone();
          return;
        }
        if (performance.now() >= killedAt + confirm) {
          // Still there after SIGKILL: keep looking after this call has gone,
          // and let the lock that guards the folder wait for it.
          registerSurvivor(receiptIds, outlive(pid, probe, child));
          groupGone = true;
          closed = true;
          settleIfDone();
          return;
        }
        timers.push(setTimeout(() => void look(), GROUP_POLL_MS));
      };
      void look();
    };
    const stop = (why: "aborted" | "timeout" | "buffer") => {
      if (stopped !== undefined || settled) return;
      stopped = why;
      signalTree(child, "SIGTERM");
      const killedAt = performance.now() + grace;
      // The escalation is never cancelled by the direct child leaving: only the
      // group being gone ends it.
      timers.push(
        setTimeout(() => {
          signalTree(child, "SIGKILL");
          killed = true;
        }, grace),
      );
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
async function outlive(pid: number, probe: GroupProbe, child: ChildProcess): Promise<void> {
  for (;;) {
    await new Promise<void>((resolve) => setTimeout(resolve, SURVIVOR_POLL_MS));
    if (!(await probe(pid, true))) return;
    signalTree(child, "SIGKILL");
  }
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

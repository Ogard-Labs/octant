import { execFile, spawn } from "node:child_process";
import type { DetachedProcessStart } from "./androidToolchainService";

/** How long a polite stop may take before the group is killed, and how long the kill may take. */
const GRACE_MS = 5_000;
const KILL_MS = 3_000;
const POLL_MS = 100;

/**
 * Starts a process that is not expected to exit, such as `emulator -avd`.
 * The caller waits on adb for readiness instead of this handle, and uses
 * `stop` to end the process when readiness never comes.
 *
 * The process leads its own process group, because the emulator launcher runs
 * the emulator proper as a child. `stop` signals that group and nothing else.
 */
export function spawnDetachedProcess(input: {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<DetachedProcessStart> {
  const unavailable = {
    kind: "unavailable",
    message: "emulator is unavailable on this host.",
  } as const;
  const command = input.argv[0];
  if (command === undefined) return Promise.resolve(unavailable);
  try {
    const child = spawn(command, input.argv.slice(1), {
      cwd: input.cwd,
      // The emulator binary is absolute; qemu next to it still consults PATH
      // and HOME. Overlay the SDK variables onto the host environment rather
      // than replacing it, or the process cannot start.
      env: { ...process.env, ...input.environment },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => undefined);
    const pid = child.pid;
    if (pid === undefined) return Promise.resolve(unavailable);
    // The group id is this child's pid, and the operating system may hand that
    // number to an unrelated process once the child is gone. The child's own
    // exit is therefore the proof of ownership: after it, nothing is signalled.
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.unref();
    return Promise.resolve({
      kind: "spawned",
      stop: async () => await stopProcessGroup(pid, () => exited),
    });
  } catch {
    return Promise.resolve(unavailable);
  }
}

/**
 * Whether a group still has a member that is running. A member that exited but
 * was never reaped (a zombie, which a host without a reaping init leaves
 * behind) still answers `kill(-pgid, 0)`, so signal delivery cannot tell.
 * `output` is `ps -A -o pgid=,stat=`.
 */
export function groupHasLiveMember(output: string, pgid: number): boolean {
  for (const line of output.split("\n")) {
    const [group, state] = line.trim().split(/\s+/);
    if (group === String(pgid) && state !== undefined && !state.startsWith("Z")) return true;
  }
  return false;
}

function listProcesses(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pgid=,stat="], { timeout: 5_000 }, (error, stdout) =>
      resolve(error === null ? stdout : undefined),
    );
  });
}

/** Not knowing counts as alive: a cleanup is only reported complete when it is proven. */
async function groupAlive(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    // EPERM means a member exists that this process may not signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  const listing = await listProcesses();
  return listing === undefined || groupHasLiveMember(listing, pid);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group ended between the check and the signal.
  }
}

async function waitUntilGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (await groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((settle) => setTimeout(settle, POLL_MS));
  }
  return true;
}

async function stopProcessGroup(
  pid: number,
  leaderExited: () => boolean,
): Promise<"stopped" | "still-running"> {
  // Once the leader is gone the number may belong to someone else, so no signal
  // is sent. Whether anything of ours is left cannot be proven, and the answer
  // says so rather than claiming a stop.
  if (leaderExited()) return (await groupAlive(pid)) ? "still-running" : "stopped";
  if (!(await groupAlive(pid))) return "stopped";
  signalGroup(pid, "SIGTERM");
  if (await waitUntilGone(pid, GRACE_MS)) return "stopped";
  if (leaderExited()) return (await groupAlive(pid)) ? "still-running" : "stopped";
  signalGroup(pid, "SIGKILL");
  return (await waitUntilGone(pid, KILL_MS)) ? "stopped" : "still-running";
}

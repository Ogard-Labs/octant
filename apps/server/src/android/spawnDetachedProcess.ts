import { spawn } from "node:child_process";
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
    child.unref();
    return Promise.resolve({
      kind: "spawned",
      stop: async () => await stopProcessGroup(pid),
    });
  } catch {
    return Promise.resolve(unavailable);
  }
}

/** A group stays alive while any member does, so this sees the emulator after its launcher exits. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM means a member exists that this process may not signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((settle) => setTimeout(settle, POLL_MS));
  }
  return true;
}

async function stopProcessGroup(pid: number): Promise<"stopped" | "still-running"> {
  if (!groupAlive(pid)) return "stopped";
  signalGroup(pid, "SIGTERM");
  if (await waitUntilGone(pid, GRACE_MS)) return "stopped";
  signalGroup(pid, "SIGKILL");
  return (await waitUntilGone(pid, KILL_MS)) ? "stopped" : "still-running";
}

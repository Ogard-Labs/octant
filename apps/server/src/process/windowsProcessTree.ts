import { spawn } from "node:child_process";
import { win32 } from "node:path";

export type WindowsProcessTreeStop = "stopped" | "absent" | "failed";

/**
 * Ends a process and every process it started, on Windows. Windows has no
 * process groups: the POSIX stop (a signal to the negated pid) has no Windows
 * form, and `ChildProcess.kill` there ends only the root, so a provider's
 * shell command and the programs it started outlived the provider they
 * belonged to. `taskkill /T` follows the parent links down from the root and
 * `/F` ends each process without asking, the stop the GitHub ports already
 * use. It runs from System32 by absolute path, never a `taskkill` found on
 * PATH, and through no shell.
 *
 * The answer is the tree's state: `absent` when the root had already exited
 * (taskkill's exit code 128), `failed` when taskkill could not run or refused.
 */
export function stopWindowsProcessTree(
  pid: number,
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = WINDOWS_TREE_STOP_TIMEOUT_MS,
): Promise<WindowsProcessTreeStop> {
  if (!Number.isSafeInteger(pid) || pid < 1) return Promise.resolve("failed");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        windowsSystemProgram("taskkill.exe", environment),
        ["/PID", String(pid), "/T", "/F"],
        {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch {
      resolve("failed");
      return;
    }
    // A stop that does not answer is a failed stop, so no caller (a host
    // starting up, a tool call) waits on it without end.
    const timer = setTimeout(() => {
      child.kill();
      resolve("failed");
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve("failed");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? "stopped" : code === 128 ? "absent" : "failed");
    });
  });
}

/** How long a tree stop may take before it counts as failed. */
export const WINDOWS_TREE_STOP_TIMEOUT_MS = 10_000;

/**
 * A program in the Windows system folder, by absolute path. `SystemRoot` is
 * set for every Windows process; a host without it falls back to the
 * folder every Windows install uses.
 */
export function windowsSystemProgram(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return win32.join(
    environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    name,
  );
}

/**
 * Stops a launch's whole tree and answers whether that is confirmed: the tree
 * stop ran (or found the root already gone) and the root's exit was seen
 * within `waitMs`. Anything else is `uncertain`, and the caller keeps the
 * launch's ownership receipt, so a restarted host still finds and stops a
 * tree a failed stop left running.
 */
export async function stopWindowsTreeConfirmed(
  pid: number,
  exited: Promise<void>,
  stop: (pid: number) => Promise<WindowsProcessTreeStop>,
  waitMs: number,
): Promise<"stopped" | "uncertain"> {
  const stopped = await stop(pid).catch(() => "failed" as const);
  if (stopped === "failed") return "uncertain";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
      timer.unref?.();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return ended ? "stopped" : "uncertain";
}

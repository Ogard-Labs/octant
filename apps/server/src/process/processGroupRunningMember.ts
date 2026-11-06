import { readdir, readFile } from "node:fs/promises";

type StatRead =
  | { readonly status: "read"; readonly state: string; readonly group: string }
  | { readonly status: "gone" }
  | { readonly status: "unreadable" };

/**
 * Reads the state and process group from a `/proc` stat file. The command name
 * is parenthesised and may itself contain spaces or parentheses, so the fields
 * are read after the last ")".
 */
async function readStat(path: string): Promise<StatRead> {
  let processStat: string;
  try {
    processStat = await readFile(path, "utf8");
  } catch (error) {
    // The process or thread was reaped between listing and reading its entry.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? { status: "gone" } : { status: "unreadable" };
  }
  const commandEnd = processStat.lastIndexOf(")");
  if (commandEnd < 0) return { status: "unreadable" };
  const fields = processStat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const group = fields[2];
  if (state === undefined || group === undefined) return { status: "unreadable" };
  return { status: "read", state, group };
}

function exited(state: string): boolean {
  return state === "Z" || state === "X";
}

/**
 * Whether a process whose main thread reads as a zombie still has a thread
 * that runs. When the main thread of a multithreaded process calls
 * `pthread_exit()`, `/proc/<pid>/stat` reports `Z` while its other threads keep
 * executing, and listing `/proc` visits only each process's main thread.
 */
async function zombieLeaderHasRunningThread(procRoot: string, pid: string): Promise<boolean> {
  let threads: ReadonlyArray<string>;
  try {
    threads = await readdir(`${procRoot}/${pid}/task`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return !(code === "ENOENT" || code === "ESRCH");
  }
  for (const thread of threads) {
    if (!/^[1-9]\d*$/.test(thread)) continue;
    const stat = await readStat(`${procRoot}/${pid}/task/${thread}/stat`);
    if (stat.status === "unreadable") return true;
    if (stat.status === "read" && !exited(stat.state)) return true;
  }
  return false;
}

/**
 * Whether a process group that still answers `kill(-pgid, 0)` has a member
 * that can run. A signal probe succeeds against a group whose only members are
 * zombies: processes that have exited but wait for their parent to reap them.
 * A descendant orphaned by the group leader's exit is reparented to PID 1 (or
 * the nearest subreaper), and that process reaps on its own schedule. A
 * container init was seen holding such zombies for about 1.5 seconds, longer
 * than any termination deadline, so the group read as alive after SIGKILL and
 * cleanup failed although nothing in it could run.
 *
 * Only Linux exposes per-process state cheaply, through `/proc`. Elsewhere,
 * and whenever `/proc` cannot be read or does not list the group, it is
 * reported as running so a caller never treats an unobserved group as gone.
 * `procRoot` lets a test present thread states without compiling a native
 * fixture.
 */
export async function processGroupHasRunningMember(
  pgid: number,
  procRoot = "/proc",
): Promise<boolean> {
  if (process.platform !== "linux") return true;
  let entries: ReadonlyArray<string>;
  try {
    entries = await readdir(procRoot);
  } catch {
    return true;
  }
  const group = String(pgid);
  let observedMember = false;
  for (const entry of entries) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    const stat = await readStat(`${procRoot}/${entry}/stat`);
    if (stat.status === "unreadable") return true;
    if (stat.status === "gone" || stat.group !== group) continue;
    if (!exited(stat.state)) return true;
    if (await zombieLeaderHasRunningThread(procRoot, entry)) return true;
    observedMember = true;
  }
  // A group the signal probe found but `/proc` does not list (a `/proc` from
  // another PID namespace) is unobserved, not gone.
  return !observedMember;
}

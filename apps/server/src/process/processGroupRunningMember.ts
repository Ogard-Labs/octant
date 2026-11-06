import { readdir, readFile } from "node:fs/promises";

/**
 * What the group check reads from the host. Paths are absolute `/proc` paths.
 * A test supplies its own to present process and thread states, and the
 * moments between reads, that the kernel cannot be made to produce on demand.
 */
export interface ProcessGroupObservation {
  readonly readdir: (path: string) => Promise<ReadonlyArray<string>>;
  readonly readFile: (path: string) => Promise<string>;
  /** Whether a signal probe of the group still reaches any member. */
  readonly groupExists: (pgid: number) => boolean;
}

const hostObservation: ProcessGroupObservation = {
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path, "utf8"),
  groupExists: (pgid) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
};

type StatRead =
  | { readonly status: "read"; readonly state: string; readonly group: string }
  | { readonly status: "gone" }
  | { readonly status: "unreadable" };

/**
 * Reads the state and process group from a `/proc` stat file. The command name
 * is parenthesised and may itself contain spaces or parentheses, so the fields
 * are read after the last ")".
 */
async function readStat(observation: ProcessGroupObservation, path: string): Promise<StatRead> {
  let processStat: string;
  try {
    processStat = await observation.readFile(path);
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
async function zombieLeaderHasRunningThread(
  observation: ProcessGroupObservation,
  pid: string,
): Promise<boolean> {
  let threads: ReadonlyArray<string>;
  try {
    threads = await observation.readdir(`/proc/${pid}/task`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return !(code === "ENOENT" || code === "ESRCH");
  }
  for (const thread of threads) {
    if (!/^[1-9]\d*$/.test(thread)) continue;
    const stat = await readStat(observation, `/proc/${pid}/task/${thread}/stat`);
    if (stat.status === "unreadable") return true;
    if (stat.status === "read" && !exited(stat.state)) return true;
  }
  return false;
}

type GroupScan =
  | { readonly status: "running" }
  | { readonly status: "exited"; readonly members: ReadonlyArray<string> };

/**
 * One pass over `/proc`. It reports the group exited only when every member
 * it found is a zombie with no running thread, and it found at least one: a
 * group the signal probe reaches but `/proc` does not list (a `/proc` from
 * another PID namespace) is unobserved, not gone.
 */
async function scanGroup(observation: ProcessGroupObservation, pgid: number): Promise<GroupScan> {
  let entries: ReadonlyArray<string>;
  try {
    entries = await observation.readdir("/proc");
  } catch {
    return { status: "running" };
  }
  const group = String(pgid);
  const members: string[] = [];
  for (const entry of entries) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    const stat = await readStat(observation, `/proc/${entry}/stat`);
    if (stat.status === "unreadable") return { status: "running" };
    if (stat.status === "gone" || stat.group !== group) continue;
    if (!exited(stat.state)) return { status: "running" };
    if (await zombieLeaderHasRunningThread(observation, entry)) return { status: "running" };
    members.push(entry);
  }
  return members.length === 0 ? { status: "running" } : { status: "exited", members };
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
 * One scan is not enough to say no member runs: a member can fork after the
 * `/proc` listing is taken and exit before its own entry is read, so the scan
 * sees only its zombie and never the live child. The group counts as exited
 * only when a second scan, taken after the signal probe still reaches the
 * group, finds exactly the same zombie members; a child forked during the
 * first scan carries the group's id and appears in the second.
 *
 * Only Linux exposes per-process state cheaply, through `/proc`. Elsewhere,
 * and whenever `/proc` cannot be read or does not list the group, it is
 * reported as running so a caller never treats an unobserved group as gone.
 */
export async function processGroupHasRunningMember(
  pgid: number,
  observation: ProcessGroupObservation = hostObservation,
): Promise<boolean> {
  if (process.platform !== "linux") return true;
  const first = await scanGroup(observation, pgid);
  if (first.status === "running") return true;
  if (!observation.groupExists(pgid)) return false;
  const second = await scanGroup(observation, pgid);
  if (second.status === "running") return true;
  const earlier = new Set(first.members);
  return !(
    second.members.length === earlier.size && second.members.every((pid) => earlier.has(pid))
  );
}

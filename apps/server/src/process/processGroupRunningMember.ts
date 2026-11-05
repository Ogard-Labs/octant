import { readdir, readFile } from "node:fs/promises";

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
 */
export async function processGroupHasRunningMember(pgid: number): Promise<boolean> {
  if (process.platform !== "linux") return true;
  let entries: ReadonlyArray<string>;
  try {
    entries = await readdir("/proc");
  } catch {
    return true;
  }
  const group = String(pgid);
  let observedMember = false;
  for (const entry of entries) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    let processStat: string;
    try {
      processStat = await readFile(`/proc/${entry}/stat`, "utf8");
    } catch (error) {
      // The process was reaped between listing and reading its entry.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") continue;
      return true;
    }
    // The command name is parenthesised and may itself contain spaces or
    // parentheses, so the state and group fields are read after the last ")".
    const commandEnd = processStat.lastIndexOf(")");
    if (commandEnd < 0) return true;
    const fields = processStat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/);
    const state = fields[0];
    if (fields[2] !== group || state === undefined) continue;
    if (state !== "Z" && state !== "X") return true;
    observedMember = true;
  }
  // A group the signal probe found but `/proc` does not list (a `/proc` from
  // another PID namespace) is unobserved, not gone.
  return !observedMember;
}

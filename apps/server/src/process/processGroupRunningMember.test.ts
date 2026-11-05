import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { processGroupHasRunningMember } from "./processGroupRunningMember";

const parents: ChildProcess[] = [];

afterEach(() => {
  for (const parent of parents.splice(0)) parent.kill("SIGKILL");
});

/**
 * Starts a parent that forks one child into a process group of its own and
 * never reaps it, so the child's exit leaves a zombie that a signal probe of
 * the group still reaches: the state an orphaned provider descendant is in
 * until PID 1 reaps it.
 */
async function groupLedByChild(childExits: boolean): Promise<number> {
  const parent = spawn(
    "/usr/bin/perl",
    [
      "-e",
      `use POSIX; $| = 1; my $p = fork; if (!$p) { setpgid(0, 0); ${childExits ? "POSIX::_exit(0)" : "sleep 30; POSIX::_exit(0)"} } print "$p\\n"; sleep 30`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  parents.push(parent);
  const pid = await new Promise<number>((resolve, reject) => {
    parent.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    parent.once("error", reject);
  });
  await expect
    .poll(() => {
      const processStat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = processStat
        .slice(processStat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      return fields[2] === String(pid) && (fields[0] === "Z") === childExits;
    })
    .toBe(true);
  return pid;
}

describe.skipIf(process.platform !== "linux")("process group running member", () => {
  it("reports a group whose only member has exited as not running though a signal still reaches it", async () => {
    const group = await groupLedByChild(true);
    expect(() => process.kill(-group, 0)).not.toThrow();
    await expect(processGroupHasRunningMember(group)).resolves.toBe(false);
  });

  it("reports a group with a member that can still run as running", async () => {
    const group = await groupLedByChild(false);
    try {
      await expect(processGroupHasRunningMember(group)).resolves.toBe(true);
    } finally {
      process.kill(-group, "SIGKILL");
    }
  });
});

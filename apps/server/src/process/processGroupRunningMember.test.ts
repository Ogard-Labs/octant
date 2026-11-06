import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processGroupHasRunningMember } from "./processGroupRunningMember";

const parents: ChildProcess[] = [];
const procRoots: string[] = [];

afterEach(() => {
  for (const parent of parents.splice(0)) parent.kill("SIGKILL");
  for (const root of procRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Writes a `/proc` tree holding one process with the given thread states. */
function procWithThreads(pid: number, threadStates: ReadonlyArray<string>): string {
  const root = mkdtempSync(join(tmpdir(), "octant-proc-"));
  procRoots.push(root);
  const stat = (id: number, state: string) => `${id} (worker (main)) ${state} 1 ${pid} ${pid} 0\n`;
  mkdirSync(join(root, String(pid)));
  writeFileSync(join(root, String(pid), "stat"), stat(pid, threadStates[0] ?? "Z"));
  threadStates.forEach((state, index) => {
    const thread = join(root, String(pid), "task", String(pid + index));
    mkdirSync(thread, { recursive: true });
    writeFileSync(join(thread, "stat"), stat(pid + index, state));
  });
  return root;
}

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

  it("reports a group as running while a thread outlives its process's exited main thread", async () => {
    // After `pthread_exit()` on the main thread, the process reads as a zombie
    // and only its task list shows the worker thread still running.
    await expect(
      processGroupHasRunningMember(4242, procWithThreads(4242, ["Z", "S"])),
    ).resolves.toBe(true);
    await expect(
      processGroupHasRunningMember(4242, procWithThreads(4242, ["Z", "Z"])),
    ).resolves.toBe(false);
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

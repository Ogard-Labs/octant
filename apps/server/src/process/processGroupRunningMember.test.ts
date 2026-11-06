import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  processGroupHasRunningMember,
  type ProcessGroupObservation,
} from "./processGroupRunningMember";

const parents: ChildProcess[] = [];

afterEach(() => {
  for (const parent of parents.splice(0)) parent.kill("SIGKILL");
});

const statLine = (pid: number, state: string, pgid: number) =>
  `${pid} (worker (main)) ${state} 1 ${pgid} ${pgid} 0\n`;

/**
 * A `/proc` that answers each listing of `/proc` with the next of `listings`
 * (repeating the last), so a test can place a fork between two reads.
 */
function fakeProc(
  listings: ReadonlyArray<ReadonlyArray<string>>,
  files: Readonly<Record<string, string>>,
): ProcessGroupObservation {
  let listing = 0;
  return {
    readdir: async (path) => {
      if (path === "/proc") return listings[Math.min(listing++, listings.length - 1)] ?? [];
      const prefix = `${path}/`;
      const children = Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split("/")[0] ?? "");
      if (children.length === 0) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return [...new Set(children)];
    },
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return content;
    },
    groupExists: () => true,
  };
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
    const process42 = (workerState: string) =>
      fakeProc([["42"]], {
        "/proc/42/stat": statLine(42, "Z", 42),
        "/proc/42/task/42/stat": statLine(42, "Z", 42),
        "/proc/42/task/43/stat": statLine(43, workerState, 42),
      });
    await expect(processGroupHasRunningMember(42, process42("S"))).resolves.toBe(true);
    await expect(processGroupHasRunningMember(42, process42("Z"))).resolves.toBe(false);
  });

  it("reports a group as running when a member forks a live child and exits during a scan", async () => {
    // The listing was taken before 42 forked 43; 42 had exited by the time its
    // entry was read, so the first pass sees only its zombie.
    const observation = fakeProc([["42"], ["42", "43"]], {
      "/proc/42/stat": statLine(42, "Z", 42),
      "/proc/42/task/42/stat": statLine(42, "Z", 42),
      "/proc/43/stat": statLine(43, "S", 42),
      "/proc/43/task/43/stat": statLine(43, "S", 42),
    });
    await expect(processGroupHasRunningMember(42, observation)).resolves.toBe(true);
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

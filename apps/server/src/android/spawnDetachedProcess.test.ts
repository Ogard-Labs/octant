import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { groupHasLiveMember, spawnDetachedProcess } from "./spawnDetachedProcess";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function recordedPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = Number((await readFile(path, "utf8").catch(() => "")).trim());
    if (Number.isInteger(value) && value > 0) return value;
    await new Promise((settle) => setTimeout(settle, 50));
  }
  throw new Error("the launcher never recorded its child");
}

describe("spawnDetachedProcess", () => {
  it("stops the whole process group it started, children included", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-detached-"));
    try {
      // A launcher that runs the real work as a child, as the emulator does.
      const started = await spawnDetachedProcess({
        argv: ["/bin/sh", "-c", 'sleep 300 & echo $! > "$0"; wait', join(directory, "child.pid")],
        cwd: directory,
        environment: {},
      });
      expect(started.kind).toBe("spawned");
      if (started.kind !== "spawned") return;
      const childPid = await recordedPid(join(directory, "child.pid"));
      expect(alive(childPid)).toBe(true);
      expect(await started.stop()).toBe("stopped");
      expect(alive(childPid)).toBe(false);
      expect(await started.stop()).toBe("stopped");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sends no signal to a group once the process it started has exited, since its number may be reused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-detached-"));
    let orphan: number | undefined;
    try {
      // The launcher exits and leaves a member behind, so the group still answers
      // a liveness probe, as a group would if its number had been reused.
      const started = await spawnDetachedProcess({
        argv: ["/bin/sh", "-c", 'sleep 300 & echo $! > "$0"; exit 0', join(directory, "child.pid")],
        cwd: directory,
        environment: {},
      });
      expect(started.kind).toBe("spawned");
      if (started.kind !== "spawned") return;
      orphan = await recordedPid(join(directory, "child.pid"));
      await new Promise((settle) => setTimeout(settle, 500));
      const kill = vi.spyOn(process, "kill");
      try {
        // Nothing is signalled, and the answer does not claim a stop it cannot prove.
        expect(await started.stop()).toBe("still-running");
        const signals = kill.mock.calls.map(([, signal]) => signal);
        expect(signals).not.toContain("SIGTERM");
        expect(signals).not.toContain("SIGKILL");
      } finally {
        kill.mockRestore();
      }
      expect(alive(orphan)).toBe(true);
    } finally {
      if (orphan !== undefined) process.kill(orphan, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("is unavailable for an empty command line", async () => {
    expect((await spawnDetachedProcess({ argv: [], cwd: "/", environment: {} })).kind).toBe(
      "unavailable",
    );
  });
});

describe("groupHasLiveMember", () => {
  it("does not count a member that exited and was never reaped", () => {
    const listing = ["  100 Ss", "  4919 Z", "  4919 Z+", "  4920 S"].join("\n");
    expect(groupHasLiveMember(listing, 4919)).toBe(false);
    expect(groupHasLiveMember(listing, 4920)).toBe(true);
    expect(groupHasLiveMember(`${listing}\n  4919 S`, 4919)).toBe(true);
  });
});

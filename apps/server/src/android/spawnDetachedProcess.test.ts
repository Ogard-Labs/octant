import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnDetachedProcess } from "./spawnDetachedProcess";

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

  it("is unavailable for an empty command line", async () => {
    expect((await spawnDetachedProcess({ argv: [], cwd: "/", environment: {} })).kind).toBe(
      "unavailable",
    );
  });
});

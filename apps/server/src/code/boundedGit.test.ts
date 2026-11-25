import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoundedGit } from "./boundedGit";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A child that ignores SIGTERM and starts a grandchild, as a hook or a filter might. */
async function stubborn() {
  const directory = await mkdtemp(join(tmpdir(), "octant-bounded-git-"));
  directories.push(directory);
  const script = `echo $$ > "${directory}/pid"; sleep 60 & echo $! > "${directory}/child"; trap "" TERM; while :; do sleep 1; done`;
  const pids = async () => ({
    child: Number(await readFile(join(directory, "pid"), "utf8")),
    grandchild: Number(await readFile(join(directory, "child"), "utf8")),
  });
  return { script, pids };
}

const env = { PATH: process.env.PATH ?? "" };

describe("runBoundedGit", () => {
  it("returns the output and exit code of a command that finishes", async () => {
    const result = await runBoundedGit({
      executable: "sh",
      args: ["-c", "echo out; echo err >&2; exit 3"],
      env,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });

  it("returns from a stopped command only after it and what it started have exited", async () => {
    const { script, pids } = await stubborn();
    const stop = new AbortController();
    const running = runBoundedGit({
      executable: "sh",
      args: ["-c", script],
      env,
      signal: stop.signal,
      timeoutMs: 60_000,
      graceMs: 150,
    });
    await expect
      .poll(async () =>
        pids().then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const { child, grandchild } = await pids();
    const started = Date.now();
    stop.abort(new Error("the person stopped it"));
    await expect(running).rejects.toThrow("the person stopped it");
    // SIGTERM was ignored, so the settle waited for the kill, not for the sleep.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(alive(child)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  });

  it("stops a command at its time limit, says so, and has it gone before it returns", async () => {
    const { script, pids } = await stubborn();
    const result = await runBoundedGit({
      executable: "sh",
      args: ["-c", script],
      env,
      signal: new AbortController().signal,
      timeoutMs: 300,
      graceMs: 150,
    });
    expect(result.timedOut).toBe(true);
    const { child, grandchild } = await pids();
    expect(alive(child)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  });

  it("refuses to start under a signal that has already stopped", async () => {
    await expect(
      runBoundedGit({
        executable: "sh",
        args: ["-c", "true"],
        env,
        signal: AbortSignal.abort(new Error("already")),
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("already");
  });
});

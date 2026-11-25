import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forReceipt, memberFromStat, runBoundedGit, waitForSurvivingGit } from "./boundedGit";

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

  it("keeps waiting for a helper that ignores SIGTERM and closed its pipes after Git itself left on SIGTERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-bounded-git-"));
    directories.push(directory);
    // The helper shares Git's process group but holds none of its pipes.
    const script = `(trap "" TERM; exec sleep 60) >/dev/null 2>&1 </dev/null & echo $! > "${directory}/helper"; echo ready > "${directory}/ready"; sleep 60`;
    const stop = new AbortController();
    const running = runBoundedGit({
      executable: "sh",
      args: ["-c", script],
      env,
      signal: stop.signal,
      timeoutMs: 60_000,
      graceMs: 300,
    });
    await expect
      .poll(() =>
        readFile(join(directory, "ready"), "utf8").then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const helper = Number(await readFile(join(directory, "helper"), "utf8"));
    expect(alive(helper)).toBe(true);
    stop.abort(new Error("stopped"));
    await expect(running).rejects.toThrow("stopped");
    expect(alive(helper)).toBe(false);
  });

  it("settles when a group cannot be confirmed gone, and keeps reporting it until it is", async () => {
    let present = true;
    const result = await forReceipt("outer", () =>
      forReceipt("inner", () =>
        runBoundedGit({
          executable: "sh",
          args: ["-c", "sleep 60"],
          env,
          signal: new AbortController().signal,
          timeoutMs: 100,
          graceMs: 50,
          confirmMs: 100,
          probeGroup: () => present,
        }),
      ),
    );
    expect(result.timedOut).toBe(true);
    const drained: string[] = [];
    const waiting = ["outer", "inner"].map((receiptId) =>
      waitForSurvivingGit(receiptId).then(() => drained.push(receiptId)),
    );
    await waitForSurvivingGit("unrelated");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(drained).toEqual([]);
    present = false;
    await Promise.all(waiting);
    expect(drained).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32")(
    "counts a group of only exited, unreaped processes as gone",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "octant-bounded-git-"));
      directories.push(directory);
      // A member of the group exits, and its parent, in a group of its own,
      // never reaps it: what a container without an init leaves behind.
      const script = `
        my $group = $$;
        if (fork == 0) {
          setpgrp(0, 0);
          close STDOUT; close STDERR;
          if (fork == 0) { setpgrp(0, $group); open(my $f, ">", "${directory}/ready"); close $f; sleep 60; exit; }
          open(my $f, ">", "${directory}/keeper"); print $f $$; close $f;
          sleep 60;
          exit;
        }
        sleep 60;
      `;
      const stop = new AbortController();
      const running = forReceipt("zombies", () =>
        runBoundedGit({
          executable: "perl",
          args: ["-e", script],
          env,
          signal: stop.signal,
          timeoutMs: 60_000,
          graceMs: 400,
          confirmMs: 4_000,
        }),
      );
      const ended = running.then(
        () => "finished",
        (error: unknown) => String(error),
      );
      const keeper = () =>
        readFile(join(directory, "keeper"), "utf8").then(
          (text) => Number(text),
          () => 0,
        );
      try {
        await expect.poll(keeper).toBeGreaterThan(0);
        await expect
          .poll(() =>
            readFile(join(directory, "ready"), "utf8").then(
              () => true,
              () => false,
            ),
          )
          .toBe(true);
        const began = Date.now();
        stop.abort(new Error("stopped"));
        await expect(ended).resolves.toContain("stopped");
        // Not before SIGKILL, and well before it would count as surviving.
        expect(Date.now() - began).toBeGreaterThanOrEqual(390);
        expect(Date.now() - began).toBeLessThan(3_000);
        expect(alive(await keeper())).toBe(true);
        await waitForSurvivingGit("zombies");
      } finally {
        stop.abort(new Error("stopped"));
        const pid = await keeper();
        if (pid > 0) process.kill(pid, "SIGKILL");
        await ended;
      }
    },
  );

  it("counts a process whose first thread exited as running while others do", () => {
    const stat = (state: string, threads: number) =>
      `41 (git) (x) ${state} 1 40 40 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 ${threads} 0 100`;
    expect(memberFromStat(stat("Z", 3))).toEqual({ group: 40, running: true });
    expect(memberFromStat(stat("Z", 1))).toEqual({ group: 40, running: false });
    expect(memberFromStat(stat("S", 1))).toEqual({ group: 40, running: true });
    expect(memberFromStat("")).toBeUndefined();
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

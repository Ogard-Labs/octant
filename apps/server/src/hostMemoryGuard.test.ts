import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostMemoryLimits } from "@octant/contracts/host-control";
import type { SystemMemorySignal } from "@octant/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostMemoryGuard } from "./hostMemoryGuard";

const GIB = 1024 ** 3;

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "octant-memory-guard-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function harness(overrides: { activeTurns?: number } = {}) {
  const state = {
    signal: "normal" as SystemMemorySignal,
    rss: 500 * 1024 ** 2,
    now: Date.parse("2026-10-31T10:00:00.000Z"),
    limits: { kind: "automatic" } as HostMemoryLimits,
  };
  const logs: string[] = [];
  const releaseIdle = vi.fn(async () => ({ idleRuntimesStopped: 2, idleSessionsReleased: 1 }));
  const trimCaches = vi.fn(() => true);
  const guard = new HostMemoryGuard({
    stateFile: join(directory, "host-memory.json"),
    readSystem: async () => ({ signal: state.signal, totalBytes: 32 * GIB }),
    readProcessRssBytes: () => state.rss,
    readLimits: () => state.limits,
    relief: { releaseIdle, trimCaches, activeTurns: () => overrides.activeTurns ?? 0 },
    clock: () => state.now,
    log: (line) => logs.push(line),
    setTimer: () => ({ unref: () => undefined, clear: () => undefined }),
  });
  return { guard, state, logs, releaseIdle, trimCaches };
}

describe("HostMemoryGuard", () => {
  it("leaves everything alone while memory is normal", async () => {
    const { guard, releaseIdle, trimCaches, logs } = harness();
    await guard.start();
    await guard.sample();
    expect(guard.report()).toEqual({
      pressure: "normal",
      processMegabytes: 500,
      limits: { kind: "automatic" },
      effectiveLimits: { pressuredMegabytes: 2048, criticalMegabytes: 4096 },
    });
    expect(releaseIdle).not.toHaveBeenCalled();
    expect(trimCaches).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("stops idle work, trims caches, and reports what it did when pressure rises", async () => {
    const { guard, state, releaseIdle, trimCaches, logs } = harness({ activeTurns: 2 });
    await guard.start();
    state.signal = "warning";
    await guard.sample();

    expect(releaseIdle).toHaveBeenCalledOnce();
    expect(trimCaches).toHaveBeenCalledOnce();
    expect(guard.report()).toEqual({
      pressure: "elevated",
      processMegabytes: 500,
      limits: { kind: "automatic" },
      effectiveLimits: { pressuredMegabytes: 2048, criticalMegabytes: 4096 },
      lastRelief: {
        at: "2026-10-31T10:00:00.000Z",
        pressure: "elevated",
        source: "system",
        idleProviderRuntimesStopped: 2,
        idleSessionsReleased: 1,
        cachesTrimmed: true,
        activeTurnsKept: 2,
      },
    });
    expect(logs.join("\n")).toContain("normal to elevated");
    expect(logs.join("\n")).toContain("2 turns kept running");
  });

  it("relieves once per cooldown at one level and again when pressure rises", async () => {
    const { guard, state, releaseIdle } = harness();
    await guard.start();
    state.signal = "warning";
    await guard.sample();
    state.now += 10_000;
    await guard.sample();
    expect(releaseIdle).toHaveBeenCalledTimes(1);

    state.signal = "critical";
    state.now += 1_000;
    await guard.sample();
    expect(releaseIdle).toHaveBeenCalledTimes(2);
    expect(guard.report().lastRelief?.pressure).toBe("critical");

    state.now += 61_000;
    await guard.sample();
    expect(releaseIdle).toHaveBeenCalledTimes(3);
  });

  it("treats a large host process as pressure even when the system is quiet", async () => {
    const { guard, state, releaseIdle } = harness();
    await guard.start();
    state.rss = 3 * GIB;
    await guard.sample();
    expect(releaseIdle).toHaveBeenCalledOnce();
    expect(guard.report().lastRelief?.source).toBe("process");
  });

  it("applies new limits at the next sample without a restart", async () => {
    const { guard, state, releaseIdle } = harness();
    await guard.start();
    state.rss = 5 * GIB;
    state.limits = { kind: "custom", pressuredGb: 6, criticalGb: 10 };
    await guard.sample();
    expect(releaseIdle).not.toHaveBeenCalled();
    expect(guard.report().pressure).toBe("normal");

    state.limits = { kind: "custom", pressuredGb: 4, criticalGb: 8 };
    await guard.sample();
    expect(releaseIdle).toHaveBeenCalledOnce();
    expect(guard.report()).toMatchObject({ pressure: "elevated" });
    expect(guard.report().lastRelief?.source).toBe("process");

    state.limits = { kind: "custom", pressuredGb: 1, criticalGb: 4.5 };
    await guard.sample();
    expect(guard.report().pressure).toBe("critical");
    expect(releaseIdle).toHaveBeenCalledTimes(2);
  });

  it("reports the limits in force, resolved for this machine, as soon as they change", async () => {
    const { guard, state } = harness();
    await guard.start();
    expect(guard.report().effectiveLimits).toEqual({
      pressuredMegabytes: 2048,
      criticalMegabytes: 4096,
    });
    state.limits = { kind: "custom", pressuredGb: 1.5, criticalGb: 3 };
    expect(guard.report()).toMatchObject({
      limits: { kind: "custom", pressuredGb: 1.5, criticalGb: 3 },
      effectiveLimits: { pressuredMegabytes: 1536, criticalMegabytes: 3072 },
    });
  });

  it("falls back to the automatic limits when the stored limits cannot be read", async () => {
    const { guard, state, releaseIdle, logs } = harness();
    await guard.start();
    state.rss = 3 * GIB;
    const failing = new HostMemoryGuard({
      stateFile: join(directory, "other.json"),
      readSystem: async () => ({ signal: "normal", totalBytes: 32 * GIB }),
      readProcessRssBytes: () => state.rss,
      readLimits: () => {
        throw new Error("projection unavailable");
      },
      relief: { releaseIdle, trimCaches: () => true, activeTurns: () => 0 },
      log: (line) => logs.push(line),
      setTimer: () => ({ unref: () => undefined, clear: () => undefined }),
    });
    await failing.sample();
    expect(failing.report().limits).toEqual({ kind: "automatic" });
    expect(failing.report().pressure).toBe("elevated");
    expect(logs.join("\n")).toContain("memory limits could not be read");
    expect(logs.join("\n")).not.toContain("projection unavailable");
  });

  it("saves the new reading before relief runs, so a kill during cleanup still leaves it behind", async () => {
    const { guard, state, releaseIdle } = harness();
    await guard.start();
    let finishRelief: () => void = () => undefined;
    releaseIdle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRelief = () => resolve({ idleRuntimesStopped: 0, idleSessionsReleased: 0 });
        }),
    );
    state.signal = "critical";
    state.rss = 4.5 * GIB;
    const sampling = guard.sample();
    await vi.waitFor(() => expect(releaseIdle).toHaveBeenCalledOnce());

    expect(JSON.parse(await readFile(join(directory, "host-memory.json"), "utf8"))).toMatchObject({
      cleanExit: false,
      pressure: "critical",
      processMegabytes: 4608,
    });
    finishRelief();
    await sampling;
  });

  it("keeps sampling when a relief step fails", async () => {
    const { guard, state, releaseIdle, logs } = harness();
    releaseIdle.mockRejectedValueOnce(new Error("provider close failed"));
    await guard.start();
    state.signal = "critical";
    await guard.sample();
    expect(guard.report().lastRelief).toMatchObject({
      idleProviderRuntimesStopped: 0,
      idleSessionsReleased: 0,
      cachesTrimmed: true,
    });
    expect(logs.join("\n")).toContain("could not stop idle provider work");
    expect(logs.join("\n")).not.toContain("provider close failed");
  });

  it("shows nothing on the next start after a clean stop", async () => {
    const first = harness();
    await first.guard.start();
    await first.guard.sample();
    await first.guard.stop();
    expect(JSON.parse(await readFile(join(directory, "host-memory.json"), "utf8"))).toMatchObject({
      cleanExit: true,
    });

    const second = harness();
    await second.guard.start();
    expect(second.guard.report().previousStop).toBeUndefined();
  });

  it("reports the last reading when the previous host ended without a clean stop", async () => {
    const first = harness();
    await first.guard.start();
    first.state.signal = "critical";
    first.state.rss = 4.5 * GIB;
    await first.guard.sample();
    // No stop(): the process was killed.

    const second = harness();
    second.logs.length = 0;
    await second.guard.start();
    expect(second.guard.report().previousStop).toEqual({
      lastSeenAt: "2026-10-31T10:00:00.000Z",
      pressure: "critical",
      processMegabytes: 4608,
    });
    expect(second.logs.join("\n")).toContain("previous host stopped without a clean exit");
  });

  it("starts clean when the state file is missing, unreadable, or not ours", async () => {
    await writeFile(join(directory, "host-memory.json"), "{not json", { mode: 0o600 });
    const { guard } = harness();
    await guard.start();
    expect(guard.report().previousStop).toBeUndefined();

    await writeFile(
      join(directory, "host-memory.json"),
      JSON.stringify({ schemaVersion: 1, cleanExit: false, pressure: "loud" }),
      { mode: 0o600 },
    );
    const again = harness();
    await again.guard.start();
    expect(again.guard.report().previousStop).toBeUndefined();
  });

  it("keeps its state file private to the owner and free of provider or thread names", async () => {
    const { guard, state } = harness();
    await guard.start();
    state.signal = "warning";
    await guard.sample();
    const file = join(directory, "host-memory.json");
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(Object.keys(JSON.parse(await readFile(file, "utf8"))).sort()).toEqual([
      "cleanExit",
      "lastSeenAt",
      "pressure",
      "processMegabytes",
      "schemaVersion",
    ]);
  });
});

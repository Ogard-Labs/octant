import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { slowStatementTally } from "../persistence/slowStatementLog";
import { HostHealthRecorder } from "./hostHealthRecorder";

const directories: string[] = [];
const stops: Array<() => void> = [];

afterEach(() => {
  while (stops.length > 0) stops.pop()?.();
  while (directories.length > 0) {
    rmSync(directories.pop() ?? "", { recursive: true, force: true });
  }
});

function recorder(path: string, clock: () => string) {
  const created = new HostHealthRecorder({
    path,
    clock,
    memory: () => ({ rss: 1_000_000, heapUsed: 400_000 }),
    databaseBytes: () => 8_192,
    latencyWindow: () => [{ key: "rpc", count: 3, p50Ms: 4, p95Ms: 9, maxMs: 12 }],
  });
  stops.push(created.start.bind(created)());
  return created;
}

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-host-health-"));
  directories.push(directory);
  return join(directory, "host-health.sqlite3");
}

describe("the host health recorder", () => {
  it("keeps a minute's figures and reads them back after a restart", () => {
    const path = scratch();
    let now = Date.parse("2026-11-07T10:00:00.000Z");
    const clock = () => new Date(now).toISOString();
    const first = recorder(path, clock);
    slowStatementTally.record(45);
    now += 60_000;
    first.sample();

    const restarted = recorder(path, clock);
    const history = restarted.read({});

    expect(history.resolution).toBe("minute");
    expect(history.retentionDays).toBe(14);
    expect(history.samples).toHaveLength(1);
    expect(history.samples[0]).toMatchObject({
      sampledAt: "2026-11-07T10:01:00.000Z",
      windowMs: 60_000,
      processStartedAt: "2026-11-07T10:00:00.000Z",
      rssBytes: 1_000_000,
      databaseBytes: 8_192,
      slowStatementCount: 1,
      slowStatementWorstMs: 45,
      latency: [{ key: "rpc", count: 3, p50Ms: 4, p95Ms: 9, maxMs: 12 }],
    });
  });

  it("counts a slow statement in one window only", () => {
    const path = scratch();
    let now = Date.parse("2026-11-07T10:00:00.000Z");
    const health = recorder(path, () => new Date(now).toISOString());
    slowStatementTally.record(30);
    now += 60_000;
    health.sample();
    now += 60_000;
    health.sample();

    expect(health.read({}).samples.map((sample) => sample.slowStatementCount)).toEqual([1, 0]);
  });

  it("forgets samples older than two weeks", () => {
    const path = scratch();
    let now = Date.parse("2026-10-01T10:00:00.000Z");
    const health = recorder(path, () => new Date(now).toISOString());
    health.sample();
    now = Date.parse("2026-11-07T10:00:00.000Z");
    for (let minute = 0; minute < 60; minute += 1) {
      now += 60_000;
      health.sample();
    }

    const all = health.read({ from: "2026-01-01T00:00:00.000Z" as never });

    expect(all.samples.every((sample) => sample.sampledAt >= "2026-11-01")).toBe(true);
  });

  it("prunes on its first sample, so a host that restarts often still forgets old samples", () => {
    const path = scratch();
    let now = Date.parse("2026-10-01T10:00:00.000Z");
    const clock = () => new Date(now).toISOString();
    recorder(path, clock).sample();
    now = Date.parse("2026-11-07T10:00:00.000Z");
    recorder(path, clock).sample();

    const all = recorder(path, clock).read({ from: "2026-01-01T00:00:00.000Z" as never });

    expect(all.samples.map((sample) => sample.sampledAt)).toEqual(["2026-11-07T10:00:00.000Z"]);
  });

  it("neither writes nor reopens its file once stopped", () => {
    const path = scratch();
    const health = new HostHealthRecorder({ path, latencyWindow: () => [] });
    const stop = health.start();
    expect(health.sample()).toBeDefined();
    stop();

    expect(health.sample()).toBeUndefined();
    expect(health.read({}).samples).toEqual([]);
  });

  it("never throws into the host when its file cannot be written", () => {
    const health = new HostHealthRecorder({
      path: "/nonexistent-octant-dir/host-health.sqlite3",
      latencyWindow: () => [],
    });

    expect(health.sample()).toBeUndefined();
    expect(health.read({}).samples).toEqual([]);
  });
});

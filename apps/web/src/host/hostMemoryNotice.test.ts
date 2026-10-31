import type { HostMemoryStatus } from "@octant/contracts/host-control";
import { describe, expect, it } from "vitest";
import { hostMemoryFact, hostMemoryNotices, hostReliefFact } from "./hostMemoryNotice";

const relief = {
  at: "2026-10-31T10:00:00.000Z",
  pressure: "elevated",
  source: "system",
  idleProviderRuntimesStopped: 2,
  idleSessionsReleased: 1,
  cachesTrimmed: true,
  activeTurnsKept: 1,
} as const;

describe("hostMemoryNotices", () => {
  it("says nothing while memory is fine and nothing has happened", () => {
    expect(hostMemoryNotices(undefined)).toEqual([]);
    expect(hostMemoryNotices({ pressure: "normal", processMegabytes: 400 })).toEqual([]);
  });

  it("names what was stopped and that running turns were left alone", () => {
    const [notice] = hostMemoryNotices({
      pressure: "elevated",
      processMegabytes: 2300,
      lastRelief: relief,
    });
    expect(notice?.id).toBe("relief:2026-10-31T10:00:00.000Z");
    expect(notice?.title).toBe("Octant freed memory");
    expect(notice?.detail).toBe(
      "Memory was running low, so Octant stopped 2 idle provider processes and released 1 paused session. 1 running turn kept going.",
    );
  });

  it("stays quiet about a relief that stopped nothing at elevated pressure", () => {
    const quiet: HostMemoryStatus = {
      pressure: "elevated",
      processMegabytes: 2300,
      lastRelief: { ...relief, idleProviderRuntimesStopped: 0, idleSessionsReleased: 0 },
    };
    expect(hostMemoryNotices(quiet)).toEqual([]);
  });

  it("still speaks at critical pressure when nothing idle was left to stop", () => {
    const [notice] = hostMemoryNotices({
      pressure: "critical",
      processMegabytes: 4200,
      lastRelief: {
        ...relief,
        pressure: "critical",
        idleProviderRuntimesStopped: 0,
        idleSessionsReleased: 0,
        activeTurnsKept: 2,
      },
    });
    expect(notice?.detail).toBe(
      "Memory was running low. Octant trimmed its caches and left the rest running. 2 running turns kept going.",
    );
  });

  it("tells the person after an unclean stop what the last reading was", () => {
    const [notice] = hostMemoryNotices({
      pressure: "normal",
      processMegabytes: 300,
      previousStop: {
        lastSeenAt: "2026-10-31T09:00:00.000Z",
        pressure: "critical",
        processMegabytes: 4100,
      },
    });
    expect(notice?.id).toBe("stop:2026-10-31T09:00:00.000Z");
    expect(notice?.title).toBe("Octant stopped unexpectedly");
    expect(notice?.detail).toContain("memory was very low");
    expect(notice?.detail).toContain("4100 MB");
  });

  it("does not blame memory when the last reading looked normal", () => {
    const [notice] = hostMemoryNotices({
      pressure: "normal",
      processMegabytes: 300,
      previousStop: {
        lastSeenAt: "2026-10-31T09:00:00.000Z",
        pressure: "normal",
        processMegabytes: 500,
      },
    });
    expect(notice?.detail).toContain("memory looked normal");
    expect(notice?.detail).toContain("cause is not known");
  });

  it("lists the unexpected stop before the relief", () => {
    const ids = hostMemoryNotices({
      pressure: "elevated",
      processMegabytes: 2300,
      lastRelief: relief,
      previousStop: {
        lastSeenAt: "2026-10-31T09:00:00.000Z",
        pressure: "normal",
        processMegabytes: 500,
      },
    }).map((notice) => notice.id.split(":")[0]);
    expect(ids).toEqual(["stop", "relief"]);
  });
});

describe("hostMemoryFact", () => {
  it("states the pressure and the host's size", () => {
    expect(hostMemoryFact({ pressure: "normal", processMegabytes: 612 })).toBe(
      "Normal, host using 612 MB",
    );
    expect(hostMemoryFact({ pressure: "critical", processMegabytes: 4200 })).toBe(
      "Very low, host using 4200 MB",
    );
  });
});

describe("hostReliefFact", () => {
  it("counts with the right plural", () => {
    expect(
      hostReliefFact({ ...relief, idleProviderRuntimesStopped: 1, activeTurnsKept: 0 }),
    ).toMatch(
      /stopped 1 idle provider process, released 1 paused session, 0 running turns kept going$/,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyHostMemory,
  decideHostMemoryLimits,
  resolveHostMemoryLimits,
  shouldRelieveHostMemory,
} from "./hostMemoryPolicy";

const GIB = 1024 ** 3;

describe("classifyHostMemory with custom limits", () => {
  const custom = { kind: "custom" as const, pressuredGb: 6, criticalGb: 10 };

  it("keeps the built-in limits when none are given or the setting is automatic", () => {
    const reading = { system: "normal" as const, processRssBytes: 3 * GIB, totalBytes: 32 * GIB };
    expect(classifyHostMemory(reading, { kind: "automatic" })).toEqual(classifyHostMemory(reading));
    expect(classifyHostMemory(reading)).toEqual({ pressure: "elevated", source: "process" });
  });

  it("holds a host below the custom pressured limit at normal even where the built-in limit would fire", () => {
    expect(
      classifyHostMemory(
        { system: "normal", processRssBytes: 5 * GIB, totalBytes: 32 * GIB },
        custom,
      ),
    ).toEqual({ pressure: "normal", source: "none" });
  });

  it("raises pressure at the custom pressured limit and at the custom critical limit", () => {
    expect(
      classifyHostMemory(
        { system: "normal", processRssBytes: 6 * GIB, totalBytes: 32 * GIB },
        custom,
      ),
    ).toEqual({ pressure: "elevated", source: "process" });
    expect(
      classifyHostMemory(
        { system: "unknown", processRssBytes: 10 * GIB, totalBytes: 32 * GIB },
        custom,
      ),
    ).toEqual({ pressure: "critical", source: "process" });
  });

  it("uses custom limits as given on a small machine instead of scaling them down", () => {
    expect(
      classifyHostMemory(
        { system: "normal", processRssBytes: 1.2 * GIB, totalBytes: 4 * GIB },
        { kind: "custom", pressuredGb: 3, criticalGb: 5 },
      ),
    ).toEqual({ pressure: "normal", source: "none" });
  });

  it("still follows the system signal whatever the custom limits say", () => {
    expect(
      classifyHostMemory(
        { system: "critical", processRssBytes: GIB / 2, totalBytes: 32 * GIB },
        custom,
      ),
    ).toEqual({ pressure: "critical", source: "system" });
  });
});

describe("resolveHostMemoryLimits", () => {
  it("reports the built-in pair on a large machine and the scaled pair on a small one", () => {
    expect(resolveHostMemoryLimits({ kind: "automatic" }, 32 * GIB)).toEqual({
      pressuredBytes: 2 * GIB,
      criticalBytes: 4 * GIB,
    });
    expect(resolveHostMemoryLimits({ kind: "automatic" }, 4 * GIB)).toEqual({
      pressuredBytes: GIB,
      criticalBytes: 2 * GIB,
    });
    expect(resolveHostMemoryLimits({ kind: "automatic" }, 0)).toEqual({
      pressuredBytes: 2 * GIB,
      criticalBytes: 4 * GIB,
    });
  });

  it("reports a custom pair unchanged whatever the machine", () => {
    expect(
      resolveHostMemoryLimits({ kind: "custom", pressuredGb: 1.5, criticalGb: 3 }, 4 * GIB),
    ).toEqual({ pressuredBytes: 1.5 * GIB, criticalBytes: 3 * GIB });
  });
});

describe("decideHostMemoryLimits", () => {
  it("allows automatic and a valid custom pair from a local window", () => {
    expect(
      decideHostMemoryLimits({ principalKind: "local-window", limits: { kind: "automatic" } }),
    ).toEqual({ kind: "allow", limits: { kind: "automatic" } });
    expect(
      decideHostMemoryLimits({
        principalKind: "local-window",
        limits: { kind: "custom", pressuredGb: 0.5, criticalGb: 64 },
      }),
    ).toEqual({ kind: "allow", limits: { kind: "custom", pressuredGb: 0.5, criticalGb: 64 } });
  });

  it("refuses a remote device before looking at the numbers", () => {
    expect(
      decideHostMemoryLimits({
        principalKind: "remote-device",
        limits: { kind: "custom", pressuredGb: 2, criticalGb: 4 },
      }),
    ).toMatchObject({ kind: "refused", code: "unauthorized" });
  });

  it.each([
    [0.4, 4],
    [2, 65],
    [-1, 4],
    [Number.NaN, 4],
    [2, Number.POSITIVE_INFINITY],
  ])("refuses %s and %s as out of range with a plain message", (pressuredGb, criticalGb) => {
    const decision = decideHostMemoryLimits({
      principalKind: "local-window",
      limits: { kind: "custom", pressuredGb, criticalGb },
    });
    expect(decision).toEqual({
      kind: "refused",
      code: "out-of-range",
      message: "Memory limits must be between 0.5 and 64 GB.",
    });
  });

  it.each([
    [4, 4],
    [8, 2],
  ])("refuses %s and %s when the critical limit is not above the pressured one", (p, c) => {
    expect(
      decideHostMemoryLimits({
        principalKind: "local-window",
        limits: { kind: "custom", pressuredGb: p, criticalGb: c },
      }),
    ).toEqual({
      kind: "refused",
      code: "critical-not-above-pressured",
      message: "The critical limit must be above the pressured limit.",
    });
  });
});

describe("classifyHostMemory", () => {
  it("reads a quiet machine and a small host as normal", () => {
    expect(
      classifyHostMemory({
        system: "normal",
        processRssBytes: 600 * 1024 ** 2,
        totalBytes: 16 * GIB,
      }),
    ).toEqual({ pressure: "normal", source: "none" });
  });

  it("follows the system signal when the host itself is small", () => {
    expect(
      classifyHostMemory({ system: "warning", processRssBytes: GIB / 2, totalBytes: 16 * GIB }),
    ).toEqual({ pressure: "elevated", source: "system" });
    expect(
      classifyHostMemory({ system: "critical", processRssBytes: GIB / 2, totalBytes: 16 * GIB }),
    ).toEqual({ pressure: "critical", source: "system" });
  });

  it("flags a large host process even when the system says nothing", () => {
    expect(
      classifyHostMemory({ system: "normal", processRssBytes: 3 * GIB, totalBytes: 32 * GIB }),
    ).toEqual({ pressure: "elevated", source: "process" });
    expect(
      classifyHostMemory({ system: "unknown", processRssBytes: 5 * GIB, totalBytes: 32 * GIB }),
    ).toEqual({ pressure: "critical", source: "process" });
  });

  it("scales the process limits down on a small machine", () => {
    // 25% of 4 GiB is 1 GiB; 50% is 2 GiB.
    expect(
      classifyHostMemory({ system: "normal", processRssBytes: 1.2 * GIB, totalBytes: 4 * GIB }),
    ).toEqual({ pressure: "elevated", source: "process" });
    expect(
      classifyHostMemory({ system: "normal", processRssBytes: 2.1 * GIB, totalBytes: 4 * GIB }),
    ).toEqual({ pressure: "critical", source: "process" });
  });

  it("names both sources when they agree on the worst level", () => {
    expect(
      classifyHostMemory({ system: "warning", processRssBytes: 3 * GIB, totalBytes: 32 * GIB }),
    ).toEqual({ pressure: "elevated", source: "both" });
  });

  it("does not guess a limit it cannot know the machine size for", () => {
    expect(
      classifyHostMemory({ system: "normal", processRssBytes: 3 * GIB, totalBytes: 0 }),
    ).toEqual({ pressure: "elevated", source: "process" });
  });
});

describe("shouldRelieveHostMemory", () => {
  it("does nothing while memory is normal", () => {
    expect(
      shouldRelieveHostMemory({ pressure: "normal", now: 10_000, lastRelief: undefined }),
    ).toBe(false);
  });

  it("relieves at once on the first pressure reading", () => {
    expect(
      shouldRelieveHostMemory({ pressure: "elevated", now: 10_000, lastRelief: undefined }),
    ).toBe(true);
  });

  it("waits out the cooldown at the same level and relieves again after it", () => {
    const lastRelief = { at: 10_000, pressure: "elevated" as const };
    expect(shouldRelieveHostMemory({ pressure: "elevated", now: 20_000, lastRelief })).toBe(false);
    expect(shouldRelieveHostMemory({ pressure: "elevated", now: 71_000, lastRelief })).toBe(true);
  });

  it("relieves again straight away when pressure rises", () => {
    expect(
      shouldRelieveHostMemory({
        pressure: "critical",
        now: 12_000,
        lastRelief: { at: 10_000, pressure: "elevated" },
      }),
    ).toBe(true);
  });
});

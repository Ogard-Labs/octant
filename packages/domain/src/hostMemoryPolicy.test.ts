import { describe, expect, it } from "vitest";
import { classifyHostMemory, shouldRelieveHostMemory } from "./hostMemoryPolicy";

const GIB = 1024 ** 3;

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

import { describe, expect, it } from "vitest";
import { decodeHostResourceSnapshot } from "./hostResources";

const sampledAt = "2026-10-06T12:00:00.000Z";

describe("a host resource snapshot", () => {
  it("decodes cores, a CPU percentage, memory, and an optional disk volume", () => {
    expect(
      decodeHostResourceSnapshot({
        cores: 8,
        cpuPercent: 42,
        memory: { usedBytes: 4_000, totalBytes: 16_000 },
        disk: { usedBytes: 20, freeBytes: 80 },
        sampledAt,
      }),
    ).toEqual({
      cores: 8,
      cpuPercent: 42,
      memory: { usedBytes: 4_000, totalBytes: 16_000 },
      disk: { usedBytes: 20, freeBytes: 80 },
      sampledAt,
    });
  });

  it("accepts a snapshot that omits disk when the volume could not be read", () => {
    const decoded = decodeHostResourceSnapshot({
      cores: 4,
      cpuPercent: 0,
      memory: { usedBytes: 1, totalBytes: 2 },
      sampledAt,
    });
    expect(decoded.disk).toBeUndefined();
  });

  it("refuses a path, a user name, or a process list on the snapshot", () => {
    expect(() =>
      decodeHostResourceSnapshot({
        cores: 4,
        cpuPercent: 1,
        memory: { usedBytes: 1, totalBytes: 2 },
        sampledAt,
        path: "/Users/ada/Library/Application Support/Octant",
      }),
    ).toThrow();
    expect(() =>
      decodeHostResourceSnapshot({
        cores: 4,
        cpuPercent: 1,
        memory: { usedBytes: 1, totalBytes: 2, user: "ada" },
        sampledAt,
      }),
    ).toThrow();
    expect(() =>
      decodeHostResourceSnapshot({
        cores: 4,
        cpuPercent: 1,
        memory: { usedBytes: 1, totalBytes: 2 },
        processes: ["node"],
        sampledAt,
      }),
    ).toThrow();
  });
});

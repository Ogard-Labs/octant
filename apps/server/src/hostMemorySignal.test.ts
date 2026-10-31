import { describe, expect, it } from "vitest";
import {
  classifyAvailableMemory,
  parseDarwinPressureLevel,
  parseLinuxMemoryInfo,
  readSystemMemory,
} from "./hostMemorySignal";

describe("parseDarwinPressureLevel", () => {
  it("maps the kernel's pressure levels", () => {
    expect(parseDarwinPressureLevel("1\n")).toBe("normal");
    expect(parseDarwinPressureLevel("2\n")).toBe("warning");
    expect(parseDarwinPressureLevel("4\n")).toBe("critical");
  });

  it("reports a level it does not know as unknown rather than normal", () => {
    expect(parseDarwinPressureLevel("")).toBe("unknown");
    expect(parseDarwinPressureLevel("3")).toBe("unknown");
    expect(parseDarwinPressureLevel("not a number")).toBe("unknown");
  });
});

describe("parseLinuxMemoryInfo", () => {
  it("reads total and available memory in bytes", () => {
    expect(
      parseLinuxMemoryInfo(
        "MemTotal:       16384000 kB\nMemFree: 100 kB\nMemAvailable:    1638400 kB\n",
      ),
    ).toEqual({ totalBytes: 16384000 * 1024, availableBytes: 1638400 * 1024 });
  });

  it("returns nothing when the kernel omits either field", () => {
    expect(parseLinuxMemoryInfo("MemTotal: 10 kB\n")).toBeUndefined();
    expect(parseLinuxMemoryInfo("")).toBeUndefined();
  });
});

describe("classifyAvailableMemory", () => {
  it("warns under ten percent available and calls five percent critical", () => {
    expect(classifyAvailableMemory({ totalBytes: 1000, availableBytes: 200 })).toBe("normal");
    expect(classifyAvailableMemory({ totalBytes: 1000, availableBytes: 90 })).toBe("warning");
    expect(classifyAvailableMemory({ totalBytes: 1000, availableBytes: 40 })).toBe("critical");
  });
});

describe("readSystemMemory", () => {
  it("asks the kernel on macOS and keeps the machine size", async () => {
    await expect(
      readSystemMemory({
        platform: "darwin",
        totalBytes: () => 8_000,
        runSysctl: async () => "4\n",
      }),
    ).resolves.toEqual({ signal: "critical", totalBytes: 8_000 });
  });

  it("reads available memory on Linux", async () => {
    await expect(
      readSystemMemory({
        platform: "linux",
        totalBytes: () => 0,
        readFile: async () => "MemTotal: 1000 kB\nMemAvailable: 40 kB\n",
      }),
    ).resolves.toEqual({ signal: "critical", totalBytes: 1000 * 1024 });
  });

  it("falls back to unknown when the reading fails", async () => {
    await expect(
      readSystemMemory({
        platform: "darwin",
        totalBytes: () => 8_000,
        runSysctl: async () => {
          throw new Error("sysctl missing");
        },
      }),
    ).resolves.toEqual({ signal: "unknown", totalBytes: 8_000 });
  });

  it("reports unknown on a platform with no pressure signal", async () => {
    await expect(readSystemMemory({ platform: "win32", totalBytes: () => 8_000 })).resolves.toEqual(
      {
        signal: "unknown",
        totalBytes: 8_000,
      },
    );
  });
});

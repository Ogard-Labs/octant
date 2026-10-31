import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import type { SystemMemorySignal } from "@octant/domain";

export interface SystemMemorySample {
  readonly signal: SystemMemorySignal;
  /** Physical memory of the machine; zero when it could not be read. */
  readonly totalBytes: number;
}

/**
 * macOS publishes its own pressure level (1 normal, 2 warning, 4 critical).
 * Free-page counts mislead there because the kernel keeps reclaimable cache
 * in use on purpose, so the level is the only honest signal.
 */
export function parseDarwinPressureLevel(output: string): SystemMemorySignal {
  const level = Number.parseInt(output.trim(), 10);
  if (level === 1) return "normal";
  if (level === 2) return "warning";
  if (level === 4) return "critical";
  return "unknown";
}

export function parseLinuxMemoryInfo(
  text: string,
): { readonly totalBytes: number; readonly availableBytes: number } | undefined {
  const field = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return match?.[1] === undefined ? undefined : Number(match[1]) * 1024;
  };
  const totalBytes = field("MemTotal");
  const availableBytes = field("MemAvailable");
  if (totalBytes === undefined || availableBytes === undefined) return undefined;
  return { totalBytes, availableBytes };
}

export function classifyAvailableMemory(input: {
  readonly totalBytes: number;
  readonly availableBytes: number;
}): SystemMemorySignal {
  if (input.totalBytes <= 0) return "unknown";
  const share = input.availableBytes / input.totalBytes;
  if (share < 0.05) return "critical";
  if (share < 0.1) return "warning";
  return "normal";
}

export interface SystemMemoryReaderOptions {
  readonly platform?: NodeJS.Platform;
  readonly totalBytes?: () => number;
  readonly runSysctl?: () => Promise<string>;
  readonly readFile?: (path: string) => Promise<string>;
}

function runDarwinSysctl(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/sbin/sysctl",
      ["-n", "kern.memorystatus_vm_pressure_level"],
      { timeout: 2_000 },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    );
  });
}

/**
 * One local reading of system memory. It spawns nothing but the macOS sysctl
 * and reads nothing but `/proc/meminfo`; a reading that fails is `unknown`,
 * which the policy treats as no signal, never as normal pressure.
 */
export async function readSystemMemory(
  options: SystemMemoryReaderOptions = {},
): Promise<SystemMemorySample> {
  const platform = options.platform ?? process.platform;
  const total = (options.totalBytes ?? totalmem)();
  try {
    if (platform === "darwin") {
      const output = await (options.runSysctl ?? runDarwinSysctl)();
      return { signal: parseDarwinPressureLevel(output), totalBytes: total };
    }
    if (platform === "linux") {
      const text = await (options.readFile ?? ((path) => readFile(path, "utf8")))("/proc/meminfo");
      const info = parseLinuxMemoryInfo(text);
      if (info === undefined) return { signal: "unknown", totalBytes: total };
      return { signal: classifyAvailableMemory(info), totalBytes: info.totalBytes };
    }
  } catch {
    return { signal: "unknown", totalBytes: total };
  }
  return { signal: "unknown", totalBytes: total };
}

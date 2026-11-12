import type { HostResourcePolicy } from "@octant/contracts";

export interface HostResourceReading {
  readonly cores: number;
  readonly totalMemoryBytes: number;
  readonly availableMemoryBytes: number;
  readonly cpuPercent: number;
  readonly load: number;
}
export interface HostResourceLimits {
  readonly commands: number;
  readonly workers: number;
  readonly agents: number;
  readonly reason:
    | "ready"
    | "cpu-pressure"
    | "memory-pressure"
    | "paused"
    | "unavailable"
    | "recovering";
}

/** Admission estimates, not OS CPU or memory quotas. A unit reserves 1 GiB and one core. */
export function decideHostResourceLimits(
  policy: HostResourcePolicy,
  reading: HostResourceReading,
): HostResourceLimits {
  const held = (reason: HostResourceLimits["reason"]): HostResourceLimits => ({
    commands: 0,
    workers: 1,
    agents: 0,
    reason,
  });
  if (policy.mode === "paused") return held("paused");
  if (policy.mode === "manual")
    return {
      commands: policy.maxCommands,
      workers: policy.maxWorkers,
      agents: policy.maxAgents,
      reason: "ready",
    };
  if (
    Object.values(reading).some((value) => !Number.isFinite(value) || value < 0) ||
    reading.cores < 1 ||
    reading.totalMemoryBytes <= 0
  ) {
    return { commands: 1, workers: 1, agents: 1, reason: "unavailable" };
  }
  const reserve = Math.max(2 ** 30, (reading.totalMemoryBytes * policy.memoryReservePercent) / 100);
  const memoryUnits = Math.floor((reading.availableMemoryBytes - reserve) / 2 ** 30);
  if (memoryUnits < 1) return held("memory-pressure");
  if (
    reading.cpuPercent >= policy.cpuTargetPercent ||
    reading.load >= (reading.cores * policy.cpuTargetPercent) / 100
  )
    return held("cpu-pressure");
  // Both instantaneous CPU and the one-minute runnable load include other local work.
  const freeCores = (reading.cores * (policy.cpuTargetPercent - reading.cpuPercent)) / 100;
  const units = Math.max(
    1,
    Math.min(
      memoryUnits,
      Math.floor(freeCores),
      Math.floor((reading.cores * policy.cpuTargetPercent) / 100 - reading.load),
    ),
  );
  return {
    commands: Math.min(policy.maxCommands, units),
    workers: Math.min(policy.maxWorkers, units),
    agents: Math.min(policy.maxAgents, units),
    reason: "ready",
  };
}

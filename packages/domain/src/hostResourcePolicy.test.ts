import { describe, expect, it } from "vitest";
import { decideHostResourceLimits } from "./hostResourcePolicy";

const policy = {
  mode: "automatic" as const,
  cpuTargetPercent: 60,
  memoryReservePercent: 20,
  maxCommands: 4,
  maxWorkers: 4,
  maxAgents: 4,
};
const idle = {
  cores: 8,
  totalMemoryBytes: 16 * 2 ** 30,
  availableMemoryBytes: 12 * 2 ** 30,
  cpuPercent: 10,
  load: 0.5,
};
describe("host resource admission", () => {
  it("uses macOS pressure when available bytes cannot be measured", () => {
    expect(
      decideHostResourceLimits(policy, {
        ...idle,
        cpuPercent: 99,
        availableMemoryBytes: undefined,
        memoryPressure: "unknown",
      }),
    ).toMatchObject({ commands: 0, reason: "cpu-pressure" });
    expect(
      decideHostResourceLimits(policy, {
        ...idle,
        availableMemoryBytes: undefined,
        memoryPressure: "normal",
      }),
    ).toMatchObject({ commands: 4, reason: "ready" });
    expect(
      decideHostResourceLimits(policy, {
        ...idle,
        availableMemoryBytes: undefined,
        memoryPressure: "warning",
      }),
    ).toMatchObject({ commands: 0, reason: "memory-pressure" });
    expect(
      decideHostResourceLimits(policy, {
        ...idle,
        availableMemoryBytes: undefined,
        memoryPressure: "unknown",
      }),
    ).toMatchObject({ commands: 1, reason: "unavailable" });
  });
  it("reserves hardware capacity and honours lower manual ceilings", () => {
    expect(decideHostResourceLimits(policy, idle)).toMatchObject({
      commands: 4,
      workers: 4,
      agents: 4,
      reason: "ready",
    });
    expect(
      decideHostResourceLimits({ ...policy, maxCommands: 1, maxWorkers: 2, maxAgents: 1 }, idle),
    ).toMatchObject({ commands: 1, workers: 2, agents: 1 });
    expect(
      decideHostResourceLimits(policy, {
        ...idle,
        cores: 2,
        totalMemoryBytes: 4 * 2 ** 30,
        availableMemoryBytes: 3 * 2 ** 30,
      }),
    ).toMatchObject({ commands: 1, workers: 1, agents: 1 });
  });
  it("holds new work when another application consumes CPU or memory", () => {
    expect(decideHostResourceLimits(policy, { ...idle, cpuPercent: 95 })).toMatchObject({
      commands: 0,
      agents: 0,
      reason: "cpu-pressure",
    });
    expect(
      decideHostResourceLimits(policy, { ...idle, availableMemoryBytes: 300 * 2 ** 20 }),
    ).toMatchObject({ commands: 0, agents: 0, reason: "memory-pressure" });
    expect(decideHostResourceLimits(policy, { ...idle, load: 20 })).toMatchObject({
      commands: 0,
      reason: "cpu-pressure",
    });
  });
  it("manual mode retains ceilings and pause holds new launches", () => {
    expect(
      decideHostResourceLimits({ ...policy, mode: "manual" }, { ...idle, cpuPercent: 99 }),
    ).toMatchObject({ commands: 4, workers: 4, agents: 4 });
    expect(decideHostResourceLimits({ ...policy, mode: "paused" }, idle)).toMatchObject({
      commands: 0,
      agents: 0,
      reason: "paused",
    });
  });
  it("uses conservative limits when a hardware reading is unavailable", () => {
    expect(decideHostResourceLimits(policy, { ...idle, cpuPercent: NaN })).toMatchObject({
      commands: 1,
      workers: 1,
      agents: 1,
      reason: "unavailable",
    });
  });
});

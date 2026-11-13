import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Ceiling = Schema.Int.pipe(Schema.between(1, 16));
export const HostResourcePolicy = Schema.Struct({
  mode: Schema.Literal("automatic", "manual", "paused"),
  cpuTargetPercent: Schema.Int.pipe(Schema.between(20, 90)),
  memoryReservePercent: Schema.Int.pipe(Schema.between(10, 50)),
  maxCommands: Ceiling,
  maxWorkers: Ceiling,
  maxAgents: Ceiling,
}).annotations(strict);
export type HostResourcePolicy = typeof HostResourcePolicy.Type;
export const DEFAULT_HOST_RESOURCE_POLICY: HostResourcePolicy = {
  mode: "automatic",
  cpuTargetPercent: 60,
  memoryReservePercent: 20,
  maxCommands: 4,
  maxWorkers: 4,
  maxAgents: 4,
};
const Count = Schema.Int.pipe(Schema.greaterThanOrEqualTo(0));
export const HostResourceBudgetSnapshot = Schema.Struct({
  policy: HostResourcePolicy,
  cores: Count,
  totalMemoryBytes: Count,
  availableMemoryBytes: Schema.optional(Count),
  memoryPressure: Schema.optional(Schema.Literal("normal", "warning", "critical", "unknown")),
  cpuPercent: Schema.Number.pipe(Schema.between(0, 100)),
  commands: Count,
  workers: Count,
  agents: Count,
  activeCommands: Count,
  queuedCommands: Count,
  reason: Schema.Literal(
    "ready",
    "cpu-pressure",
    "memory-pressure",
    "paused",
    "unavailable",
    "recovering",
  ),
}).annotations(strict);
export type HostResourceBudgetSnapshot = typeof HostResourceBudgetSnapshot.Type;

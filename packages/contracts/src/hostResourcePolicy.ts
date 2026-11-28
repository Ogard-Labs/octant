import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

const Ceiling = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }));

/**
 * Whether the desktop app holds an app-suspension blocker while agents work.
 * Never prevents display sleep.
 */
export const KeepAwakePolicy = Schema.Literals(["on-power", "always", "never"]);
export type KeepAwakePolicy = typeof KeepAwakePolicy.Type;
export const DEFAULT_KEEP_AWAKE_POLICY: KeepAwakePolicy = "on-power";

export const HostResourcePolicy = Schema.Struct({
  mode: Schema.Literals(["automatic", "manual", "paused"]),
  cpuTargetPercent: Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 90 })),
  memoryReservePercent: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 50 })),
  maxCommands: Ceiling,
  maxWorkers: Ceiling,
  maxAgents: Ceiling,
  /** Optional so settings journaled before keep-awake existed replay as on-power. */
  keepAwake: Schema.optional(KeepAwakePolicy),
});
export type HostResourcePolicy = typeof HostResourcePolicy.Type;
export const DEFAULT_HOST_RESOURCE_POLICY: HostResourcePolicy = {
  mode: "automatic",
  cpuTargetPercent: 60,
  memoryReservePercent: 20,
  maxCommands: 4,
  maxWorkers: 4,
  maxAgents: 4,
};

const Count = NonNegativeInt;
export const HostResourceBudgetSnapshot = Schema.Struct({
  policy: HostResourcePolicy,
  cores: Count,
  totalMemoryBytes: Count,
  availableMemoryBytes: Schema.optional(Count),
  memoryPressure: Schema.optional(Schema.Literals(["normal", "warning", "critical", "unknown"])),
  cpuPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  commands: Count,
  workers: Count,
  agents: Count,
  activeCommands: Count,
  queuedCommands: Count,
  reason: Schema.Literals([
    "ready",
    "cpu-pressure",
    "memory-pressure",
    "paused",
    "unavailable",
    "recovering",
  ]),
});
export type HostResourceBudgetSnapshot = typeof HostResourceBudgetSnapshot.Type;

/**
 * Counts-only running-work signal polled by the local desktop app over
 * loopback (`GET /api/desktop/agent-work`) to decide whether to hold a
 * prevent-app-suspension assertion. Carries no thread titles or paths.
 */
export const DesktopAgentWorkTurns = Schema.Struct({
  chat: Count,
  work: Count,
  code: Count,
});
export type DesktopAgentWorkTurns = typeof DesktopAgentWorkTurns.Type;

export const DesktopAgentWorkSnapshot = Schema.Struct({
  keepAwake: KeepAwakePolicy,
  turns: DesktopAgentWorkTurns,
  childRuns: Count,
  coordinatorWorkers: Count,
  nextRoutineDueAt: Schema.NullOr(UtcTimestamp),
  observedAt: UtcTimestamp,
});
export type DesktopAgentWorkSnapshot = typeof DesktopAgentWorkSnapshot.Type;
export const decodeDesktopAgentWorkSnapshot = Schema.decodeUnknownSync(
  DesktopAgentWorkSnapshot,
  STRICT_DECODE_OPTIONS,
);

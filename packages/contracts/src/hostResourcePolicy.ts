import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Ceiling = Schema.Int.pipe(Schema.between(1, 16));

/**
 * Whether the desktop app holds an app-suspension blocker while agents work.
 * Never prevents display sleep.
 */
export const KeepAwakePolicy = Schema.Literal("on-power", "always", "never");
export type KeepAwakePolicy = typeof KeepAwakePolicy.Type;
export const DEFAULT_KEEP_AWAKE_POLICY: KeepAwakePolicy = "on-power";

export const HostResourcePolicy = Schema.Struct({
  mode: Schema.Literal("automatic", "manual", "paused"),
  cpuTargetPercent: Schema.Int.pipe(Schema.between(20, 90)),
  memoryReservePercent: Schema.Int.pipe(Schema.between(10, 50)),
  maxCommands: Ceiling,
  maxWorkers: Ceiling,
  maxAgents: Ceiling,
  /** Optional so settings journaled before keep-awake existed replay as on-power. */
  keepAwake: Schema.optional(KeepAwakePolicy),
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

/**
 * Counts-only running-work signal polled by the local desktop app over
 * loopback (`GET /api/desktop/agent-work`) to decide whether to hold a
 * prevent-app-suspension assertion. Carries no thread titles or paths.
 */
export const DesktopAgentWorkTurns = Schema.Struct({
  chat: Count,
  work: Count,
  code: Count,
}).annotations(strict);
export type DesktopAgentWorkTurns = typeof DesktopAgentWorkTurns.Type;

export const DesktopAgentWorkSnapshot = Schema.Struct({
  keepAwake: KeepAwakePolicy,
  turns: DesktopAgentWorkTurns,
  childRuns: Count,
  coordinatorWorkers: Count,
  nextRoutineDueAt: Schema.NullOr(UtcTimestamp),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type DesktopAgentWorkSnapshot = typeof DesktopAgentWorkSnapshot.Type;
export const decodeDesktopAgentWorkSnapshot = Schema.decodeUnknownSync(DesktopAgentWorkSnapshot);
